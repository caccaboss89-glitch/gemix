#!/usr/bin/env python3
"""Build a .pptx presentation from a JSON spec.

Two complementary spec styles (mixable slide-by-slide):

A) **Block-based (recommended for rich, editorial-grade decks)**
   A slide is a list of `blocks`. Each block has `type`, `x`, `y`, `w`, `h`
   (inches) and block-specific fields. Block catalog:

     - title           large heading (auto-positioned if x/y omitted)
     - text            paragraph(s); accepts `text` or `lines:[{text,size,bold,italic,color,align}]`
     - header_bar      full-width slide header with title + optional brand chip
     - accent_bar      solid colored stripe (vertical or horizontal)
     - shape           generic rect / rounded / oval / circle with optional text
     - pills           horizontal row of small rounded badges
     - bullets         bullet list (same items schema as legacy `content`)
     - card_grid       NxM cards; each {avatar?:{initials,color,size?}, title, subtitle, badge?:{text,fill,fg}, accent?}
     - progress_list   vertical list with title + description + progress bar + status pill
     - kpi_grid        stat tiles {label, value, delta?, delta_color?, value_color?}
     - table           extended table (zebra, column_widths, header_fill/fg, body_size, align)
     - chart           native chart: kind ∈ column|bar|line|pie|doughnut; categories[], series:[{name,values:[]}]
     - banner          full-width callout with optional icon circle and multi-line text
     - footer_bar      thin horizontal bar with left/right text (page num, brand, confidential…)
     - image           picture (path required) with optional caption
     - divider         thin horizontal line
     - gradient_shape  rect/rounded/oval with linear gradient fill
     - background_image full-slide image with optional overlay opacity
     - text_columns    multi-column text layout (2-4 columns)
     - arrow_line      straight connector with arrow
     - curved_line     curved connector
     - watermark       overlay text/image (semi-transparent)
     - diagram         simple flowchart nodes with auto-layout

   Color values inside any block accept either a 6-char hex (`RRGGBB`) **or** a
   theme token name (`accent`, `accent_dark`, `surface`, `surface_alt`, `title_color`,
   `body_color`, `muted`, `success`, `warning`, `danger`, `on_accent`, `background`).

   Advanced effects (optional on most blocks):
     - gradient: `gradient: true, stops:[{color,pos},...], angle: 0-360`
     - shadow: `shadow: {blur, distance, angle, color, transparency}`
     - glow: `glow: {color, radius}`
     - reflection: `reflection: {blur, size, direction, transparency, distance}`
     - rotation: `rotation: 0-360` (degrees)
     - hyperlink: `hyperlink: "https://..."`
     - circle_mask (image only): `circle_mask: true`

B) **Layout-based (legacy quick-shot)** — `layout` ∈ title|title_content|
   two_content|section|picture|blank with `content`/`left`/`right`/`image`/`table`.
   Still supported for trivial decks.

Coordinates are in INCHES. A 16:9 slide = 13.333 × 7.5; 4:3 = 10 × 7.5; A4 = 11.69 × 8.27.
"""
import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image, ImageEnhance

from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Inches, Pt


# ── Built-in themes (semantic tokens) ──────────────────────────────────────
THEMES: Dict[str, Dict[str, str]] = {
    "minimal":   {"background": "FFFFFF", "surface": "F8FAFC", "surface_alt": "EEF2F6",
                  "title_color": "111827", "body_color": "374151", "muted": "6B7280",
                  "accent": "2563EB", "accent_dark": "1E40AF",
                  "success": "10B981", "warning": "F59E0B", "danger": "DC2626",
                  "on_accent": "FFFFFF", "font_name": "Calibri"},
    "corporate": {"background": "F8FAFC", "surface": "FFFFFF", "surface_alt": "E2E8F0",
                  "title_color": "0F172A", "body_color": "1F2937", "muted": "64748B",
                  "accent": "0EA5E9", "accent_dark": "0369A1",
                  "success": "10B981", "warning": "F59E0B", "danger": "DC2626",
                  "on_accent": "FFFFFF", "font_name": "Calibri"},
    "executive": {"background": "0B1220", "surface": "0F1A2D", "surface_alt": "1B2A44",
                  "title_color": "FFFFFF", "body_color": "D1D5DB", "muted": "9CA3AF",
                  "accent": "14B8A6", "accent_dark": "0F766E",
                  "success": "22C55E", "warning": "F59E0B", "danger": "EF4444",
                  "on_accent": "0B1220", "font_name": "Calibri"},
    "dark":      {"background": "0F172A", "surface": "1E293B", "surface_alt": "334155",
                  "title_color": "F8FAFC", "body_color": "CBD5E1", "muted": "94A3B8",
                  "accent": "38BDF8", "accent_dark": "0EA5E9",
                  "success": "34D399", "warning": "FBBF24", "danger": "F87171",
                  "on_accent": "0F172A", "font_name": "Calibri"},
    "mono":      {"background": "FFFFFF", "surface": "F5F5F5", "surface_alt": "E5E5E5",
                  "title_color": "000000", "body_color": "1F2937", "muted": "6B7280",
                  "accent": "525252", "accent_dark": "1F2937",
                  "success": "16A34A", "warning": "CA8A04", "danger": "DC2626",
                  "on_accent": "FFFFFF", "font_name": "Helvetica"},
}

DEFAULT_TITLE_SIZE = 32
DEFAULT_BODY_SIZE = 18
DEFAULT_FOOTER_SIZE = 10


# ── Color / text helpers ───────────────────────────────────────────────────
def _hex_to_rgb(hexstr: str) -> RGBColor:
    s = (hexstr or "").strip().lstrip("#")
    if len(s) != 6:
        raise ValueError(f"Invalid color '{hexstr}': expected RRGGBB hex.")
    return RGBColor(int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))


def _resolve_color(theme: Dict[str, Any], value: Any) -> Optional[str]:
    """Return a 6-char hex string. Accepts hex, '#RRGGBB', or theme token name."""
    if value is None or value is False:
        return None
    if isinstance(value, str):
        v = value.strip().lstrip("#")
        if v in theme and isinstance(theme[v], str):
            return theme[v].lstrip("#")
        return v
    raise ValueError(f"Unsupported color value: {value!r}")


def _resolve_theme(spec: Dict[str, Any]) -> Dict[str, Any]:
    name = spec.get("theme", "corporate")
    base = dict(THEMES.get(name, THEMES["corporate"]))
    overrides = spec.get("defaults") or {}
    for k, v in overrides.items():
        if v is not None:
            base[k] = v
    base.setdefault("title_size", DEFAULT_TITLE_SIZE)
    base.setdefault("body_size", DEFAULT_BODY_SIZE)
    return base


def _set_slide_size(prs: Presentation, slide_size: str) -> None:
    s = (slide_size or "16:9").lower()
    if s in ("16:9", "widescreen"):
        prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
    elif s == "4:3":
        prs.slide_width, prs.slide_height = Inches(10.0), Inches(7.5)
    elif s == "a4":
        prs.slide_width, prs.slide_height = Inches(11.69), Inches(8.27)
    else:
        raise ValueError(f"Unsupported slide_size '{slide_size}' (use 16:9, widescreen, 4:3, a4)")


def _paint_background(slide, hex_color: str) -> None:
    fill = slide.background.fill
    fill.solid()
    fill.fore_color.rgb = _hex_to_rgb(hex_color)


def _solid_fill(shape, hex_color: str) -> None:
    shape.fill.solid()
    shape.fill.fore_color.rgb = _hex_to_rgb(hex_color)


def _no_line(shape) -> None:
    try:
        shape.line.fill.background()
    except Exception:
        pass


def _set_line(shape, hex_color: str, width_pt: float = 0.75) -> None:
    try:
        shape.line.color.rgb = _hex_to_rgb(hex_color)
        shape.line.width = Pt(width_pt)
    except Exception:
        pass


def _align(name: Optional[str]) -> int:
    return {
        "left": PP_ALIGN.LEFT, "center": PP_ALIGN.CENTER, "centre": PP_ALIGN.CENTER,
        "right": PP_ALIGN.RIGHT, "justify": PP_ALIGN.JUSTIFY,
    }.get((name or "left").lower(), PP_ALIGN.LEFT)


