#!/usr/bin/env python3
"""Build a .docx Word document from a JSON spec.

A document is described by a JSON spec containing:
  - top-level page setup (page_size, orientation, margins_in, theme, defaults,
    properties, header, footer, page_numbers, different_first_page)
  - either a flat ``blocks`` list (single-section document) or a ``sections``
    list (multi-section / multi-column / per-section header-footer documents)

Block catalog:
  heading, paragraph, list, table, image, page_break, divider, callout, toc,
  quote, code_block, kpi_grid, signature_block, table_of_figures, cover_page.

Color values inside any block accept either a 6-char hex (`RRGGBB`) **or** a
theme token name (`accent`, `accent_dark`, `surface`, `surface_alt`,
`title_color`, `body_color`, `muted`, `success`, `warning`, `danger`,
`on_accent`, `background`).

Coordinates / sizes are in INCHES.
"""
import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

# Word unit conversion constants
TWIPS_PER_INCH = 1440  # 1 inch = 1440 twips (twentieths of a point)
EMU_PER_INCH = 914400  # 1 inch = 914400 EMUs (English Metric Units)

from PIL import Image as PILImage

from docx import Document
from docx.document import Document as DocumentObject
from docx.enum.section import WD_ORIENTATION, WD_SECTION
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_LINE_SPACING
from docx.oxml import OxmlElement
from docx.oxml.ns import nsmap, qn
from docx.shared import Inches, Pt, RGBColor


# ── Built-in themes (semantic tokens) ──────────────────────────────────────
THEMES: Dict[str, Dict[str, str]] = {
    "corporate": {
        "background": "FFFFFF", "surface": "F8FAFC", "surface_alt": "E2E8F0",
        "title_color": "0F172A", "body_color": "1F2937", "muted": "64748B",
        "accent": "2563EB", "accent_dark": "1E40AF",
        "success": "10B981", "warning": "F59E0B", "danger": "DC2626",
        "on_accent": "FFFFFF", "font_name": "Calibri",
        "heading_font": "Calibri",
    },
    "executive": {
        "background": "FFFFFF", "surface": "F1F5F9", "surface_alt": "E2E8F0",
        "title_color": "0B1220", "body_color": "1F2937", "muted": "475569",
        "accent": "0F766E", "accent_dark": "134E4A",
        "success": "15803D", "warning": "B45309", "danger": "B91C1C",
        "on_accent": "FFFFFF", "font_name": "Garamond",
        "heading_font": "Garamond",
    },
    "academic": {
        "background": "FFFFFF", "surface": "F8F8F4", "surface_alt": "E7E5E4",
        "title_color": "1F1B16", "body_color": "292524", "muted": "78716C",
        "accent": "7C3AED", "accent_dark": "5B21B6",
        "success": "15803D", "warning": "B45309", "danger": "B91C1C",
        "on_accent": "FFFFFF", "font_name": "Times New Roman",
        "heading_font": "Times New Roman",
    },
    "minimal": {
        "background": "FFFFFF", "surface": "FAFAFA", "surface_alt": "EEEEEE",
        "title_color": "111827", "body_color": "374151", "muted": "6B7280",
        "accent": "111827", "accent_dark": "000000",
        "success": "10B981", "warning": "F59E0B", "danger": "DC2626",
        "on_accent": "FFFFFF", "font_name": "Helvetica",
        "heading_font": "Helvetica",
    },
    "modern": {
        "background": "FFFFFF", "surface": "F8FAFC", "surface_alt": "E0F2FE",
        "title_color": "0F172A", "body_color": "1F2937", "muted": "64748B",
        "accent": "0EA5E9", "accent_dark": "0369A1",
        "success": "10B981", "warning": "F59E0B", "danger": "DC2626",
        "on_accent": "FFFFFF", "font_name": "Calibri",
        "heading_font": "Calibri",
    },
}

DEFAULT_BODY_SIZE = 11
DEFAULT_TITLE_SIZE = 28
DEFAULT_HEADING_SIZES = {1: 22, 2: 16, 3: 13, 4: 12, 5: 11, 6: 11, 7: 11, 8: 11, 9: 11}

PAGE_SIZES_IN: Dict[str, Tuple[float, float]] = {
    "letter":  (8.5, 11.0),
    "legal":   (8.5, 14.0),
    "a4":      (8.27, 11.69),
    "a5":      (5.83, 8.27),
    "tabloid": (11.0, 17.0),
}

CALLOUT_PRESETS: Dict[str, Dict[str, str]] = {
    "info":    {"icon": "ℹ", "fill": "surface_alt", "fg": "title_color", "border_color": "accent"},
    "success": {"icon": "✓", "fill": "surface_alt", "fg": "title_color", "border_color": "success"},
    "warning": {"icon": "⚠", "fill": "surface_alt", "fg": "title_color", "border_color": "warning"},
    "danger":  {"icon": "✗", "fill": "surface_alt", "fg": "title_color", "border_color": "danger"},
    "note":    {"icon": "✎", "fill": "surface_alt", "fg": "muted",       "border_color": "muted"},
}


# ── Color / font helpers ───────────────────────────────────────────────────
def _hex_to_rgb(value: str) -> RGBColor:
    s = (value or "").strip().lstrip("#")
    if len(s) != 6:
        raise ValueError(f"Invalid color '{value}': expected RRGGBB hex.")
    return RGBColor(int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))


def _resolve_color(theme: Dict[str, Any], value: Any) -> Optional[str]:
    """Return a 6-char hex string (no `#`). Accepts hex, '#RRGGBB', or theme token."""
    if value is None or value is False:
        return None
    if isinstance(value, str):
        v = value.strip().lstrip("#")
        if v in theme:
            token_val = theme[v]
            if isinstance(token_val, str):
                return token_val.lstrip("#")
            raise ValueError(f"Theme token '{v}' is not a string: {type(token_val).__name__}")
        if len(v) == 6 and all(c in "0123456789abcdefABCDEF" for c in v):
            return v.upper()
        # Fall through: invalid string → raise
    raise ValueError(f"Unsupported color value: {value!r}")


def _resolve_theme(spec: Dict[str, Any]) -> Dict[str, Any]:
    name = (spec.get("theme") or "corporate").lower()
    base = dict(THEMES.get(name, THEMES["corporate"]))
    overrides = spec.get("defaults") or {}
    for k, v in overrides.items():
        if v is not None:
            base[k] = v
    base.setdefault("body_size", DEFAULT_BODY_SIZE)
    base.setdefault("title_size", DEFAULT_TITLE_SIZE)
    return base


# ── Page setup ─────────────────────────────────────────────────────────────
def _resolve_page_size(value: Any) -> Tuple[float, float]:
    if isinstance(value, dict):
        w = float(value.get("width_in") or 0)
        h = float(value.get("height_in") or 0)
        if w <= 0 or h <= 0:
            raise ValueError(f"page_size object must have positive width_in/height_in: {value!r}")
        return (w, h)
    name = (value or "a4").strip().lower() if isinstance(value, str) else "a4"
    if name not in PAGE_SIZES_IN:
        raise ValueError(f"Unsupported page_size '{value}'. "
                         f"Use one of {sorted(PAGE_SIZES_IN)} or {{width_in, height_in}}.")
    return PAGE_SIZES_IN[name]


