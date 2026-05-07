#!/usr/bin/env python3
"""Inspect a .pptx presentation and emit a JSON summary.

This is the FIRST tool the AI runs on any pre-existing presentation, because
the GemiX runtime does not auto-parse .pptx files (unlike PDFs). `read_file`
on a binary .pptx returns garbage.

Output: structured JSON with slide inventory, titles, text, tables, images,
notes, layouts, and theme colors. Optionally extracts embedded images.
"""
import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE


def _emu_to_in(value: Optional[int]) -> Optional[float]:
    if value is None:
        return None
    return round(value / 914400.0, 3)


def _shape_kind(shape) -> str:
    try:
        st = shape.shape_type
    except Exception:
        return "unknown"
    mapping = {
        MSO_SHAPE_TYPE.AUTO_SHAPE: "auto_shape",
        MSO_SHAPE_TYPE.PICTURE: "picture",
        MSO_SHAPE_TYPE.TABLE: "table",
        MSO_SHAPE_TYPE.CHART: "chart",
        MSO_SHAPE_TYPE.GROUP: "group",
        MSO_SHAPE_TYPE.LINE: "line",
        MSO_SHAPE_TYPE.PLACEHOLDER: "placeholder",
        MSO_SHAPE_TYPE.TEXT_BOX: "text_box",
        MSO_SHAPE_TYPE.MEDIA: "media",
        MSO_SHAPE_TYPE.FREEFORM: "freeform",
    }
    return mapping.get(st, str(st) if st is not None else "unknown")


def _collect_text(shape) -> str:
    if not shape.has_text_frame:
        return ""
    parts: List[str] = []
    for para in shape.text_frame.paragraphs:
        line = "".join(run.text for run in para.runs)
        if not line:
            line = para.text or ""
        parts.append(line)
    return "\n".join(p for p in parts if p)


def _table_summary(shape) -> Dict[str, Any]:
    tbl = shape.table
    rows = []
    for r_idx, row in enumerate(tbl.rows):
        cells = []
        for cell in row.cells:
            cells.append(cell.text.strip())
        rows.append(cells)
    return {
        "rows": len(rows),
        "cols": len(rows[0]) if rows else 0,
        "data": rows,
    }


def _image_summary(shape, extract_dir: Optional[Path], slide_idx: int, shape_idx: int) -> Dict[str, Any]:
    img = shape.image
    info = {
        "content_type": img.content_type,
        "ext": img.ext,
        "size_bytes": len(img.blob),
    }
    if extract_dir is not None:
        extract_dir.mkdir(parents=True, exist_ok=True)
        out = extract_dir / f"slide{slide_idx:02d}_shape{shape_idx:02d}.{img.ext}"
        out.write_bytes(img.blob)
        info["saved_to"] = str(out)
    return info


def _shape_geom(shape) -> Dict[str, Any]:
    try:
        return {
            "left_in": _emu_to_in(shape.left),
            "top_in": _emu_to_in(shape.top),
            "width_in": _emu_to_in(shape.width),
            "height_in": _emu_to_in(shape.height),
        }
    except Exception:
        return {"left_in": None, "top_in": None, "width_in": None, "height_in": None}


def _scan_shape(shape, slide_idx: int, shape_idx: int,
                extract_dir: Optional[Path]) -> Dict[str, Any]:
    kind = _shape_kind(shape)
    out: Dict[str, Any] = {
        "index": shape_idx,
        "name": getattr(shape, "name", None),
        "kind": kind,
        **_shape_geom(shape),
    }
    if shape.has_text_frame:
        out["text"] = _collect_text(shape)
    if kind == "picture":
        try:
            out["image"] = _image_summary(shape, extract_dir, slide_idx, shape_idx)
        except Exception as exc:
            out["image_error"] = str(exc)
    if kind == "table":
        try:
            out["table"] = _table_summary(shape)
        except Exception as exc:
            out["table_error"] = str(exc)
    if kind == "group":
        children = []
        for i, child in enumerate(shape.shapes):
            children.append(_scan_shape(child, slide_idx, i, extract_dir))
        out["children"] = children
    if shape.is_placeholder:
        try:
            out["placeholder"] = {
                "idx": shape.placeholder_format.idx,
                "type": str(shape.placeholder_format.type),
            }
        except Exception:
            pass
    return out


def _slide_title(slide) -> Optional[str]:
    try:
        if slide.shapes.title is not None:
            return slide.shapes.title.text or None
    except Exception:
        pass
    return None


def _notes_text(slide) -> Optional[str]:
    try:
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame is not None:
            txt = slide.notes_slide.notes_text_frame.text
            return txt or None
    except Exception:
        pass
    return None


def inspect(input_path: Path, extract_images: Optional[Path],
            text_only: bool) -> Dict[str, Any]:
    if not input_path.exists():
        raise FileNotFoundError(f"File not found: {input_path}")
    if input_path.suffix.lower() != ".pptx":
        raise ValueError(f"Unsupported extension: {input_path.suffix} (use .pptx)")

    prs = Presentation(str(input_path))

    slides_out: List[Dict[str, Any]] = []
    for s_idx, slide in enumerate(prs.slides, start=1):
        layout = slide.slide_layout
        shapes_data: List[Dict[str, Any]] = []
        for sh_idx, shape in enumerate(slide.shapes):
            if text_only and _shape_kind(shape) not in ("text_box", "placeholder", "auto_shape"):
                continue
            shapes_data.append(_scan_shape(shape, s_idx, sh_idx, extract_images))

        slides_out.append({
            "index": s_idx,
            "layout_name": layout.name if layout is not None else None,
            "title": _slide_title(slide),
            "shape_count": len(slide.shapes),
            "shapes": shapes_data,
            "notes": _notes_text(slide),
        })

    layouts = []
    for layout in prs.slide_layouts:
        layouts.append({"name": layout.name})

    core = prs.core_properties
    return {
        "file": str(input_path),
        "slide_width_in": _emu_to_in(prs.slide_width),
        "slide_height_in": _emu_to_in(prs.slide_height),
        "slide_count": len(prs.slides),
        "layouts": layouts,
        "properties": {
            "title": core.title,
            "author": core.author,
            "subject": core.subject,
            "modified": str(core.modified) if core.modified else None,
        },
        "slides": slides_out,
    }


def main() -> None:
    p = argparse.ArgumentParser(description="Inspect a .pptx presentation (JSON summary).")
    p.add_argument("--input", required=True)
    p.add_argument("--output", help="Write JSON here (default: stdout)")
    p.add_argument("--extract-images", help="Save embedded images to this directory")
    p.add_argument("--text-only", action="store_true",
                   help="Skip pictures/tables/charts; report only text shapes")
    args = p.parse_args()

    extract_dir = Path(args.extract_images) if args.extract_images else None
    try:
        report = inspect(Path(args.input), extract_dir, args.text_only)
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