def _anchor(name: Optional[str]) -> int:
    return {
        "top": MSO_ANCHOR.TOP, "middle": MSO_ANCHOR.MIDDLE,
        "center": MSO_ANCHOR.MIDDLE, "centre": MSO_ANCHOR.MIDDLE,
        "bottom": MSO_ANCHOR.BOTTOM,
    }.get((name or "top").lower(), MSO_ANCHOR.TOP)


def _add_textbox(slide, x: float, y: float, w: float, h: float,
                 anchor: int = MSO_ANCHOR.TOP, margin: float = 0.05):
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = box.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    for prop in ("margin_left", "margin_right", "margin_top", "margin_bottom"):
        setattr(tf, prop, Inches(margin))
    return box, tf


def _set_run(run, theme: Dict[str, Any], *, size: float, bold: bool = False,
             italic: bool = False, color: Any = None, font: Optional[str] = None) -> None:
    run.font.name = font or theme["font_name"]
    run.font.size = Pt(int(round(size)))
    run.font.bold = bool(bold)
    run.font.italic = bool(italic)
    hex_color = _resolve_color(theme, color) if color is not None else theme["body_color"]
    if hex_color:
        run.font.color.rgb = _hex_to_rgb(hex_color)


def _approx_text_width(text: str, size_pt: float) -> float:
    """Rough inches estimate for a single-line label."""
    return max(0.4, len(text) * (size_pt * 0.0058) + 0.05)


# ── Advanced effects helpers ─────────────────────────────────────────────────
def _set_gradient(shape, theme, b) -> None:
    """Apply linear gradient fill to a shape."""
    try:
        fill = shape.fill
        fill.gradient()
        fill.gradient_angle = int(b.get("angle", 0))
        stops = b.get("stops") or [{"color": b.get("color", "accent"), "pos": 0.0},
                                   {"color": b.get("color_end", "accent_dark"), "pos": 1.0}]
        for i, stop in enumerate(stops):
            cs = fill.gradient_stops[i]
            cs.color.rgb = _hex_to_rgb(_resolve_color(theme, stop.get("color")))
            cs.position = float(stop.get("pos", i / max(1, len(stops) - 1)))
    except Exception:
        pass


def _set_shadow(shape, theme, b) -> None:
    """Apply shadow effect."""
    try:
        shadow = shape.shadow
        shadow.inherit = False
        shadow.visible = True
        shadow.blur_radius = Pt(float(b.get("blur", 8)))
        shadow.distance = Pt(float(b.get("distance", 4)))
        shadow.angle = float(b.get("angle", 270))
        shadow.color.rgb = _hex_to_rgb(_resolve_color(theme, b.get("color", "000000")))
        shadow.transparency = float(b.get("transparency", 0.25))
    except Exception:
        pass


def _set_glow(shape, theme, b) -> None:
    """Apply glow effect."""
    try:
        glow = shape.glow
        glow.color.rgb = _hex_to_rgb(_resolve_color(theme, b.get("color", "accent")))
        glow.radius = Pt(float(b.get("radius", 12)))
    except Exception:
        pass


def _set_reflection(shape, b) -> None:
    """Apply reflection effect."""
    try:
        refl = shape.reflection
        refl.blur = Pt(float(b.get("blur", 4)))
        refl.size = float(b.get("size", 0.5))
        refl.direction = float(b.get("direction", 90))
        refl.transparency = float(b.get("transparency", 0.35))
        refl.distance = Pt(float(b.get("distance", 3)))
    except Exception:
        pass


def _set_rotation(shape, b) -> None:
    """Apply rotation (degrees)."""
    try:
        shape.rotation = float(b.get("rotation", 0))
    except Exception:
        pass


def _set_hyperlink(shape, url: str) -> None:
    """Set click hyperlink."""
    try:
        shape.click_action.hyperlink.address = url
    except Exception:
        pass


def _mask_image_to_circle(shape) -> None:
    """Crop image to circle using aspect ratio crop."""
    try:
        pf = shape.picture_format
        w, h = shape.width, shape.height
        min_dim = min(w, h)
        pf.crop_left = (w - min_dim) / 2.0 / w
        pf.crop_right = (w - min_dim) / 2.0 / w
        pf.crop_top = (h - min_dim) / 2.0 / h
        pf.crop_bottom = (h - min_dim) / 2.0 / h
    except Exception:
        pass


# ── Block renderers ────────────────────────────────────────────────────────
def _b_title(slide, prs, theme, b):
    sw = prs.slide_width / 914400.0
    x = float(b.get("x", 0.5))
    y = float(b.get("y", 0.4))
    w = float(b.get("w", sw - 1.0))
    h = float(b.get("h", 1.0))
    text = b.get("text") or b.get("title") or ""
    box, tf = _add_textbox(slide, x, y, w, h, anchor=_anchor(b.get("anchor", "top")))
    p = tf.paragraphs[0]
    p.alignment = _align(b.get("align", "left"))
    run = p.add_run()
    run.text = str(text)
    _set_run(run, theme,
             size=b.get("size", theme["title_size"]),
             bold=b.get("bold", True),
             color=b.get("color", theme["title_color"]))


def _b_text(slide, prs, theme, b):
    box, tf = _add_textbox(slide, b["x"], b["y"], b["w"], b["h"],
                           anchor=_anchor(b.get("anchor", "top")),
                           margin=float(b.get("margin", 0.05)))
    lines = b.get("lines")
    if not lines:
        lines = [{
            "text": b.get("text", ""),
            "size": b.get("size", theme["body_size"]),
            "bold": b.get("bold", False),
            "italic": b.get("italic", False),
            "color": b.get("color"),
            "align": b.get("align"),
        }]
    for i, line in enumerate(lines):
        if isinstance(line, str):
            line = {"text": line}
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        if line.get("align"):
            p.alignment = _align(line["align"])
        elif b.get("align"):
            p.alignment = _align(b["align"])
        run = p.add_run()
        run.text = str(line.get("text", ""))
        _set_run(run, theme,
                 size=line.get("size", b.get("size", theme["body_size"])),
                 bold=line.get("bold", False),
                 italic=line.get("italic", False),
                 color=line.get("color", b.get("color")))


def _b_header_bar(slide, prs, theme, b):
    fill = _resolve_color(theme, b.get("fill") or theme["title_color"])
    fg = _resolve_color(theme, b.get("fg") or theme["on_accent"]) or "FFFFFF"
    bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE,
                                 Inches(b["x"]), Inches(b["y"]),
                                 Inches(b["w"]), Inches(b["h"]))
    _solid_fill(bar, fill)
    _no_line(bar)
    tf = bar.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    for prop in ("margin_left", "margin_right", "margin_top", "margin_bottom"):
        setattr(tf, prop, Inches(0.05))
    tf.margin_left = Inches(0.3)
    p = tf.paragraphs[0]
    run = p.add_run()
    run.text = str(b.get("title", ""))
    _set_run(run, theme, size=b.get("size", 20), bold=True, color=fg)
    brand = b.get("brand")
    if brand:
        bw = float(b.get("brand_w", 0.85))
        bh = float(b.get("brand_h", max(0.45, b["h"] - 0.25)))
        bx = float(b["x"]) + float(b["w"]) - bw - 0.2
        by = float(b["y"]) + (float(b["h"]) - bh) / 2.0
        chip = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE,
                                      Inches(bx), Inches(by), Inches(bw), Inches(bh))
        _solid_fill(chip, _resolve_color(theme, b.get("brand_fill") or theme["accent"]))
        _no_line(chip)
        chip.text_frame.vertical_anchor = MSO_ANCHOR.MIDDLE
        for prop in ("margin_left", "margin_right", "margin_top", "margin_bottom"):
            setattr(chip.text_frame, prop, Inches(0.04))
        cp = chip.text_frame.paragraphs[0]
        cp.alignment = PP_ALIGN.CENTER
        cr = cp.add_run()
        cr.text = str(brand)
        _set_run(cr, theme, size=b.get("brand_size", 11), bold=True,
                 color=_resolve_color(theme, b.get("brand_fg") or theme["on_accent"]))


