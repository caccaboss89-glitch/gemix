#!/usr/bin/env python3
import argparse
import json
import sys
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

import sympy as sp
from latex_utils import latex_escape




WORKSPACE_ROOT = Path(os.environ.get("SANDBOX_WORKDIR", "/workspace"))


def generate_booktabs_table(
    data: Union[List[Dict[str, Any]], List[List[Any]]],
    caption: Optional[str] = None,
    label: Optional[str] = None,
    alignment: Optional[str] = None,
) -> str:
    if not data:
        raise ValueError("Table data is empty.")

    if isinstance(data[0], dict):
        headers = list(data[0].keys())
        rows = [[row.get(h, "") for h in headers] for row in data]
    else:
        headers = data[0] if isinstance(data[0], (list, tuple)) else None
        rows = data[1:] if headers is not None else data
        if headers is None:
            headers = [f"Col{i + 1}" for i in range(len(rows[0]))] if rows else []

    if not headers:
        raise ValueError("Cannot generate table with no headers.")

    lines = [
        r"\begin{table}[htbp]",
        r"    \centering",
        r"    \begin{tabularx}{\textwidth}{" + (alignment or "X" * len(headers)) + "}",
        r"        \toprule",
        "        " + " & ".join(r"\textbf{" + latex_escape(h) + "}" for h in headers) + r" \\",
        r"        \midrule"
    ]

    for row in rows:
        if isinstance(row, dict):
            row_line = " & ".join(latex_escape(row.get(h, "")) for h in headers) + r" \\"
        else:
            row_line = " & ".join(latex_escape(cell) for cell in row) + r" \\"
        lines.append("        " + row_line)

    lines.append(r"        \bottomrule")
    lines.append(r"\end{tabularx}")

    if caption:
        lines.append(r"    \caption{" + latex_escape(caption) + r"}")
    if label:
        lines.append(r"    \label{" + label + r"}")

    lines.append(r"\end{table}")

    return "\n".join(lines)


def sympy_to_latex(expr_str: str, simplify: bool = True, display: bool = True) -> str:
    from sympy.parsing.sympy_parser import parse_expr, standard_transformations, implicit_multiplication_application

    transformations = standard_transformations + (implicit_multiplication_application,)
    
    try:
        def _parse(s):
            # Try sympify first for standard stuff
            try:
                return sp.sympify(s)
            except Exception:
                # Fallback to parse_expr with auto-symbols for variables like hbar, grad, etc.
                return parse_expr(s, transformations=transformations)

        if "==" in expr_str:
            parts = expr_str.split("==", 1)
            lhs = _parse(parts[0].strip())
            rhs = _parse(parts[1].strip())
            expr = sp.Eq(lhs, rhs)
        elif "=" in expr_str:
            parts = expr_str.split("=", 1)
            lhs = _parse(parts[0].strip())
            rhs = _parse(parts[1].strip())
            expr = sp.Eq(lhs, rhs)
        else:
            expr = _parse(expr_str)

        if simplify:
            expr = sp.simplify(expr)
        latex_str = sp.latex(expr)

        if display:
            return f"\\begin{{equation}}\n    {latex_str}\n\\end{{equation}}"
        else:
            return f"${latex_str}$"
    except Exception as e:
        raise ValueError(f"SymPy conversion error: {e}. Ensure you are passing a math expression, NOT LaTeX code.") from e


def main() -> None:
    parser = argparse.ArgumentParser(
        description="LaTeX helper for booktabs tables and SymPy math"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    table_p = subparsers.add_parser(
        "table", help="Generate LaTeX booktabs table from JSON"
    )
    table_p.add_argument("--data", help="JSON inline (list of dicts or list of lists)")
    table_p.add_argument("--data-file", help="JSON file containing the data")
    table_p.add_argument(
        "--output", default="table.tex", help="Output file (default: table.tex)"
    )
    table_p.add_argument("--caption", help="Table caption")
    table_p.add_argument("--label", help="LaTeX label (e.g. tab:results)")
    table_p.add_argument(
        "--alignment", help="Alignment string (e.g. lcr or lllll)"
    )

    sympy_p = subparsers.add_parser(
        "sympy", help="Convert math expression to LaTeX"
    )
    sympy_p.add_argument(
        "--expr",
        required=True,
        help='Mathematical expression (e.g. "Integral(exp(-x**2), (x, -oo, oo))")',
    )
    sympy_p.add_argument("--output", default="equation.tex", help="Output file")
    sympy_p.add_argument(
        "--no-simplify", action="store_true", help="Disable simplify()"
    )
    sympy_p.add_argument(
        "--inline", action="store_true", help="Use $...$ instead of equation environment"
    )

    args = parser.parse_args()

    try:
        if args.command == "table":
            if args.data:
                data = json.loads(args.data)
            elif args.data_file:
                data_path = WORKSPACE_ROOT / args.data_file
                data = json.loads(data_path.read_text(encoding="utf-8"))
            else:
                print("Error: specify --data or --data-file", file=sys.stderr)
                sys.exit(1)

            snippet = generate_booktabs_table(
                data=data,
                caption=args.caption,
                label=args.label,
                alignment=args.alignment,
            )

            out_path = WORKSPACE_ROOT / args.output
            out_path.parent.mkdir(parents=True, exist_ok=True)
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(snippet)
                f.flush()
                os.fsync(f.fileno())
            print(f"Booktabs table generated -> {out_path}")

        elif args.command == "sympy":
            snippet = sympy_to_latex(
                expr_str=args.expr,
                simplify=not args.no_simplify,
                display=not args.inline,
            )

            out_path = WORKSPACE_ROOT / args.output
            out_path.parent.mkdir(parents=True, exist_ok=True)
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(snippet)
                f.flush()
                os.fsync(f.fileno())
            print(f"SymPy expression converted -> {out_path}")

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
