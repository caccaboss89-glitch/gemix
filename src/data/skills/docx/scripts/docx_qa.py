#!/usr/bin/env python3
"""Static QA checks on a .docx Word document without rendering.

Detects:
  CRITICAL (fix before delivery)
    - placeholder_text     leftover lorem/ipsum/tbd/todo/{{...}}/click here
    - tiny_font            text below --min-font-pt
    - low_contrast         text vs white background luma delta < threshold
    - image_missing_alt    image with no descr/title (alt-text)
    - image_distorted      image whose width/height ratio differs from the
                           natural ratio of the source bytes (tolerance ±5%)
    - table_overflow       sum(column widths) exceeds printable area
    - heading_skip         heading level jumped (e.g. H1 → H3 with no H2)
    - broken_image_path    referenced image relationship has no embedded blob
    - empty_required_block heading or cover_page title is blank
  WARNING (optional improvements)
    - long_paragraph       paragraph longer than --max-paragraph-chars
    - wide_table           table with > --max-table-cols columns
    - inconsistent_heading_font  heading uses a font ≠ the document's heading font
    - no_toc               5+ headings but no TOC field
    - unfilled_field       TOC/PAGE field present but never refreshed
"""
import argparse
import io
import json
import re
import sys
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from docx import Document
from docx.oxml.ns import qn

try:
    from PIL import Image as PILImage
except Exception:
    PILImage = None  # type: ignore


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

PLACEHOLDER_PATTERNS = [
    r"\blorem\b", r"\bipsum\b", r"\bxxxx+\b", r"\btbd\b", r"\btodo\b",
    r"\bplaceholder\b", r"\bclick\s+here\b", r"\binsert\s+(?:text|name)\b",
    r"\{\{[^}]+\}\}",  # unfilled mustache
]
PLACEHOLDER_RE = re.compile("|".join(PLACEHOLDER_PATTERNS), re.IGNORECASE)


# ── Color / luma helpers ───────────────────────────────────────────────────
def _hex_to_rgb(value: str) -> Tuple[int, int, int]:
    s = value.strip().lstrip("#")
    if len(s) != 6:
        return (0, 0, 0)
    try:
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
    except ValueError:
        return (0, 0, 0)


