#!/usr/bin/env python3
import subprocess
import sys
import os
import argparse
from pathlib import Path


WORKSPACE_ROOT = Path(os.environ.get("SANDBOX_WORKDIR", "/workspace"))


def cleanup_aux_files(tex_file):
    base = os.path.splitext(tex_file)[0]
    for ext in [".aux", ".log", ".out", ".toc", ".bbl", ".blg", ".idx", ".ind", ".nav", ".snm", ".vrb", ".synctex.gz"]:
        f = base + ext
        if os.path.exists(f):
            try:
                os.remove(f)
            except OSError:
                pass


def compile_tex(tex_file, engine="pdflatex", clean=True):
    tex_file = WORKSPACE_ROOT / tex_file
    if not tex_file.exists():
        raise FileNotFoundError(f"Error: {tex_file} not found.")

    print(f"Compiling {tex_file} with {engine}...")
    try:
        for i in range(3):
            print(f"Pass {i + 1}/3...")
            result = subprocess.run(
                [engine, "-interaction=nonstopmode", "-halt-on-error", tex_file],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=str(tex_file.parent) or ".",
                timeout=60,
            )
            if result.returncode != 0:
                print("Compilation error:")
                # Show full stdout/stderr for better error diagnosis
                print("=== STDOUT ===")
                print(result.stdout)
                print("=== STDERR ===")
                print(result.stderr)
                # Extract and highlight error lines
                error_lines = [line for line in result.stdout.split('\n') if 'Error:' in line or '!' in line]
                if error_lines:
                    print("=== KEY ERROR LINES ===")
                    for line in error_lines[-10:]:  # Last 10 error lines
                        print(line)
                raise RuntimeError(f"LaTeX compilation failed with return code {result.returncode}")

        pdf_file = tex_file.with_suffix(".pdf")
        if pdf_file.exists():
            print(f"PDF generated: {pdf_file}")
            if clean:
                cleanup_aux_files(str(tex_file))
                print("Auxiliary files removed.")
            return pdf_file
    except Exception as e:
        raise RuntimeError(f"Error during compilation: {e}") from e


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("tex_file")
    parser.add_argument(
        "--engine", default="pdflatex", choices=["pdflatex", "xelatex", "lualatex"]
    )
    parser.add_argument("--no-clean", action="store_true")
    args = parser.parse_args()
    try:
        compile_tex(args.tex_file, args.engine, not args.no_clean)
    except Exception as e:
        print(e, file=sys.stderr)
        sys.exit(1)
