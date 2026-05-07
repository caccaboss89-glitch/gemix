#!/usr/bin/env python3
import argparse
import json
import sys
import os
from pathlib import Path
from typing import Any, Dict, Optional, Union

from jinja2 import Environment, FileSystemLoader, Undefined
from latex_utils import latex_escape


WORKSPACE_ROOT = Path(os.environ.get("SANDBOX_WORKDIR", "/workspace"))




class SilentUndefined(Undefined):
    def __getattr__(self, name: str) -> Any:
        return self
    def __getitem__(self, name: str) -> Any:
        return self
    def __str__(self) -> str:
        return ""
    def __bool__(self) -> bool:
        return False


def render_latex_template(
    template_path: Union[str, Path],
    data: Dict[str, Any],
    output_path: Optional[Union[str, Path]] = None,
    extra_template_dirs: Optional[list] = None,
) -> str:
    template_path = (WORKSPACE_ROOT / template_path).resolve()
    if not template_path.exists():
        raise FileNotFoundError(f"Template not found: {template_path}")

    searchpath = [str(template_path.parent)]
    if extra_template_dirs:
        searchpath.extend(str((WORKSPACE_ROOT / d).resolve()) for d in extra_template_dirs)

    env = Environment(
        block_start_string="\\BLOCK{",
        block_end_string="}",
        variable_start_string="\\VAR{",
        variable_end_string="}",
        comment_start_string="\\#{",
        comment_end_string="}",
        line_statement_prefix="%%",
        line_comment_prefix="%#",
        trim_blocks=True,
        autoescape=False,
        loader=FileSystemLoader(searchpath),
        undefined=SilentUndefined,
        extensions=["jinja2.ext.do"],
    )

    env.filters["latex_escape"] = latex_escape

    template = env.get_template(template_path.name)

    try:
        rendered = template.render(**data)
    except Exception as e:
        print(f"Jinja2 Error: {e}", file=sys.stderr)
        raise

    if output_path:
        output_path = WORKSPACE_ROOT / output_path
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(rendered)
            f.flush()
            os.fsync(f.fileno())
        print(f"Template rendered -> {output_path}")
    else:
        print("Template rendered (in-memory only)")

    return rendered


def main() -> None:
    parser = argparse.ArgumentParser(description="Render LaTeX templates using Jinja2")
    parser.add_argument("template", help="Path to the .tex template")
    parser.add_argument("--data", help='JSON string (e.g., \'{"title": "My Paper"}\')')
    parser.add_argument("--data-file", help="JSON file with the data")
    parser.add_argument("--output", default="main.tex", help="Output .tex file")
    parser.add_argument(
        "--snippets", nargs="*", help="Extra folders for \\input (e.g. assets/snippets)"
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
            data_path = WORKSPACE_ROOT / args.data_file
            data = json.loads(data_path.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"Error reading --data-file: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        data = {}

    try:
        render_latex_template(
            template_path=args.template,
            data=data,
            output_path=args.output,
            extra_template_dirs=args.snippets,
        )
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
