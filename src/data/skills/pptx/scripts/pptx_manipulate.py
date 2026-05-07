#!/usr/bin/env python3
"""Manipulate .pptx files: merge, extract, split, info.

Slide copying uses python-pptx + lxml deepcopy of the slide's spTree onto a
blank layout in the destination. This is the standard recipe and preserves
text, images, tables, and shapes WITHOUT inheriting source masters/themes.
Limitations:
  - Source theme colors/fonts that resolve via the master are NOT preserved;
    explicit RGB/Pt values are. For fully theme-faithful merges, convert each
    deck to PDF with pptx_convert.py first and stitch them outside this tool.
  - Charts, embedded media, and SmartArt may degrade because their relations
    are not deep-copied.
"""
import argparse
import copy
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from pptx import Presentation


def _emu_in(v: Optional[int]) -> Optional[float]:
    return None if v is None else round(v / 914400.0, 3)


def _copy_slide(src_slide, dest_prs) -> None:
    blank = dest_prs.slide_layouts[6]
    new_slide = dest_prs.slides.add_slide(blank)
    # Remove blank-layout placeholders so we don't get residual text frames.
    for ph in list(new_slide.placeholders):
        sp = ph._element
        sp.getparent().remove(sp)
    for shape in src_slide.shapes:
        el = shape.element
        new_slide.shapes._spTree.append(copy.deepcopy(el))
    # Copy notes if present
    try:
        if src_slide.has_notes_slide:
            new_slide.notes_slide.notes_text_frame.text = (
                src_slide.notes_slide.notes_text_frame.text or ""
            )
    except Exception:
        pass


def _parse_indices(spec: str, total: int) -> List[int]:
    """Parse '1,3-5,8' into a sorted list of 1-based indices."""
    out: List[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            a, b = int(a), int(b)
            if a > b:
                a, b = b, a
            out.extend(range(a, b + 1))
        else:
            out.append(int(part))
    out = [i for i in out if 1 <= i <= total]
    return sorted(set(out))


# ── merge ──────────────────────────────────────────────────────────────────

def cmd_merge(inputs: Sequence[Path], output: Path,
              slide_size_from: Optional[int]) -> Dict[str, Any]:
    if len(inputs) < 2:
        raise ValueError("merge requires at least 2 input files.")
    base_idx = (slide_size_from or 1) - 1
    if not (0 <= base_idx < len(inputs)):
        raise ValueError(f"--slide-size-from out of range (1..{len(inputs)})")

    src0 = Presentation(str(inputs[base_idx]))
    dest = Presentation()
    dest.slide_width = src0.slide_width
    dest.slide_height = src0.slide_height

    counts = []
    for path in inputs:
        prs = Presentation(str(path))
        n = 0
        for slide in prs.slides:
            _copy_slide(slide, dest)
            n += 1
        counts.append({"file": str(path), "slides_copied": n})

    output.parent.mkdir(parents=True, exist_ok=True)
    dest.save(str(output))
    return {
        "action": "merge",
        "output": str(output),
        "slide_size_inherited_from": str(inputs[base_idx]),
        "inputs": counts,
        "total_slides": len(dest.slides),
    }


# ── extract ────────────────────────────────────────────────────────────────

def cmd_extract(input_path: Path, slides: str, output: Path) -> Dict[str, Any]:
    src = Presentation(str(input_path))
    indices = _parse_indices(slides, len(src.slides))
    if not indices:
        raise ValueError(f"No valid slide indices in '{slides}' (file has {len(src.slides)} slides)")

    dest = Presentation()
    dest.slide_width = src.slide_width
    dest.slide_height = src.slide_height
    src_slides = list(src.slides)
    for idx in indices:
        _copy_slide(src_slides[idx - 1], dest)

    output.parent.mkdir(parents=True, exist_ok=True)
    dest.save(str(output))
    return {
        "action": "extract",
        "input": str(input_path),
        "output": str(output),
        "slides_extracted": indices,
        "total": len(indices),
    }


# ── split ──────────────────────────────────────────────────────────────────

def cmd_split(input_path: Path, output_prefix: str) -> Dict[str, Any]:
    src = Presentation(str(input_path))
    out_files: List[str] = []
    src_slides = list(src.slides)
    pad = max(3, len(str(len(src_slides))))
    for idx, slide in enumerate(src_slides, start=1):
        dest = Presentation()
        dest.slide_width = src.slide_width
        dest.slide_height = src.slide_height
        _copy_slide(slide, dest)
        out_path = Path(f"{output_prefix}_{str(idx).zfill(pad)}.pptx")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        dest.save(str(out_path))
        out_files.append(str(out_path))
    return {
        "action": "split",
        "input": str(input_path),
        "outputs": out_files,
        "count": len(out_files),
    }


# ── info ───────────────────────────────────────────────────────────────────

def cmd_info(input_path: Path) -> Dict[str, Any]:
    prs = Presentation(str(input_path))
    core = prs.core_properties
    slides = []
    for i, slide in enumerate(prs.slides, start=1):
        try:
            title = slide.shapes.title.text if slide.shapes.title is not None else None
        except Exception:
            title = None
        slides.append({"index": i, "title": title,
                       "shape_count": len(slide.shapes),
                       "layout": slide.slide_layout.name if slide.slide_layout else None})
    return {
        "action": "info",
        "file": str(input_path),
        "slide_width_in": _emu_in(prs.slide_width),
        "slide_height_in": _emu_in(prs.slide_height),
        "slide_count": len(prs.slides),
        "properties": {
            "title": core.title, "author": core.author,
            "subject": core.subject,
            "modified": str(core.modified) if core.modified else None,
        },
        "slides": slides,
    }


def main() -> None:
    p = argparse.ArgumentParser(description="Manipulate .pptx files (merge / extract / split / info).")
    sub = p.add_subparsers(dest="action", required=True)

    p_merge = sub.add_parser("merge", help="Concatenate slides from multiple .pptx files.")
    p_merge.add_argument("--inputs", nargs="+", required=True)
    p_merge.add_argument("--output", required=True)
    p_merge.add_argument("--slide-size-from", type=int, default=1,
                         help="1-based index of the input whose slide size is inherited (default 1)")

    p_ext = sub.add_parser("extract", help="Extract a subset of slides by index range.")
    p_ext.add_argument("--input", required=True)
    p_ext.add_argument("--slides", required=True, help='Index spec like "1,3-5,8"')
    p_ext.add_argument("--output", required=True)

    p_split = sub.add_parser("split", help="Split into one .pptx per slide.")
    p_split.add_argument("--input", required=True)
    p_split.add_argument("--output-prefix", required=True)

    p_info = sub.add_parser("info", help="Print metadata + slide inventory.")
    p_info.add_argument("--input", required=True)

    args = p.parse_args()

    try:
        if args.action == "merge":
            res = cmd_merge([Path(x) for x in args.inputs], Path(args.output),
                            slide_size_from=args.slide_size_from)
        elif args.action == "extract":
            res = cmd_extract(Path(args.input), args.slides, Path(args.output))
        elif args.action == "split":
            res = cmd_split(Path(args.input), args.output_prefix)
        elif args.action == "info":
            res = cmd_info(Path(args.input))
        else:
            raise ValueError(f"unknown action: {args.action}")
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)

    print(json.dumps(res, indent=2, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
