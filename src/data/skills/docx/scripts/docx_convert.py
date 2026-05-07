#!/usr/bin/env python3
"""Convert .doc/.docx files to other formats.

Sub-commands:
  doc2docx   -> Legacy .doc → .docx (REQUIRED before python-docx can open .doc)
  docx2pdf   -> .docx → .pdf via LibreOffice headless (auto-refreshes TOC/PAGE fields)
  docx2text  -> Lossy markdown-style text extraction (headings, paragraphs, tables, lists)
  docx2html  -> .docx → .html via LibreOffice headless

LibreOffice conversions use an isolated --user-profile so multiple soffice
calls in the same kernel session do not collide on the X/Unix socket.
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
import zipfile
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from docx import Document
from docx.oxml.ns import qn


def _check_bin(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise RuntimeError(f"Required binary '{name}' not found in PATH.")
    return path


def _libreoffice_convert(input_path: Path, output_path: Path, *,
                         to_format: str, expected_ext: str, timeout: int) -> Path:
    """Convert via LibreOffice headless to the requested format.

    Args:
      to_format: argument for `--convert-to` (e.g. 'docx', 'pdf', 'html').
      expected_ext: expected output extension including the dot (e.g. '.pdf').
    """
    if not input_path.exists():
        raise FileNotFoundError(f"Input not found: {input_path}")
    if output_path.suffix.lower() != expected_ext:
        raise ValueError(f"Output must end with {expected_ext} (got {output_path.suffix})")

    soffice = _check_bin("soffice")
    work_dir = Path(tempfile.mkdtemp(prefix=f"docx_convert_{to_format}_"))
    try:
        profile = work_dir / f"lo_profile_{uuid.uuid4().hex}"
        profile.mkdir(parents=True, exist_ok=True)
        cmd = [
            soffice,
            f"-env:UserInstallation=file://{profile}",
            "--headless",
            "--norestore",
            "--nolockcheck",
            "--convert-to", to_format,
            "--outdir", str(work_dir),
            str(input_path),
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"soffice timeout after {timeout}s")
        if proc.returncode != 0:
            raise RuntimeError(
                f"soffice failed (rc={proc.returncode}):\n"
                f"STDOUT: {proc.stdout}\nSTDERR: {proc.stderr}"
            )

        produced = work_dir / (input_path.stem + expected_ext)
        if not produced.exists():
            candidates = list(work_dir.glob(f"*{expected_ext}"))
            if not candidates:
                raise RuntimeError(f"No {expected_ext} produced by soffice.")
            produced = candidates[0]

        output_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(produced, output_path)
        return output_path
    finally:
        try:
            shutil.rmtree(work_dir)
        except Exception:
            pass


# ── doc → docx ─────────────────────────────────────────────────────────────
def doc2docx(input_doc: Path, output_docx: Path, timeout: int) -> Path:
    if input_doc.suffix.lower() not in (".doc", ".rtf"):
        raise ValueError(f"Expected .doc or .rtf (got {input_doc.suffix})")
    return _libreoffice_convert(
        input_doc, output_docx,
        to_format="docx",
        expected_ext=".docx",
        timeout=timeout,
    )


# ── docx → pdf ─────────────────────────────────────────────────────────────
def docx2pdf(input_docx: Path, output_pdf: Path, timeout: int) -> Path:
    if input_docx.suffix.lower() not in (".docx", ".dotx"):
        raise ValueError(f"Expected .docx/.dotx (got {input_docx.suffix})")
    return _libreoffice_convert(
        input_docx, output_pdf,
        to_format="pdf",
        expected_ext=".pdf",
        timeout=timeout,
    )


# ── docx → html ────────────────────────────────────────────────────────────
def docx2html(input_docx: Path, output_html: Path, timeout: int) -> Path:
    if input_docx.suffix.lower() not in (".docx", ".dotx"):
        raise ValueError(f"Expected .docx/.dotx (got {input_docx.suffix})")
    return _libreoffice_convert(
        input_docx, output_html,
        to_format="html",
        expected_ext=".html",
        timeout=timeout,
    )


# ── docx → markdown text ───────────────────────────────────────────────────
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


def _is_list_paragraph(para) -> Tuple[bool, str, int]:
    """Return (is_list, kind, level). kind ∈ 'bullet', 'number'."""
    style_name = (para.style.name if para.style else "") or ""
    s = style_name.lower()
    is_bullet = "bullet" in s
    is_number = "number" in s
    if is_bullet or is_number:
        # Try to extract level from style name suffix
        level = 0
        m = re.search(r"\d+$", style_name)
        if m:
            level = max(0, int(m.group(0)) - 1)
        return (True, "number" if is_number else "bullet", level)
    # Check numPr presence too (manual numbering)
    pPr = para._element.find(qn("w:pPr"))
    if pPr is not None and pPr.find(qn("w:numPr")) is not None:
        return (True, "number", 0)
    # Not a list paragraph
    return (False, "", 0)


def _para_to_md(para) -> List[str]:
    text = (para.text or "").rstrip()
    if not text:
        return [""]
    lvl = _heading_level(para)
    if lvl is not None:
        return [f"{'#' * lvl} {text}"]
    is_list, kind, level = _is_list_paragraph(para)
    if is_list:
        indent = "  " * level
        marker = "1." if kind == "number" else "-"
        return [f"{indent}{marker} {text}"]
    return [text]


def _table_to_md(table) -> List[str]:
    rows = list(table.rows)
    if not rows:
        return []
    n_cols = max((len(r.cells) for r in rows), default=0)
    if n_cols == 0:
        return []
    out: List[str] = [""]
    header_cells = [c.text.strip().replace("\n", " ").replace("|", "\\|")
                    for c in rows[0].cells]
    while len(header_cells) < n_cols:
        header_cells.append("")
    out.append("| " + " | ".join(header_cells) + " |")
    out.append("| " + " | ".join(["---"] * n_cols) + " |")
    for row in rows[1:]:
        cells = [c.text.strip().replace("\n", " ").replace("|", "\\|")
                 for c in row.cells]
        while len(cells) < n_cols:
            cells.append("")
        out.append("| " + " | ".join(cells) + " |")
    out.append("")
    return out


def _iter_body_blocks_in_order(doc):
    """Yield ('paragraph', para_obj) and ('table', table_obj) in document order."""
    body = doc.element.body
    para_iter = iter(doc.paragraphs)
    table_iter = iter(doc.tables)
    para_map = {p._element: p for p in doc.paragraphs}
    table_map = {t._element: t for t in doc.tables}
    for child in body.iterchildren():
        if child.tag == qn("w:p"):
            obj = para_map.get(child)
            if obj is not None:
                yield ("paragraph", obj)
        elif child.tag == qn("w:tbl"):
            obj = table_map.get(child)
            if obj is not None:
                yield ("table", obj)


def _extract_image_refs(input_path: Path, out_dir: Path) -> Dict[str, str]:
    """Save every embedded image to out_dir; return rel_target → relative path."""
    mapping: Dict[str, str] = {}
    if not out_dir.exists():
        out_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(input_path) as zf:
        for name in zf.namelist():
            if name.startswith("word/media/"):
                blob = zf.read(name)
                base = Path(name).name
                target = out_dir / base
                target.write_bytes(blob)
                mapping[name] = str(target)
    return mapping


def docx2text(input_docx: Path, output_md: Path,
              include_images_as_refs: bool) -> Path:
    if not input_docx.exists():
        raise FileNotFoundError(f"Input not found: {input_docx}")
    if input_docx.suffix.lower() not in (".docx", ".dotx"):
        raise ValueError(f"Expected .docx/.dotx (got {input_docx.suffix})")

    doc = Document(str(input_docx))
    title = doc.core_properties.title or input_docx.stem

    lines: List[str] = []
    lines.append(f"# {title}")
    lines.append("")

    image_dir: Optional[Path] = None
    image_map: Dict[str, str] = {}
    if include_images_as_refs:
        image_dir = output_md.parent / (output_md.stem + "_images")
        image_map = _extract_image_refs(input_docx, image_dir)

    img_seen = 0
    for kind, item in _iter_body_blocks_in_order(doc):
        if kind == "paragraph":
            lines.extend(_para_to_md(item))
            # Inline image refs (best-effort detection: any <w:drawing> in this paragraph)
            if include_images_as_refs:
                drawings = item._element.findall(".//" + qn("w:drawing"))
                for _ in drawings:
                    img_seen += 1
                    # Just emit a placeholder pointing into the extracted dir
                    if image_dir is not None and img_seen <= len(image_map):
                        # Pair drawings with extracted media in document order — rough, but useful
                        media_paths = sorted(image_map.values())
                        if img_seen - 1 < len(media_paths):
                            ref = Path(media_paths[img_seen - 1]).name
                            lines.append(f"![image{img_seen}]({image_dir.name}/{ref})")
        elif kind == "table":
            lines.extend(_table_to_md(item))

    output_md.parent.mkdir(parents=True, exist_ok=True)
    output_md.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    return output_md


# ── CLI ────────────────────────────────────────────────────────────────────
def main() -> None:
    p = argparse.ArgumentParser(description="Convert .doc/.docx to other formats.")
    sub = p.add_subparsers(dest="action", required=True)

    p_d2d = sub.add_parser("doc2docx", help="Convert legacy .doc/.rtf -> .docx via LibreOffice headless")
    p_d2d.add_argument("--input", required=True)
    p_d2d.add_argument("--output", required=True)
    p_d2d.add_argument("--timeout", type=int, default=120)

    p_pdf = sub.add_parser("docx2pdf", help="Convert .docx -> .pdf via LibreOffice headless")
    p_pdf.add_argument("--input", required=True)
    p_pdf.add_argument("--output", required=True)
    p_pdf.add_argument("--timeout", type=int, default=120)

    p_html = sub.add_parser("docx2html", help="Convert .docx -> .html via LibreOffice headless")
    p_html.add_argument("--input", required=True)
    p_html.add_argument("--output", required=True)
    p_html.add_argument("--timeout", type=int, default=120)

    p_txt = sub.add_parser("docx2text", help="Extract a markdown-like transcript")
    p_txt.add_argument("--input", required=True)
    p_txt.add_argument("--output", required=True)
    p_txt.add_argument("--include-images-as-refs", action="store_true",
                       help="Extract embedded images and write Markdown image references")

    args = p.parse_args()

    try:
        if args.action == "doc2docx":
            res = doc2docx(Path(args.input), Path(args.output), timeout=args.timeout)
            print(json.dumps({"action": "doc2docx", "output": str(res)}, indent=2))
        elif args.action == "docx2pdf":
            res = docx2pdf(Path(args.input), Path(args.output), timeout=args.timeout)
            print(json.dumps({"action": "docx2pdf", "output": str(res)}, indent=2))
        elif args.action == "docx2html":
            res = docx2html(Path(args.input), Path(args.output), timeout=args.timeout)
            print(json.dumps({"action": "docx2html", "output": str(res)}, indent=2))
        elif args.action == "docx2text":
            res = docx2text(Path(args.input), Path(args.output),
                            include_images_as_refs=args.include_images_as_refs)
            print(json.dumps({"action": "docx2text", "output": str(res)}, indent=2))
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
