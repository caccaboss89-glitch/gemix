---
name: pdf
description: reportlab/pypdf/poppler PDFs in /workspace/ (create, edit, merge, forms). NOT LaTeX→PDF—use pdflatex. Use photos/diagrams/charts proactively; if none staged, one web_x_search with search_images=true.
---

# PDF Processing Guide

A guide for operating on PDFs inside the build sandbox. PDFs live in
`/workspace/`; this skill's files are read-only under `/skills/pdf/`.

## Scope

| Task | Use this skill? |
|------|-----------------|
| PDF via **reportlab**, pypdf, poppler | **Yes** — read this file first |
| **LaTeX / TikZ** → PDF | **No** — write `.tex` in `/workspace/`, compile with `pdflatex` (see build `<Sandbox>`) |
| Filling a user-supplied form | Yes — `references/forms.md` |

## Images (use proactively)

For reports, brochures, and rich layouts, **include real visuals** (photo, diagram,
logo, chart, map)—not text-only pages unless the user asked for plain text.

1. **Already in `/workspace/`** (attachments, prior tool output) → embed directly.
2. **None available** → one `web_x_search` with `search_images=true` and a precise
   brief (subject, style, count); files land in `/workspace/`.
3. **Charts/diagrams** → matplotlib/cairosvg to PNG, then `drawImage` / reportlab flow.

Do not skip images because the prompt didn't attach any—fetch or render when they
would make the PDF clearer or more professional.

## Companion files

- `references/reference.md` — advanced recipes: pdfplumber coordinate/table tuning, pypdf
  cropping and selective merge, batch processing, ghostscript linearize/repair,
  and more command-line options. Read it when the basics here aren't enough.
- `references/forms.md` — step-by-step workflow for **filling a PDF form** (an application,
  registration, questionnaire, etc. that the user supplies in `/workspace/`).
  No forms ship with this skill — the form is whatever the user provides. The
  helper scripts in `scripts/` exist only for that workflow and are documented
  inside `references/forms.md`; ignore them unless you are filling a form.

Read a companion file with `read_file` (e.g. `read_file /skills/pdf/references/forms.md`)
only when the task calls for it.

## Read vs. extract

When you `read_file` a PDF, you are shown its content (text and images, OCR
included) so you can understand it. That rendered view is for understanding
only. If the task needs the PDF's exact text or data — to transform it, copy it
into another file, or feed it to a script — do NOT retype what you saw. Extract
it programmatically (`pdftotext`, `pypdf`, `pdfplumber`) so the bytes are exact.

## Available tools

Python (pre-installed, no `pip` at runtime): `pypdf`, `pdfplumber`, `reportlab`,
`Pillow`, `pdf2image`, `matplotlib`, `pandas`, `openpyxl`, `cairosvg`.

Command line: `pdftotext`, `pdftoppm`, `pdfimages`, `pdfinfo`, `pdftohtml`
(poppler-utils), `gs` (ghostscript).

Not available: `qpdf`, `pdftk`, `pytesseract`/`tesseract`, ImageMagick, and
JavaScript PDF libraries. Use the Python/poppler equivalents below. For a
scanned/image-only PDF whose text is needed, `read_file` the PDF (OCR is done
server-side) instead of looking for a local OCR tool.

## Output requirements

- Write any text inside the PDF (body, headings, tables, captions) in the
  user's language, without emojis unless the user asked for them — reportlab's
  built-in fonts cannot render emoji and show them as black boxes.
- When editing an existing PDF, match its existing layout and conventions
  rather than imposing a new style.
- **Contrast:** dark page backgrounds need light text; white/light pages need
  dark text (`#1E293B`, `#363636`). Light gray on white is not readable.

## Round budget (typical PDF: 12–20 tool calls)

| Once | Avoid |
|------|--------|
| `read_file` this SKILL.md | Re-reading guides |
| One `web_x_search` for facts; optional one with `search_images=true` | Redundant research passes |
| Build PDF script → `read_file` output PDF or page images once | Many partial drafts; retyping extracted text |
| One fix pass if QA shows layout/contrast issues | Blind full rewrites |

LaTeX PDFs use `pdflatex` in `/workspace/` (not this skill) — still one package
check bash, 2–3 compile passes max, not dozens of kpsewhich calls.

## Quick Start

```python
from pypdf import PdfReader

reader = PdfReader("/workspace/document.pdf")
print(f"Pages: {len(reader.pages)}")

text = ""
for page in reader.pages:
    text += page.extract_text()
```

## Python Libraries

### pypdf — basic operations

