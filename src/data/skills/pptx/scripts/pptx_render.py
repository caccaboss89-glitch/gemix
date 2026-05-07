#!/usr/bin/env python3
"""Render every slide of a .pptx to PNG/JPG via LibreOffice + Poppler.

Pipeline:
  1. soffice --headless --convert-to pdf -> intermediate PDF in /tmp
  2. pdftoppm -png/-jpeg -r <dpi>      -> per-slide image files

Required system binaries (pre-installed in the GemiX sandbox):
  - soffice (libreoffice-core / libreoffice-impress)
  - pdftoppm (poppler-utils)

Each invocation isolates LibreOffice in its own --user-profile to avoid
"Unix socket already in use" collisions when multiple LibreOffice tools run
in the same kernel session.
"""
import argparse
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Optional


def _check_bin(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise RuntimeError(f"Required binary '{name}' not found in PATH.")
    return path


def _convert_to_pdf(input_pptx: Path, work_dir: Path, timeout: int) -> Path:
    soffice = _check_bin("soffice")
    profile = work_dir / f"lo_profile_{uuid.uuid4().hex}"
    profile.mkdir(parents=True, exist_ok=True)
    user_install = f"-env:UserInstallation=file://{profile}"

    cmd = [
        soffice,
        user_install,
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
        raise RuntimeError(f"soffice timeout after {timeout}s while converting {input_pptx.name}")

    if proc.returncode != 0:
        raise RuntimeError(
            f"soffice failed (rc={proc.returncode}):\n"
            f"STDOUT: {proc.stdout}\nSTDERR: {proc.stderr}"
        )

    out_pdf = work_dir / (input_pptx.stem + ".pdf")
    if not out_pdf.exists():
        # LibreOffice sometimes writes with sanitized name
        candidates = list(work_dir.glob("*.pdf"))
        if not candidates:
            raise RuntimeError("PDF was not produced by soffice (no .pdf in work dir).")
        out_pdf = candidates[0]
    return out_pdf


def _pdf_to_images(pdf: Path, output_dir: Path, dpi: int, fmt: str,
                   pages: Optional[str], prefix: str) -> List[Path]:
    pdftoppm = _check_bin("pdftoppm")
    output_dir.mkdir(parents=True, exist_ok=True)

    fmt_flag = "-png" if fmt == "png" else "-jpeg"
    cmd: List[str] = [pdftoppm, fmt_flag, "-r", str(dpi)]
    if pages:
        if "-" in pages:
            f, l = pages.split("-", 1)
            cmd += ["-f", f, "-l", l]
        else:
            cmd += ["-f", pages, "-l", pages]
    cmd += [str(pdf), str(output_dir / prefix)]

    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"pdftoppm failed (rc={proc.returncode}):\n"
            f"STDOUT: {proc.stdout}\nSTDERR: {proc.stderr}"
        )

    ext = "png" if fmt == "png" else "jpg"
    return sorted(output_dir.glob(f"{prefix}-*.{ext}"))


def render(input_pptx: Path, output_dir: Path, dpi: int, fmt: str,
           pages: Optional[str], keep_pdf: bool, timeout: int) -> List[Path]:
    if not input_pptx.exists():
        raise FileNotFoundError(f"Input not found: {input_pptx}")
    if input_pptx.suffix.lower() != ".pptx":
        raise ValueError(f"Expected .pptx (got {input_pptx.suffix})")
    if fmt not in ("png", "jpg"):
        raise ValueError(f"Unsupported format '{fmt}' (use png or jpg)")

    work_dir = Path(tempfile.mkdtemp(prefix="pptx_render_"))
    try:
        pdf = _convert_to_pdf(input_pptx, work_dir, timeout=timeout)
        prefix = input_pptx.stem
        images = _pdf_to_images(pdf, output_dir, dpi=dpi, fmt=fmt,
                                pages=pages, prefix=prefix)
        if keep_pdf:
            kept = output_dir / (input_pptx.stem + ".pdf")
            shutil.copyfile(pdf, kept)
        return images
    finally:
        try:
            shutil.rmtree(work_dir)
        except Exception:
            pass


def main() -> None:
    p = argparse.ArgumentParser(description="Render a .pptx to per-slide images.")
    p.add_argument("--input", required=True)
    p.add_argument("--output-dir", required=True)
    p.add_argument("--dpi", type=int, default=150)
    p.add_argument("--format", choices=["png", "jpg"], default="png")
    p.add_argument("--pages", help='Page range like "1-5" or single "3"')
    p.add_argument("--keep-pdf", action="store_true",
                   help="Also copy the intermediate PDF into output-dir")
    p.add_argument("--timeout", type=int, default=90,
                   help="soffice timeout in seconds (default 90)")
    args = p.parse_args()

    try:
        images = render(
            Path(args.input), Path(args.output_dir),
            dpi=args.dpi, fmt=args.format,
            pages=args.pages, keep_pdf=args.keep_pdf,
            timeout=args.timeout,
        )
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)

    print(f"Rendered {len(images)} slide(s) -> {args.output_dir}")
    for img in images:
        print(str(img))


if __name__ == "__main__":
    main()