def _apply_section_setup(section, spec: Dict[str, Any]) -> None:
    """Apply page_size, orientation, margins, columns, header/footer settings."""
    width_in, height_in = _resolve_page_size(spec.get("page_size", "a4"))
    orientation = (spec.get("orientation") or "portrait").lower()
    if orientation == "landscape":
        section.orientation = WD_ORIENTATION.LANDSCAPE
        section.page_width = Inches(max(width_in, height_in))
        section.page_height = Inches(min(width_in, height_in))
    else:
        section.orientation = WD_ORIENTATION.PORTRAIT
        section.page_width = Inches(min(width_in, height_in))
        section.page_height = Inches(max(width_in, height_in))

    margins = spec.get("margins_in") or {}
    section.top_margin = Inches(margins.get("top", 1.0))
    section.right_margin = Inches(margins.get("right", 1.0))
    section.bottom_margin = Inches(margins.get("bottom", 1.0))
    section.left_margin = Inches(margins.get("left", 1.0))
    if "header" in margins:
        section.header_distance = Inches(margins["header"])
    if "footer" in margins:
        section.footer_distance = Inches(margins["footer"])

    # Columns
    try:
        cols = int(spec.get("columns") or 1)
    except (ValueError, TypeError):
        cols = 1
    # Always remove existing <w:cols/> to ensure clean state
    sectPr = section._sectPr
    for existing in sectPr.findall(qn("w:cols")):
        sectPr.remove(existing)
    if cols > 1:
        cols_el = OxmlElement("w:cols")
        cols_el.set(qn("w:num"), str(cols))
        space_in = float(spec.get("column_space_in") or 0.5)
        cols_el.set(qn("w:space"), str(int(space_in * TWIPS_PER_INCH)))
        if spec.get("column_separator"):
            cols_el.set(qn("w:sep"), "1")
        sectPr.append(cols_el)
    else:
        # Explicitly set single column to reset from previous multi-column sections
        cols_el = OxmlElement("w:cols")
        cols_el.set(qn("w:num"), "1")
        sectPr.append(cols_el)

    # Different first page header/footer
    if spec.get("different_first_page"):
        section.different_first_page_header_footer = True


# ── Run / paragraph helpers ────────────────────────────────────────────────
def _set_run_font(run, theme: Dict[str, Any], font_name: Optional[str],
                  size_pt: Optional[float], color_hex: Optional[str]) -> None:
    if font_name:
        run.font.name = font_name
        # Force complex-script & east-asian font fallback to the same font
        rPr = run._element.get_or_add_rPr()
        rFonts = rPr.find(qn("w:rFonts"))
        if rFonts is None:
            rFonts = OxmlElement("w:rFonts")
            rPr.insert(0, rFonts)
        for attr in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
            rFonts.set(qn(attr), font_name)
    if size_pt:
        run.font.size = Pt(float(size_pt))
    if color_hex:
        run.font.color.rgb = _hex_to_rgb(color_hex)


def _add_run_field(paragraph, instr: str) -> None:
    """Insert a Word field code (e.g., 'PAGE', 'NUMPAGES', 'DATE')."""
    fld = OxmlElement("w:fldSimple")
    fld.set(qn("w:instr"), instr)
    r = OxmlElement("w:r")
    t = OxmlElement("w:t")
    t.text = ""
    r.append(t)
    fld.append(r)
    paragraph._element.append(fld)


def _add_hyperlink(paragraph, url: str, text: str, theme: Dict[str, Any],
                   font_name: Optional[str], size_pt: Optional[float],
                   color_hex: Optional[str], bold: bool, italic: bool, underline: bool) -> None:
    part = paragraph.part
    try:
        rid = part.relate_to(url,
                             "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
                             is_external=True)
    except Exception as exc:
        raise ValueError(f"Failed to create hyperlink for URL '{url}': {exc}") from exc
    hyperlink = OxmlElement("w:hyperlink")
    hyperlink.set(qn("r:id"), rid)
    new_run = OxmlElement("w:r")
    rPr = OxmlElement("w:rPr")
    # Resolve color: use explicit hex, theme token, or fallback to default blue
    if color_hex:
        color_to_use = _resolve_color(theme, color_hex)
    elif theme.get("accent"):
        color_to_use = _resolve_color(theme, theme["accent"])
    else:
        color_to_use = "0563C1"  # Word default hyperlink blue
    color_el = OxmlElement("w:color")
    color_el.set(qn("w:val"), color_to_use.lstrip("#"))
    rPr.append(color_el)
    if underline:
        u = OxmlElement("w:u")
        u.set(qn("w:val"), "single")
        rPr.append(u)
    if bold:
        rPr.append(OxmlElement("w:b"))
    if italic:
        rPr.append(OxmlElement("w:i"))
    if size_pt:
        sz = OxmlElement("w:sz")
        sz.set(qn("w:val"), str(int(float(size_pt) * 2)))
        rPr.append(sz)
    if font_name:
        rFonts = OxmlElement("w:rFonts")
        for attr in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
            rFonts.set(qn(attr), font_name)
        rPr.append(rFonts)
    new_run.append(rPr)
    t = OxmlElement("w:t")
    t.set(qn("xml:space"), "preserve")
    t.text = text
    new_run.append(t)
    hyperlink.append(new_run)
    paragraph._element.append(hyperlink)


def _alignment_enum(value: Optional[str]) -> Optional[WD_ALIGN_PARAGRAPH]:
    if not value:
        return None
    mapping = {
        "left": WD_ALIGN_PARAGRAPH.LEFT,
        "center": WD_ALIGN_PARAGRAPH.CENTER,
        "centre": WD_ALIGN_PARAGRAPH.CENTER,
        "right": WD_ALIGN_PARAGRAPH.RIGHT,
        "justify": WD_ALIGN_PARAGRAPH.JUSTIFY,
        "both": WD_ALIGN_PARAGRAPH.JUSTIFY,
    }
    return mapping.get(value.lower())


# Field tokens we resolve inline inside run text:
FIELD_TOKENS = {
    "{PAGE}":  "PAGE",
    "{PAGES}": "NUMPAGES",
    "{DATE}":  'DATE \\@ "yyyy-MM-dd"',
    "{TIME}":  'TIME \\@ "HH:mm"',
}


def _add_runs(paragraph, runs: Sequence[Dict[str, Any]], theme: Dict[str, Any],
              default_font: str, default_size: float, default_color: str) -> None:
    """Append rich runs to a paragraph. Supports text, bold, italic, underline,
    strike, color, size, font, highlight, hyperlink, subscript/superscript and
    field tokens like {PAGE} / {PAGES} / {DATE} / {TIME}."""
    for spec in runs:
        if isinstance(spec, str):
            spec = {"text": spec}
        text = spec.get("text", "")
        # Hyperlink path
        if spec.get("hyperlink"):
            _add_hyperlink(
                paragraph,
                url=spec["hyperlink"],
                text=text or spec["hyperlink"],
                theme=theme,
                font_name=spec.get("font") or default_font,
                size_pt=spec.get("size") or default_size,
                color_hex=_resolve_color(theme, spec.get("color")) if spec.get("color") else None,
                bold=bool(spec.get("bold")),
                italic=bool(spec.get("italic")),
                underline=spec.get("underline", True),  # links default to underlined
            )
            continue

        # Field token shortcut: replace {PAGE}/{PAGES}/{DATE}/{TIME}
        if text in FIELD_TOKENS:
            _add_run_field(paragraph, FIELD_TOKENS[text])
            continue

        run = paragraph.add_run(text)
        if spec.get("bold"):
            run.bold = True
        if spec.get("italic"):
            run.italic = True
        if spec.get("underline"):
            run.underline = True
        if spec.get("strike"):
            run.font.strike = True
        if spec.get("subscript"):
            run.font.subscript = True
        if spec.get("superscript"):
            run.font.superscript = True
        if spec.get("highlight"):
            # Highlight colors use Word's predefined color names (not hex/theme tokens)
            # Valid values: AUTO, BLACK, BLUE, BRIGHT_GREEN, DARK_BLUE, DARK_RED, DARK_YELLOW, GRAY_25, GRAY_50, GREEN, PINK, RED, TEAL, TURQUOISE, VIOLET, WHITE, YELLOW
            try:
                from docx.enum.text import WD_COLOR_INDEX  # pylint: disable=import-outside-toplevel
                color_name = spec["highlight"].upper()
                if hasattr(WD_COLOR_INDEX, color_name):
                    run.font.highlight_color = getattr(WD_COLOR_INDEX, color_name)
            except Exception:
                pass
        font_name = spec.get("font") or default_font
        size_pt = spec.get("size") or default_size
        color_resolved = _resolve_color(theme, spec.get("color")) if spec.get("color") else default_color
        _set_run_font(run, theme, font_name, size_pt, color_resolved)


