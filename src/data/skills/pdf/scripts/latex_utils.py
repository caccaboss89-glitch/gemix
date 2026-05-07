#!/usr/bin/env python3
from typing import Any

def latex_escape(text: Any) -> str:
    """
    Escapes special LaTeX characters in a string or nested structure.
    """
    if text is None:
        return ""
    if isinstance(text, (list, tuple)):
        return ", ".join(str(latex_escape(item)) for item in text)
    if isinstance(text, dict):
        return {k: latex_escape(v) for k, v in text.items()}

    text = str(text)
    replacements = {
        "\\": r"\textbackslash{}",
        "&": r"\&",
        "%": r"\%",
        "$": r"\$",
        "#": r"\#",
        "_": r"\_",
        "{": r"\{",
        "}": r"\}",
        "~": r"\textasciitilde{}",
        "^": r"\textasciicircum{}",
        "<": r"\textless{}",
        ">": r"\textgreater{}",
        "|": r"\textbar{}",
    }
    return "".join(replacements.get(c, c) for c in text)
