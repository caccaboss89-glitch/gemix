#!/usr/bin/env python3
"""Structural QA for pptxgenjs decks — slide backgrounds and contrast risks.

Usage:
    python /skills/pptx/scripts/inspect_pptx.py /workspace/deck.pptx

Exits 0 when backgrounds look intentional; exits 1 when every slide inherits
the default white background (common when slide.background was never set).
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    from pptx import Presentation
    from pptx.enum.dml import MSO_FILL_TYPE
except ImportError:
    print("Error: python-pptx is required", file=sys.stderr)
    sys.exit(2)


def _hex6(rgb) -> str | None:
    if rgb is None:
        return None
    try:
        val = str(rgb).upper()
    except Exception:
        return None
    val = re.sub(r"[^0-9A-F]", "", val)
    if len(val) >= 6:
        return val[-6:]
    return None


def _luminance(hex6: str) -> float:
    r = int(hex6[0:2], 16)
    g = int(hex6[2:4], 16)
    b = int(hex6[4:6], 16)
    return 0.299 * r + 0.587 * g + 0.114 * b


def slide_background_hex(slide) -> str | None:
    try:
        fill = slide.background.fill
        if fill.type == MSO_FILL_TYPE.SOLID:
            return _hex6(fill.fore_color.rgb)
    except Exception:
        pass
    return None


def sample_text_hex(slide) -> str | None:
    for shape in slide.shapes:
        if not getattr(shape, "has_text_frame", False):
            continue
        try:
            for para in shape.text_frame.paragraphs:
                for run in para.runs:
                    rgb = _hex6(run.font.color.rgb)
                    if rgb:
                        return rgb
        except Exception:
            continue
    return None


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: inspect_pptx.py /workspace/deck.pptx", file=sys.stderr)
        sys.exit(2)

    path = Path(sys.argv[1])
    if not path.is_file():
        print(f"Error: {path} not found", file=sys.stderr)
        sys.exit(2)

    prs = Presentation(str(path))
    n = len(prs.slides)
    print(f"slides={n}")

    unset = 0
    light_bg = 0
    risky = 0

    for i, slide in enumerate(prs.slides, 1):
        bg = slide_background_hex(slide)
        txt = sample_text_hex(slide)
        bg_label = bg or "inherit (default white in PowerPoint)"
        print(f"  slide {i}: background={bg_label} sample_text={txt or 'n/a'}")

        if bg is None:
            unset += 1
            effective_bg_lum = 255.0
        else:
            effective_bg_lum = _luminance(bg)
            if effective_bg_lum > 200:
                light_bg += 1

        if txt and effective_bg_lum > 200 and _luminance(txt) > 200:
            risky += 1
            print(
                f"    WARN slide {i}: light text ({txt}) on light/white background — poor contrast",
            )

    if n == 0:
        print("Error: deck has no slides", file=sys.stderr)
        sys.exit(1)

    if unset == n:
        print(
            "FAIL: no slide sets slide.background — dark-theme text will sit on white. "
            "Call addChrome() (or slide.background = { color: C.bg }) on EVERY slide.",
            file=sys.stderr,
        )
        sys.exit(1)

    if risky > 0:
        print(
            f"FAIL: {risky} slide(s) with light-on-light text. Fix palette or backgrounds, then re-render.",
            file=sys.stderr,
        )
        sys.exit(1)

    if light_bg == n:
        print(
            "WARN: all slide backgrounds are very light — confirm this matches the brief.",
            file=sys.stderr,
        )

    print("OK: backgrounds and sampled text colors look consistent.")
    sys.exit(0)


if __name__ == "__main__":
    main()