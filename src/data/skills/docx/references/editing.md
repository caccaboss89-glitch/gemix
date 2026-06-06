# Editing and Filling Existing Documents

When the user supplies a `.docx` or `.dotx` in `/workspace/`, the job is almost
always to **edit or fill that file**, preserving its design — not to rebuild it.
`.dotx` templates open exactly like `.docx`; you do not need to convert them
first.

## Golden rules

1. **Edit the supplied file; don't recreate it.** Styled shapes, theme colors,
   custom headers/footers, decorative elements and exact fonts are lost if you
   rebuild from scratch. Fill/modify the file in place, save.
2. **Keep the template's look.** Do not "adapt" its fonts or colors to the
   topic. Reuse its styles, its media, its layout. Change only what the task
   asks for.
3. **Preserve formatting on replacement** (write into the matching run rather
   than recreating paragraphs).
4. **Match the document's language and conventions** for any new text, with no
   emojis unless explicitly requested.

## Pick the right approach

First inspect the file (always — `read_file` can't open `.docx`):

```bash
python /skills/docx/scripts/inspect_docx.py /workspace/template.docx --text --tables
python /skills/docx/scripts/render_doc.py /workspace/template.docx   # then read_file /workspace/doc_pages.jpg
```

Then choose:

- **Template with placeholders / loops / conditionals** (`{name}`, `{#items}`,
  `{#flag}`) → **docxtemplater** via `fill_template.js`. Best for invoices,
  contracts, letters, certificates, repeated rows from data.
- **Plain document, literal value swaps** (no placeholder syntax) →
  **`replace_text.py`** (python-docx).
- **Structural changes** (add/remove paragraphs, set specific table cells, edit
  headers) → **python-docx** directly.
- **Accept tracked changes** → `accept_changes.py`.

## A) docxtemplater — placeholder templates

If the document was authored with docxtemplater tags, fill it with a JSON data
file:

```bash
node /skills/docx/scripts/fill_template.js \
    /workspace/template.docx /workspace/data.json /workspace/filled.docx
```

`data.json`:

```json
{
  "company": "Acme S.r.l.",
  "date": "2025-05-31",
  "hasDiscount": true,
  "items": [
    { "name": "Widget", "qty": 3, "price": "9,90" },
    { "name": "Gadget", "qty": 1, "price": "19,90" }
  ]
}
```

Tag syntax inside the Word document:

| Tag | Meaning |
|-----|---------|
| `{company}` | simple value |
| `{#items}{name} x{qty}{/items}` | loop; put `{#items}` at the start of a **table row** to repeat the whole row |
| `{#hasDiscount}...{/hasDiscount}` | section shown when truthy |
| `{^hasDiscount}...{/hasDiscount}` | section shown when falsy |
| `{price \| upper}` | filter (`upper`/`lower` provided; add more in the script if needed) |

`fill_template.js` enables `paragraphLoop` and `linebreaks` (a `\n` in a value
becomes a real line break). If a tag is malformed it prints the offending tags
and exits non-zero — fix the data or the template and re-run. **Image
placeholders are not supported** (no image module installed): render the
document, then add images with python-docx (below), or build from scratch with
docx-js.

If you need to *author* a template yourself and then fill it, build the layout
with docx-js (see `SKILL.md`), writing the literal `{tags}` as text, then run
`fill_template.js`.

## B) replace_text.py — literal find-and-replace

For a normal Word file with no placeholder syntax, swap exact strings while
preserving formatting (works across split runs, and covers body + tables +
headers/footers):

```bash
# Single value
python /skills/docx/scripts/replace_text.py /workspace/doc.docx \
    --match "Old Name" --text "New Name" --out /workspace/edited.docx

# Batch from a JSON map
python /skills/docx/scripts/replace_text.py /workspace/doc.docx \
    --map /workspace/replacements.json --out /workspace/edited.docx
```

`replacements.json`:

```json
{
  "Name Surname": "Jane Smith",
  "Job Title": "Wedding Photographer",
  "Work Phone": "+39 02 1234567"
}
```

It is case-insensitive; use `--dry-run` to preview match counts before writing.
Omit `--out` to edit in place.

## C) python-docx — structural edits

For changes beyond substitution, open the document and manipulate it directly:

```python
from docx import Document

doc = Document("/workspace/template.docx")

for p in doc.paragraphs:                 # body paragraphs
    print(p.style.name, repr(p.text))

table = doc.tables[0]                     # tables and cells
table.cell(1, 0).text = "Jane Smith"
new_cells = table.add_row().cells         # grow a table
new_cells[0].text = "New"; new_cells[1].text = "Row"

doc.sections[0].header.paragraphs[0].text = "Confidential"   # header/footer

doc.add_picture("/workspace/logo.png")    # add an image (set width=Mm(40) to scale)

doc.save("/workspace/edited.docx")
```

Change a **run's** text (not by deleting/recreating paragraphs) so formatting is
kept. For substring replacement inside a multi-run cell, prefer
`replace_text.py`.

## Converting legacy / other formats

`python-docx`, docxtemplater and `read_file` all need a real `.docx`. Convert
first when needed:

```bash
python /skills/docx/scripts/convert_doc.py /workspace/legacy.doc --to docx
python /skills/docx/scripts/convert_doc.py /workspace/doc.docx --to pdf      # inspect/deliver as PDF
python /skills/docx/scripts/convert_doc.py /workspace/doc.docx --to images   # per-page images
```

(You usually do NOT need to convert a `.dotx` — python-docx and docxtemplater
open it directly. Convert only if a step specifically requires a `.docx`.)

## Tracked changes

To accept every tracked change and deliver a clean document:

```bash
python /skills/docx/scripts/accept_changes.py /workspace/draft.docx /workspace/clean.docx
```

This drives headless LibreOffice (python-docx does not natively accept/reject
revisions).

## Verify, then deliver

Always render the result and look at it before delivering:

```bash
python /skills/docx/scripts/render_doc.py /workspace/filled.docx
# then: read_file /workspace/doc_pages.jpg
```

## Common pitfalls

- **`read_file` on a `.docx` fails** — inspect via `inspect_docx.py` or render
  to an image/PDF first.
- **Rebuilding instead of editing** loses the template's design — fill/edit the
  supplied file.
- **Using `replace_text.py` on a docxtemplater template** — for `{tags}`/loops
  use `fill_template.js`; `replace_text.py` is for literal strings only.
- **Text split across runs** makes naive substring replacement miss matches —
  `replace_text.py` concatenates the paragraph first, so use it.
- **Headers/footers are separate** from the body — `inspect_docx.py` shows them
  and `replace_text.py` already covers them.
- **TOC/field values won't auto-update** from python-docx/docxtemplater alone —
  round-trip through LibreOffice (`convert_doc.py`) or deliver a rendered PDF.
- **Image placeholders in docxtemplater are unsupported** — add images with
  python-docx after rendering, or build from scratch with docx-js.
- **No emojis / keep the user's language** in any text you add or change.
