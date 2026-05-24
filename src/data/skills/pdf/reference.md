# PDF — Advanced Reference

Use this when `SKILL.md` is not enough: TikZ/pgfplots figures, biblatex with a local `.bib`, custom Platypus headers/footers, Ghostscript compression, advanced cropping, OCR for scanned PDFs that GemiX's parser couldn't handle.

---

## reportlab — Advanced Patterns

### Page numbers + custom header/footer (Platypus)

```python
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer

def _draw_page_chrome(canvas, doc):
    canvas.saveState()
    w, h = A4
    canvas.setFont("Helvetica", 9)
    canvas.setFillGray(0.4)
    # Header
    canvas.drawString(2*cm, h - 1.2*cm, "Annual Report — 2026")
    canvas.line(2*cm, h - 1.4*cm, w - 2*cm, h - 1.4*cm)
    # Footer with page number
    footer = f"Page {doc.page}"
    canvas.drawRightString(w - 2*cm, 1.2*cm, footer)
    canvas.restoreState()

styles = getSampleStyleSheet()
story = [Paragraph("Contents flow here…", styles["BodyText"]) for _ in range(40)]

doc = SimpleDocTemplate(
    "/workspace/output/report.pdf",
    pagesize=A4,
    leftMargin=2*cm, rightMargin=2*cm, topMargin=2.5*cm, bottomMargin=2*cm,
)
doc.build(story, onFirstPage=_draw_page_chrome, onLaterPages=_draw_page_chrome)
```

### Table of Contents (Platypus)

```python
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak,
)
from reportlab.platypus.tableofcontents import TableOfContents

class TocDoc(SimpleDocTemplate):
    def afterFlowable(self, flowable):
        if isinstance(flowable, Paragraph):
            style_name = flowable.style.name
            text = flowable.getPlainText()
            level = {"H1": 0, "H2": 1, "H3": 2}.get(style_name)
            if level is not None:
                self.notify("TOCEntry", (level, text, self.page))

styles = getSampleStyleSheet()
h1 = ParagraphStyle("H1", parent=styles["Heading1"])
h2 = ParagraphStyle("H2", parent=styles["Heading2"])

toc = TableOfContents()
toc.levelStyles = [
    ParagraphStyle(name="TocL0", fontSize=12, leading=16),
    ParagraphStyle(name="TocL1", fontSize=10, leading=14, leftIndent=20),
]

story = [
    Paragraph("Table of Contents", styles["Title"]),
    toc,
    PageBreak(),
    Paragraph("Introduction", h1),
    Paragraph("Lots of intro text…", styles["BodyText"]),
    Paragraph("Methods", h1),
    Paragraph("Setup", h2),
    Paragraph("…", styles["BodyText"]),
]

doc = TocDoc("/workspace/output/with_toc.pdf", pagesize=A4)
# multiBuild reruns until the TOC stabilizes
doc.multiBuild(story)
```

### Custom canvas (full control over every drawing primitive)

```python
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib.colors import HexColor

c = canvas.Canvas("/workspace/output/custom.pdf", pagesize=A4)
w, h = A4

# Background banner
c.setFillColor(HexColor("#1e3a8a"))
c.rect(0, h - 4*72, w, 4*72, fill=1, stroke=0)

# White title on banner
c.setFillColor(HexColor("#ffffff"))
c.setFont("Helvetica-Bold", 28)
c.drawString(72, h - 2.5*72, "Custom Layout")

# Subtitle
c.setFont("Helvetica", 14)
c.drawString(72, h - 3.2*72, "Drawing primitives only — no flowables")

# Body
c.setFillColor(HexColor("#111827"))
c.setFont("Helvetica", 11)
text = c.beginText(72, h - 5*72)
text.setLeading(16)
for line in [
    "Use beginText() for multi-line bodies.",
    "Origin is bottom-left, Y grows upward.",
    "1 inch = 72 points; 1 cm ≈ 28.35 points.",
]:
    text.textLine(line)
c.drawText(text)

c.save()
```

### Bookmarks / outline tree

