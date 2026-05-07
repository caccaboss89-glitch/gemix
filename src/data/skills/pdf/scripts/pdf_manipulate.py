#!/usr/bin/env python3
import argparse
import sys
import os
from pathlib import Path
from typing import List, Optional

from pypdf import PdfReader, PdfWriter


WORKSPACE_ROOT = Path(os.environ.get("SANDBOX_WORKDIR", "/workspace"))


def validate_pdf(path: str) -> Path:
    p = WORKSPACE_ROOT / path
    if not p.exists():
        raise FileNotFoundError(f"File not found: {p}")
    if p.suffix.lower() != ".pdf":
        raise ValueError(f"File {p} is not a PDF")
    return p


def merge_pdfs(inputs: List[str], output: str) -> str:
    if not inputs:
        raise ValueError("No files provided for merge.")
    writer = PdfWriter()
    for pdf_path in inputs:
        reader = PdfReader(validate_pdf(pdf_path))
        for page in reader.pages:
            writer.add_page(page)

    out_path = WORKSPACE_ROOT / output
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "wb") as f:
        writer.write(f)

    print(f"Merge completed -> {out_path}")
    return str(out_path)


def split_pdf(input_path: str, pages: str, output_prefix: str) -> List[str]:
    reader = PdfReader(validate_pdf(input_path))
    output_prefix = WORKSPACE_ROOT / output_prefix
    output_prefix.parent.mkdir(parents=True, exist_ok=True)

    created_files = []
    page_ranges = pages.replace(" ", "").split(",")

    for i, pr in enumerate(page_ranges):
        if "-" in pr:
            start, end = map(int, pr.split("-"))
            page_list = range(start - 1, end)
        else:
            page_list = [int(pr) - 1]

        writer = PdfWriter()
        for p in page_list:
            if 0 <= p < len(reader.pages):
                writer.add_page(reader.pages[p])

        out_file = output_prefix.parent / f"{output_prefix.name}_{i + 1:03d}.pdf"
        with open(out_file, "wb") as f:
            writer.write(f)
        created_files.append(str(out_file))
        print(f"Page(s) {pr} -> {out_file}")

    return created_files


def rotate_pdf(input_path: str, pages: str, angle: int, output: str) -> str:
    reader = PdfReader(validate_pdf(input_path))
    writer = PdfWriter()

    page_list = []
    for pr in pages.replace(" ", "").split(","):
        if "-" in pr:
            start, end = map(int, pr.split("-"))
            page_list.extend(range(start - 1, end))
        else:
            page_list.append(int(pr) - 1)

    for i, page in enumerate(reader.pages):
        if i in page_list:
            rotated = page.rotate(angle)
            writer.add_page(rotated)
        else:
            writer.add_page(page)

    out_path = WORKSPACE_ROOT / output
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "wb") as f:
        writer.write(f)

    print(f"Rotation of {angle}° on pages {pages} completed -> {out_path}")
    return str(out_path)


def encrypt_pdf(
    input_path: str,
    user_password: str,
    owner_password: Optional[str] = None,
    output: Optional[str] = None,
) -> str:
    reader = PdfReader(validate_pdf(input_path))
    writer = PdfWriter()

    for page in reader.pages:
        writer.add_page(page)

    out_path = (
        WORKSPACE_ROOT / output
        if output
        else (WORKSPACE_ROOT / input_path).with_name(f"{Path(input_path).stem}_encrypted.pdf")
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)

    writer.encrypt(
        user_password=user_password, owner_password=owner_password or user_password
    )
    with open(out_path, "wb") as f:
        writer.write(f)

    print(f"PDF encrypted -> {out_path}")
    return str(out_path)


