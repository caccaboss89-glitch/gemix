#!/usr/bin/env python3
"""Static QA checks on a .pptx without rendering.

Detects (per slide):
  - off_slide        : shapes that overflow the slide canvas (or have negative pos)
  - overlaps         : pairs of shapes whose bounding boxes overlap
  - tiny_text        : runs with font size below --min-font-pt (default 10)
  - leftover_text    : matches against placeholder regex (lorem|ipsum|xxxx|tbd|todo|placeholder)
  - empty_title      : layouts that should have a title but don't
  - dense_text       : text boxes whose chars/in² ratio exceeds --max-density
  - low_contrast     : warns if text RGB ≈ background RGB on the same slide
                       (luma delta < --contrast-threshold, default 0.25)

Use as a Phase-3 step right after pptx_build.py and BEFORE the visual render
loop, to catch obvious problems instantly without invoking LibreOffice.
"""
import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE_TYPE


PLACEHOLDER_PATTERNS = [
    r"\blorem\b", r"\bipsum\b", r"\bxxxx+\b", r"\btbd\b", r"\btodo\b",
    r"\bplaceholder\b", r"this\s+(?:page|slide)\s+layout",
    r"\bclick\s+to\s+add\b",
]
PLACEHOLDER_RE = re.compile("|".join(PLACEHOLDER_PATTERNS), re.IGNORECASE)


def _emu_in(v: Optional[int]) -> Optional[float]:
    return None if v is None else round(v / 914400.0, 3)


def _shape_box(shape) -> Optional[Tuple[float, float, float, float]]:
    try:
        l, t, w, h = shape.left, shape.top, shape.width, shape.height
        if None in (l, t, w, h):
            return None
        return (_emu_in(l), _emu_in(t), _emu_in(w), _emu_in(h))
    except Exception:
        return None


def _boxes_overlap(a, b, tolerance_in: float = 0.05) -> bool:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    if ax + aw <= bx + tolerance_in or bx + bw <= ax + tolerance_in:
        return False
    if ay + ah <= by + tolerance_in or by + bh <= ay + tolerance_in:
        return False
    return True


def _runs(shape) -> List[Any]:
    if not shape.has_text_frame:
        return []
    out = []
    for para in shape.text_frame.paragraphs:
        for run in para.runs:
            out.append(run)
    return out


def _shape_text(shape) -> str:
    if not shape.has_text_frame:
        return ""
    return shape.text_frame.text or ""


def _font_size_pt(run) -> Optional[float]:
    try:
        if run.font.size is not None:
            return run.font.size.pt
    except Exception:
        return None
    return None


def _rgb_or_none(color_format) -> Optional[Tuple[int, int, int]]:
    try:
        if color_format.type is None:
            return None
        rgb = color_format.rgb
        if rgb is None:
            return None
        return (rgb[0], rgb[1], rgb[2])
    except Exception:
        return None