```python
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4

c = canvas.Canvas("/workspace/output/outlined.pdf", pagesize=A4)
w, h = A4

def page(title):
    c.bookmarkPage(title)
    c.addOutlineEntry(title, title, level=0)
    c.setFont("Helvetica-Bold", 18)
    c.drawString(72, h - 100, title)
    c.showPage()

c.showOutline()
page("Chapter 1")
page("Chapter 2")
page("Chapter 3")
c.save()
```

---

## LaTeX — Advanced Patterns

### TikZ — vector diagrams

```latex
\documentclass{article}
\usepackage{tikz}
\usetikzlibrary{positioning,arrows.meta}

\begin{document}
\begin{tikzpicture}[
    node distance=2cm,
    box/.style={draw, rounded corners, minimum width=2.5cm, minimum height=1cm,
                align=center, fill=blue!10},
    arrow/.style={-Stealth, thick}
  ]
  \node[box] (input)  {Input};
  \node[box, right=of input]   (proc)  {Process};
  \node[box, right=of proc]    (output){Output};
  \draw[arrow] (input)  -- (proc);
  \draw[arrow] (proc)   -- (output);
\end{tikzpicture}
\end{document}
```

### pgfplots — high-quality charts

```latex
\documentclass{standalone}
\usepackage{pgfplots}
\pgfplotsset{compat=1.18}
\begin{document}
\begin{tikzpicture}
  \begin{axis}[
      xlabel={$x$}, ylabel={$f(x)$},
      legend pos=south east, grid=both,
      width=10cm, height=6cm
    ]
    \addplot[domain=-3:3, samples=100, blue, thick] {x^2};
    \addlegendentry{$x^2$}
    \addplot[domain=-3:3, samples=100, red,  thick] {x^3};
    \addlegendentry{$x^3$}
  \end{axis}
\end{tikzpicture}
\end{document}
```

Compile with `pdflatex` and include the result via `\includegraphics{plot.pdf}` in the parent document, or compile `standalone` and use it directly.

### biblatex with a local `.bib`

`refs.bib` (write via `write_file` to `/workspace/temp/refs.bib`):

```bibtex
@article{einstein1905,
  author = {Einstein, Albert},
  title  = {Zur Elektrodynamik bewegter K\"orper},
  journal= {Annalen der Physik},
  year   = {1905},
  volume = {322},
  pages  = {891--921},
}
```

`main.tex`:

```latex
\documentclass{article}
\usepackage[backend=biber,style=numeric]{biblatex}
\addbibresource{/workspace/temp/refs.bib}
\begin{document}
Special relativity \cite{einstein1905} introduced …
\printbibliography
\end{document}
```

Compile (3 passes):

```bash
pdflatex -interaction=nonstopmode -halt-on-error -output-directory=/workspace/temp /workspace/temp/main.tex
```
```bash
biber --output-directory /workspace/temp /workspace/temp/main
```
```bash
pdflatex -interaction=nonstopmode -halt-on-error -output-directory=/workspace/temp /workspace/temp/main.tex
```
```bash
pdflatex -interaction=nonstopmode -halt-on-error -output-directory=/workspace/temp /workspace/temp/main.tex
```

### `minted` — syntax-highlighted code listings

`minted` requires `Pygments` (preinstalled with TeX Live in this sandbox) and `-shell-escape`:

```latex
\documentclass{article}
\usepackage{minted}
\begin{document}
\begin{minted}[linenos,bgcolor=gray!10,fontsize=\small]{python}
def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
\end{minted}
\end{document}
```

```bash
pdflatex -shell-escape -interaction=nonstopmode -halt-on-error -output-directory=/workspace/temp /workspace/temp/main.tex
```

If `Pygments` is unavailable, fall back to `listings` (no `shell-escape` needed).

### `tcolorbox` — callouts, theorem boxes, code frames

```latex
\usepackage[breakable,skins,theorems]{tcolorbox}
\newtcbtheorem[number within=section]{thm}{Theorem}{
    colback=blue!5,colframe=blue!50!black,
    fonttitle=\bfseries,
}{thm}

\begin{thm}{Pythagoras}{pyth}
  In a right triangle, $a^2 + b^2 = c^2$.
\end{thm}
```

