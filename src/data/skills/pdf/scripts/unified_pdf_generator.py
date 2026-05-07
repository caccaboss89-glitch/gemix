#!/usr/bin/env python3
import argparse
import json
import sys
import os
import subprocess
import shutil
import time
import re
from pathlib import Path
from typing import Any, Dict, Optional, List

from render_latex_template import render_latex_template
from generate_matplotlib_figure import generate_matplotlib_figure
from compile_tex import compile_tex

WORKSPACE_ROOT = Path(os.environ.get("SANDBOX_WORKDIR", "/workspace"))


def generate_figures_from_data(data: Dict[str, Any], figures_dir: str = "temp") -> None:
    figures_dir = Path(WORKSPACE_ROOT) / figures_dir
    figures_dir.mkdir(parents=True, exist_ok=True)

    fig_specs = []
    seen_ids = set()

    if "figures" in data and isinstance(data["figures"], list):
        for fig in data["figures"]:
            if isinstance(fig, dict) and "code" in fig:
                fig_specs.append(fig)
                seen_ids.add(id(fig))

    def find_figures(obj):
        if isinstance(obj, dict):
            if "code" in obj and ("filename" in obj or "path" in obj):
                if id(obj) not in seen_ids:
                    fig_specs.append(obj)
                    seen_ids.add(id(obj))
            for v in obj.values():
                find_figures(v)
        elif isinstance(obj, list):
            for item in obj:
                find_figures(item)

    find_figures(data)

    if not fig_specs:
        return

    print(f"Generating {len(fig_specs)} Matplotlib figures...")

    fig_map = {}
    for i, fig_spec in enumerate(fig_specs):
        filename = fig_spec.get("filename")
        if not filename or not isinstance(filename, str):
            p = fig_spec.get("path")
            if p and isinstance(p, str) and p.endswith(".pdf"):
                filename = Path(p).name
            else:
                filename = f"figure_{i + 1}.pdf"

        filename = filename.replace(" ", "_")
        if not filename.lower().endswith(".pdf"):
            filename += ".pdf"

        output_path = figures_dir / filename
        print(f"   • Generating {filename}...")

        try:
            extra_params = {
                k: v
                for k, v in fig_spec.items()
                if k not in ["code", "filename", "path", "title", "caption"]
            }

            generate_matplotlib_figure(
                code=fig_spec["code"],
                output_path=str(output_path),
                title=fig_spec.get("title"),
                caption=fig_spec.get("caption"),
                usetex=True,
                extra_params=extra_params,
            )
            abs_path = (Path(WORKSPACE_ROOT) / output_path).as_posix()
            fig_spec["path"] = abs_path
            fig_map[filename] = abs_path
        except Exception as e:
            print(f"Error generating figure {filename}: {e}", file=sys.stderr)

    if not fig_map:
        return

    def update_paths(obj):
        if isinstance(obj, dict):
            for k, v in obj.items():
                if (k == "path" or k.endswith("_path")) and isinstance(v, str):
                    if v in fig_map:
                        obj[k] = fig_map[v]
                    elif Path(v).name in fig_map:
                        obj[k] = fig_map[Path(v).name]
                else:
                    update_paths(v)
        elif isinstance(obj, list):
            for item in obj:
                update_paths(item)

    update_paths(data)