def _b_accent_bar(slide, prs, theme, b):
    color = _resolve_color(theme, b.get("color") or theme["accent"])
    bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE,
                                 Inches(b["x"]), Inches(b["y"]),
                                 Inches(b["w"]), Inches(b["h"]))
    _solid_fill(bar, color)
    _no_line(bar)


def _b_shape(slide, prs, theme, b):
    kind = (b.get("kind") or "rect").lower()
    sh_type = {
        "rect": MSO_SHAPE.RECTANGLE,
        "rectangle": MSO_SHAPE.RECTANGLE,
        "rounded": MSO_SHAPE.ROUNDED_RECTANGLE,
        "rounded_rect": MSO_SHAPE.ROUNDED_RECTANGLE,
        "oval": MSO_SHAPE.OVAL,
        "circle": MSO_SHAPE.OVAL,
    }.get(kind, MSO_SHAPE.RECTANGLE)
    sh = slide.shapes.add_shape(sh_type,
                                Inches(b["x"]), Inches(b["y"]),
                                Inches(b["w"]), Inches(b["h"]))
    fill = b.get("fill", theme["surface"])
    if fill is False or fill == "none":
        sh.fill.background()
    elif b.get("gradient"):
        _set_gradient(sh, theme, b)
    else:
        _solid_fill(sh, _resolve_color(theme, fill))
    line = b.get("line", "surface_alt")
    if line is False or line == "none":
        _no_line(sh)
    else:
        _set_line(sh, _resolve_color(theme, line) or theme["surface_alt"],
                  float(b.get("line_width", 0.75)))
    if b.get("shadow"):
        _set_shadow(sh, theme, b["shadow"])
    if b.get("glow"):
        _set_glow(sh, theme, b["glow"])
    if b.get("reflection"):
        _set_reflection(sh, b["reflection"])
    if b.get("rotation"):
        _set_rotation(sh, b)
    text = b.get("text")
    if text is not None:
        tf = sh.text_frame
        tf.word_wrap = True
        tf.vertical_anchor = _anchor(b.get("anchor", "middle"))
        for prop in ("margin_left", "margin_right", "margin_top", "margin_bottom"):
            setattr(tf, prop, Inches(float(b.get("padding", 0.08))))
        lines = text if isinstance(text, list) else [text]
        for i, line in enumerate(lines):
            p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            p.alignment = _align(b.get("align", "center"))
            r = p.add_run()
            if isinstance(line, dict):
                r.text = str(line.get("text", ""))
                _set_run(r, theme,
                         size=line.get("size", b.get("font_size", theme["body_size"])),
                         bold=line.get("bold", b.get("bold", False)),
                         italic=line.get("italic", False),
                         color=line.get("color", b.get("fg", theme["body_color"])))
            else:
                r.text = str(line)
                _set_run(r, theme,
                         size=b.get("font_size", theme["body_size"]),
                         bold=b.get("bold", False),
                         color=b.get("fg", theme["body_color"]))
    if b.get("hyperlink"):
        _set_hyperlink(sh, b["hyperlink"])


def _b_pills(slide, prs, theme, b):
    items = b.get("items") or []
    if not items:
        return
    h = float(b.get("h", 0.32))
    gap = float(b.get("gap", 0.12))
    size = int(b.get("size", 11))
    padding = float(b.get("padding", 0.18))
    default_fill = _resolve_color(theme, b.get("fill") or theme["surface_alt"])
    default_fg = _resolve_color(theme, b.get("fg") or theme["body_color"])
    x = float(b["x"])
    y = float(b["y"])
    for it in items:
        if isinstance(it, dict):
            text = str(it.get("text", ""))
            ifill = _resolve_color(theme, it.get("fill") or default_fill)
            ifg = _resolve_color(theme, it.get("fg") or default_fg)
        else:
            text = str(it)
            ifill = default_fill
            ifg = default_fg
        w = _approx_text_width(text, size) + 2 * padding
        chip = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE,
                                      Inches(x), Inches(y), Inches(w), Inches(h))
        _solid_fill(chip, ifill)
        _no_line(chip)
        chip.text_frame.vertical_anchor = MSO_ANCHOR.MIDDLE
        for prop in ("margin_left", "margin_right", "margin_top", "margin_bottom"):
            setattr(chip.text_frame, prop, Inches(0.04))
        p = chip.text_frame.paragraphs[0]
        p.alignment = PP_ALIGN.CENTER
        r = p.add_run()
        r.text = text
        _set_run(r, theme, size=size, bold=True, color=ifg)
        x += w + gap


def _b_bullets(slide, prs, theme, b):
    items = b.get("items") or b.get("content") or []
    box, tf = _add_textbox(slide, b["x"], b["y"], b["w"], b["h"],
                           margin=float(b.get("margin", 0.05)))
    for i, item in enumerate(items):
        if isinstance(item, dict):
            text = str(item.get("text", ""))
            level = int(item.get("level", 0))
            bold = bool(item.get("bold", False))
            italic = bool(item.get("italic", False))
            color = item.get("color") or theme["body_color"]
            size = int(item.get("size") or b.get("size") or theme["body_size"])
        else:
            text = str(item)
            level = 0
            bold = False
            italic = False
            color = theme["body_color"]
            size = int(b.get("size") or theme["body_size"])
        para = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        para.level = max(0, min(level, 4))
        prefix = "• " if level == 0 else ("– " if level == 1 else "› ")
        run = para.add_run()
        run.text = prefix + text
        _set_run(run, theme, size=size, bold=bold, italic=italic, color=color)


def _b_card_grid(slide, prs, theme, b):
    cards = b.get("cards") or []
    n = len(cards)
    if n == 0:
        return
    cols = int(b.get("columns") or n)
    rows = (n + cols - 1) // cols
    gap = float(b.get("gap", 0.18))
    x0 = float(b["x"])
    y0 = float(b["y"])
    cw = (float(b["w"]) - gap * (cols - 1)) / cols
    ch = (float(b["h"]) - gap * (rows - 1)) / rows
    accent_stripe = bool(b.get("accent_stripe", True))
    card_fill = _resolve_color(theme, b.get("card_fill") or theme["surface"])
    card_border = _resolve_color(theme, b.get("card_border") or theme["surface_alt"])
    default_avatar = _resolve_color(theme, b.get("avatar_color") or theme["accent"])
    title_color = _resolve_color(theme, b.get("title_color") or theme["title_color"])
    subtitle_color = _resolve_color(theme, b.get("subtitle_color") or theme["muted"])

    for i, card in enumerate(cards):
        r = i // cols
        c = i % cols
        cx = x0 + c * (cw + gap)
        cy = y0 + r * (ch + gap)
        body = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE,
                                      Inches(cx), Inches(cy), Inches(cw), Inches(ch))
        _solid_fill(body, card_fill)
        _set_line(body, card_border, 0.5)
        cur_y = cy + 0.18
        if accent_stripe:
            stripe_color = _resolve_color(theme, card.get("accent") or default_avatar)
            stripe = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE,
                                            Inches(cx), Inches(cy),
                                            Inches(cw), Inches(0.07))
            _solid_fill(stripe, stripe_color)
            _no_line(stripe)
            cur_y = cy + 0.22
        avatar = card.get("avatar")
        if avatar:
            initials = str(avatar.get("initials") or "")
            ac = _resolve_color(theme, avatar.get("color") or default_avatar)
            ad = float(avatar.get("size", min(1.1, ch * 0.32)))
            ax = cx + (cw - ad) / 2.0
            circ = slide.shapes.add_shape(MSO_SHAPE.OVAL,
                                          Inches(ax), Inches(cur_y),
                                          Inches(ad), Inches(ad))
            _solid_fill(circ, ac)
            _no_line(circ)
            circ.text_frame.vertical_anchor = MSO_ANCHOR.MIDDLE
            ap = circ.text_frame.paragraphs[0]
            ap.alignment = PP_ALIGN.CENTER
            ar = ap.add_run()
            ar.text = initials
            _set_run(ar, theme, size=int(ad * 22), bold=True,
                     color=_resolve_color(theme, avatar.get("fg") or theme["on_accent"]))
            cur_y += ad + 0.10
        title = card.get("title")
        if title:
            box, tf = _add_textbox(slide, cx + 0.1, cur_y, cw - 0.2, 0.42, margin=0.02)
            p = tf.paragraphs[0]
            p.alignment = PP_ALIGN.CENTER
            r = p.add_run()
            r.text = str(title)
            _set_run(r, theme, size=card.get("title_size", 14), bold=True, color=title_color)
            cur_y += 0.42
        sub = card.get("subtitle")
        if sub:
            box, tf = _add_textbox(slide, cx + 0.1, cur_y, cw - 0.2, 0.7, margin=0.02)
            p = tf.paragraphs[0]
            p.alignment = PP_ALIGN.CENTER
            r = p.add_run()
            r.text = str(sub)
            _set_run(r, theme, size=card.get("subtitle_size", 11), color=subtitle_color)
            cur_y += 0.4
        badge = card.get("badge")
        if badge:
            if isinstance(badge, dict):
                btxt = str(badge.get("text", ""))
                bfill = _resolve_color(theme, badge.get("fill") or theme["accent"])
                bfg = _resolve_color(theme, badge.get("fg") or theme["on_accent"])
            else:
                btxt = str(badge)
                bfill = _resolve_color(theme, theme["accent"])
                bfg = _resolve_color(theme, theme["on_accent"])
            bw = max(0.8, min(cw - 0.4, _approx_text_width(btxt, 11) + 0.5))
            bx = cx + (cw - bw) / 2.0
            by = cy + ch - 0.5
            chip = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE,
                                          Inches(bx), Inches(by),
                                          Inches(bw), Inches(0.34))
            _solid_fill(chip, bfill)
            _no_line(chip)
            chip.text_frame.vertical_anchor = MSO_ANCHOR.MIDDLE
            for prop in ("margin_left", "margin_right", "margin_top", "margin_bottom"):
                setattr(chip.text_frame, prop, Inches(0.04))
            bp = chip.text_frame.paragraphs[0]
            bp.alignment = PP_ALIGN.CENTER
            br = bp.add_run()
            br.text = btxt
            _set_run(br, theme, size=11, bold=True, color=bfg)