def _apply_paragraph_properties(paragraph, spec: Dict[str, Any]) -> None:
    align = _alignment_enum(spec.get("align"))
    if align is not None:
        paragraph.alignment = align
    pf = paragraph.paragraph_format
    if "indent_in" in spec:
        pf.left_indent = Inches(float(spec["indent_in"]))
    if "right_indent_in" in spec:
        pf.right_indent = Inches(float(spec["right_indent_in"]))
    if "first_line_in" in spec:
        pf.first_line_indent = Inches(float(spec["first_line_in"]))
    if "space_before_pt" in spec:
        pf.space_before = Pt(float(spec["space_before_pt"]))
    if "space_after_pt" in spec:
        pf.space_after = Pt(float(spec["space_after_pt"]))
    if "line_spacing" in spec:
        pf.line_spacing = float(spec["line_spacing"])
    if spec.get("page_break_before"):
        pf.page_break_before = True
    if spec.get("keep_together"):
        pf.keep_together = True
    if spec.get("keep_with_next"):
        pf.keep_with_next = True


# ── Block renderers ────────────────────────────────────────────────────────
def _render_heading(container, block: Dict[str, Any], theme: Dict[str, Any]) -> None:
    text = block.get("text", "")
    try:
        level = int(block.get("level") or 1)
    except (ValueError, TypeError):
        level = 1
    if level < 1:
        level = 1
    if level > 9:
        level = 9
    if hasattr(container, "add_heading"):
        para = container.add_heading(level=level)
    else:
        para = container.add_paragraph()
        para.style = container.part.document.styles[f"Heading {level}"]
    # Remove auto-generated runs (add_heading inserts an empty one)
    for r in list(para.runs):
        r._element.getparent().remove(r._element)

    size = float(block.get("size") or DEFAULT_HEADING_SIZES.get(level, DEFAULT_BODY_SIZE))
    color = _resolve_color(theme, block.get("color") or "title_color")
    font = block.get("font") or theme.get("heading_font") or theme.get("font_name")
    bold = block.get("bold", True if level <= 3 else None)
    italic = block.get("italic", False)

    runs: List[Dict[str, Any]] = [{
        "text": text,
        "bold": bold,
        "italic": italic,
        "color": color,
        "size": size,
        "font": font,
    }]
    _add_runs(para, runs, theme, default_font=font, default_size=size, default_color=color)
    _apply_paragraph_properties(para, block)


def _render_paragraph(container, block: Dict[str, Any], theme: Dict[str, Any]) -> None:
    para = container.add_paragraph()
    if block.get("style"):
        try:
            para.style = container.part.document.styles[block["style"]]
        except KeyError:
            pass

    default_font = theme.get("font_name") or "Calibri"
    default_size = float(block.get("size") or theme.get("body_size", DEFAULT_BODY_SIZE))
    default_color = _resolve_color(theme, block.get("color") or "body_color")

    runs = block.get("runs")
    if runs is None:
        text = block.get("text", "")
        if text:
            runs = [{"text": text}]
        else:
            runs = []
    if not isinstance(runs, list):
        raise ValueError("paragraph.runs must be a list")
    _add_runs(para, runs, theme, default_font, default_size, default_color)
    _apply_paragraph_properties(para, block)


def _render_list(container, block: Dict[str, Any], theme: Dict[str, Any]) -> None:
    style_kind = (block.get("style") or "bullet").lower()
    style_map = {
        "bullet": "List Bullet",
        "number": "List Number",
        "check":  "List Bullet",  # fallback; we'll prepend a check char
    }
    style_name = style_map.get(style_kind, "List Bullet")
    items = block.get("items") or []
    default_font = theme.get("font_name") or "Calibri"
    default_size = float(block.get("size") or theme.get("body_size", DEFAULT_BODY_SIZE))
    default_color = _resolve_color(theme, block.get("color") or "body_color")

    for item in items:
        if isinstance(item, str):
            item = {"text": item}
        text = item.get("text", "")
        level = int(item.get("level") or 0)
        actual_style = style_name
        if level > 0:
            # Try Heading-style sub-list (List Bullet 2/3/...)
            for candidate in (f"{style_name} {level + 1}", style_name):
                if candidate in [s.name for s in container.part.document.styles]:
                    actual_style = candidate
                    break
        para = container.add_paragraph(style=actual_style)
        if style_kind == "check":
            text = "☑ " + text  # visual check; numbering remains bullet
        runs = item.get("runs")
        if runs is None and text:
            runs = [{
                "text": text,
                "bold": item.get("bold"),
                "color": _resolve_color(theme, item.get("color")) if item.get("color") else None,
            }]
        _add_runs(para, runs or [], theme, default_font, default_size, default_color)


def _set_cell_borders(cell, *, style: str = "single", size_pt: float = 0.5,
                      color_hex: str = "BFBFBF", which: str = "all") -> None:
    """Apply borders to a single cell. `which` ∈ all|none|outer|<side-list>."""
    tcPr = cell._tc.get_or_add_tcPr()
    tcBorders = tcPr.find(qn("w:tcBorders"))
    if tcBorders is None:
        tcBorders = OxmlElement("w:tcBorders")
        tcPr.append(tcBorders)
    sides = {"top", "left", "bottom", "right"}
    requested = set()
    if which == "all" or which == "outer":
        requested = sides
    elif which == "none":
        requested = sides
        style = "nil"
    elif isinstance(which, (list, tuple, set)):
        requested = set(s for s in which if s in sides)
    else:
        requested = {which} if which in sides else sides
    for side in sides:
        existing = tcBorders.find(qn(f"w:{side}"))
        if existing is not None:
            tcBorders.remove(existing)
        if side not in requested:
            continue
        b = OxmlElement(f"w:{side}")
        b.set(qn("w:val"), style)
        b.set(qn("w:sz"), str(int(max(2, size_pt * 8))))
        b.set(qn("w:space"), "0")
        b.set(qn("w:color"), color_hex.lstrip("#"))
        tcBorders.append(b)


def _shade_cell(cell, color_hex: str) -> None:
    tcPr = cell._tc.get_or_add_tcPr()
    shd = tcPr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tcPr.append(shd)
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), color_hex.lstrip("#"))


def _set_cell_padding(cell, top_in: float, left_in: float, bottom_in: float, right_in: float) -> None:
    tcPr = cell._tc.get_or_add_tcPr()
    tcMar = tcPr.find(qn("w:tcMar"))
    if tcMar is None:
        tcMar = OxmlElement("w:tcMar")
        tcPr.append(tcMar)
    for side, value in (("top", top_in), ("left", left_in),
                        ("bottom", bottom_in), ("right", right_in)):
        el = tcMar.find(qn(f"w:{side}"))
        if el is None:
            el = OxmlElement(f"w:{side}")
            tcMar.append(el)
        el.set(qn("w:w"), str(int(value * TWIPS_PER_INCH)))
        el.set(qn("w:type"), "dxa")