#### Merge PDFs
```python
from pypdf import PdfWriter, PdfReader

writer = PdfWriter()
for pdf_file in ["/workspace/doc1.pdf", "/workspace/doc2.pdf", "/workspace/doc3.pdf"]:
    reader = PdfReader(pdf_file)
    for page in reader.pages:
        writer.add_page(page)

with open("/workspace/merged.pdf", "wb") as output:
    writer.write(output)
```

#### Split PDF (one file per page)
```python
reader = PdfReader("/workspace/input.pdf")
for i, page in enumerate(reader.pages):
    writer = PdfWriter()
    writer.add_page(page)
    with open(f"/workspace/page_{i+1}.pdf", "wb") as output:
        writer.write(output)
```

#### Extract metadata
```python
meta = PdfReader("/workspace/document.pdf").metadata
print(meta.title, meta.author, meta.subject, meta.creator)
```

#### Rotate pages
```python
reader = PdfReader("/workspace/input.pdf")
writer = PdfWriter()
page = reader.pages[0]
page.rotate(90)  # clockwise
writer.add_page(page)
with open("/workspace/rotated.pdf", "wb") as output:
    writer.write(output)
```

#### Encrypt / decrypt
```python
# Encrypt
reader = PdfReader("/workspace/input.pdf")
writer = PdfWriter()
for page in reader.pages:
    writer.add_page(page)
writer.encrypt("userpassword", "ownerpassword")
with open("/workspace/encrypted.pdf", "wb") as output:
    writer.write(output)

# Decrypt
reader = PdfReader("/workspace/encrypted.pdf")
if reader.is_encrypted:
    reader.decrypt("password")
```

#### Watermark
```python
watermark = PdfReader("/workspace/watermark.pdf").pages[0]
reader = PdfReader("/workspace/document.pdf")
writer = PdfWriter()
for page in reader.pages:
    page.merge_page(watermark)
    writer.add_page(page)
with open("/workspace/watermarked.pdf", "wb") as output:
    writer.write(output)
```

### pdfplumber — text and table extraction

#### Extract text
```python
import pdfplumber

with pdfplumber.open("/workspace/document.pdf") as pdf:
    for page in pdf.pages:
        print(page.extract_text())
```

#### Extract tables to Excel
```python
import pandas as pd
import pdfplumber

with pdfplumber.open("/workspace/document.pdf") as pdf:
    all_tables = []
    for page in pdf.pages:
        for table in page.extract_tables():
            if table:  # skip empty
                all_tables.append(pd.DataFrame(table[1:], columns=table[0]))

if all_tables:
    pd.concat(all_tables, ignore_index=True).to_excel(
        "/workspace/extracted_tables.xlsx", index=False
    )
```

(For complex layouts, tuned table settings, and per-character coordinates, see
`references/reference.md`.)

### reportlab — create PDFs

#### Simple document
```python
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
from reportlab.lib.styles import getSampleStyleSheet

doc = SimpleDocTemplate("/workspace/report.pdf", pagesize=A4)
styles = getSampleStyleSheet()
story = [
    Paragraph("Report Title", styles['Title']),
    Spacer(1, 12),
    Paragraph("Body text. " * 20, styles['Normal']),
    PageBreak(),
    Paragraph("Page 2", styles['Heading1']),
]
doc.build(story)
```

#### Add an image
```python
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import inch
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

c = canvas.Canvas("/workspace/image-demo.pdf", pagesize=A4)
page_w, page_h = A4

img = ImageReader("/workspace/chart.png")
img_w, img_h = img.getSize()
target_w = 4.5 * inch
target_h = target_w * (img_h / img_w)   # preserve aspect ratio

# Canvas origin is bottom-left.
c.drawImage(img, inch, page_h - inch - target_h, width=target_w, height=target_h)
c.save()
```

Image rules (see **Images (use proactively)** above):
- Staged `/workspace/` files, matplotlib/cairosvg PNGs, or `web_x_search` with
  `search_images=true`.
- Preserve aspect ratio (compute the missing dimension, or pass
  `preserveAspectRatio=True` when fitting a fixed box).
- Canvas coordinates are bottom-left based.
- Need a chart? Render it to PNG with matplotlib, then place the PNG.
- Have an SVG? Convert first with `cairosvg.svg2png(url=..., write_to=...)`.

#### Subscripts and superscripts
Never use Unicode sub/superscript characters (₀₁₂, ⁰¹²) in reportlab — the
built-in fonts lack those glyphs and render solid black boxes. Use XML markup in
`Paragraph` objects instead:
```python
from reportlab.platypus import Paragraph
from reportlab.lib.styles import getSampleStyleSheet

styles = getSampleStyleSheet()
Paragraph("H<sub>2</sub>O", styles['Normal'])
Paragraph("x<super>2</super> + y<super>2</super>", styles['Normal'])
```