def decrypt_pdf(input_path: str, password: str, output: Optional[str] = None) -> str:
    reader = PdfReader(validate_pdf(input_path))
    if not reader.is_encrypted:
        print("PDF is not encrypted")
        return str(Path(input_path))

    reader.decrypt(password)

    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)

    out_path = (
        WORKSPACE_ROOT / output
        if output
        else (WORKSPACE_ROOT / input_path).with_name(f"{Path(input_path).stem}_decrypted.pdf")
    )
    with open(out_path, "wb") as f:
        writer.write(f)

    print(f"PDF decrypted -> {out_path}")
    return str(out_path)


def add_watermark(input_path: str, watermark_path: str, output: str) -> str:
    reader = PdfReader(validate_pdf(input_path))
    watermark = PdfReader(validate_pdf(watermark_path)).pages[0]

    writer = PdfWriter()
    for page in reader.pages:
        page.merge_page(watermark)
        writer.add_page(page)

    out_path = WORKSPACE_ROOT / output
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "wb") as f:
        writer.write(f)

    print(f"Watermark applied -> {out_path}")
    return str(out_path)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Unified PDF manipulator for the PDF skill"
    )
    subparsers = parser.add_subparsers(dest="action", required=True)

    merge_p = subparsers.add_parser("merge", help="Merge multiple PDF files")
    merge_p.add_argument("--inputs", nargs="+", required=True, help="PDF files to merge")
    merge_p.add_argument("--output", required=True, help="Output PDF file")

    split_p = subparsers.add_parser("split", help="Split a PDF into pages/ranges")
    split_p.add_argument("--input", required=True)
    split_p.add_argument("--pages", required=True, help="Ranges e.g. 1-5,7,10-12")
    split_p.add_argument(
        "--output-prefix", default="page", help="File prefix (default: page)"
    )

    rotate_p = subparsers.add_parser("rotate", help="Rotate specific pages")
    rotate_p.add_argument("--input", required=True)
    rotate_p.add_argument(
        "--pages", required=True, help="Pages to rotate (e.g. 1,3-5)"
    )
    rotate_p.add_argument(
        "--angle", type=int, choices=[90, 180, 270, -90, -180, -270], required=True
    )
    rotate_p.add_argument("--output", required=True)

    enc_p = subparsers.add_parser("encrypt", help="Protect with password")
    enc_p.add_argument("--input", required=True)
    enc_p.add_argument("--password", required=True)
    enc_p.add_argument("--owner-password", help="Owner password (optional)")
    enc_p.add_argument("--output", help="Output file")

    dec_p = subparsers.add_parser("decrypt", help="Remove protection")
    dec_p.add_argument("--input", required=True)
    dec_p.add_argument("--password", required=True)
    dec_p.add_argument("--output", help="Output file")

    wm_p = subparsers.add_parser("watermark", help="Apply watermark")
    wm_p.add_argument("--input", required=True)
    wm_p.add_argument("--watermark", required=True, help="PDF file to use as watermark")
    wm_p.add_argument("--output", required=True)

    info_p = subparsers.add_parser("info", help="Show metadata")
    info_p.add_argument("--input", required=True)

    args = parser.parse_args()

    try:
        if args.action == "merge":
            merge_pdfs(args.inputs, args.output)
        elif args.action == "split":
            split_pdf(args.input, args.pages, args.output_prefix)
        elif args.action == "rotate":
            rotate_pdf(args.input, args.pages, args.angle, args.output)
        elif args.action == "encrypt":
            encrypt_pdf(args.input, args.password, args.owner_password, args.output)
        elif args.action == "decrypt":
            decrypt_pdf(args.input, args.password, args.output)
        elif args.action == "watermark":
            add_watermark(args.input, args.watermark, args.output)
        elif args.action == "info":
            reader = PdfReader(validate_pdf(args.input))
            print(f"Info of {args.input}:")
            print(f"   Pages: {len(reader.pages)}")
            print(f"   Encrypted: {reader.is_encrypted}")
            if reader.metadata:
                for k, v in reader.metadata.items():
                    print(f"   {k}: {v}")
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