def _set_cell_text(cell, text: str, theme: Dict[str, Any], *,
                   bold: bool = False, italic: bool = False, font_name: Optional[str] = None,
                   size_pt: Optional[float] = None, color_hex: Optional[str] = None,
                   align: Optional[str] = None) -> None:
    cell.text = ""  # clear default run
    if not cell.paragraphs:
        cell.add_paragraph()  # Ensure at least one paragraph exists
    para = cell.paragraphs[0]
    if align:
        a = _alignment_enum(align)
        if a is not None:
            para.alignment = a
    run = para.add_run(text)
    if bold:
        run.bold = True
    if italic:
        run.italic = True
    _set_run_font(run, theme, font_name, size_pt, color_hex)


def _repeat_table_header(row) -> None:
    trPr = row._tr.get_or_add_trPr()
    tblHeader = OxmlElement("w:tblHeader")
    tblHeader.set(qn("w:val"), "true")
    trPr.append(tblHeader)


def _render_table(container, block: Dict[str, Any], theme: Dict[str, Any]) -> None:
    headers = block.get("headers") or []
    rows = block.get("rows") or []
    if not headers and not rows:
        raise ValueError("table block requires `headers` or `rows`.")

    n_cols = max(len(headers), max((len(r) for r in rows), default=0))
    n_data_rows = len(rows)
    has_header = bool(headers)
    total_rows = n_data_rows + (1 if has_header else 0)

    table = container.add_table(rows=total_rows, cols=n_cols)
    table.autofit = False
    align = (block.get("align") or "left").lower()
    if align == "center":
        table.alignment = WD_TABLE_ALIGNMENT.CENTER
    elif align == "right":
        table.alignment = WD_TABLE_ALIGNMENT.RIGHT
    else:
        table.alignment = WD_TABLE_ALIGNMENT.LEFT

    column_widths = block.get("column_widths_in") or []
    if column_widths:
        if len(column_widths) != n_cols:
            print(f"Warning: column_widths_in has {len(column_widths)} values but table has {n_cols} columns. Widths will not be applied.", file=sys.stderr)
        else:
            for col_idx, w in enumerate(column_widths):
                for row in table.rows:
                    row.cells[col_idx].width = Inches(float(w))
            table.width = Inches(sum(float(x) for x in column_widths))

    # Borders
    borders_spec = block.get("borders") or {}
    border_style = "single"
    border_size_pt = 0.5
    border_color = _resolve_color(theme, borders_spec.get("color") or "muted")
    if border_color is None:
        border_color = "BFBFBF"
    which = "all"
    if borders_spec.get("none"):
        which = "none"
    elif borders_spec.get("all"):
        which = "all"
        thickness = borders_spec.get("all")
        if thickness in ("thin", "medium", "thick"):
            border_size_pt = {"thin": 0.5, "medium": 1.0, "thick": 1.5}[thickness]
    elif "thickness_pt" in borders_spec:
        border_size_pt = float(borders_spec["thickness_pt"])

    cell_pad = block.get("cell_padding_in") or {}
    pad_top = float(cell_pad.get("top", 0.05))
    pad_bot = float(cell_pad.get("bottom", 0.05))
    pad_left = float(cell_pad.get("left", 0.08))
    pad_right = float(cell_pad.get("right", 0.08))

    body_size = float(block.get("body_size") or theme.get("body_size", DEFAULT_BODY_SIZE))
    body_color = _resolve_color(theme, block.get("body_color") or "body_color")
    font = theme.get("font_name") or "Calibri"

    header_fill = _resolve_color(theme, block.get("header_fill") or "accent") if has_header else None
    header_fg = _resolve_color(theme, block.get("header_fg") or "on_accent") if has_header else None
    header_align = block.get("header_align") or align
    body_align = align

    zebra = bool(block.get("zebra"))
    zebra_fill = _resolve_color(theme, block.get("zebra_color") or "surface")

    # Header row
    if has_header:
        hdr_row = table.rows[0]
        for col_idx in range(n_cols):
            cell = hdr_row.cells[col_idx]
            text = headers[col_idx] if col_idx < len(headers) else ""
            _set_cell_text(cell, str(text), theme,
                           bold=True, font_name=font,
                           size_pt=body_size,
                           color_hex=header_fg,
                           align=header_align)
            cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
            if header_fill:
                _shade_cell(cell, header_fill)
            _set_cell_borders(cell, style=border_style, size_pt=border_size_pt,
                              color_hex=border_color, which=which)
            _set_cell_padding(cell, pad_top, pad_left, pad_bot, pad_right)
        if block.get("repeat_header", True):
            _repeat_table_header(hdr_row)

    # Data rows
    for row_idx, row in enumerate(rows):
        target_row = table.rows[row_idx + (1 if has_header else 0)]
        for col_idx in range(n_cols):
            cell = target_row.cells[col_idx]
            cell_value = row[col_idx] if col_idx < len(row) else ""
            cell_obj = cell_value if isinstance(cell_value, dict) else {"text": str(cell_value)}
            text = cell_obj.get("text", "")
            cell_align = cell_obj.get("align") or body_align
            cell_bold = cell_obj.get("bold", False)
            cell_color = _resolve_color(theme, cell_obj.get("color")) if cell_obj.get("color") else body_color
            cell_fill = _resolve_color(theme, cell_obj.get("fill")) if cell_obj.get("fill") else None
            _set_cell_text(cell, text, theme,
                           bold=cell_bold, font_name=font,
                           size_pt=body_size,
                           color_hex=cell_color,
                           align=cell_align)
            cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
            fill_to_use = cell_fill
            if fill_to_use is None and zebra and (row_idx % 2 == 1):
                fill_to_use = zebra_fill
            if fill_to_use:
                _shade_cell(cell, fill_to_use)
            _set_cell_borders(cell, style=border_style, size_pt=border_size_pt,
                              color_hex=border_color, which=which)
            _set_cell_padding(cell, pad_top, pad_left, pad_bot, pad_right)

    # Cell merges: list of [r1, c1, r2, c2] (1-based, inclusive; r=0 means header row)
    for merge_spec in block.get("merge_cells") or []:
        r1, c1, r2, c2 = merge_spec
        # 1-based: r1=1 → header (if present) or first data row.
        a = table.cell(max(0, r1 - 1), max(0, c1 - 1))
        b = table.cell(max(0, r2 - 1), max(0, c2 - 1))
        a.merge(b)


def _natural_size(image_path: Path) -> Tuple[int, int]:
    with PILImage.open(str(image_path)) as img:
        return img.size  # (width, height) in pixels


