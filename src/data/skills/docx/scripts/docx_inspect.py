#!/usr/bin/env python3
"""Inspect a .docx / .dotx Word document and emit a JSON summary.

This is the FIRST tool the AI runs on any pre-existing Word document, because
the GemiX runtime does not auto-parse .docx files (unlike PDFs). `read_file`
on a binary .docx returns garbage.

Output: structured JSON with section/page setup, heading outline, paragraph
sample, table inventory, image inventory, comments, tracked changes counts,
and styles in use. Optionally extracts embedded images.
"""
import argparse
import json
import re
import sys
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from docx import Document
from docx.oxml.ns import qn

try:
    from lxml import etree
except ImportError:
    etree = None


# Word unit conversion constants
EMU_PER_INCH = 914400  # 1 inch = 914400 EMUs (English Metric Units)

def _emu_to_in(value: Optional[int]) -> Optional[float]:
    if value is None:
        return None
    return round(value / EMU_PER_INCH, 3)


def _named_page_size(width_in: Optional[float], height_in: Optional[float]) -> str:
    """Best-effort match against well-known sizes (tolerance ±0.1")."""
    if width_in is None or height_in is None:
        return "unknown"
    if width_in <= 0 or height_in <= 0:
        return "custom"
    candidates = {
        "letter": (8.5, 11.0),
        "legal":  (8.5, 14.0),
        "a4":     (8.27, 11.69),
        "a5":     (5.83, 8.27),
        "tabloid": (11.0, 17.0),
    }
    for name, (w, h) in candidates.items():
        if (abs(width_in - w) < 0.1 and abs(height_in - h) < 0.1) or \
           (abs(width_in - h) < 0.1 and abs(height_in - w) < 0.1):
            return name
    return "custom"


def _section_summary(section) -> Dict[str, Any]:
    width_in = _emu_to_in(section.page_width)
    height_in = _emu_to_in(section.page_height)
    orientation = "landscape" if (width_in or 0) > (height_in or 0) else "portrait"
    return {
        "page_size": _named_page_size(width_in, height_in),
        "page_width_in": width_in,
        "page_height_in": height_in,
        "orientation": orientation,
        "margins_in": {
            "top": _emu_to_in(section.top_margin),
            "right": _emu_to_in(section.right_margin),
            "bottom": _emu_to_in(section.bottom_margin),
            "left": _emu_to_in(section.left_margin),
            "header": _emu_to_in(section.header_distance),
            "footer": _emu_to_in(section.footer_distance),
        },
        "different_first_page": bool(getattr(section, "different_first_page_header_footer", False)),
    }


def _heading_level(para) -> Optional[int]:
    style_name = (para.style.name if para.style else "") or ""
    # Standard names are "Heading 1" .. "Heading 9"
    # Also handle "Heading1", "Heading-1", "Heading 1" formats
    if style_name.lower().startswith("heading"):
        # Extract digits from the style name
        match = re.search(r'\d+', style_name)
        if match:
            try:
                lvl = int(match.group())
                if 1 <= lvl <= 9:
                    return lvl
            except ValueError:
                pass
    return None


def _table_summary(table, idx: int, max_rows_sample: int = 3) -> Dict[str, Any]:
    rows = list(table.rows)
    n_rows = len(rows)
    n_cols = max((len(r.cells) for r in rows), default=0)
    header = [c.text.strip() for c in rows[0].cells] if rows else []
    sample: List[List[str]] = []
    for row in rows[: max_rows_sample + 1]:  # +1 so header isn't the only row sampled
        sample.append([c.text.strip().replace("\n", " ") for c in row.cells])
    return {
        "index": idx,
        "rows": n_rows,
        "cols": n_cols,
        "header_row": header,
        "sample_rows": sample,
    }


def _extract_images_from_zip(path: Path, out_dir: Path) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    with zipfile.ZipFile(path) as zf:
        for name in zf.namelist():
            if name.startswith("word/media/"):
                blob = zf.read(name)
                ext = Path(name).suffix.lower().lstrip(".") or "bin"
                base = Path(name).name
                target = out_dir / base
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(blob)
                out.append({
                    "name": base,
                    "ext": ext,
                    "size_bytes": len(blob),
                    "saved_to": str(target),
                })
    return out