#### Tables
Always wrap every cell value (headers included) in a `Paragraph` — plain
strings don't wrap and overflow the cell. Size columns proportionally to
expected content.
```python
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Table, TableStyle

doc = SimpleDocTemplate("/workspace/table.pdf", pagesize=A4)
cell = getSampleStyleSheet()["BodyText"]

data = [
    [Paragraph("<b>ID</b>", cell), Paragraph("<b>Name</b>", cell), Paragraph("<b>Description</b>", cell)],
    [Paragraph("1", cell), Paragraph("Widget", cell),
     Paragraph("A long description that wraps across multiple lines.", cell)],
]
# A4 is 8.27" wide; with 1" margins, total <= ~6.2".
table = Table(data, colWidths=[0.5 * inch, 1.5 * inch, 4.2 * inch], repeatRows=1)
table.setStyle(TableStyle([
    ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
]))
doc.build([table])
```
- `colWidths` must total within the printable area (A4 w/ 1" margins ≈ 6.2";
  landscape A4 ≈ 9.7").
- Use `repeatRows=1` so the header repeats across page breaks.
- For very wide content switch to `landscape(A4)` rather than squeezing
  columns.

## Command-Line Tools

```bash
# Extract text
pdftotext /workspace/input.pdf /workspace/output.txt
pdftotext -layout /workspace/input.pdf /workspace/output.txt   # preserve layout
pdftotext -f 1 -l 5 /workspace/input.pdf /workspace/output.txt # pages 1-5

# Render pages to PNG (snapshot of the rendered page: text + vectors + layout)
pdftoppm -png -r 300 /workspace/input.pdf /workspace/page       # -> page-1.png, ...

# Extract the ORIGINAL embedded bitmaps (not a page snapshot)
pdfimages -all /workspace/input.pdf /workspace/img              # -> img-000.png, ...

# Metadata / page count / sizes
pdfinfo /workspace/input.pdf

# Compress (presets: /screen smallest, /ebook medium, /printer & /prepress high)
gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook \
   -dNOPAUSE -dQUIET -dBATCH \
   -sOutputFile=/workspace/compressed.pdf /workspace/input.pdf
```

`pdfimages` extracts embedded image objects; `pdftoppm` rasterizes the rendered
page. They are different — pick the one the task needs. Merging, splitting, page
extraction, and rotation use `pypdf` (above), since `qpdf`/`pdftk` are absent.

## Scanned PDFs

`pdftotext` returns little or nothing for image-only pages, and there is no
local OCR engine. To get a scanned PDF's text, `read_file` the PDF (OCR runs
server-side). Extract from the source where possible and fall back to that view
only for genuinely image-only pages.

## Quick Reference

| Task | Tool | Code / command |
|------|------|----------------|
| Merge / split / rotate | pypdf | `writer.add_page(page)` / `page.rotate(90)` |
| Encrypt / decrypt | pypdf | `writer.encrypt(...)` / `reader.decrypt(...)` |
| Watermark | pypdf | `page.merge_page(watermark)` |
| Extract text | pdftotext / pdfplumber | `pdftotext -layout` / `page.extract_text()` |
| Extract tables | pdfplumber | `page.extract_tables()` |
| Create PDF | reportlab | Canvas or Platypus |
| Tables / images in a PDF | reportlab | Wrap cells in `Paragraph`; `drawImage(...)` |
| Extract embedded images | pdfimages | `pdfimages -all input.pdf prefix` |
| Render pages to images | pdftoppm / pdf2image | page snapshots |
| Compress / optimize | ghostscript | `gs -dPDFSETTINGS=/ebook ...` |
| OCR a scanned PDF | read_file | read_file the PDF, use the returned text |
| Fill a PDF form | scripts (see references/forms.md) | follow `references/forms.md` |

## Visual verification

After creating or editing a PDF (especially after filling a form), render the
relevant pages to PNG in `/workspace/` and `read_file` them to confirm fonts,
layout, image placement, and field values. Do NOT `read_file` the produced
`.pdf` for QA — that re-ingests parsed text, not the real layout. Render to PNG:

```bash
pdftoppm -png -r 300 -f 1 -l 1 /workspace/output.pdf /workspace/verify
# then: read_file /workspace/verify-1.png
```

Render selectively (one page at a time) to keep it cheap. This catches
misplaced values, overflow, overlapping text, and wrong field mappings that are
invisible in the raw structure.
