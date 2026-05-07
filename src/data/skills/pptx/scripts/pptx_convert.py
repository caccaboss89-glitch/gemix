#!/usr/bin/env python3
"""Convert .pptx files to other formats.

Sub-commands:
  pptx2pdf  -> LibreOffice headless conversion (one PDF per deck)
  pptx2text -> Lossy markdown-style text extraction (titles, bullets, tables, notes)

PDF conversion uses an isolated --user-profile so multiple soffice calls in
the same kernel session do not collide on the X/Unix socket.
"""
import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Optional

from pptx import Presentation


def _check_bin(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise RuntimeError(f"Required binary '{name}' not found in PATH.")
    return path


# ── pptx → pdf ─────────────────────────────────────────────────────────────

def pptx2pdf(input_pptx: Path, output_pdf: Path, timeout: int) -> Path:
    if not input_pptx.exists():
        raise FileNotFoundError(f"Input not found: {input_pptx}")
    if input_pptx.suffix.lower() != ".pptx":
        raise ValueError(f"Expected .pptx (got {input_pptx.suffix})")
    if output_pdf.suffix.lower() != ".pdf":
        raise ValueError(f"Output must end with .pdf (got {output_pdf.suffix})")

    soffice = _check_bin("soffice")
    work_dir = Path(tempfile.mkdtemp(prefix="pptx2pdf_"))
    try:
        profile = work_dir / f"lo_profile_{uuid.uuid4().hex}"
        profile.mkdir(parents=True, exist_ok=True)
        cmd = [
            soffice,
            f"-env:UserInstallation=file://{profile}",
            "--headless",
            "--norestore",
            "--nolockcheck",
            "--convert-to", "pdf",
            "--outdir", str(work_dir),
            str(input_pptx),
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

        produced = work_dir / (input_pptx.stem + ".pdf")
        if not produced.exists():
            candidates = list(work_dir.glob("*.pdf"))
            if not candidates:
                raise RuntimeError("No .pdf produced by soffice.")
            produced = candidates[0]

        output_pdf.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(produced, output_pdf)
        return output_pdf
    finally:
        try:
            shutil.rmtree(work_dir)
        except Exception:
            pass


# ── pptx → text/markdown ───────────────────────────────────────────────────

def _shape_to_md(shape) -> List[str]:
    out: List[str] = []
    if shape.has_text_frame:
        for para in shape.text_frame.paragraphs:
            txt = "".join(run.text for run in para.runs) or (para.text or "")
            if not txt.strip():
                continue
            indent = "  " * max(0, getattr(para, "level", 0) or 0)
            out.append(f"{indent}- {txt}")
    if shape.has_table:
        rows = shape.table.rows
        if list(rows):
            cols = len(list(rows)[0].cells)
            out.append("")
            out.append("| " + " | ".join(f"col{i+1}" for i in range(cols)) + " |")
            out.append("| " + " | ".join(["---"] * cols) + " |")
            for row in rows:
                cells = [c.text.strip().replace("\n", " ") for c in row.cells]
                out.append("| " + " | ".join(cells) + " |")
            out.append("")
    return out


def pptx2text(input_pptx: Path, output_md: Path) -> Path:
    if not input_pptx.exists():
        raise FileNotFoundError(f"Input not found: {input_pptx}")
    prs = Presentation(str(input_pptx))

    lines: List[str] = []
    title = prs.core_properties.title or input_pptx.stem
    lines.append(f"# {title}")
    lines.append("")

    for s_idx, slide in enumerate(prs.slides, start=1):
        try:
            slide_title = slide.shapes.title.text if slide.shapes.title is not None else None
        except Exception:
            slide_title = None
        lines.append(f"## Slide {s_idx}" + (f" — {slide_title}" if slide_title else ""))
        lines.append("")
        for shape in slide.shapes:
            # Skip the title shape, already rendered above
            try:
                if shape == slide.shapes.title:
                    continue
            except Exception:
                pass
            lines.extend(_shape_to_md(shape))
        if slide.has_notes_slide:
            note = slide.notes_slide.notes_text_frame.text or ""
            if note.strip():
                lines.append("")
                lines.append(f"> **Notes:** {note.strip()}")
        lines.append("")

    output_md.parent.mkdir(parents=True, exist_ok=True)
    output_md.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    return output_md


def main() -> None:
    p = argparse.ArgumentParser(description="Convert .pptx to PDF or markdown text.")
    sub = p.add_subparsers(dest="action", required=True)

    p_pdf = sub.add_parser("pptx2pdf", help="Convert .pptx -> .pdf via LibreOffice headless")
    p_pdf.add_argument("--input", required=True)
    p_pdf.add_argument("--output", required=True)
    p_pdf.add_argument("--timeout", type=int, default=120)

    p_txt = sub.add_parser("pptx2text", help="Extract a markdown-like transcript")
    p_txt.add_argument("--input", required=True)
    p_txt.add_argument("--output", required=True)

    args = p.parse_args()

    try:
        if args.action == "pptx2pdf":
            res = pptx2pdf(Path(args.input), Path(args.output), timeout=args.timeout)
            print(json.dumps({"action": "pptx2pdf", "output": str(res)}, indent=2))
        elif args.action == "pptx2text":
            res = pptx2text(Path(args.input), Path(args.output))
            print(json.dumps({"action": "pptx2text", "output": str(res)}, indent=2))
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