def _list_images_in_zip(path: Path) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    with zipfile.ZipFile(path) as zf:
        for info in zf.infolist():
            if info.filename.startswith("word/media/"):
                out.append({
                    "name": Path(info.filename).name,
                    "ext": Path(info.filename).suffix.lower().lstrip(".") or "bin",
                    "size_bytes": info.file_size,
                })
    return out


def _count_tracked_changes(path: Path) -> Dict[str, int]:
    """Count w:ins / w:del elements across document.xml, header*.xml, footer*.xml."""
    counts = {"insertions": 0, "deletions": 0, "moves": 0, "format_changes": 0}
    targets = ["word/document.xml"]
    extra_prefixes = ("word/header", "word/footer", "word/footnotes", "word/endnotes")
    try:
        with zipfile.ZipFile(path) as zf:
            for name in zf.namelist():
                if name in targets or any(name.startswith(p) for p in extra_prefixes):
                    if not name.endswith(".xml"):
                        continue
                    blob = zf.read(name).decode("utf-8", errors="ignore")
                    counts["insertions"] += blob.count("<w:ins ")
                    counts["deletions"] += blob.count("<w:del ")
                    counts["moves"] += blob.count("<w:moveFrom ") + blob.count("<w:moveTo ")
                    counts["format_changes"] += blob.count("<w:rPrChange ") + blob.count("<w:pPrChange ")
    except Exception:
        pass
    return counts


def _extract_comments(path: Path, max_comments: int = 50) -> List[Dict[str, Any]]:
    """Return up to `max_comments` items from word/comments.xml."""
    out: List[Dict[str, Any]] = []
    if etree is None:
        return out
    try:
        with zipfile.ZipFile(path) as zf:
            if "word/comments.xml" not in zf.namelist():
                return out
            xml = zf.read("word/comments.xml")
            root = etree.fromstring(xml)
            for c in root.findall(qn("w:comment"))[:max_comments]:
                cid = c.get(qn("w:id"))
                author = c.get(qn("w:author"))
                date = c.get(qn("w:date"))
                # collect text from descendant <w:t>
                text_parts = [t.text or "" for t in c.iter(qn("w:t"))]
                out.append({
                    "id": cid,
                    "author": author,
                    "date": date,
                    "text": "".join(text_parts),
                })
    except Exception as exc:
        # Log comment parsing failure but continue with other inspection tasks
        import sys
        print(f"Warning: Failed to parse comments from {path}: {exc}", file=sys.stderr)
    return out


def _styles_used(doc) -> List[str]:
    seen = set()
    for para in doc.paragraphs:
        try:
            seen.add(para.style.name)
        except Exception:
            pass
    for tbl in doc.tables:
        try:
            if tbl.style is not None:
                seen.add(tbl.style.name)
        except Exception:
            pass
    return sorted(seen)


def _iter_body_blocks(doc):
    """Yield body-level paragraphs and tables in document order."""
    body = doc.element.body
    # Build element-to-object mappings once for O(n) lookup
    para_map = {p._element: p for p in doc.paragraphs}
    table_map = {t._element: t for t in doc.tables}
    
    for child in body.iterchildren():
        tag = child.tag
        if tag == qn("w:p"):
            obj = para_map.get(child)
            if obj is not None:
                yield ("paragraph", obj)
        elif tag == qn("w:tbl"):
            obj = table_map.get(child)
            if obj is not None:
                yield ("table", obj)


def _has_field(para, name: str) -> bool:
    """Detect FIELD codes like TOC, PAGE, NUMPAGES inside a paragraph."""
    for fld in para._element.iter(qn("w:instrText")):
        if fld.text and name.upper() in fld.text.upper():
            return True
    for fld in para._element.iter(qn("w:fldSimple")):
        instr = fld.get(qn("w:instr")) or ""
        if name.upper() in instr.upper():
            return True
    return False