def _b_progress_list(slide, prs, theme, b):
    items = b.get("items") or []
    n = len(items)
    if n == 0:
        return
    gap = float(b.get("gap", 0.12))
    x = float(b["x"])
    y = float(b["y"])
    w = float(b["w"])
    h_total = float(b["h"])
    rh = (h_total - gap * (n - 1)) / n
    text_w_ratio = float(b.get("text_ratio", 0.58))
    text_w = w * text_w_ratio
    bar_w = w - text_w - 0.25
    bar_x = x + w - bar_w
    track_h = float(b.get("bar_height", 0.22))
    card_fill = _resolve_color(theme, b.get("card_fill") or theme["surface"])
    card_border = _resolve_color(theme, b.get("card_border") or theme["surface_alt"])
    track_fill = _resolve_color(theme, b.get("track_color") or theme["surface_alt"])

    for i, it in enumerate(items):
        ry = y + i * (rh + gap)
        card = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE,
                                      Inches(x), Inches(ry), Inches(w), Inches(rh))
        _solid_fill(card, card_fill)
        _set_line(card, card_border, 0.5)
        accent_color = _resolve_color(theme, it.get("accent") or theme["accent"])
        stripe = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE,
                                        Inches(x), Inches(ry),
                                        Inches(0.09), Inches(rh))
        _solid_fill(stripe, accent_color)
        _no_line(stripe)
        title = it.get("title", "")
        box, tf = _add_textbox(slide, x + 0.28, ry + 0.12,
                               text_w - 0.3, 0.4, margin=0.02)
        r = tf.paragraphs[0].add_run()
        r.text = str(title)
        _set_run(r, theme, size=14, bold=True, color=theme["title_color"])
        desc = it.get("description", "")
        if desc:
            box, tf = _add_textbox(slide, x + 0.28, ry + 0.5,
                                   text_w - 0.3, rh - 0.6, margin=0.02)
            r = tf.paragraphs[0].add_run()
            r.text = str(desc)
            _set_run(r, theme, size=11, color=theme["muted"])
        pct = max(0.0, min(100.0, float(it.get("percent", 0))))
        track_y = ry + (rh - track_h) / 2.0
        track = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE,
                                       Inches(bar_x), Inches(track_y),
                                       Inches(bar_w), Inches(track_h))
        _solid_fill(track, track_fill)
        _no_line(track)
        if pct > 0:
            fill_w = max(0.05, bar_w * (pct / 100.0))
            fill_bar = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE,
                                              Inches(bar_x), Inches(track_y),
                                              Inches(fill_w), Inches(track_h))
            _solid_fill(fill_bar, _resolve_color(theme, it.get("bar_color") or accent_color))
            _no_line(fill_bar)
        box, tf = _add_textbox(slide, bar_x, track_y - 0.36,
                               bar_w, 0.32, margin=0.02)
        p = tf.paragraphs[0]
        p.alignment = PP_ALIGN.RIGHT
        r = p.add_run()
        r.text = f"{int(round(pct))}%"
        _set_run(r, theme, size=12, bold=True, color=theme["title_color"])
        status = it.get("status")
        if status:
            if isinstance(status, dict):
                stext = str(status.get("text", ""))
                sfill = _resolve_color(theme, status.get("fill") or theme["accent"])
                sfg = _resolve_color(theme, status.get("fg") or theme["on_accent"])
            else:
                stext = str(status)
                sfill = _resolve_color(theme, theme["accent"])
                sfg = _resolve_color(theme, theme["on_accent"])
            sw = max(0.9, min(bar_w, _approx_text_width(stext, 10) + 0.5))
            sx = bar_x + bar_w - sw
            sy = track_y + track_h + 0.06
            chip = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE,
                                          Inches(sx), Inches(sy),
                                          Inches(sw), Inches(0.28))
            _solid_fill(chip, sfill)
            _no_line(chip)
            chip.text_frame.vertical_anchor = MSO_ANCHOR.MIDDLE
            for prop in ("margin_left", "margin_right", "margin_top", "margin_bottom"):
                setattr(chip.text_frame, prop, Inches(0.04))
            sp = chip.text_frame.paragraphs[0]
            sp.alignment = PP_ALIGN.CENTER
            sr = sp.add_run()
            sr.text = stext
            _set_run(sr, theme, size=10, bold=True, color=sfg)


def _b_kpi_grid(slide, prs, theme, b):
    items = b.get("items") or []
    n = len(items)
    if n == 0:
        return
    cols = int(b.get("columns") or n)
    rows = (n + cols - 1) // cols
    gap = float(b.get("gap", 0.18))
    cw = (float(b["w"]) - gap * (cols - 1)) / cols
    ch = (float(b["h"]) - gap * (rows - 1)) / rows
    card_border = _resolve_color(theme, b.get("card_border") or theme["surface_alt"])
    for i, it in enumerate(items):
        r = i // cols
        c = i % cols
        cx = float(b["x"]) + c * (cw + gap)
        cy = float(b["y"]) + r * (ch + gap)
        card_fill = _resolve_color(theme, it.get("fill") or theme["surface"])
        card = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE,
                                      Inches(cx), Inches(cy), Inches(cw), Inches(ch))
        _solid_fill(card, card_fill)
        _set_line(card, card_border, 0.5)
        label = str(it.get("label", ""))
        box, tf = _add_textbox(slide, cx + 0.18, cy + 0.12,
                               cw - 0.36, 0.4, margin=0.02)
        r2 = tf.paragraphs[0].add_run()
        r2.text = label
        _set_run(r2, theme, size=11, bold=True, color=theme["muted"])
        value = str(it.get("value", ""))
        box, tf = _add_textbox(slide, cx + 0.18, cy + 0.45,
                               cw - 0.36, ch - 0.85, margin=0.02)
        tf.vertical_anchor = MSO_ANCHOR.MIDDLE
        r2 = tf.paragraphs[0].add_run()
        r2.text = value
        _set_run(r2, theme, size=int(it.get("value_size", 28)), bold=True,
                 color=_resolve_color(theme, it.get("value_color") or theme["accent"]))
        delta = it.get("delta")
        if delta:
            dcolor = _resolve_color(theme, it.get("delta_color") or theme["success"])
            box, tf = _add_textbox(slide, cx + 0.18, cy + ch - 0.45,
                                   cw - 0.36, 0.35, margin=0.02)
            r2 = tf.paragraphs[0].add_run()
            r2.text = str(delta)
            _set_run(r2, theme, size=12, bold=True, color=dcolor)