### Custom geometry & two-column with balanced last page

```latex
\documentclass[11pt,a4paper,twocolumn]{article}
\usepackage[margin=1.8cm,columnsep=0.7cm]{geometry}
\usepackage{flushend}   % balances the last page columns
```

### Italian typography

```latex
\usepackage[italian]{babel}
\usepackage{microtype}
\frenchspacing             % no extra space after periods (Italian convention)
% Optional: italian dashes and quotes
\usepackage[autostyle=true,italian=guillemets]{csquotes}
```

### Headers/footers with `fancyhdr`

```latex
\usepackage{fancyhdr}
\pagestyle{fancy}
\fancyhf{}
\fancyhead[L]{\textit{\leftmark}}
\fancyhead[R]{\thepage}
\renewcommand{\headrulewidth}{0.4pt}
```

---

## Ghostscript — Compression, Linearization, Repair

### Reduce file size

```bash
gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -dNOPAUSE -dQUIET -dBATCH -sOutputFile=/workspace/output/compressed.pdf /readonly/history/large.pdf
```

`-dPDFSETTINGS` accepts `/screen` (smallest, 72 dpi), `/ebook` (~150 dpi, good default), `/printer` (300 dpi), `/prepress` (300 dpi + color preserved).

### Linearize for fast web view

```bash
gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.5 -dFastWebView=true -dNOPAUSE -dQUIET -dBATCH -sOutputFile=/workspace/output/linearized.pdf /readonly/history/document.pdf
```

### Convert to PDF/A-2b (archival)

```bash
gs -dPDFA=2 -dBATCH -dNOPAUSE -sProcessColorModel=DeviceRGB -sDEVICE=pdfwrite -sPDFACompatibilityPolicy=1 -sOutputFile=/workspace/output/archival.pdf /readonly/history/source.pdf
```

### Repair a damaged PDF

```bash
gs -o /workspace/temp/repaired.pdf -sDEVICE=pdfwrite /readonly/history/broken.pdf
```

Ghostscript regenerates the cross-reference table; many "unreadable" PDFs become readable after this.

### Concatenate (alternative to pypdf)

```bash
gs -dBATCH -dNOPAUSE -q -sDEVICE=pdfwrite -sOutputFile=/workspace/output/joined.pdf /readonly/history/a.pdf /readonly/history/b.pdf
```

---

## Page Geometry — Crop & Resize Recipes

### Crop a fixed margin off every page

```python
from pypdf import PdfReader, PdfWriter
r = PdfReader("/readonly/history/scan.pdf")
w = PdfWriter()
trim_pt = 14.4   # 0.2 inch = 14.4 pt
for page in r.pages:
    box = page.mediabox
    box.left   += trim_pt
    box.bottom += trim_pt
    box.right  -= trim_pt
    box.top    -= trim_pt
    page.cropbox = box
    w.add_page(page)
with open("/workspace/output/cropped.pdf", "wb") as f:
    w.write(f)
```

### Force a page size (scale content to A4)

Best done with Ghostscript (preserves vectors):

```bash
gs -o /workspace/output/a4.pdf -sDEVICE=pdfwrite -sPAPERSIZE=a4 -dFIXEDMEDIA -dPDFFitPage -dCompatibilityLevel=1.4 /readonly/history/letter.pdf
```

---

## OCR — When the GemiX Parser Isn't Enough

The GemiX PDF parser handles OCR for most scanned documents and feeds the result directly into your context. Reach for manual OCR only when:

- the parser returned empty/garbled text on a particular scan, or
- the user wants a **searchable PDF** (sidecar OCR text embedded), or
- the user wants raw OCR text in a specific format/layout.

### Render to PNG → Tesseract → text