def inspect(input_path: Path, paragraphs_sample: int,
            extract_images: Optional[Path], text_only: bool) -> Dict[str, Any]:
    if not input_path.exists():
        raise FileNotFoundError(f"File not found: {input_path}")
    suffix = input_path.suffix.lower()
    if suffix not in (".docx", ".dotx"):
        raise ValueError(f"Unsupported extension: {suffix} (use .docx or .dotx). "
                         f"For legacy .doc files, run docx_convert.py doc2docx first.")

    doc = Document(str(input_path))

    # Sections / page setup
    sections_out = [_section_summary(s) for s in doc.sections]
    primary = sections_out[0] if sections_out else {}

    # Body iteration: paragraphs + tables in order
    body_items = list(_iter_body_blocks(doc))
    paragraph_count = sum(1 for k, _ in body_items if k == "paragraph")
    table_count = sum(1 for k, _ in body_items if k == "table")

    # Heading outline
    outline: List[Dict[str, Any]] = []
    paragraphs_sample_out: List[Dict[str, Any]] = []
    has_toc = False
    has_page_field = False
    p_idx = 0
    for kind, item in body_items:
        if kind != "paragraph":
            continue
        para = item
        lvl = _heading_level(para)
        if lvl is not None:
            outline.append({"level": lvl, "text": para.text.strip(), "index": p_idx})
        if not has_toc and _has_field(para, "TOC"):
            has_toc = True
        if not has_page_field and (_has_field(para, "PAGE") or _has_field(para, "NUMPAGES")):
            has_page_field = True
        if len(paragraphs_sample_out) < paragraphs_sample:
            txt = para.text or ""
            if txt.strip() or lvl is not None:
                paragraphs_sample_out.append({
                    "index": p_idx,
                    "style": (para.style.name if para.style else None),
                    "text": txt[:400],
                })
        p_idx += 1

    # Tables
    tables_out: List[Dict[str, Any]] = []
    if not text_only:
        for t_idx, tbl in enumerate(doc.tables):
            try:
                tables_out.append(_table_summary(tbl, t_idx))
            except Exception as exc:
                tables_out.append({"index": t_idx, "error": str(exc)})

    # Images (from raw zip; python-docx does not give a flat inventory)
    images_out: List[Dict[str, Any]] = []
    if not text_only:
        if extract_images is not None:
            extract_images.mkdir(parents=True, exist_ok=True)
            images_out = _extract_images_from_zip(input_path, extract_images)
        else:
            images_out = _list_images_in_zip(input_path)

    # Comments + tracked changes
    comments_out = _extract_comments(input_path)
    tracked = _count_tracked_changes(input_path)

    # Styles in use
    styles_used = _styles_used(doc)

    # Core properties
    core = doc.core_properties
    properties = {
        "title": core.title,
        "author": core.author,
        "subject": core.subject,
        "keywords": core.keywords,
        "comments": core.comments,
        "modified": str(core.modified) if core.modified else None,
        "revision": core.revision,
    }

    return {
        "file": str(input_path),
        "page_setup": primary,
        "section_count": len(sections_out),
        "sections": sections_out,
        "paragraph_count": paragraph_count,
        "table_count": table_count,
        "image_count": len(images_out),
        "heading_outline": outline,
        "tables": tables_out,
        "images": images_out,
        "comments": comments_out,
        "comment_count": len(comments_out),
        "tracked_changes": tracked,
        "has_toc_field": has_toc,
        "has_page_number_field": has_page_field,
        "styles_used": styles_used,
        "paragraphs_sample": paragraphs_sample_out,
        "properties": properties,
    }


def main() -> None:
    p = argparse.ArgumentParser(description="Inspect a .docx/.dotx Word document (JSON summary).")
    p.add_argument("--input", required=True)
    p.add_argument("--output", help="Write JSON here (default: stdout)")
    p.add_argument("--paragraphs-sample", type=int, default=30,
                   help="Max number of paragraph samples to include (default 30)")
    p.add_argument("--extract-images", help="Save embedded images to this directory")
    p.add_argument("--text-only", action="store_true",
                   help="Skip tables and images; report only paragraphs and headings")
    args = p.parse_args()

    extract_dir = Path(args.extract_images) if args.extract_images else None
    try:
        report = inspect(
            Path(args.input),
            paragraphs_sample=args.paragraphs_sample,
            extract_images=extract_dir,
            text_only=args.text_only,
        )
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)

    payload = json.dumps(report, indent=2, ensure_ascii=False, default=str)
    if args.output:
        out = Path(args.output)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(payload, encoding="utf-8")
        print(f"Inspection written -> {out}")
    else:
        print(payload)


if __name__ == "__main__":
    main()