def _b_table(slide, prs, theme, b):
    _add_table(slide, theme, b)


def _b_chart(slide, prs, theme, b):
    kind = (b.get("kind") or "column").lower()
    chart_type = {
        "column": XL_CHART_TYPE.COLUMN_CLUSTERED,
        "column_stacked": XL_CHART_TYPE.COLUMN_STACKED,
        "bar": XL_CHART_TYPE.BAR_CLUSTERED,
        "bar_stacked": XL_CHART_TYPE.BAR_STACKED,
        "line": XL_CHART_TYPE.LINE,
        "line_markers": XL_CHART_TYPE.LINE_MARKERS,
        "pie": XL_CHART_TYPE.PIE,
        "doughnut": XL_CHART_TYPE.DOUGHNUT,
    }.get(kind, XL_CHART_TYPE.COLUMN_CLUSTERED)
    cats = b.get("categories") or []
    series = b.get("series") or []
    cd = CategoryChartData()
    cd.categories = cats
    for s in series:
        cd.add_series(s.get("name", "Series"), s.get("values") or [])
    chart_shape = slide.shapes.add_chart(chart_type,
                                         Inches(b["x"]), Inches(b["y"]),
                                         Inches(b["w"]), Inches(b["h"]),
                                         cd)
    chart = chart_shape.chart
    title = b.get("title")
    chart.has_title = bool(title)
    if title:
        chart.chart_title.text_frame.text = str(title)
        for p in chart.chart_title.text_frame.paragraphs:
            for r in p.runs:
                r.font.name = theme["font_name"]
                r.font.size = Pt(14)
                r.font.bold = True
                r.font.color.rgb = _hex_to_rgb(theme["title_color"])
    chart.has_legend = bool(b.get("show_legend", len(series) > 1))
    if chart.has_legend:
        chart.legend.position = XL_LEGEND_POSITION.BOTTOM
        chart.legend.include_in_layout = False
        try:
            chart.legend.font.size = Pt(10)
            chart.legend.font.color.rgb = _hex_to_rgb(theme["body_color"])
            chart.legend.font.name = theme["font_name"]
        except Exception:
            pass
    if b.get("show_values"):
        try:
            plot = chart.plots[0]
            plot.has_data_labels = True
            dl = plot.data_labels
            dl.font.size = Pt(10)
            dl.font.color.rgb = _hex_to_rgb(theme["body_color"])
            dl.font.name = theme["font_name"]
        except Exception:
            pass
    palette = b.get("colors") or [theme["accent"], theme["accent_dark"],
                                  theme["success"], theme["warning"], theme["danger"]]
    palette = [_resolve_color(theme, c) for c in palette]
    try:
        for i, s in enumerate(chart.series):
            fmt = s.format.fill
            fmt.solid()
            fmt.fore_color.rgb = _hex_to_rgb(palette[i % len(palette)])
    except Exception:
        pass
    # category/value axis styling
    try:
        for ax in (chart.category_axis, chart.value_axis):
            ax.tick_labels.font.size = Pt(10)
            ax.tick_labels.font.name = theme["font_name"]
            ax.tick_labels.font.color.rgb = _hex_to_rgb(theme["body_color"])
    except Exception:
        pass


def _b_banner(slide, prs, theme, b):
    fill = _resolve_color(theme, b.get("fill") or theme["surface_alt"])
    fg = _resolve_color(theme, b.get("fg") or theme["body_color"])
    rect = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE,
                                  Inches(b["x"]), Inches(b["y"]),
                                  Inches(b["w"]), Inches(b["h"]))
    _solid_fill(rect, fill)
    _no_line(rect)
    icon = b.get("icon")
    text_x = float(b["x"]) + 0.25
    if icon:
        ad = max(0.4, float(b["h"]) - 0.3)
        ax = float(b["x"]) + 0.2
        ay = float(b["y"]) + (float(b["h"]) - ad) / 2.0
        circ = slide.shapes.add_shape(MSO_SHAPE.OVAL,
                                      Inches(ax), Inches(ay),
                                      Inches(ad), Inches(ad))
        _solid_fill(circ, _resolve_color(theme, b.get("icon_color") or theme["accent"]))
        _no_line(circ)
        circ.text_frame.vertical_anchor = MSO_ANCHOR.MIDDLE
        for prop in ("margin_left", "margin_right", "margin_top", "margin_bottom"):
            setattr(circ.text_frame, prop, Inches(0.02))
        ip = circ.text_frame.paragraphs[0]
        ip.alignment = PP_ALIGN.CENTER
        ir = ip.add_run()
        ir.text = str(icon)
        _set_run(ir, theme, size=int(ad * 16), bold=True,
                 color=_resolve_color(theme, b.get("icon_fg") or theme["on_accent"]))
        text_x = ax + ad + 0.2
    text_w = float(b["x"]) + float(b["w"]) - text_x - 0.2
    box, tf = _add_textbox(slide, text_x, b["y"], text_w, b["h"],
                           anchor=MSO_ANCHOR.MIDDLE, margin=0.05)
    text = b.get("text")
    if isinstance(text, list):
        for i, line in enumerate(text):
            p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            p.alignment = _align(b.get("align", "left"))
            r = p.add_run()
            if isinstance(line, dict):
                r.text = str(line.get("text", ""))
                _set_run(r, theme,
                         size=line.get("size", b.get("size", 13)),
                         bold=line.get("bold", False),
                         italic=line.get("italic", False),
                         color=_resolve_color(theme, line.get("color")) or fg)
            else:
                r.text = str(line)
                _set_run(r, theme, size=b.get("size", 13), color=fg)
    else:
        p = tf.paragraphs[0]
        p.alignment = _align(b.get("align", "left"))
        r = p.add_run()
        r.text = str(text or "")
        _set_run(r, theme, size=b.get("size", 13), bold=b.get("bold", True), color=fg)


def _b_footer_bar(slide, prs, theme, b):
    fill = b.get("fill", "surface_alt")
    if fill is False or fill == "none":
        bar = None
    else:
        bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE,
                                     Inches(b["x"]), Inches(b["y"]),
                                     Inches(b["w"]), Inches(b["h"]))
        _solid_fill(bar, _resolve_color(theme, fill))
        _no_line(bar)
    fg = _resolve_color(theme, b.get("fg") or theme["muted"])
    left = b.get("left")
    right = b.get("right")
    if left:
        box, tf = _add_textbox(slide, b["x"] + 0.25, b["y"],
                               float(b["w"]) / 2.0 - 0.3, b["h"],
                               anchor=MSO_ANCHOR.MIDDLE, margin=0.04)
        p = tf.paragraphs[0]
        p.alignment = PP_ALIGN.LEFT
        r = p.add_run()
        r.text = str(left)
        _set_run(r, theme, size=b.get("size", 10), color=fg)
    if right:
        box, tf = _add_textbox(slide,
                               float(b["x"]) + float(b["w"]) / 2.0,
                               b["y"], float(b["w"]) / 2.0 - 0.25, b["h"],
                               anchor=MSO_ANCHOR.MIDDLE, margin=0.04)
        p = tf.paragraphs[0]
        p.alignment = PP_ALIGN.RIGHT
        r = p.add_run()
        r.text = str(right)
        _set_run(r, theme, size=b.get("size", 10), color=fg)


