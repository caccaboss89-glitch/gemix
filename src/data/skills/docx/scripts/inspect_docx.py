"""Inspect a .docx / .dotx document with python-docx.

read_file does NOT work on .docx/.dotx (it fails on those types), so use this
to see a document's structure before editing it: page setup, sections, styles,
paragraphs (with their style), tables (dimensions + cell text), headers/footers,
and embedded images.

Usage:
    python /skills/docx/scripts/inspect_docx.py /workspace/document.docx
    python /skills/docx/scripts/inspect_docx.py /workspace/document.docx --text     # full paragraph list
    python /skills/docx/scripts/inspect_docx.py /workspace/document.docx --tables    # detailed table dump

Notes:
    - For a .doc or legacy file, convert it first with convert_doc.py --to docx.
    - For a visual overview of the rendered pages, use render_doc.py.
"""

import argparse
import sys
from pathlib import Path

from docx import Document
from docx.shared import Emu


def _emu_to_inches(value) -> float:
    if value is None:
        return 0.0
    try:
        return Emu(value).inches
    except Exception:
        return 0.0


def inspect_sections(doc) -> str:
    lines = ["\n=== Sections ==="]
    for idx, section in enumerate(doc.sections):
        w = _emu_to_inches(section.page_width)
        h = _emu_to_inches(section.page_height)
        orient = "landscape" if w > h else "portrait"
        paper = ""
        # A4: 8.27 x 11.69 in (either orientation)
        dims = sorted([round(w, 1), round(h, 1)])
        if dims == [8.3, 11.7]:
            paper = " (A4)"
        elif dims == [8.5, 11.0]:
            paper = " (Letter)"
        m_top = _emu_to_inches(section.top_margin)
        m_bot = _emu_to_inches(section.bottom_margin)
        m_left = _emu_to_inches(section.left_margin)
        m_right = _emu_to_inches(section.right_margin)
        lines.append(
            f'  [{idx}] {w:.1f}"x{h:.1f}" {orient}{paper}  '
            f'margins: t={m_top:.1f}" b={m_bot:.1f}" l={m_left:.1f}" r={m_right:.1f}"  '
            f"start={section.start_type}"
        )
    return "\n".join(lines)


def inspect_styles(doc) -> str:
    lines = ["\n=== Styles in use ==="]
    used = {}
    for p in doc.paragraphs:
        name = p.style.name if p.style else "(none)"
        used[name] = used.get(name, 0) + 1
    for name in sorted(used):
        lines.append(f"  {name:30s} {used[name]} paragraph(s)")
    return "\n".join(lines)


def inspect_content(doc, show_text: bool = False) -> str:
    lines = ["\n=== Content Summary ==="]
    paragraphs = doc.paragraphs
    tables = doc.tables
    lines.append(f"  Paragraphs: {len(paragraphs)}")
    lines.append(f"  Tables: {len(tables)}")

    # Inline images
    img_count = len(doc.inline_shapes)
    lines.append(f"  Inline images/shapes: {img_count}")

    nonempty = [(i, p) for i, p in enumerate(paragraphs) if p.text.strip()]
    if nonempty:
        preview = " | ".join(p.text.strip() for _, p in nonempty[:8])
        if len(preview) > 200:
            preview = preview[:197] + "..."
        lines.append(f'  Text preview: "{preview}"')

    if show_text:
        lines.append(f"\n  --- Paragraphs ({len(nonempty)} non-empty) ---")
        MAX_ITEMS = 120
        for i, p in nonempty[:MAX_ITEMS]:
            txt = p.text.strip()
            if len(txt) > 90:
                txt = txt[:87] + "..."
            style = p.style.name if p.style else ""
            lines.append(f"  [{i:3d}] ({style}) {txt}")
        if len(nonempty) > MAX_ITEMS:
            lines.append(f"  ... and {len(nonempty) - MAX_ITEMS} more")

    return "\n".join(lines)


def inspect_tables(doc, detailed: bool = False) -> str:
    tables = doc.tables
    if not tables:
        return "\n=== Tables ===\n  (no tables found)"

    lines = [f"\n=== Tables ({len(tables)}) ==="]
    for t_idx, table in enumerate(tables):
        n_rows = len(table.rows)
        n_cols = len(table.columns) if table.rows else 0
        lines.append(f"\n  Table {t_idx} ({n_rows} rows x {n_cols} cols)")

        max_rows = n_rows if detailed else min(n_rows, 8)
        for r_idx in range(max_rows):
            row = table.rows[r_idx]
            parts = []
            for c_idx, cell in enumerate(row.cells):
                txt = cell.text.strip().replace("\n", " ")
                if len(txt) > 20:
                    txt = txt[:17] + "..."
                parts.append(f'[{r_idx},{c_idx}] "{txt}"')
            line = "    " + "  ".join(f"{p:24s}" for p in parts)
            lines.append(line.rstrip())
        if not detailed and n_rows > 8:
            lines.append(f"    ... and {n_rows - 8} more rows")

    return "\n".join(lines)


def inspect_headers_footers(doc) -> str:
    lines = ["\n=== Headers & Footers ==="]
    found = False
    for idx, section in enumerate(doc.sections):
        for label, hf in (("header", section.header), ("footer", section.footer)):
            if hf is None or hf.is_linked_to_previous:
                continue
            text = " | ".join(p.text.strip() for p in hf.paragraphs if p.text.strip())
            if text:
                found = True
                if len(text) > 100:
                    text = text[:97] + "..."
                lines.append(f'  section {idx} {label}: "{text}"')
    if not found:
        lines.append("  (no header/footer text, or linked to previous)")
    return "\n".join(lines)


if __name__ == "__main__":
    import signal

    if hasattr(signal, "SIGPIPE"):
        signal.signal(signal.SIGPIPE, signal.SIG_DFL)

    parser = argparse.ArgumentParser(description="Inspect a .docx/.dotx document with python-docx.")
    parser.add_argument("docx_file", help="Path to a .docx or .dotx file")
    parser.add_argument("--text", action="store_true", help="List all non-empty paragraphs")
    parser.add_argument("--tables", action="store_true", help="Dump every table row in full")
    args = parser.parse_args()

    path = Path(args.docx_file)
    if not path.is_file():
        print(f"Error: {path} not found", file=sys.stderr)
        sys.exit(1)
    if path.suffix.lower() not in (".docx", ".dotx"):
        print(
            f"Error: {path} is not a .docx/.dotx file. "
            f"Convert a legacy .doc first with convert_doc.py --to docx.",
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        doc = Document(str(path))
    except Exception as e:
        print(f"Error opening {path}: {e}", file=sys.stderr)
        sys.exit(1)

    print(inspect_sections(doc))
    print(inspect_styles(doc))
    print(inspect_content(doc, show_text=args.text))
    print(inspect_tables(doc, detailed=args.tables))
    print(inspect_headers_footers(doc))
