#!/usr/bin/env python3
import argparse
import sys
import os
from pathlib import Path
from typing import Any, Dict, Optional

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
import json
import shutil


WORKSPACE_ROOT = Path(os.environ.get("SANDBOX_WORKDIR", "/workspace"))


def setup_publication_style(usetex: bool = True):
    plt.rcParams.update(
        {
            "font.family": "serif",
            "font.serif": ["Computer Modern"] if usetex else ["DejaVu Serif"],
            "font.size": 11,
            "axes.titlesize": 12,
            "axes.labelsize": 11,
            "xtick.labelsize": 10,
            "ytick.labelsize": 10,
            "legend.fontsize": 10,
            "figure.figsize": (8, 5),
            "figure.dpi": 300,
            "savefig.dpi": 300,
            "savefig.transparent": True,
            "savefig.bbox": "tight",
            "text.usetex": usetex,
            "mathtext.fontset": "cm" if usetex else "dejavuserif",
            "axes.grid": True,
            "grid.alpha": 0.3,
            "grid.linestyle": "--",
        }
    )


def generate_matplotlib_figure(
    code: str,
    output_path: str,
    title: Optional[str] = None,
    caption: Optional[str] = None,
    usetex: bool = True,
    extra_params: Optional[Dict[str, Any]] = None,
) -> str:
    if usetex and not shutil.which("pdflatex"):
        print(
            "pdflatex not found. Disabling usetex=True for safe fallback."
        )
        usetex = False
    output_path = WORKSPACE_ROOT / output_path
    output_path.parent.mkdir(parents=True, exist_ok=True)

    setup_publication_style(usetex=usetex)

    local_namespace = {
        "plt": plt,
        "np": np,
        "title": title,
        "caption": caption,
    }
    if extra_params:
        # Prevent overwriting protected names used by the script
        protected = {"plt", "np", "title", "caption"}
        safe_params = {k: v for k, v in extra_params.items() if k not in protected}
        local_namespace.update(safe_params)

    try:
        local_namespace["__name__"] = "__main__"
        exec(code, local_namespace, local_namespace)

        if not plt.gcf().get_axes():
            raise ValueError("Code did not generate any figure.")

        if title:
            # Use suptitle for a global title, positioned to avoid overlap
            plt.suptitle(title, y=0.98, fontsize=14)
            plt.subplots_adjust(top=0.88) # Make room for suptitle

        plt.savefig(output_path, format="pdf", bbox_inches="tight")
        plt.close()

        print(f"Figure generated -> {output_path}")
        if caption:
            print(f"   Suggested caption: {caption}")

        return str(output_path)

    except Exception as e:
        print(f"Error generating figure: {e}", file=sys.stderr)
        plt.close()
        raise


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate publication-quality Matplotlib figures for LaTeX"
    )
    parser.add_argument(
        "--code",
        required=True,
        help="Matplotlib Python code to execute (use plt. as usual)",
    )
    parser.add_argument(
        "--output",
        default="temp/figure.pdf",
        help="Output path (default: temp/figure.pdf)",
    )
    parser.add_argument(
        "--title",
        help="Figure title (optional)",
    )
    parser.add_argument(
        "--caption",
        help="LaTeX caption for \\caption{} (optional)",
    )
    parser.add_argument(
        "--no-usetex",
        action="store_true",
        help="Disable usetex=True (use if pdflatex is not available)",
    )
    parser.add_argument(
        "--params",
        help='JSON extra parameters (e.g. {"L": 3.5, "M": 1})',
    )
    parser.add_argument(
        "--params-file",
        help="JSON file containing extra parameters",
    )

    args = parser.parse_args()

    if args.params:
        try:
            extra_params = json.loads(args.params)
        except Exception as e:
            print(f"Invalid JSON in --params: {e}", file=sys.stderr)
            sys.exit(1)
    elif args.params_file:
        try:
            params_path = WORKSPACE_ROOT / args.params_file
            extra_params = json.loads(params_path.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"Error reading --params-file: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        extra_params = None

    try:
        generate_matplotlib_figure(
            code=args.code,
            output_path=args.output,
            title=args.title,
            caption=args.caption,
            usetex=not args.no_usetex,
            extra_params=extra_params,
        )
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
