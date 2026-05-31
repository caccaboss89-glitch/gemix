# PDF Processing — Advanced Reference

Advanced recipes that build on `SKILL.md`. Read this only when the basics in
`SKILL.md` aren't enough. Everything here uses tools available in the sandbox
(`pypdf`, `pdfplumber`, `reportlab`, `Pillow`, `pdf2image`, `pandas`,
`poppler-utils`, `ghostscript`). For the toolchain and the simple recipes
(merge, split, rotate, encrypt, watermark, basic text/table extraction, render
to PNG, embedded-image extraction, compression, scanned-PDF OCR) see `SKILL.md`.

## Rendering with pdf2image (Python)

`pdftoppm` (CLI) is usually enough. Use `pdf2image` when you want the pages as
PIL images to post-process in the same script:

```python
from pdf2image import convert_from_path

images = convert_from_path("/workspace/document.pdf", dpi=200,
                           first_page=1, last_page=3)
for i, image in enumerate(images, 1):
    image.save(f"/workspace/page_{i}.png", "PNG")
```

JPEG with a quality setting via the CLI:
```bash
pdftoppm -jpeg -jpegopt quality=85 -r 200 /workspace/document.pdf /workspace/jpg
```

## pdfplumber — precise extraction

### Per-character coordinates and bounding-box text
```python
import pdfplumber

with pdfplumber.open("/workspace/document.pdf") as pdf:
    page = pdf.pages[0]
    for char in page.chars[:10]:
        print(f"'{char['text']}' at x:{char['x0']:.1f} y:{char['y0']:.1f}")

    # text inside a region (left, top, right, bottom)
    region = page.within_bbox((100, 100, 400, 200)).extract_text()
```

### Tables in tricky layouts
```python
import pdfplumber

with pdfplumber.open("/workspace/complex_table.pdf") as pdf:
    page = pdf.pages[0]
    tables = page.extract_tables({
        "vertical_strategy": "lines",
        "horizontal_strategy": "lines",
        "snap_tolerance": 3,
        "intersection_tolerance": 15,
    })

    # Visual debugging: render the detected layout to inspect with read_file
    page.to_image(resolution=150).save("/workspace/debug_layout.png")
```

## pypdf — advanced manipulation

### Crop a page
```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("/workspace/input.pdf")
writer = PdfWriter()
page = reader.pages[0]
# points, origin bottom-left: (left, bottom, right, top)
page.mediabox.left = 50
page.mediabox.bottom = 50
page.mediabox.right = 550
page.mediabox.top = 750
writer.add_page(page)
with open("/workspace/cropped.pdf", "wb") as output:
    writer.write(output)
```

### Selective merge (specific pages from multiple files)
```python
from pypdf import PdfReader, PdfWriter

writer = PdfWriter()
r1 = PdfReader("/workspace/doc1.pdf")
for i in range(0, 3):          # pages 1-3
    writer.add_page(r1.pages[i])
r2 = PdfReader("/workspace/doc2.pdf")
for i in (4, 6):               # pages 5 and 7
    writer.add_page(r2.pages[i])
with open("/workspace/combined.pdf", "wb") as output:
    writer.write(output)
```

### Batch text extraction with error handling
```python
import glob, logging
from pypdf import PdfReader

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

for pdf_file in glob.glob("/workspace/*.pdf"):
    try:
        reader = PdfReader(pdf_file)
        text = "".join(page.extract_text() or "" for page in reader.pages)
        with open(pdf_file.replace(".pdf", ".txt"), "w", encoding="utf-8") as f:
            f.write(text)
    except Exception as e:
        log.error(f"Failed on {pdf_file}: {e}")
```

## reportlab — styled report table (TableStyle)

```python
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib import colors

data = [
    ['Product', 'Q1', 'Q2', 'Q3', 'Q4'],
    ['Widgets', '120', '135', '142', '158'],
    ['Gadgets', '85', '92', '98', '105'],
]
doc = SimpleDocTemplate("/workspace/report.pdf")
styles = getSampleStyleSheet()
table = Table(data)
table.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), colors.grey),
    ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
    ('GRID', (0, 0), (-1, -1), 1, colors.black),
]))
doc.build([Paragraph("Quarterly Sales Report", styles['Title']), table])
```
For long prose cells, wrap each in a `Paragraph` and set proportional
`colWidths` (see the Tables section of `SKILL.md`).

## Command-line — structure and coordinates

```bash
# Text with bounding-box coordinates (XML) — useful for structured extraction
pdftotext -bbox-layout /workspace/document.pdf /workspace/output.xml

# HTML with positioned text and extracted images
pdftohtml -c /workspace/document.pdf /workspace/output.html

# List embedded images with metadata (no extraction)
pdfimages -list /workspace/document.pdf
```

## ghostscript — linearize and repair

```bash
# Linearize for fast web view
gs -sDEVICE=pdfwrite -dFastWebView=true -dNOPAUSE -dQUIET -dBATCH \
   -sOutputFile=/workspace/optimized.pdf /workspace/input.pdf

# Repair a damaged PDF by rewriting it
gs -o /workspace/repaired.pdf -sDEVICE=pdfwrite /workspace/damaged.pdf
```

## Performance tips

- Large PDFs: process page-by-page with `pypdf` instead of loading everything;
  write each page or chunk out as you go.
- Text: `pdftotext -layout` is fastest for plain text; `pdfplumber` for
  structured data and tables.
- Images: `pdfimages` is much faster than rendering; render low-res for
  previews, high-res only for final output.

## License information

pypdf (BSD), pdfplumber (MIT), reportlab (BSD), Pillow (HPND/MIT-CMU),
pdf2image (MIT, wraps poppler), poppler-utils (GPL-2), ghostscript (AGPL).