def _luma(rgb: Tuple[int, int, int]) -> float:
    r, g, b = (c / 255.0 for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


# ── Heading helpers ────────────────────────────────────────────────────────
def _heading_level(para) -> Optional[int]:
    style_name = (para.style.name if para.style else "") or ""
    if style_name.lower().startswith("heading"):
        tail = style_name.split()[-1] if " " in style_name else ""
        try:
            lvl = int(tail)
            if 1 <= lvl <= 9:
                return lvl
        except ValueError:
            pass
    return None


def _para_runs_with_size(para) -> List[Tuple[Any, Optional[float]]]:
    out: List[Tuple[Any, Optional[float]]] = []
    for run in para.runs:
        sz_pt = None
        try:
            if run.font.size is not None:
                sz_pt = run.font.size.pt
        except Exception:
            sz_pt = None
        out.append((run, sz_pt))
    return out


def _para_run_color(run) -> Optional[Tuple[int, int, int]]:
    try:
        rgb = run.font.color.rgb
        if rgb is None:
            return None
        return (rgb[0], rgb[1], rgb[2])
    except Exception:
        return None


def _para_run_font(run) -> Optional[str]:
    try:
        return run.font.name
    except Exception:
        return None


# ── Image inspection (raw zip, since python-docx doesn't expose alt-text directly) ─
def _enumerate_images(path: Path) -> List[Dict[str, Any]]:
    """Return one entry per <w:drawing> in the document body / headers / footers
    with: rel_id, embed_size_bytes, natural_w, natural_h, displayed_cx_emu,
    displayed_cy_emu, alt_descr, alt_title."""
    out: List[Dict[str, Any]] = []
    try:
        from lxml import etree  # pylint: disable=import-outside-toplevel
    except Exception:
        return out

    try:
        with zipfile.ZipFile(path) as zf:
            # Map of part_name -> rels {rel_id -> target}
            rels_cache: Dict[str, Dict[str, str]] = {}
            # Map of media name -> bytes
            media_cache: Dict[str, bytes] = {}
            for name in zf.namelist():
                if name.startswith("word/media/"):
                    media_cache[Path(name).name] = zf.read(name)

            def _load_rels(part_name: str) -> Dict[str, str]:
                if part_name in rels_cache:
                    return rels_cache[part_name]
                rels_path = "word/_rels/" + Path(part_name).name + ".rels"
                rels: Dict[str, str] = {}
                if rels_path in zf.namelist():
                    rels_xml = zf.read(rels_path)
                    rels_root = etree.fromstring(rels_xml)
                    for r in rels_root:
                        rels[r.get("Id")] = r.get("Target")
                rels_cache[part_name] = rels
                return rels

            targets = ["word/document.xml"]
            for n in zf.namelist():
                if (n.startswith("word/header") or n.startswith("word/footer")
                        or n.startswith("word/footnotes") or n.startswith("word/endnotes")) \
                        and n.endswith(".xml"):
                    targets.append(n)
            for tgt in targets:
                if tgt not in zf.namelist():
                    continue
                rels = _load_rels(tgt)
                xml = zf.read(tgt)
                root = etree.fromstring(xml)
                for drawing in root.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}drawing"):
                    # docPr → alt-text
                    descr = None
                    title = None
                    for el in drawing.iter():
                        if el.tag.endswith("}docPr"):
                            descr = el.get("descr")
                            title = el.get("title")
                            break
                    # extent (cx, cy in EMU)
                    cx = cy = None
                    for el in drawing.iter():
                        if el.tag.endswith("}extent"):
                            try:
                                cx = int(el.get("cx") or 0)
                                cy = int(el.get("cy") or 0)
                            except Exception:
                                pass
                            break
                    # blip embed id
                    rel_id = None
                    for el in drawing.iter():
                        if el.tag.endswith("}blip"):
                            rel_id = el.get(qn("r:embed"))
                            break
                    media_name = None
                    nat_w = nat_h = None
                    embed_size = None
                    if rel_id is not None and rel_id in rels:
                        rel_target = rels[rel_id]
                        media_name = Path(rel_target).name
                        if media_name in media_cache:
                            blob = media_cache[media_name]
                            embed_size = len(blob)
                            if PILImage is not None:
                                try:
                                    with PILImage.open(io.BytesIO(blob)) as img:
                                        nat_w, nat_h = img.size
                                except Exception:
                                    nat_w = nat_h = None
                    out.append({
                        "part": tgt,
                        "rel_id": rel_id,
                        "media": media_name,
                        "embed_size_bytes": embed_size,
                        "natural_w": nat_w,
                        "natural_h": nat_h,
                        "displayed_cx_emu": cx,
                        "displayed_cy_emu": cy,
                        "alt_descr": descr,
                        "alt_title": title,
                    })
    except Exception:
        return out
    return out


# ── Field detection ────────────────────────────────────────────────────────
def _has_any_field(doc, name: str) -> bool:
    name_upper = name.upper()
    for fld in doc.element.iter(qn("w:instrText")):
        if fld.text and name_upper in fld.text.upper():
            return True
    for fld in doc.element.iter(qn("w:fldSimple")):
        instr = fld.get(qn("w:instr")) or ""
        if name_upper in instr.upper():
            return True
    return False