def _luma(rgb: Tuple[int, int, int]) -> float:
    r, g, b = (c / 255.0 for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _slide_background_rgb(slide) -> Optional[Tuple[int, int, int]]:
    try:
        fill = slide.background.fill
        if fill.type is not None:
            return _rgb_or_none(fill.fore_color)
    except Exception:
        return None
    return None


def _shape_kind(shape) -> str:
    try:
        return str(shape.shape_type)
    except Exception:
        return "unknown"


def _qa_slide(idx: int, slide, slide_w_in: float, slide_h_in: float,
              min_font_pt: float, max_density: float,
              contrast_threshold: float) -> Dict[str, Any]:
    issues: Dict[str, List[Dict[str, Any]]] = {
        "off_slide": [], "overlaps": [], "tiny_text": [],
        "leftover_text": [], "empty_title": [],
        "dense_text": [], "low_contrast": [],
    }

    # 1. Empty title check
    try:
        title_sh = slide.shapes.title
    except Exception:
        title_sh = None
    if title_sh is not None and not (title_sh.text or "").strip():
        issues["empty_title"].append({"shape": title_sh.name})

    bg_rgb = _slide_background_rgb(slide)
    bg_luma = _luma(bg_rgb) if bg_rgb else None

    boxes: List[Tuple[int, str, Tuple[float, float, float, float]]] = []

    for sh_idx, shape in enumerate(slide.shapes):
        kind = _shape_kind(shape)
        box = _shape_box(shape)

        # 2. Off-slide / negative geometry
        if box:
            x, y, w, h = box
            if x < -0.05 or y < -0.05 or (x + w) > slide_w_in + 0.05 or (y + h) > slide_h_in + 0.05:
                issues["off_slide"].append({
                    "shape": shape.name, "kind": kind,
                    "box_in": box,
                    "slide_in": [slide_w_in, slide_h_in],
                })
            boxes.append((sh_idx, shape.name, box))

        # 3. Tiny font + 4. low contrast on text shapes
        text = _shape_text(shape)
        char_count = len(text)
        for run in _runs(shape):
            sz = _font_size_pt(run)
            if sz is not None and sz < min_font_pt and (run.text or "").strip():
                issues["tiny_text"].append({
                    "shape": shape.name, "size_pt": sz, "text": run.text[:60],
                })
            if bg_luma is not None:
                rgb = _rgb_or_none(run.font.color)
                if rgb is not None and (run.text or "").strip():
                    if abs(_luma(rgb) - bg_luma) < contrast_threshold:
                        issues["low_contrast"].append({
                            "shape": shape.name,
                            "text_rgb": rgb,
                            "background_rgb": bg_rgb,
                            "text_sample": run.text[:60],
                        })

        # 5. Leftover placeholder text
        if text:
            m = PLACEHOLDER_RE.search(text)
            if m:
                issues["leftover_text"].append({
                    "shape": shape.name, "match": m.group(0),
                    "text_sample": text[:120],
                })

        # 6. Dense text (chars per in²)
        if char_count > 0 and box and shape.has_text_frame:
            _, _, w, h = box
            area = max(0.01, w * h)
            density = char_count / area
            if density > max_density:
                issues["dense_text"].append({
                    "shape": shape.name, "chars": char_count,
                    "area_in2": round(area, 2),
                    "density_chars_per_in2": round(density, 1),
                    "limit": max_density,
                })

    # 7. Overlap pairs (skip group containers, accept small tolerance)
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            ai, an, ab = boxes[i]
            bi, bn, bb = boxes[j]
            if _boxes_overlap(ab, bb):
                issues["overlaps"].append({
                    "shape_a": an, "shape_b": bn,
                    "box_a": ab, "box_b": bb,
                })

    total = sum(len(v) for v in issues.values())
    return {
        "index": idx,
        "title": (title_sh.text if title_sh is not None else None),
        "issue_count": total,
        "issues": {k: v for k, v in issues.items() if v},
    }


def qa(input_path: Path, min_font_pt: float, max_density: float,
       contrast_threshold: float) -> Dict[str, Any]:
    if not input_path.exists():
        raise FileNotFoundError(f"File not found: {input_path}")
    prs = Presentation(str(input_path))
    sw_in = _emu_in(prs.slide_width) or 13.333
    sh_in = _emu_in(prs.slide_height) or 7.5

    slides_out = []
    for s_idx, slide in enumerate(prs.slides, start=1):
        slides_out.append(_qa_slide(
            s_idx, slide, sw_in, sh_in,
            min_font_pt=min_font_pt,
            max_density=max_density,
            contrast_threshold=contrast_threshold,
        ))

    total_issues = sum(s["issue_count"] for s in slides_out)
    return {
        "file": str(input_path),
        "slide_count": len(prs.slides),
        "slide_size_in": [sw_in, sh_in],
        "total_issues": total_issues,
        "status": "ok" if total_issues == 0 else "issues_found",
        "slides": slides_out,
    }


def main() -> None:
    p = argparse.ArgumentParser(description="Static QA on a .pptx (no render).")
    p.add_argument("--input", required=True)
    p.add_argument("--output", help="Write JSON here (default: stdout)")
    p.add_argument("--min-font-pt", type=float, default=10.0)
    p.add_argument("--max-density", type=float, default=85.0,
                   help="chars per in² before flagging dense_text (default 85)")
    p.add_argument("--contrast-threshold", type=float, default=0.25,
                   help="luma delta below which text is flagged low_contrast (0..1)")
    args = p.parse_args()

    try:
        report = qa(
            Path(args.input),
            min_font_pt=args.min_font_pt,
            max_density=args.max_density,
            contrast_threshold=args.contrast_threshold,
        )
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)

    payload = json.dumps(report, indent=2, ensure_ascii=False, default=str)
    if args.output:
        out = Path(args.output)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(payload, encoding="utf-8")
        print(f"QA report written -> {out}  (status={report['status']}, issues={report['total_issues']})")
    else:
        print(payload)


if __name__ == "__main__":
    main()