def _b_image(slide, prs, theme, b):
    path = b.get("path")
    if not path:
        raise ValueError("image block missing 'path'")
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"Image not found: {p}. HINT: When using image_search, you must use the EXACT path returned by the tool output. Do NOT guess filenames like '1.jpg' or 'image.png'.")
    kwargs: Dict[str, Any] = {}
    if b.get("w") is not None:
        kwargs["width"] = Inches(float(b["w"]))
    if b.get("h") is not None:
        kwargs["height"] = Inches(float(b["h"]))
    shape = slide.shapes.add_picture(str(p), Inches(b["x"]), Inches(b["y"]), **kwargs)
    if b.get("circle_mask"):
        _mask_image_to_circle(shape)
    if b.get("rotation"):
        _set_rotation(shape, b)
    if b.get("shadow"):
        _set_shadow(shape, theme, b["shadow"])
    if b.get("glow"):
        _set_glow(shape, theme, b["glow"])
    if b.get("hyperlink"):
        _set_hyperlink(shape, b["hyperlink"])
    cap = b.get("caption")
    if cap:
        cy = float(b["y"]) + float(b.get("h", 3.0)) + 0.05
        cx = float(b["x"])
        cw = float(b.get("w", 4.0))
        box, tf = _add_textbox(slide, cx, cy, cw, 0.4, margin=0.02)
        p2 = tf.paragraphs[0]
        p2.alignment = _align(b.get("caption_align", "center"))
        r = p2.add_run()
        r.text = str(cap)
        _set_run(r, theme, size=10, italic=True, color=theme["muted"])


def _b_divider(slide, prs, theme, b):
    color = _resolve_color(theme, b.get("color") or theme["surface_alt"])
    th = float(b.get("thickness", 0.02))
    line = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE,
                                  Inches(b["x"]), Inches(b["y"]),
                                  Inches(b["w"]), Inches(th))
    _solid_fill(line, color)
    _no_line(line)


def _b_gradient_shape(slide, prs, theme, b):
    kind = (b.get("kind") or "rounded").lower()
    sh_type = {
        "rect": MSO_SHAPE.RECTANGLE,
        "rectangle": MSO_SHAPE.RECTANGLE,
        "rounded": MSO_SHAPE.ROUNDED_RECTANGLE,
        "rounded_rect": MSO_SHAPE.ROUNDED_RECTANGLE,
        "oval": MSO_SHAPE.OVAL,
        "circle": MSO_SHAPE.OVAL,
    }.get(kind, MSO_SHAPE.ROUNDED_RECTANGLE)
    sh = slide.shapes.add_shape(sh_type,
                                Inches(b["x"]), Inches(b["y"]),
                                Inches(b["w"]), Inches(b["h"]))
    _set_gradient(sh, theme, b)
    if b.get("shadow"):
        _set_shadow(sh, theme, b["shadow"])
    if b.get("glow"):
        _set_glow(sh, theme, b["glow"])
    if b.get("reflection"):
        _set_reflection(sh, b["reflection"])
    if b.get("rotation"):
        _set_rotation(sh, b)
    line = b.get("line", "none")
    if line and line != "none":
        _set_line(sh, _resolve_color(theme, line), float(b.get("line_width", 0.75)))
    else:
        _no_line(sh)
    text = b.get("text")
    if text is not None:
        tf = sh.text_frame
        tf.word_wrap = True
        tf.vertical_anchor = _anchor(b.get("anchor", "middle"))
        for prop in ("margin_left", "margin_right", "margin_top", "margin_bottom"):
            setattr(tf, prop, Inches(float(b.get("padding", 0.08))))
        lines = text if isinstance(text, list) else [text]
        for i, line in enumerate(lines):
            p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            p.alignment = _align(b.get("align", "center"))
            r = p.add_run()
            if isinstance(line, dict):
                r.text = str(line.get("text", ""))
                _set_run(r, theme,
                         size=line.get("size", b.get("font_size", theme["body_size"])),
                         bold=line.get("bold", b.get("bold", False)),
                         italic=line.get("italic", False),
                         color=line.get("color", b.get("fg", "white")))
            else:
                r.text = str(line)
                _set_run(r, theme, size=b.get("font_size", theme["body_size"]),
                         bold=b.get("bold", False), color=b.get("fg", "white"))
    if b.get("hyperlink"):
        _set_hyperlink(sh, b["hyperlink"])


def _b_background_image(slide, prs, theme, b):
    path = b.get("path")
    if not path:
        raise ValueError("background_image block missing 'path'")
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"Image not found: {p}. HINT: When using image_search, you must use the EXACT path returned by the tool output. Do NOT guess filenames like '1.jpg' or 'image.png'.")
    
    # Full-slide image dimensions
    slide_width = prs.slide_width / 914400.0
    slide_height = prs.slide_height / 914400.0
    
    # Apply darkening effect if overlay_opacity is specified
    overlay_opacity = b.get("overlay_opacity")
    image_to_use = p
    
    if overlay_opacity is not None and overlay_opacity > 0:
        try:
            # Load image with PIL
            img = Image.open(p)
            # Darken the image: overlay_opacity 0 = no change, 1 = very dark
            # We use brightness reduction: 1.0 = original, 0.0 = black
            brightness_factor = 1.0 - float(overlay_opacity)
            if brightness_factor < 0.1:
                brightness_factor = 0.1  # Don't make it completely black
            enhancer = ImageEnhance.Brightness(img)
            darkened = enhancer.enhance(brightness_factor)
            
            # Save to temp file
            temp_path = Path("/workspace/temp") / f"darkened_{p.name}"
            temp_path.parent.mkdir(parents=True, exist_ok=True)
            darkened.save(temp_path)
            image_to_use = temp_path
        except Exception:
            # If PIL processing fails, use original image
            pass
    
    # Add the (possibly darkened) image to the slide
    pic = slide.shapes.add_picture(str(image_to_use), Inches(0), Inches(0),
                                   width=Inches(slide_width), height=Inches(slide_height))
    # Send to back so it's behind all other content
    pic.z_order = 0


def _b_text_columns(slide, prs, theme, b):
    cols = int(b.get("columns", 2))
    if cols < 2 or cols > 4:
        raise ValueError("text_columns: columns must be 2-4")
    gap = float(b.get("gap", 0.3))
    col_w = (float(b["w"]) - gap * (cols - 1)) / cols
    content = b.get("content") or []
    for i in range(cols):
        cx = float(b["x"]) + i * (col_w + gap)
        col_content = content[i] if i < len(content) else []
        if not col_content:
            continue
        box, tf = _add_textbox(slide, cx, b["y"], col_w, b["h"], margin=0.05)
        for j, item in enumerate(col_content):
            if isinstance(item, dict):
                p = tf.paragraphs[0] if j == 0 else tf.add_paragraph()
                r = p.add_run()
                r.text = str(item.get("text", ""))
                _set_run(r, theme,
                         size=item.get("size", b.get("size", theme["body_size"])),
                         bold=item.get("bold", False),
                         italic=item.get("italic", False),
                         color=item.get("color"))
            else:
                p = tf.paragraphs[0] if j == 0 else tf.add_paragraph()
                r = p.add_run()
                r.text = str(item)
                _set_run(r, theme, size=b.get("size", theme["body_size"]))


def _b_arrow_line(slide, prs, theme, b):
    from pptx.enum.connector import CONNECTOR
    from pptx.enum.shapes import MSO_CONNECTOR
    x1, y1 = float(b.get("x1", b["x"])), float(b.get("y1", b["y"]))
    x2, y2 = float(b.get("x2", b["x"] + b["w"])), float(b.get("y2", b["y"] + b["h"]))
    line = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT,
                                      Inches(x1), Inches(y1), Inches(x2), Inches(y2))
    color = _resolve_color(theme, b.get("color") or "accent")
    _set_line(line, color, float(b.get("width", 2.0)))
    if b.get("arrow_end"):
        try:
            line.line.end_arrowhead_style = CONNECTOR.ARROW
            line.line.end_arrowhead_width = CONNECTOR.WIDTH_MEDIUM
            line.line.end_arrowhead_length = CONNECTOR.LENGTH_MEDIUM
        except Exception:
            pass