def _render_image(container, block: Dict[str, Any], theme: Dict[str, Any]) -> None:
    path = block.get("path")
    if not path:
        raise ValueError("image block requires `path`.")
    img_path = Path(path)
    if not img_path.exists():
        raise FileNotFoundError(f"Image not found: {img_path}")

    width_in = block.get("width_in")
    height_in = block.get("height_in")
    nat_w, nat_h = _natural_size(img_path)
    
    if nat_w == 0 or nat_h == 0:
        raise ValueError(f"Image has invalid dimensions: {nat_w}x{nat_h} pixels")
    
    nat_ratio = nat_h / nat_w

    # Auto-compute missing dimension to preserve aspect ratio
    if width_in and not height_in:
        height_in = round(float(width_in) * nat_ratio, 4)
    elif height_in and not width_in:
        width_in = round(float(height_in) / nat_ratio, 4)
    elif not width_in and not height_in:
        # Default: 6 inches wide capped by page sense
        width_in = 6.0
        height_in = round(width_in * nat_ratio, 4)

    para = container.add_paragraph()
    align = _alignment_enum(block.get("align") or "center")
    if align is not None:
        para.alignment = align
    run = para.add_run()
    if block.get("alt_text"):
        # python-docx's add_picture has no native alt-text; we set descr/title via XML below
        run.add_picture(str(img_path), width=Inches(float(width_in)), height=Inches(float(height_in)))
        # Patch alt-text on the inserted drawing
        try:
            drawing = run._element.find(qn("w:drawing"))
            if drawing is not None:
                docPr = drawing.find(".//" + qn("wp:docPr"), namespaces=nsmap)
                # nsmap may not contain 'wp'; fall back to any docPr in the subtree
                if docPr is None:
                    for el in drawing.iter():
                        if el.tag.endswith("}docPr"):
                            docPr = el
                            break
                if docPr is not None:
                    docPr.set("descr", block["alt_text"])
                    docPr.set("title", block.get("alt_text_title", block["alt_text"][:80]))
        except Exception:
            pass
    else:
        run.add_picture(str(img_path), width=Inches(float(width_in)), height=Inches(float(height_in)))

    caption = block.get("caption")
    if caption:
        cap_para = container.add_paragraph()
        cap_align = _alignment_enum(block.get("caption_align") or "center")
        if cap_align is not None:
            cap_para.alignment = cap_align
        cap_run = cap_para.add_run(caption)
        cap_run.italic = True
        _set_run_font(cap_run, theme,
                      theme.get("font_name") or "Calibri",
                      max(9, float(theme.get("body_size", DEFAULT_BODY_SIZE)) - 1),
                      _resolve_color(theme, "muted"))


def _render_page_break(container, block: Dict[str, Any], theme: Dict[str, Any]) -> None:
    para = container.add_paragraph()
    run = para.add_run()
    run.add_break(WD_BREAK.PAGE)


def _render_divider(container, block: Dict[str, Any], theme: Dict[str, Any]) -> None:
    para = container.add_paragraph()
    pPr = para._element.get_or_add_pPr()
    pBdr = pPr.find(qn("w:pBdr"))
    if pBdr is None:
        pBdr = OxmlElement("w:pBdr")
        pPr.append(pBdr)
    bottom = OxmlElement("w:bottom")
    thickness = float(block.get("thickness_pt") or 0.75)
    color_hex = _resolve_color(theme, block.get("color") or "muted") or "BFBFBF"
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), str(int(max(4, thickness * 8))))
    bottom.set(qn("w:space"), "1")
    bottom.set(qn("w:color"), color_hex.lstrip("#"))
    pBdr.append(bottom)
    pf = para.paragraph_format
    if "space_before_pt" in block:
        pf.space_before = Pt(float(block["space_before_pt"]))
    if "space_after_pt" in block:
        pf.space_after = Pt(float(block["space_after_pt"]))


def _render_callout(container, block: Dict[str, Any], theme: Dict[str, Any]) -> None:
    kind = (block.get("kind") or "info").lower()
    preset = CALLOUT_PRESETS.get(kind, CALLOUT_PRESETS["info"])
    fill = _resolve_color(theme, block.get("fill") or preset["fill"])
    fg = _resolve_color(theme, block.get("fg") or preset["fg"])
    border_color = _resolve_color(theme, block.get("border_color") or preset["border_color"])
    icon = block.get("icon", preset["icon"])
    padding_in = float(block.get("padding_in") or 0.1)

    # 1-row 2-col table: icon | text
    table = container.add_table(rows=1, cols=2)
    table.autofit = False
    icon_w = 0.45
    text_w = 5.6
    table.width = Inches(icon_w + text_w)
    table.rows[0].cells[0].width = Inches(icon_w)
    table.rows[0].cells[1].width = Inches(text_w)

    # Icon cell
    icon_cell = table.rows[0].cells[0]
    _set_cell_text(icon_cell, str(icon), theme,
                   bold=True, font_name=theme.get("font_name") or "Calibri",
                   size_pt=14, color_hex=_resolve_color(theme, preset.get("border_color", "muted")),
                   align="center")
    icon_cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
    if fill:
        _shade_cell(icon_cell, fill)
    _set_cell_borders(icon_cell, color_hex=border_color or "BFBFBF",
                      size_pt=1.0, which=("top", "left", "bottom"))
    _set_cell_padding(icon_cell, padding_in, padding_in, padding_in, padding_in)

    # Text cell
    text_cell = table.rows[0].cells[1]
    text_cell.text = ""
    para = text_cell.paragraphs[0]
    para.alignment = _alignment_enum(block.get("align") or "left") or WD_ALIGN_PARAGRAPH.LEFT
    if fill:
        _shade_cell(text_cell, fill)
    _set_cell_borders(text_cell, color_hex=border_color or "BFBFBF",
                      size_pt=1.0, which=("top", "right", "bottom"))
    _set_cell_padding(text_cell, padding_in, padding_in, padding_in, padding_in)
    text_cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER

    default_font = theme.get("font_name") or "Calibri"
    default_size = float(block.get("size") or theme.get("body_size", DEFAULT_BODY_SIZE))
    default_color = fg

    runs = block.get("runs")
    if runs is None:
        lines = block.get("lines")
        if lines:
            for i, line in enumerate(lines):
                if i > 0:
                    para = text_cell.add_paragraph()
                    para.alignment = _alignment_enum(block.get("align") or "left") or WD_ALIGN_PARAGRAPH.LEFT
                if isinstance(line, str):
                    line = {"text": line}
                _add_runs(para, [line], theme, default_font, default_size, default_color)
        else:
            text = block.get("text", "")
            _add_runs(para, [{"text": text}], theme, default_font, default_size, default_color)
    else:
        _add_runs(para, runs, theme, default_font, default_size, default_color)


def _render_quote(container, block: Dict[str, Any], theme: Dict[str, Any]) -> None:
    text = block.get("text", "")
    citation = block.get("citation")
    accent = _resolve_color(theme, block.get("accent_color") or "accent") or "2563EB"
    para = container.add_paragraph()
    pPr = para._element.get_or_add_pPr()
    # left border
    pBdr = pPr.find(qn("w:pBdr"))
    if pBdr is None:
        pBdr = OxmlElement("w:pBdr")
        pPr.append(pBdr)
    left = OxmlElement("w:left")
    left.set(qn("w:val"), "single")
    left.set(qn("w:sz"), "24")
    left.set(qn("w:space"), "10")
    left.set(qn("w:color"), accent)
    pBdr.append(left)
    pf = para.paragraph_format
    pf.left_indent = Inches(0.3)
    pf.space_before = Pt(6)
    pf.space_after = Pt(6)
    run = para.add_run(text)
    run.italic = True
    _set_run_font(run, theme,
                  theme.get("font_name") or "Calibri",
                  float(theme.get("body_size", DEFAULT_BODY_SIZE)),
                  _resolve_color(theme, "body_color"))
    if citation:
        cite_para = container.add_paragraph()
        cite_para.paragraph_format.left_indent = Inches(0.3)
        cite_run = cite_para.add_run(f"— {citation}")
        cite_run.italic = True
        _set_run_font(cite_run, theme,
                      theme.get("font_name") or "Calibri",
                      max(9, float(theme.get("body_size", DEFAULT_BODY_SIZE)) - 1),
                      _resolve_color(theme, "muted"))