def _has_unrefreshed_field(path: Path) -> bool:
    """A TOC/PAGE field that's never been resolved is just <w:fldChar
    w:fldCharType='begin'/> followed immediately by <w:instrText>...</w:instrText>
    and <w:fldChar w:fldCharType='end'/>, with no separate text run between
    'separate' and 'end'. This is hard to detect 100% reliably, so we just
    flag any TOC field code: it always needs refresh on first open."""
    try:
        with zipfile.ZipFile(path) as zf:
            if "word/document.xml" not in zf.namelist():
                return False
            xml = zf.read("word/document.xml").decode("utf-8", errors="ignore")
            return "TOC " in xml or "TOC\\" in xml
    except Exception:
        return False


def _printable_width_in(doc) -> Optional[float]:
    try:
        sec = doc.sections[0]
        return round(((sec.page_width or 0) - (sec.left_margin or 0) - (sec.right_margin or 0)) / 914400.0, 3)
    except Exception:
        return None


def _table_total_width_in(table) -> Optional[float]:
    try:
        # Look for tblGrid for explicit column widths (DXA twips)
        grid = table._element.find(qn("w:tblGrid"))
        if grid is not None:
            total = 0
            cols = grid.findall(qn("w:gridCol"))
            for col in cols:
                w = col.get(qn("w:w"))
                if w is not None and w.isdigit():
                    total += int(w)
            if total > 0:
                return round(total / 1440.0, 3)
    except Exception:
        pass
    return None


