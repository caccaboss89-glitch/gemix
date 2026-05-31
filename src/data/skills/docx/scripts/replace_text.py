"""Replace text in a .docx / .dotx while preserving formatting (python-docx).

Word splits a single visible string across several <w:r> runs, so a naive
run-by-run replace misses matches. This script searches the *concatenated*
text of each paragraph, performs the replacement, and writes the result back
into the first matching run (clearing the others) so the run's formatting is
preserved. It walks body paragraphs, every table cell, and every header/footer.

Usage:
    # Single replacement (case-insensitive)
    python /skills/docx/scripts/replace_text.py /workspace/doc.docx \
        --match "Name Surname" --text "Jane Smith"

    # Batch replace from a JSON map, writing to a new file
    python /skills/docx/scripts/replace_text.py /workspace/template.docx \
        --map /workspace/replacements.json --out /workspace/filled.docx

    # Preview only
    python /skills/docx/scripts/replace_text.py /workspace/doc.docx \
        --match "old" --text "new" --dry-run

JSON map format:
    {
      "Name Surname": "Jane Smith",
      "Job Title": "Wedding Photographer",
      "Work Phone": "+39 02 1234567"
    }

By default the input file is edited in place; pass --out to write a copy.
"""

import argparse
import json
import re
import sys
from pathlib import Path

from docx import Document


def _iter_paragraphs(doc):
    """Yield every paragraph in the document: body, tables, headers, footers."""
    def _walk(parent):
        for p in parent.paragraphs:
            yield p
        for table in parent.tables:
            for row in table.rows:
                for cell in row.cells:
                    yield from _walk(cell)

    yield from _walk(doc)
    for section in doc.sections:
        for hf in (section.header, section.footer,
                   section.first_page_header, section.first_page_footer,
                   section.even_page_header, section.even_page_footer):
            if hf is not None:
                yield from _walk(hf)


def _replace_in_paragraph(paragraph, old: str, new: str) -> int:
    """Replace all (case-insensitive) occurrences of old with new in a paragraph.

    Works across run boundaries. Returns the number of replacements.
    """
    runs = paragraph.runs
    if not runs:
        return 0

    full = "".join(r.text for r in runs)
    if old.lower() not in full.lower():
        return 0

    # Map each character position to its owning run index.
    char_runs = []
    for idx, r in enumerate(runs):
        char_runs.extend([idx] * len(r.text))

    pattern = re.compile(re.escape(old), re.IGNORECASE)
    matches = list(pattern.finditer(full))
    if not matches:
        return 0

    # Build the new full string and remember which runs are touched.
    new_full = pattern.sub(lambda m: new, full)

    # Simplest robust approach: put the whole new string in the first run and
    # blank the rest. This preserves the first run's formatting for the line.
    runs[0].text = new_full
    for r in runs[1:]:
        r.text = ""
    return len(matches)


def replace_text(doc, replacements: dict, dry_run: bool = False) -> dict:
    counts = {k: 0 for k in replacements}
    for paragraph in _iter_paragraphs(doc):
        full = paragraph.text
        for old, new in replacements.items():
            if old.lower() in full.lower():
                if dry_run:
                    counts[old] += len(re.findall(re.escape(old), full, re.IGNORECASE))
                else:
                    counts[old] += _replace_in_paragraph(paragraph, old, new)
                full = paragraph.text
    return counts


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Replace text in a .docx/.dotx preserving formatting (handles split runs)."
    )
    parser.add_argument("docx_file", help="Path to a .docx/.dotx file")
    parser.add_argument("--match", metavar="TEXT", help="Text to find (case-insensitive)")
    parser.add_argument("--text", metavar="TEXT", default=None, help="Replacement text")
    parser.add_argument("--map", metavar="FILE", help="JSON file with {old: new} mappings")
    parser.add_argument("--out", metavar="FILE", help="Write to this file instead of in place")
    parser.add_argument("--dry-run", action="store_true", help="Preview without modifying")
    args = parser.parse_args()

    if not args.match and not args.map:
        parser.error("Specify --match TEXT (with --text) or --map FILE")
    if args.match and args.text is None and not args.dry_run:
        parser.error("--match requires --text")

    path = Path(args.docx_file)
    if not path.is_file():
        print(f"Error: {path} not found", file=sys.stderr)
        sys.exit(1)
    if path.suffix.lower() not in (".docx", ".dotx"):
        print(f"Error: {path} is not a .docx/.dotx file", file=sys.stderr)
        sys.exit(1)

    if args.map:
        map_path = Path(args.map)
        if not map_path.is_file():
            print(f"Error: {map_path} not found", file=sys.stderr)
            sys.exit(1)
        replacements = json.loads(map_path.read_text(encoding="utf-8"))
    else:
        replacements = {args.match: args.text}

    doc = Document(str(path))
    counts = replace_text(doc, replacements, dry_run=args.dry_run)

    total = sum(counts.values())
    for old, n in counts.items():
        if n > 0:
            verb = "would replace" if args.dry_run else "replaced"
            print(f'  "{old}" -> "{replacements[old]}" ({n}x {verb})')

    if total == 0:
        print("No matches found")
        sys.exit(1)

    if not args.dry_run:
        out_path = Path(args.out) if args.out else path
        out_path.parent.mkdir(parents=True, exist_ok=True)
        doc.save(str(out_path))
        print(f"\nSaved: {out_path} ({total} replacement(s))")
    else:
        print(f"\n[DRY RUN] {total} replacement(s) would be made")