```python
# /workspace/code/ocr.py
import os, subprocess, glob
from pathlib import Path

src = "/readonly/history/scan.pdf"
work = "/workspace/temp/ocr"
Path(work).mkdir(parents=True, exist_ok=True)

# Render every page at 300 dpi
subprocess.run(
    ["pdftoppm", "-png", "-r", "300", src, f"{work}/page"],
    check=True,
)

text_chunks = []
for png in sorted(glob.glob(f"{work}/page-*.png")):
    out = subprocess.run(
        ["tesseract", png, "-", "-l", "eng+ita"],
        capture_output=True, text=True, check=True,
    )
    text_chunks.append(out.stdout)

with open("/workspace/output/scan.txt", "w", encoding="utf-8") as f:
    f.write("\n\n".join(text_chunks))
```

`tesseract -l <lang>+<lang>` accepts combined languages. `eng`, `ita`, `fra`, `deu`, `spa`, `por`, `lat` are typically installed; check `tesseract --list-langs` if unsure.

### Searchable PDF with OCR sidecar

`tesseract` can emit a PDF with the original image plus an invisible OCR text layer. Combine page-by-page:

```python
import subprocess, glob
from pathlib import Path
from pypdf import PdfWriter, PdfReader

src = "/readonly/history/scan.pdf"
work = "/workspace/temp/ocrpdf"
Path(work).mkdir(parents=True, exist_ok=True)

subprocess.run(["pdftoppm", "-png", "-r", "300", src, f"{work}/page"], check=True)
for png in sorted(glob.glob(f"{work}/page-*.png")):
    base = png[:-4]
    subprocess.run(["tesseract", png, base, "-l", "eng+ita", "pdf"], check=True)

w = PdfWriter()
for pdf_part in sorted(glob.glob(f"{work}/page-*.pdf")):
    for page in PdfReader(pdf_part).pages:
        w.add_page(page)
with open("/workspace/output/scan_searchable.pdf", "wb") as f:
    w.write(f)
```

---

## Diagnostics & Recovery

### `pdfinfo` — quick metadata + page count + dimensions

```bash
pdfinfo /readonly/history/document.pdf
```

### Detect broken/corrupted PDFs

```bash
gs -o /dev/null -sDEVICE=nullpage /readonly/history/document.pdf
```

Non-zero exit + warnings → file is damaged. Repair with `gs` (see above).

### Extract a specific page range with `pdfseparate` (poppler)

```bash
pdfseparate -f 5 -l 10 /readonly/history/document.pdf /workspace/temp/page-%d.pdf
```

Then concatenate with `pypdf` or `gs`.

### Inspect the LaTeX log

When `pdflatex` fails, the log is at `/workspace/temp/main.log` (whatever the input basename is). Always read the **last 60–100 lines** — the actual error is near the end, after `! LaTeX Error:` or `! Undefined control sequence`.

```bash
tail -n 80 /workspace/temp/main.log
```

---

## Reportlab × Matplotlib × LaTeX — Choosing

| Need | Best fit |
| :--- | :--- |
| Quick text-heavy PDF, no math | reportlab Platypus |
| Pixel-perfect custom layout | reportlab Canvas |
| Equations, citations, professional typography | LaTeX (`pdflatex`) |
| Custom fonts / non-Latin scripts | LaTeX (`xelatex` + `fontspec`) |
| Slides | LaTeX (`beamer`) |
| Charts | matplotlib → save as `.pdf` (vector) → include in either |
| Diagrams | TikZ (LaTeX) for vector, matplotlib for data plots |
| Rapid iteration with templated content from a JSON dict | reportlab + a Python builder, or `jinja2` rendering a `.tex` and `pdflatex` |

The skill no longer ships fixed templates. Pick the engine that matches the request and write the document to spec — that's faster and gives the user exactly what they asked for instead of a template-shaped compromise.

---

## License Reminders

- `pypdf` — BSD-3
- `reportlab` — BSD
- `matplotlib`, `numpy`, `scipy`, `pandas` — BSD/PSF
- `Pillow` — MIT-CMU
- `Pygments` — BSD
- `tesseract-ocr` — Apache 2.0
- `Ghostscript` — AGPL (use only with input/output files; no GPL-incompatible bundling concerns for ad-hoc PDF processing)
- `poppler-utils` — GPL
- `TeX Live` — mixed (LPPL, GPL, others)

For documents created on behalf of users, the output PDF is the user's content; the licenses above govern the tooling, not the deliverable.