def _b_curved_line(slide, prs, theme, b):
    from pptx.enum.connector import CONNECTOR
    from pptx.enum.shapes import MSO_CONNECTOR
    x1, y1 = float(b.get("x1", b["x"])), float(b.get("y1", b["y"]))
    x2, y2 = float(b.get("x2", b["x"] + b["w"])), float(b.get("y2", b["y"] + b["h"]))
    line = slide.shapes.add_connector(MSO_CONNECTOR.CURVED,
                                      Inches(x1), Inches(y1), Inches(x2), Inches(y2))
    color = _resolve_color(theme, b.get("color") or "accent")
    _set_line(line, color, float(b.get("width", 2.0)))
    if b.get("arrow_end"):
        try:
            line.line.end_arrowhead_style = CONNECTOR.ARROW
            line.line.end_arrowhead_width = CONNECTOR.WIDTH_MEDIUM
            line.line.end_arrowhead_length = CONNECTOR.LENGTH_MEDIUM
        except Exception:
            pass


def _b_watermark(slide, prs, theme, b):
    text = b.get("text")
    image_path = b.get("image")
    opacity = float(b.get("opacity", 0.15))
    if text:
        box, tf = _add_textbox(slide, b["x"], b["y"], b["w"], b["h"],
                               anchor=MSO_ANCHOR.MIDDLE)
        p = tf.paragraphs[0]
        p.alignment = PP_ALIGN.CENTER
        r = p.add_run()
        r.text = str(text)
        _set_run(r, theme, size=b.get("size", 72), bold=True,
                 color=b.get("color", "muted"))
        try:
            r.font.color.rgb = _hex_to_rgb(_resolve_color(theme, b.get("color") or "muted"))
            r.font.color.brightness = 1.0 - opacity
        except Exception:
            pass
    elif image_path:
        p = Path(image_path)
        if not p.exists():
            raise FileNotFoundError(f"Watermark image not found: {p}. HINT: When using image_search, you must use the EXACT path returned by the tool output. Do NOT guess filenames like '1.jpg' or 'image.png'.")
        shape = slide.shapes.add_picture(str(p), Inches(b["x"]), Inches(b["y"]))
        try:
            shape.fill.transparency = opacity
        except Exception:
            pass


def _b_diagram(slide, prs, theme, b):
    nodes = b.get("nodes") or []
    edges = b.get("edges") or []
    node_map = {}
    for i, node in enumerate(nodes):
        nx = float(b["x"]) + float(node.get("x", 0))
        ny = float(b["y"]) + float(node.get("y", 0))
        nw = float(node.get("w", 1.5))
        nh = float(node.get("h", 0.8))
        kind = (node.get("kind") or "rounded").lower()
        sh_type = {
            "rect": MSO_SHAPE.RECTANGLE,
            "rounded": MSO_SHAPE.ROUNDED_RECTANGLE,
            "oval": MSO_SHAPE.OVAL,
            "diamond": MSO_SHAPE.DIAMOND,
        }.get(kind, MSO_SHAPE.ROUNDED_RECTANGLE)
        sh = slide.shapes.add_shape(sh_type, Inches(nx), Inches(ny), Inches(nw), Inches(nh))
        fill = _resolve_color(theme, node.get("fill") or "surface")
        _solid_fill(sh, fill)
        border = node.get("border")
        if border and border != "none":
            _set_line(sh, _resolve_color(theme, border), 1.0)
        else:
            _no_line(sh)
        if node.get("gradient"):
            _set_gradient(sh, theme, node["gradient"])
        if node.get("shadow"):
            _set_shadow(sh, theme, node["shadow"])
        tf = sh.text_frame
        tf.word_wrap = True
        tf.vertical_anchor = MSO_ANCHOR.MIDDLE
        p = tf.paragraphs[0]
        p.alignment = PP_ALIGN.CENTER
        r = p.add_run()
        r.text = str(node.get("label", ""))
        _set_run(r, theme, size=node.get("size", 12), bold=node.get("bold", True),
                 color=node.get("fg", theme["title_color"]))
        if node.get("hyperlink"):
            _set_hyperlink(sh, node["hyperlink"])
        node_map[i] = sh
    for edge in edges:
        from_idx = edge.get("from")
        to_idx = edge.get("to")
        if from_idx in node_map and to_idx in node_map:
            from_sh = node_map[from_idx]
            to_sh = node_map[to_idx]
            line = slide.shapes.add_connector(
                MSO_CONNECTOR.CURVED if edge.get("curved") else MSO_CONNECTOR.STRAIGHT,
                from_sh.left, from_sh.top, to_sh.left, to_sh.top
            )
            color = _resolve_color(theme, edge.get("color") or "muted")
            _set_line(line, color, float(edge.get("width", 1.5)))
            if edge.get("arrow_end"):
                try:
                    line.line.end_arrowhead_style = CONNECTOR.ARROW
                    line.line.end_arrowhead_width = CONNECTOR.WIDTH_MEDIUM
                    line.line.end_arrowhead_length = CONNECTOR.LENGTH_MEDIUM
                except Exception:
                    pass


BLOCK_RENDERERS = {
    "title": _b_title,
    "text": _b_text,
    "header_bar": _b_header_bar,
    "accent_bar": _b_accent_bar,
    "shape": _b_shape,
    "gradient_shape": _b_gradient_shape,
    "pills": _b_pills,
    "bullets": _b_bullets,
    "card_grid": _b_card_grid,
    "progress_list": _b_progress_list,
    "kpi_grid": _b_kpi_grid,
    "table": _b_table,
    "chart": _b_chart,
    "banner": _b_banner,
    "footer_bar": _b_footer_bar,
    "image": _b_image,
    "divider": _b_divider,
    "background_image": _b_background_image,
    "text_columns": _b_text_columns,
    "arrow_line": _b_arrow_line,
    "curved_line": _b_curved_line,
    "watermark": _b_watermark,
    "diagram": _b_diagram,
}


# ── Legacy primitives (used by layout-based slides) ────────────────────────
def _add_title(slide, prs, text: str, theme: Dict[str, Any],
               y_in: float = 0.4, h_in: float = 1.0) -> None:
    width_in = prs.slide_width / 914400.0
    box, tf = _add_textbox(slide, 0.5, y_in, width_in - 1.0, h_in)
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.LEFT
    run = p.add_run()
    run.text = text
    _set_run(run, theme, size=int(theme["title_size"]), bold=True, color=theme["title_color"])


def _add_bullets(slide, items: List[Any], theme: Dict[str, Any],
                 left: float, top: float, width: float, height: float) -> None:
    _b_bullets(slide, None, theme,
               {"items": items, "x": left, "y": top, "w": width, "h": height})


def _add_image(slide, prs, img_spec: Dict[str, Any], theme: Dict[str, Any]) -> None:
    _b_image(slide, prs, theme, img_spec)


def _add_table(slide, theme: Dict[str, Any], t_spec: Dict[str, Any]) -> None:
    headers = t_spec.get("headers") or []
    rows = t_spec.get("rows") or []
    if not headers and not rows:
        raise ValueError("table spec missing both 'headers' and 'rows'")
    n_rows = (1 if headers else 0) + len(rows)
    n_cols = max(len(headers), max((len(r) for r in rows), default=0))
    if n_cols == 0:
        raise ValueError("table spec has zero columns")
    x = Inches(float(t_spec.get("x", 0.5)))
    y = Inches(float(t_spec.get("y", 1.5)))
    w = Inches(float(t_spec.get("w", 9.0)))
    h = Inches(float(t_spec.get("h", max(0.5, 0.4 * n_rows))))
    shape = slide.shapes.add_table(n_rows, n_cols, x, y, w, h)
    table = shape.table
    cw = t_spec.get("column_widths")
    if cw and len(cw) == n_cols:
        for i, ww in enumerate(cw):
            table.columns[i].width = Inches(float(ww))
    header_fill = _resolve_color(theme, t_spec.get("header_fill") or theme["accent"])
    header_fg = _resolve_color(theme, t_spec.get("header_fg") or theme["on_accent"])
    body_fg = _resolve_color(theme, t_spec.get("body_color") or theme["body_color"])
    body_size = int(t_spec.get("body_size", max(11, int(theme["body_size"]) - 4)))
    zebra = bool(t_spec.get("zebra", False))
    zebra_color = _resolve_color(theme, t_spec.get("zebra_color") or theme["surface_alt"])
    first_row_bold = bool(t_spec.get("first_row_bold", True))
    align = t_spec.get("align") or "left"
    header_align = t_spec.get("header_align") or align

    def _fill_cell(cell, text, *, bold, fill_hex, fg_hex, align_name, size):
        cell.text = ""
        tf = cell.text_frame
        tf.word_wrap = True
        for prop in ("margin_left", "margin_right", "margin_top", "margin_bottom"):
            setattr(tf, prop, Inches(0.06))
        p = tf.paragraphs[0]
        p.alignment = _align(align_name)
        run = p.add_run()
        run.text = str(text)
        _set_run(run, theme, size=size, bold=bold, color=fg_hex)
        if fill_hex:
            cell.fill.solid()
            cell.fill.fore_color.rgb = _hex_to_rgb(fill_hex)

    r0 = 0
    if headers:
        for c_idx, htxt in enumerate(headers):
            _fill_cell(table.cell(r0, c_idx), htxt, bold=first_row_bold,
                       fill_hex=header_fill, fg_hex=header_fg,
                       align_name=header_align, size=body_size + 1)
        r0 = 1
    for r_idx, row in enumerate(rows):
        z = zebra and (r_idx % 2 == 1)
        for c_idx in range(n_cols):
            val = row[c_idx] if c_idx < len(row) else ""
            _fill_cell(table.cell(r0 + r_idx, c_idx), val, bold=False,
                       fill_hex=zebra_color if z else None, fg_hex=body_fg,
                       align_name=align, size=body_size)