def run_unified_pdf_generation(
    template_path: str,
    data: Dict[str, Any],
    output_pdf: str,
    verify: bool = False,
    figures_dir: str = "temp",
    snippets_dirs: Optional[List[str]] = None,
    engine: str = "pdflatex",
) -> str:

    template_path = (WORKSPACE_ROOT / template_path).resolve()
    output_pdf = (WORKSPACE_ROOT / output_pdf).resolve()
    output_pdf.parent.mkdir(parents=True, exist_ok=True)

    print(f"Starting PDF generation: {output_pdf.name}")

    generate_figures_from_data(data, figures_dir)

    temp_dir = WORKSPACE_ROOT / "temp"
    temp_dir.mkdir(parents=True, exist_ok=True)
    tex_output = temp_dir / output_pdf.with_suffix(".tex").name

    def wait_for_files(data_obj):
        referenced_files = set()
        path_pattern = re.compile(r"(/workspace/temp/[\w\-. ]+\.(?:tex|pdf))")

        def collect_files(obj):
            if isinstance(obj, dict):
                for v in obj.values():
                    if isinstance(v, str):
                        # Find all workspace paths in the string
                        matches = path_pattern.findall(v)
                        for m in matches:
                            referenced_files.add(m)
                    collect_files(v)
            elif isinstance(obj, list):
                for item in obj:
                    collect_files(item)
        
        collect_files(data_obj)
        for f in referenced_files:
            f_path = Path(f)
            retries = 5
            while retries > 0 and not f_path.exists():
                print(f"   ⏳ Waiting for referenced file: {f_path.name}...")
                time.sleep(1)
                retries -= 1
            if not f_path.exists():
                 print(f"   ⚠️ Warning: referenced file {f_path.name} still missing after wait.")

    wait_for_files(data)

    try:
        render_latex_template(
            template_path=str(template_path),
            data=data,
            output_path=str(tex_output),
            extra_template_dirs=snippets_dirs,
        )
        print(f"LaTeX template rendered successfully -> {tex_output.name}")
    except Exception as e:
        raise RuntimeError(f"Step 2 (Rendering) failed: {e}")

    try:
        generated_pdf = compile_tex(str(tex_output), engine=engine)
        if generated_pdf and Path(generated_pdf).exists():
            shutil.move(generated_pdf, str(output_pdf))
        else:
            raise FileNotFoundError("LaTeX compilation finished but no PDF was found.")
    except Exception as e:
        raise RuntimeError(f"Step 3 (Compilation) failed: {e}")

    if verify:
        verify_dir = Path(WORKSPACE_ROOT) / "temp" / "verify"
        verify_dir.mkdir(parents=True, exist_ok=True)
        png_prefix = verify_dir / output_pdf.stem
        try:
            subprocess.run(
                ["pdftoppm", "-png", "-r", "300", str(output_pdf), str(png_prefix)],
                check=True,
                capture_output=True,
            )
            print(f"Visual verification ready -> {png_prefix}-1.png (and following)")
            print("   Use read_file or visual tool to check the result.")
        except Exception as e:
            print(f"pdftoppm verification failed (pdftoppm not available?): {e}")

    print(f"PDF generated successfully: {output_pdf}")
    return str(output_pdf)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Unified high-quality PDF generator (LaTeX + Matplotlib)"
    )
    parser.add_argument(
        "--template",
        required=True,
        help="Path to the LaTeX template (e.g., assets/templates/scientific_template.tex)",
    )
    parser.add_argument(
        "--data",
        help='Inline JSON data (e.g., \'{"title": "My Paper", "figures": [...]}\')',
    )
    parser.add_argument("--data-file", help="JSON file containing the data")
    parser.add_argument(
        "--output",
        default="output/output.pdf",
        help="Final PDF output name (default: output/output.pdf)",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Run pdftoppm for visual verification after compilation",
    )
    parser.add_argument(
        "--figures-dir",
        default="temp",
        help="Folder where figures are saved (default: temp)",
    )
    parser.add_argument(
        "--engine",
        default="pdflatex",
        choices=["pdflatex", "xelatex", "lualatex"],
        help="LaTeX engine to use (default: pdflatex)",
    )
    parser.add_argument(
        "--snippets",
        nargs="*",
        help="Extra folders for Jinja2 snippets (e.g. code/snippets)",
    )

    args = parser.parse_args()

    if args.data:
        try:
            data = json.loads(args.data)
        except json.JSONDecodeError as e:
            print(f"Invalid JSON in --data: {e}", file=sys.stderr)
            sys.exit(1)
    elif args.data_file:
        try:
            data_path = Path(WORKSPACE_ROOT) / args.data_file
            data = json.loads(data_path.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"Error reading --data-file: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        data = {}

    try:
        run_unified_pdf_generation(
            template_path=args.template,
            data=data,
            output_pdf=args.output,
            verify=args.verify,
            figures_dir=args.figures_dir,
            snippets_dirs=args.snippets,
            engine=args.engine,
        )
    except Exception as e:
        print(f"Error during PDF generation: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