def _render_code_block(container, block: Dict[str, Any], theme: Dict[str, Any]) -> None:
    text = block.get("text", "")
    fill = _resolve_color(theme, block.get("fill") or "surface_alt") or "F1F5F9"
    fg = _resolve_color(theme, block.get("fg") or "title_color")
    font_size = float(block.get("font_size") or 9.5)
    # Single-cell table for the shaded background
    table = container.add_table(rows=1, cols=1)
    table.autofit = False
    cell = table.rows[0].cells[0]
    _set_cell_text(cell, "", theme)  # clear
    _shade_cell(cell, fill)
    _set_cell_borders(cell, color_hex="E5E7EB", size_pt=0.25, which="all")
    _set_cell_padding(cell, 0.06, 0.1, 0.06, 0.1)

    para = cell.paragraphs[0]
    for i, line in enumerate(text.split("\n")):
        if i > 0:
            para = cell.add_paragraph()
        run = para.add_run(line if line else " ")
        run.font.name = "Consolas"
        rPr = run._element.get_or_add_rPr()
        rFonts = rPr.find(qn("w:rFonts"))
        if rFonts is None:
            rFonts = OxmlElement("w:rFonts")
            rPr.insert(0, rFonts)
        for attr in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
            rFonts.set(qn(attr), "Consolas")
        run.font.size = Pt(font_size)
        if fg:
            run.font.color.rgb = _hex_to_rgb(fg)


def _render_toc(container, block: Dict[str, Any], theme: Dict[str, Any]) -> None:
    title = block.get("title")
    if title:
        # Use heading 1 size unless overridden, but render as a "toc heading"
        heading_block = {"text": title, "level": 1, "color": block.get("title_color")}
        _render_heading(container, heading_block, theme)
    levels = block.get("levels") or [1, 2, 3]
    if isinstance(levels, list):
        lo = min(levels)
        hi = max(levels)
    else:
        lo, hi = 1, 3
    hyperlink = bool(block.get("hyperlink", True))
    instr = f' TOC \\o "{lo}-{hi}" '
    if hyperlink:
        instr += "\\h \\z \\u "

    para = container.add_paragraph()
    # Build the field via begin/separate/end runs so Word/LibreOffice update it
    r_begin = OxmlElement("w:r")
    fld_begin = OxmlElement("w:fldChar")
    fld_begin.set(qn("w:fldCharType"), "begin")
    r_begin.append(fld_begin)
    para._element.append(r_begin)

    r_instr = OxmlElement("w:r")
    instr_el = OxmlElement("w:instrText")
    instr_el.set(qn("xml:space"), "preserve")
    instr_el.text = instr
    r_instr.append(instr_el)
    para._element.append(r_instr)

    r_sep = OxmlElement("w:r")
    fld_sep = OxmlElement("w:fldChar")
    fld_sep.set(qn("w:fldCharType"), "separate")
    r_sep.append(fld_sep)
    para._element.append(r_sep)

    # Placeholder text shown until the field is updated
    # This must be regular text (w:t) between separate and end for LibreOffice to update
    r_placeholder = OxmlElement("w:r")
    t_placeholder = OxmlElement("w:t")
    t_placeholder.set(qn("xml:space"), "preserve")
    t_placeholder.text = "Right-click and select 'Update Field' to populate the table of contents."
    r_placeholder.append(t_placeholder)
    para._element.append(r_placeholder)

    r_end = OxmlElement("w:r")
    fld_end = OxmlElement("w:fldChar")
    fld_end.set(qn("w:fldCharType"), "end")
    r_end.append(fld_end)
    para._element.append(r_end)


def _render_kpi_grid(container, block: Dict[str, Any], theme: Dict[str, Any]) -> None:
    items = block.get("items") or []
    try:
        columns = int(block.get("columns") or min(4, max(1, len(items))))
    except (ValueError, TypeError):
        columns = min(4, max(1, len(items)))
    if not items:
        return
    rows = (len(items) + columns - 1) // columns
    table = container.add_table(rows=rows, cols=columns)
    table.autofit = False

    cell_fill = _resolve_color(theme, "surface")
    border_color = _resolve_color(theme, "surface_alt")
    label_color = _resolve_color(theme, "muted")
    value_color_default = _resolve_color(theme, "title_color")
    delta_color_default = _resolve_color(theme, "accent")

    for idx, item in enumerate(items):
        r = idx // columns
        c = idx % columns
        cell = table.rows[r].cells[c]
        cell.text = ""
        if cell_fill:
            _shade_cell(cell, cell_fill)
        _set_cell_borders(cell, color_hex=border_color or "E5E7EB",
                          size_pt=0.5, which="all")
        _set_cell_padding(cell, 0.1, 0.12, 0.1, 0.12)

        para_label = cell.paragraphs[0]
        para_label.alignment = WD_ALIGN_PARAGRAPH.LEFT
        run_l = para_label.add_run(item.get("label", "") or "")
        run_l.bold = True
        _set_run_font(run_l, theme, theme.get("font_name") or "Calibri", 9, label_color)

        para_value = cell.add_paragraph()
        para_value.alignment = WD_ALIGN_PARAGRAPH.LEFT
        run_v = para_value.add_run(str(item.get("value", "") or ""))
        run_v.bold = True
        v_color = _resolve_color(theme, item.get("value_color")) if item.get("value_color") else value_color_default
        _set_run_font(run_v, theme,
                      theme.get("font_name") or "Calibri",
                      float(item.get("value_size") or 18),
                      v_color)

        delta = item.get("delta")
        if delta:
            para_delta = cell.add_paragraph()
            run_d = para_delta.add_run(str(delta))
            d_color = _resolve_color(theme, item.get("delta_color")) if item.get("delta_color") else delta_color_default
            _set_run_font(run_d, theme,
                          theme.get("font_name") or "Calibri",
                          10, d_color)


def _render_signature_block(container, block: Dict[str, Any], theme: Dict[str, Any]) -> None:
    signers = block.get("signers") or []
    try:
        columns = int(block.get("columns") or min(2, max(1, len(signers))))
    except (ValueError, TypeError):
        columns = min(2, max(1, len(signers)))
    if not signers:
        return
    rows = (len(signers) + columns - 1) // columns
    table = container.add_table(rows=rows, cols=columns)
    table.autofit = False
    border_color = _resolve_color(theme, "muted") or "9CA3AF"

    for idx, signer in enumerate(signers):
        r = idx // columns
        c = idx % columns
        cell = table.rows[r].cells[c]
        cell.text = ""
        _set_cell_padding(cell, 0.05, 0.1, 0.05, 0.1)
        _set_cell_borders(cell, color_hex="FFFFFF", size_pt=0.0, which="none")

        # Signature line
        line_para = cell.paragraphs[0]
        line_para.alignment = WD_ALIGN_PARAGRAPH.LEFT
        line_run = line_para.add_run(" " * 32)
        line_run.font.size = Pt(10)
        # Apply bottom border to the paragraph as the signature line
        pPr = line_para._element.get_or_add_pPr()
        pBdr = OxmlElement("w:pBdr")
        bottom = OxmlElement("w:bottom")
        bottom.set(qn("w:val"), "single")
        bottom.set(qn("w:sz"), "6")
        bottom.set(qn("w:space"), "1")
        bottom.set(qn("w:color"), border_color)
        pBdr.append(bottom)
        pPr.append(pBdr)

        name_para = cell.add_paragraph()
        run_n = name_para.add_run(signer.get("name", "") or "")
        run_n.bold = True
        _set_run_font(run_n, theme, theme.get("font_name") or "Calibri",
                      11, _resolve_color(theme, "title_color"))

        if signer.get("role"):
            role_para = cell.add_paragraph()
            run_r = role_para.add_run(signer["role"])
            _set_run_font(run_r, theme, theme.get("font_name") or "Calibri",
                          10, _resolve_color(theme, "muted"))

        if signer.get("date"):
            date_para = cell.add_paragraph()
            run_d = date_para.add_run(f"Date: {signer['date']}")
            _set_run_font(run_d, theme, theme.get("font_name") or "Calibri",
                          10, _resolve_color(theme, "muted"))