# ── QA core ────────────────────────────────────────────────────────────────
def qa(input_path: Path, *, min_font_pt: float, contrast_threshold: float,
       max_table_cols: int, max_paragraph_chars: int) -> Dict[str, Any]:
    if not input_path.exists():
        raise FileNotFoundError(f"File not found: {input_path}")
    suffix = input_path.suffix.lower()
    if suffix not in (".docx", ".dotx"):
        raise ValueError(f"Unsupported extension: {suffix} (use .docx or .dotx).")

    doc = Document(str(input_path))
    issues: List[Dict[str, Any]] = []
    warnings: List[Dict[str, Any]] = []

    # Stats counters
    paragraph_count = 0
    heading_count = 0
    table_count = len(doc.tables)
    image_count = 0
    section_count = len(doc.sections)
    comment_count = 0
    try:
        with zipfile.ZipFile(input_path) as zf:
            if "word/comments.xml" in zf.namelist():
                comment_count = zf.read("word/comments.xml").decode("utf-8", errors="ignore").count("<w:comment ")
    except Exception:
        comment_count = 0

    # Background color (assume white if unset; sections rarely change it)
    bg_rgb = (255, 255, 255)
    bg_luma = _luma(bg_rgb)

    # Detect document's heading font (mode of all heading runs)
    heading_fonts: Dict[str, int] = {}
    for para in doc.paragraphs:
        if _heading_level(para) is None:
            continue
        for run in para.runs:
            font = _para_run_font(run)
            if font:
                heading_fonts[font] = heading_fonts.get(font, 0) + 1
    expected_heading_font = max(heading_fonts, key=heading_fonts.get) if heading_fonts else None

    # Walk paragraphs
    last_heading_level = 0
    placeholder_locations: List[Dict[str, Any]] = []
    for p_idx, para in enumerate(doc.paragraphs):
        paragraph_count += 1
        text = para.text or ""

        lvl = _heading_level(para)
        if lvl is not None:
            heading_count += 1
            if not text.strip():
                issues.append({
                    "type": "empty_required_block",
                    "severity": "critical",
                    "location": f"p#{p_idx}",
                    "message": f"Heading {lvl} is empty.",
                })
            if last_heading_level > 0 and lvl > last_heading_level + 1:
                issues.append({
                    "type": "heading_skip",
                    "severity": "critical",
                    "location": f"p#{p_idx}",
                    "message": f"Heading level jumped from H{last_heading_level} to H{lvl}.",
                    "text_sample": text[:80],
                })
            last_heading_level = lvl
            # Inconsistent heading font (warning)
            if expected_heading_font is not None:
                for run in para.runs:
                    font = _para_run_font(run)
                    if font and font != expected_heading_font and (run.text or "").strip():
                        warnings.append({
                            "type": "inconsistent_heading_font",
                            "severity": "warning",
                            "location": f"p#{p_idx}",
                            "message": f"Heading uses font '{font}', expected '{expected_heading_font}'.",
                            "text_sample": run.text[:60],
                        })
                        break  # one per heading is enough

        # Placeholder text
        m = PLACEHOLDER_RE.search(text)
        if m:
            issues.append({
                "type": "placeholder_text",
                "severity": "critical",
                "location": f"p#{p_idx}",
                "match": m.group(0),
                "text_sample": text[:160],
            })
            placeholder_locations.append({"location": f"p#{p_idx}", "match": m.group(0)})

        # Long paragraph (warning)
        if len(text) > max_paragraph_chars:
            warnings.append({
                "type": "long_paragraph",
                "severity": "info",
                "location": f"p#{p_idx}",
                "message": f"Paragraph length {len(text)} > {max_paragraph_chars} chars.",
            })

        # Tiny / low-contrast runs
        for run, sz_pt in _para_runs_with_size(para):
            text_run = (run.text or "")
            if not text_run.strip():
                continue
            if sz_pt is not None and sz_pt < min_font_pt:
                issues.append({
                    "type": "tiny_font",
                    "severity": "critical",
                    "location": f"p#{p_idx}",
                    "size_pt": sz_pt,
                    "min_pt": min_font_pt,
                    "text_sample": text_run[:60],
                })
            rgb = _para_run_color(run)
            if rgb is not None:
                if abs(_luma(rgb) - bg_luma) < contrast_threshold:
                    issues.append({
                        "type": "low_contrast",
                        "severity": "critical",
                        "location": f"p#{p_idx}",
                        "text_rgb": list(rgb),
                        "background_rgb": list(bg_rgb),
                        "text_sample": text_run[:60],
                    })

        # Same checks inside table cells in this paragraph's vicinity? handled below.

    # Walk tables
    printable_w_in = _printable_width_in(doc)
    for t_idx, tbl in enumerate(doc.tables):
        n_cols = max((len(r.cells) for r in tbl.rows), default=0)
        if n_cols > max_table_cols:
            warnings.append({
                "type": "wide_table",
                "severity": "warning",
                "location": f"table#{t_idx}",
                "message": f"Table has {n_cols} columns (max recommended {max_table_cols}).",
            })
        total_w_in = _table_total_width_in(tbl)
        if total_w_in is not None and printable_w_in is not None:
            if total_w_in > printable_w_in + 0.05:
                issues.append({
                    "type": "table_overflow",
                    "severity": "critical",
                    "location": f"table#{t_idx}",
                    "table_width_in": total_w_in,
                    "printable_width_in": printable_w_in,
                    "message": f"Table width {total_w_in}\" > printable area {printable_w_in}\".",
                })
        # Walk cells for placeholder + tiny text
        for r_idx, row in enumerate(tbl.rows):
            for c_idx, cell in enumerate(row.cells):
                txt = cell.text or ""
                m = PLACEHOLDER_RE.search(txt)
                if m:
                    issues.append({
                        "type": "placeholder_text",
                        "severity": "critical",
                        "location": f"table#{t_idx}!{r_idx}.{c_idx}",
                        "match": m.group(0),
                        "text_sample": txt[:160],
                    })
                for para in cell.paragraphs:
                    for run, sz_pt in _para_runs_with_size(para):
                        text_run = run.text or ""
                        if not text_run.strip():
                            continue
                        if sz_pt is not None and sz_pt < min_font_pt:
                            issues.append({
                                "type": "tiny_font",
                                "severity": "critical",
                                "location": f"table#{t_idx}!{r_idx}.{c_idx}",
                                "size_pt": sz_pt,
                                "min_pt": min_font_pt,
                                "text_sample": text_run[:60],
                            })

    # Images
    images = _enumerate_images(input_path)
    image_count = len(images)
    for i, img in enumerate(images):
        # Missing alt-text
        if not (img.get("alt_descr") or img.get("alt_title")):
            issues.append({
                "type": "image_missing_alt",
                "severity": "critical",
                "location": f"image#{i}",
                "media": img.get("media"),
                "message": "Image has no alt-text (descr/title attribute on docPr).",
            })
        # Distortion
        nat_w = img.get("natural_w")
        nat_h = img.get("natural_h")
        cx = img.get("displayed_cx_emu")
        cy = img.get("displayed_cy_emu")
        if nat_w and nat_h and cx and cy:
            nat_ratio = nat_h / nat_w
            disp_ratio = cy / cx
            if nat_ratio > 0:
                delta = abs(disp_ratio - nat_ratio) / nat_ratio
                if delta > 0.05:
                    issues.append({
                        "type": "image_distorted",
                        "severity": "critical",
                        "location": f"image#{i}",
                        "media": img.get("media"),
                        "natural_ratio": round(nat_ratio, 3),
                        "displayed_ratio": round(disp_ratio, 3),
                        "deviation_pct": round(delta * 100, 1),
                        "message": "Displayed aspect ratio differs from the source image's natural ratio by >5%.",
                    })
        # Broken path: missing media file
        if img.get("rel_id") and not img.get("media"):
            issues.append({
                "type": "broken_image_path",
                "severity": "critical",
                "location": f"image#{i}",
                "message": "Image relationship has no embedded blob.",
            })

    # TOC presence vs heading count
    if heading_count >= 5 and not _has_any_field(doc, "TOC"):
        warnings.append({
            "type": "no_toc",
            "severity": "info",
            "message": f"Document has {heading_count} headings but no TOC field — consider adding a `toc` block.",
        })

    if _has_unrefreshed_field(input_path):
        warnings.append({
            "type": "unfilled_field",
            "severity": "info",
            "message": "Document contains a TOC/PAGE field that needs to be refreshed by Word/LibreOffice on open. "
                       "Run docx_convert.py docx2pdf to auto-refresh into a PDF.",
        })

    total_issues = sum(1 for i in issues if i.get("severity") == "critical")
    total_warnings = len(warnings)
    return {
        "file": str(input_path),
        "status": "passed" if total_issues == 0 else "issues_found",
        "total_issues": total_issues,
        "total_warnings": total_warnings,
        "issues": issues,
        "warnings": warnings,
        "stats": {
            "paragraph_count": paragraph_count,
            "heading_count": heading_count,
            "table_count": table_count,
            "image_count": image_count,
            "comment_count": comment_count,
            "section_count": section_count,
            "printable_width_in": printable_w_in,
            "expected_heading_font": expected_heading_font,
        },
    }


def main() -> None:
    p = argparse.ArgumentParser(description="Static QA on a .docx (no rendering).")
    p.add_argument("--input", required=True)
    p.add_argument("--output", help="Write JSON here (default: stdout)")
    p.add_argument("--min-font-pt", type=float, default=10.0)
    p.add_argument("--contrast-threshold", type=float, default=0.25,
                   help="Luma delta below which body text is flagged low_contrast (0..1)")
    p.add_argument("--max-table-cols", type=int, default=12)
    p.add_argument("--max-paragraph-chars", type=int, default=4000)
    args = p.parse_args()

    try:
        report = qa(
            Path(args.input),
            min_font_pt=args.min_font_pt,
            contrast_threshold=args.contrast_threshold,
            max_table_cols=args.max_table_cols,
            max_paragraph_chars=args.max_paragraph_chars,
        )
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)

    payload = json.dumps(report, indent=2, ensure_ascii=False, default=str)
    if args.output:
        out = Path(args.output)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(payload, encoding="utf-8")
        print(f"QA report written -> {out}  (status={report['status']}, "
              f"issues={report['total_issues']}, warnings={report['total_warnings']})")
    else:
        print(payload)


if __name__ == "__main__":
    main()