def _add_footer(slide, prs, text: str, theme: Dict[str, Any]) -> None:
    sw_in = prs.slide_width / 914400.0
    sh_in = prs.slide_height / 914400.0
    box, tf = _add_textbox(slide, 0.5, sh_in - 0.4, sw_in - 1.0, 0.3)
    tf.word_wrap = False
    run = tf.paragraphs[0].add_run()
    run.text = text
    _set_run(run, theme, size=DEFAULT_FOOTER_SIZE, color=theme["muted"])


def _add_page_number(slide, prs, idx: int, total: int, theme: Dict[str, Any]) -> None:
    sw_in = prs.slide_width / 914400.0
    sh_in = prs.slide_height / 914400.0
    box, tf = _add_textbox(slide, sw_in - 1.5, sh_in - 0.4, 1.0, 0.3)
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.RIGHT
    run = p.add_run()
    run.text = f"{idx} / {total}"
    _set_run(run, theme, size=DEFAULT_FOOTER_SIZE, color=theme["muted"])


def _add_notes(slide, text: str) -> None:
    notes = slide.notes_slide
    notes.notes_text_frame.text = str(text)


# ── Slide builder ──────────────────────────────────────────────────────────
def _build_slide(prs: Presentation, slide_spec: Dict[str, Any],
                 theme: Dict[str, Any], idx: int, total: int) -> None:
    blank = prs.slide_layouts[6]
    slide = prs.slides.add_slide(blank)

    bg = slide_spec.get("background") or theme["background"]
    if bg:
        _paint_background(slide, _resolve_color(theme, bg))

    sw_in = prs.slide_width / 914400.0
    sh_in = prs.slide_height / 914400.0
    blocks = slide_spec.get("blocks")

    if blocks:
        for b in blocks:
            t = (b or {}).get("type")
            fn = BLOCK_RENDERERS.get(t)
            if fn is None:
                raise ValueError(f"Unknown block type '{t}' on slide {idx}")
            fn(slide, prs, theme, b)
    else:
        layout = (slide_spec.get("layout") or "title_content").lower()
        title = slide_spec.get("title")
        if layout == "blank":
            pass
        elif layout == "title":
            if title:
                box, tf = _add_textbox(slide, 0.5, sh_in / 2 - 1.2,
                                       sw_in - 1.0, 1.4)
                p = tf.paragraphs[0]
                p.alignment = PP_ALIGN.CENTER
                run = p.add_run()
                run.text = title
                _set_run(run, theme, size=int(theme["title_size"]) + 12,
                         bold=True, color=theme["title_color"])
            sub = slide_spec.get("subtitle")
            if sub:
                box, tf = _add_textbox(slide, 0.5, sh_in / 2 + 0.3,
                                       sw_in - 1.0, 0.8)
                p = tf.paragraphs[0]
                p.alignment = PP_ALIGN.CENTER
                run = p.add_run()
                run.text = sub
                _set_run(run, theme, size=int(theme["body_size"]) + 4,
                         color=theme["body_color"])
        elif layout == "section":
            if title:
                box, tf = _add_textbox(slide, 0.5, sh_in / 2 - 0.6,
                                       sw_in - 1.0, 1.2)
                p = tf.paragraphs[0]
                p.alignment = PP_ALIGN.LEFT
                run = p.add_run()
                run.text = title
                _set_run(run, theme, size=int(theme["title_size"]) + 6,
                         bold=True, color=theme["accent"])
        elif layout == "title_content":
            if title:
                _add_title(slide, prs, title, theme)
            if slide_spec.get("content"):
                _add_bullets(slide, slide_spec["content"], theme,
                             left=0.5, top=1.5,
                             width=sw_in - 1.0, height=sh_in - 2.0)
            if slide_spec.get("image"):
                _add_image(slide, prs, slide_spec["image"], theme)
            if slide_spec.get("table"):
                _add_table(slide, theme, slide_spec["table"])
        elif layout == "two_content":
            if title:
                _add_title(slide, prs, title, theme)
            col_w = (sw_in - 1.5) / 2.0
            _add_bullets(slide, slide_spec.get("left") or [], theme,
                         left=0.5, top=1.5,
                         width=col_w, height=sh_in - 2.0)
            _add_bullets(slide, slide_spec.get("right") or [], theme,
                         left=0.5 + col_w + 0.5, top=1.5,
                         width=col_w, height=sh_in - 2.0)
        elif layout == "picture":
            if title:
                _add_title(slide, prs, title, theme)
            if slide_spec.get("image"):
                _add_image(slide, prs, slide_spec["image"], theme)
        else:
            raise ValueError(
                f"Unsupported layout '{layout}' "
                f"(use title|title_content|two_content|section|picture|blank)"
            )

    if slide_spec.get("footer"):
        _add_footer(slide, prs, slide_spec["footer"], theme)
    if slide_spec.get("page_number"):
        _add_page_number(slide, prs, idx, total, theme)
    if slide_spec.get("notes"):
        _add_notes(slide, slide_spec["notes"])


def build(spec: Dict[str, Any], output: Path) -> None:
    prs = Presentation()
    _set_slide_size(prs, spec.get("slide_size", "16:9"))
    theme = _resolve_theme(spec)

    slides = spec.get("slides") or []
    if not slides:
        raise ValueError("spec.slides must contain at least one slide.")

    total = len(slides)
    for i, slide_spec in enumerate(slides, start=1):
        _build_slide(prs, slide_spec, theme, i, total)

    props = spec.get("properties") or {}
    if props.get("title"):
        prs.core_properties.title = props["title"]
    if props.get("author"):
        prs.core_properties.author = props["author"]
    if props.get("subject"):
        prs.core_properties.subject = props["subject"]

    output.parent.mkdir(parents=True, exist_ok=True)
    prs.save(str(output))


def main() -> None:
    p = argparse.ArgumentParser(description="Build a .pptx presentation from a JSON spec.")
    p.add_argument("--spec", required=True)
    p.add_argument("--output", required=True)
    args = p.parse_args()

    spec_path = Path(args.spec)
    if not spec_path.exists():
        print(f"Error: spec file not found: {spec_path}", file=sys.stderr)
        sys.exit(1)
    try:
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"Error: invalid JSON in spec: {exc}", file=sys.stderr)
        sys.exit(1)

    out = Path(args.output)
    if out.suffix.lower() != ".pptx":
        print(f"Error: output must end with .pptx (got {out.suffix})", file=sys.stderr)
        sys.exit(1)

    try:
        build(spec, out)
    except Exception as exc:
        print(f"Error building presentation: {exc}", file=sys.stderr)
        sys.exit(1)

    print(f"Presentation built -> {out}  (run pptx_qa.py for validation)")


if __name__ == "__main__":
    main()