def _render_table_of_figures(container, block: Dict[str, Any], theme: Dict[str, Any]) -> None:
    title = block.get("title", "List of Figures")
    label = block.get("caption_label", "Figure")
    _render_heading(container, {"text": title, "level": 1}, theme)
    instr = f' TOC \\h \\z \\c "{label}" '
    para = container.add_paragraph()
    r_begin = OxmlElement("w:r")
    fld_begin = OxmlElement("w:fldChar")
    fld_begin.set(qn("w:fldCharType"), "begin")
    r_begin.append(fld_begin)
    para._element.append(r_begin)
    r_instr = OxmlElement("w:r")
    instr_el = OxmlElement("w:instrText")
    instr_el.set(qn("xml:space"), "preserve")
    instr_el.text = instr
    r_instr.append(instr_el)
    para._element.append(r_instr)
    r_end = OxmlElement("w:r")
    fld_end = OxmlElement("w:fldChar")
    fld_end.set(qn("w:fldCharType"), "end")
    r_end.append(fld_end)
    para._element.append(r_end)


def _render_cover_page(container, block: Dict[str, Any], theme: Dict[str, Any]) -> None:
    title = block.get("title") or ""
    subtitle = block.get("subtitle")
    author = block.get("author")
    date = block.get("date")
    accent_band = block.get("accent_band", True)
    logo_path = block.get("logo_path")

    if accent_band:
        # Thin accent strip via paragraph with bottom border
        band_para = container.add_paragraph()
        pPr = band_para._element.get_or_add_pPr()
        pBdr = OxmlElement("w:pBdr")
        bottom = OxmlElement("w:bottom")
        bottom.set(qn("w:val"), "single")
        bottom.set(qn("w:sz"), "32")
        bottom.set(qn("w:space"), "1")
        bottom.set(qn("w:color"), _resolve_color(theme, "accent") or "2563EB")
        pBdr.append(bottom)
        pPr.append(pBdr)
        band_para.paragraph_format.space_before = Pt(120)

    if logo_path and Path(logo_path).exists():
        logo_para = container.add_paragraph()
        logo_para.alignment = WD_ALIGN_PARAGRAPH.LEFT
        logo_run = logo_para.add_run()
        logo_run.add_picture(str(logo_path), width=Inches(1.5))

    title_para = container.add_paragraph()
    title_para.alignment = WD_ALIGN_PARAGRAPH.LEFT
    title_para.paragraph_format.space_before = Pt(48)
    run = title_para.add_run(title)
    run.bold = True
    _set_run_font(run, theme,
                  theme.get("heading_font") or theme.get("font_name") or "Calibri",
                  float(theme.get("title_size", DEFAULT_TITLE_SIZE)),
                  _resolve_color(theme, "title_color"))

    if subtitle:
        sub_para = container.add_paragraph()
        sub_run = sub_para.add_run(subtitle)
        _set_run_font(sub_run, theme,
                      theme.get("font_name") or "Calibri",
                      float(theme.get("title_size", DEFAULT_TITLE_SIZE)) * 0.55,
                      _resolve_color(theme, "muted"))

    if author or date:
        meta_para = container.add_paragraph()
        meta_para.paragraph_format.space_before = Pt(36)
        meta_text = []
        if author:
            meta_text.append(author)
        if date:
            meta_text.append(date)
        run_m = meta_para.add_run("  ·  ".join(meta_text))
        _set_run_font(run_m, theme,
                      theme.get("font_name") or "Calibri",
                      11,
                      _resolve_color(theme, "body_color"))


# ── Block dispatcher ───────────────────────────────────────────────────────
BLOCK_RENDERERS = {
    "heading":          _render_heading,
    "paragraph":        _render_paragraph,
    "list":             _render_list,
    "table":            _render_table,
    "image":            _render_image,
    "page_break":       _render_page_break,
    "divider":          _render_divider,
    "callout":          _render_callout,
    "quote":            _render_quote,
    "code_block":       _render_code_block,
    "toc":              _render_toc,
    "kpi_grid":         _render_kpi_grid,
    "signature_block":  _render_signature_block,
    "table_of_figures": _render_table_of_figures,
    "cover_page":       _render_cover_page,
}


def _render_blocks(container, blocks: Sequence[Dict[str, Any]], theme: Dict[str, Any]) -> None:
    for block in blocks:
        if not isinstance(block, dict):
            raise ValueError(f"Each block must be an object, got {type(block).__name__}: {block!r}")
        btype = block.get("type")
        if not btype:
            raise ValueError(f"Block missing `type`: {block!r}")
        renderer = BLOCK_RENDERERS.get(btype)
        if renderer is None:
            raise ValueError(f"Unknown block type '{btype}'. "
                             f"Valid types: {sorted(BLOCK_RENDERERS)}")
        renderer(container, block, theme)


# ── Default style configuration ────────────────────────────────────────────
def _configure_defaults(doc: DocumentObject, theme: Dict[str, Any],
                        cli_font: Optional[str], cli_size: Optional[float]) -> None:
    font_name = cli_font or theme.get("font_name") or "Calibri"
    body_size = cli_size or theme.get("body_size") or DEFAULT_BODY_SIZE
    heading_font = theme.get("heading_font") or font_name
    title_color = _resolve_color(theme, "title_color")
    body_color = _resolve_color(theme, "body_color")

    # Normal style
    try:
        style_normal = doc.styles["Normal"]
        style_normal.font.name = font_name
        style_normal.font.size = Pt(float(body_size))
        if body_color:
            style_normal.font.color.rgb = _hex_to_rgb(body_color)
        # Force complex-script font fallback for Normal
        rPr = style_normal.element.get_or_add_rPr()
        rFonts = rPr.find(qn("w:rFonts"))
        if rFonts is None:
            rFonts = OxmlElement("w:rFonts")
            rPr.insert(0, rFonts)
        for attr in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
            rFonts.set(qn(attr), font_name)
    except KeyError:
        pass

    # Heading styles
    for level in range(1, 10):
        try:
            style = doc.styles[f"Heading {level}"]
            style.font.name = heading_font
            style.font.size = Pt(DEFAULT_HEADING_SIZES.get(level, body_size))
            style.font.bold = level <= 3
            if title_color:
                style.font.color.rgb = _hex_to_rgb(title_color)
            rPr = style.element.get_or_add_rPr()
            rFonts = rPr.find(qn("w:rFonts"))
            if rFonts is None:
                rFonts = OxmlElement("w:rFonts")
                rPr.insert(0, rFonts)
            for attr in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
                rFonts.set(qn(attr), heading_font)
        except KeyError:
            continue


def _set_core_properties(doc: DocumentObject, properties: Dict[str, Any]) -> None:
    cp = doc.core_properties
    for k in ("title", "author", "subject", "keywords", "comments"):
        if properties.get(k) is not None:
            try:
                setattr(cp, k, str(properties[k]))
            except Exception:
                pass


# ── Header / footer / page numbers ─────────────────────────────────────────
def _render_header_footer(section, kind: str, blocks: Sequence[Dict[str, Any]],
                          theme: Dict[str, Any]) -> None:
    container = section.header if kind == "header" else section.footer
    # Unlink from previous section to avoid propagation
    if kind == "header":
        container.is_linked_to_previous = False
    else:
        container.is_linked_to_previous = False
    # Wipe the default empty paragraph if any blocks are provided
    for p in list(container.paragraphs):
        if not p.text and not p._element.findall(qn("w:r")):
            try:
                p._element.getparent().remove(p._element)
            except Exception:
                pass
    _render_blocks(container, blocks, theme)


def _add_default_page_numbers(section, options: Any, theme: Dict[str, Any]) -> None:
    """Add a footer paragraph with `Page X of N` (or custom format)."""
    if not options:
        return
    if options is True:
        position = "center"
        fmt = "Page X of N"
    elif isinstance(options, dict):
        position = options.get("position", "center")
        fmt = options.get("format", "Page X of N")
    else:
        return
    footer = section.footer
    para = footer.add_paragraph()
    para.alignment = _alignment_enum(position) or WD_ALIGN_PARAGRAPH.CENTER

    body_color = _resolve_color(theme, "muted")
    font_name = theme.get("font_name") or "Calibri"
    body_size = max(9, float(theme.get("body_size", DEFAULT_BODY_SIZE)) - 1)

    parts = fmt
    # Replace tokens with PAGE / NUMPAGES fields
    # Supports both {X}/{N} (braced) and X/N (unbraced) for backward compatibility
    seq: List[Tuple[str, str]] = []  # (text, kind) where kind ∈ "text", "PAGE", "NUMPAGES"
    cursor = parts
    while cursor:
        # Find literal {X} and {N} tokens (braced)
        idx_x_brace = cursor.find("{X}")
        idx_n_brace = cursor.find("{N}")
        # Find unbraced X/N tokens (word boundary to avoid matching in words)
        import re
        m_x = re.search(r'\bX\b', cursor)
        m_n = re.search(r'\bN\b', cursor)
        idx_x_unbraced = m_x.start() if m_x else -1
        idx_n_unbraced = m_n.start() if m_n else -1

        # Use braced form if present, otherwise unbraced
        candidates = []
        if idx_x_brace >= 0:
            candidates.append((idx_x_brace, "X", True))
        elif idx_x_unbraced >= 0:
            candidates.append((idx_x_unbraced, "X", False))
        if idx_n_brace >= 0:
            candidates.append((idx_n_brace, "N", True))
        elif idx_n_unbraced >= 0:
            candidates.append((idx_n_unbraced, "N", False))

        if not candidates:
            seq.append((cursor, "text"))
            break
        nxt, token, braced = min(candidates, key=lambda x: x[0])
        if nxt > 0:
            seq.append((cursor[:nxt], "text"))
        seq.append(("", "PAGE" if token == "X" else "NUMPAGES"))
        skip = 3 if braced else 1  # {X} is 3 chars, X is 1
        cursor = cursor[nxt + skip:]

    for text, kind in seq:
        if kind == "text":
            run = para.add_run(text)
            _set_run_font(run, theme, font_name, body_size, body_color)
        else:
            _add_run_field(para, kind)


# ── Top-level builder ──────────────────────────────────────────────────────
def build(spec: Dict[str, Any], output: Path,
          cli_font: Optional[str], cli_size: Optional[float]) -> Path:
    if "blocks" not in spec and "sections" not in spec:
        raise ValueError("Spec must contain `blocks` (single section) or `sections` (multi-section).")
    if "blocks" in spec and "sections" in spec:
        raise ValueError("Spec must contain EITHER `blocks` OR `sections`, not both.")

    # Auto-detect if TOC block is present
    has_toc = False
    if "blocks" in spec:
        has_toc = any(b.get("type") == "toc" for b in spec.get("blocks", []))
    elif "sections" in spec:
        for sec in spec.get("sections", []):
            has_toc = any(b.get("type") == "toc" for b in sec.get("blocks", []))
            if has_toc:
                break

    theme = _resolve_theme(spec)
    doc = Document()
    _configure_defaults(doc, theme, cli_font, cli_size)
    _set_core_properties(doc, spec.get("properties") or {})

    sections_spec: List[Dict[str, Any]]
    if "sections" in spec:
        sections_spec = spec["sections"]
    else:
        # Single section: lift all top-level page setup keys
        sections_spec = [{
            "page_size": spec.get("page_size"),
            "orientation": spec.get("orientation"),
            "margins_in": spec.get("margins_in"),
            "columns": spec.get("columns"),
            "column_space_in": spec.get("column_space_in"),
            "column_separator": spec.get("column_separator"),
            "different_first_page": spec.get("different_first_page"),
            "header": spec.get("header"),
            "footer": spec.get("footer"),
            "page_numbers": spec.get("page_numbers"),
            "blocks": spec.get("blocks", []),
        }]

    # First section is the auto-created one
    for s_idx, sec_spec in enumerate(sections_spec):
        if s_idx == 0:
            section = doc.sections[0]
        else:
            section = doc.add_section(WD_SECTION.NEW_PAGE)
        _apply_section_setup(section, sec_spec or {})
        if (sec_spec or {}).get("header"):
            _render_header_footer(section, "header", sec_spec["header"], theme)
        if (sec_spec or {}).get("footer"):
            _render_header_footer(section, "footer", sec_spec["footer"], theme)
        page_nums = (sec_spec or {}).get("page_numbers")
        if page_nums:
            _add_default_page_numbers(section, page_nums, theme)

        _render_blocks(doc, (sec_spec or {}).get("blocks") or [], theme)

    output.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(output))

    # Auto-refresh TOC if present
    if has_toc:
        try:
            _refresh_fields_via_libreoffice(output)
        except Exception as exc:
            print(f"Warning: could not refresh fields via LibreOffice: {exc}", file=sys.stderr)

    return output


def _refresh_fields_via_libreoffice(docx_path: Path) -> None:
    """Open the file with unoserver to update TOC and other indexes, then save back."""
    unoconvert = shutil.which("unoconvert")
    if not unoconvert:
        return
    work_dir = Path(tempfile.mkdtemp(prefix="docx_fields_"))
    try:
        output = work_dir / docx_path.name
        cmd = [
            unoconvert,
            "--update-index",
            "--format", "docx",
            str(docx_path),
            str(output),
        ]
        subprocess.run(cmd, capture_output=True, text=True, timeout=120, check=False)
        if output.exists():
            shutil.copyfile(output, docx_path)
    finally:
        try:
            shutil.rmtree(work_dir)
        except Exception:
            pass


def main() -> None:
    p = argparse.ArgumentParser(description="Build a .docx Word document from a JSON spec.")
    p.add_argument("--spec", required=True, help="Path to the JSON spec file")
    p.add_argument("--output", required=True, help="Destination .docx path")
    p.add_argument("--font-name", help="Override theme default font name")
    p.add_argument("--font-size", type=float, help="Override theme default body size (pt)")
    args = p.parse_args()

    spec_path = Path(args.spec)
    if not spec_path.exists():
        print(f"Error: spec file not found: {spec_path}", file=sys.stderr)
        sys.exit(1)
    try:
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"Error: invalid JSON in {spec_path}: {exc}", file=sys.stderr)
        sys.exit(1)

    try:
        out = build(
            spec,
            Path(args.output),
            cli_font=args.font_name,
            cli_size=args.font_size,
        )
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)

    print(json.dumps({"action": "build", "output": str(out)}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
