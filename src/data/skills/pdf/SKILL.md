---
name: pdf
description: Create or manipulate PDFs (build from scratch, merge/split/rotate/crop, watermark, encrypt/decrypt, extract images, render). Skip this skill for plain reading of unencrypted PDFs — the GemiX PDF parser auto-transcribes them into your context.
---

# PDF Skill Guide

> [!IMPORTANT]
> This skill is intentionally template-free. Pick the right engine for the request — `reportlab` for quick documents, raw LaTeX for professional/scientific output, `pypdf` for manipulation. No fixed templates, no rigid JSON specs.

## Don't Use This Skill For Plain Reading

When a user attaches an unencrypted PDF, GemiX's PDF parser already transcribes it for you. The content arrives **inline in the chat** as `<FileContent type="pdf-transcription"><Transcription>…</Transcription></FileContent>`. **Just read that text and reply** — do NOT call this skill, do NOT call `read_file` on the PDF, do NOT create a project.

Call this skill only when the user asks you to **produce or manipulate** a PDF (create, merge, split, rotate, watermark, encrypt, decrypt, extract images, …).

## When You Need The Original PDF File

If you must operate on the original bytes (watermark, encrypt, merge, rotate, …), call `read_file` on the user's PDF path **once**. The GemiX PDF parser materialises a structured folder next to the file:

```
/readonly/history/<name>/
    ├── <name>.pdf          ← the original file (moved here, never deleted)
    ├── transcription.md    ← parsed text (also returned to you on read)
    └── assets/             ← extracted images (may be empty)
```

The first `read_file` returns `transcription.md` plus a header listing those exact paths. Calling `read_file` on the original `.pdf` path again will keep returning the same markdown — that is by design, no re-parsing happens.

To manipulate the file, **copy it into your workspace first** (it lives under `/readonly/`, which is read-only):

```bash
cp /readonly/history/<name>/<name>.pdf /workspace/temp/<name>.pdf
```

Then operate on `/workspace/temp/<name>.pdf` and write the deliverable to `/workspace/output/`.

To use an extracted image:

```bash
cp /readonly/history/<name>/assets/<image> /workspace/temp/<image>
```

**Encrypted PDFs**: the parser cannot read them and `read_file` will fail. Decrypt first:

```python
# /workspace/code/decrypt.py
from pypdf import PdfReader, PdfWriter
r = PdfReader("/readonly/history/secured.pdf")
if r.is_encrypted:
    r.decrypt("the_password")
w = PdfWriter()
for p in r.pages:
    w.add_page(p)
with open("/workspace/temp/clear.pdf", "wb") as f:
    w.write(f)
```

Then `read_file /workspace/temp/clear.pdf` — the parser will transcribe the cleared copy normally.

---

## Paths & Layout

- **Read-only inputs**: `/readonly/history/<file>.pdf`, `/readonly/searched_images/<image>` (for figures), `/readonly/skills/pdf/` (this guide).
- **Writable working dirs**: `/workspace/code/<script>.py` (Python scripts you write), `/workspace/temp/<file>` (intermediate `.tex`, `.aux`, `.log`, figures, decrypted copies), `/workspace/output/<file>.pdf` (final deliverable — pushed to the user automatically).
- **Never write outside** `/workspace/{code|temp|output}/`. Never write back into `/readonly/`.

---

## Decision Matrix — Which Tool

| User request | Use | Why |
| :--- | :--- | :--- |
| Simple PDF: text, basic styling, a few images, basic tables | **reportlab** (Canvas or Platypus) | Pure Python, fastest path, no LaTeX compile step |
| Professional/scientific PDF: equations, footnotes, citations, multi-column, beamer slides, CV with custom typography | **LaTeX** (`pdflatex` / `xelatex` / `lualatex`) | TeX Live full + `science` + `cm-super` are installed, output quality is unmatched |
| Invoice, report, deck with charts | **reportlab** + matplotlib OR **LaTeX** + matplotlib | Either works — reportlab is faster, LaTeX looks better |
| Merge / split / rotate / encrypt / watermark / crop / extract metadata | **pypdf** | Single dependency, no LaTeX, no external CLI |
| Render PDF page → PNG/JPG (for visual QA, previews) | **`pdftoppm`** (poppler) via `bash` | Native, fast, lossless |
| Extract embedded raster images (originals, not page renders) | **`pdfimages`** (poppler) via `bash` | Pulls original bitmaps without re-rendering |
| Reading text/tables from a user-supplied PDF (incl. scanned/OCR) | **the GemiX PDF parser** (auto, no tool call) | The PDF transcription is already in your context as `<FileContent type="pdf-transcription">` |

**Rule of thumb**: if the document has math, footnotes, or needs to look like a real publication → LaTeX. Otherwise reportlab.

---

## Available Toolchain (sandbox)

Everything below is preinstalled. There is no internet (no `pip install`, no `tlmgr`, no `apt-get`), so do not use packages outside this list.

- **Python**: `pypdf`, `reportlab`, `Pillow`, `cairosvg`, `matplotlib`, `seaborn`, `plotly`, `numpy`, `scipy`, `sympy`, `mpmath`, `pandas`, `jinja2`, `python-docx`, `openpyxl`, `python-pptx`, `pyyaml`, `requests`, `rembg` (with `onnxruntime`).
- **TeX Live**: `pdflatex`, `xelatex`, `lualatex`. Installed packages: `texlive-latex-recommended`, `texlive-latex-extra`, `texlive-fonts-recommended`, `texlive-fonts-extra`, `texlive-science`, `texlive-lang-italian`, `cm-super`, `lmodern`, `dvipng`. Notable usable packages: `microtype`, `lmodern`, `booktabs`, `siunitx`, `cleveref`, `bm`, `amsmath`, `amssymb`, `mathtools`, `xcolor`, `tcolorbox`, `tikz`, `pgfplots`, `geometry`, `fancyhdr`, `hyperref`, `multicol`, `enumitem`, `tabularx`, `longtable`, `listings`, `biblatex` (compile with `biber`, local `.bib` only), `fontspec` (xelatex/lualatex only), `beamer`, `babel` with `english` and `italian` languages. **Not available**: `minted` (Pygments stylesheets need internet — use `listings` instead).
- **CLI**: `pdftotext`, `pdftoppm`, `pdfimages`, `pdfinfo`, `pdftohtml` (poppler-utils); `gs` (ghostscript); `libreoffice` (headless); `ffmpeg`; `yt-dlp`.
- **Image sourcing**: no internet from inside the sandbox for arbitrary downloads. Use the `web_x_search` tool with `search_images=true` BEFORE writing scripts; the fetched images are saved into `/workspace/` (filenames echoed in the tool response) and you reference them from your script with that exact path.

---

## reportlab — Quick Cookbook

### Minimal PDF (Canvas)

```python
# /workspace/code/simple.py
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

c = canvas.Canvas("/workspace/output/note.pdf", pagesize=A4)
w, h = A4
c.setFont("Helvetica-Bold", 18)
c.drawString(72, h - 100, "Quick Note")
c.setFont("Helvetica", 11)
c.drawString(72, h - 130, "Body text on the next line.")
c.save()
```

Run: `bash python /workspace/code/simple.py`.

### Multi-page document with styles (Platypus)

```python
# /workspace/code/report.py
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Image,
)

doc = SimpleDocTemplate(
    "/workspace/output/report.pdf",
    pagesize=A4,
    leftMargin=2*cm, rightMargin=2*cm, topMargin=2*cm, bottomMargin=2*cm,
)
styles = getSampleStyleSheet()
title = ParagraphStyle("title", parent=styles["Title"], spaceAfter=18)
h1 = ParagraphStyle("h1", parent=styles["Heading1"], spaceBefore=14, spaceAfter=6)
body = ParagraphStyle("body", parent=styles["BodyText"], leading=14, spaceAfter=8)

story = [
    Paragraph("Quarterly Report — Q2 2026", title),
    Paragraph("Executive Summary", h1),
    Paragraph("Revenue grew <b>12%</b> compared to Q1, driven by …", body),
    Spacer(1, 12),
    Image("/readonly/searched_images/chart.png", width=12*cm, height=7*cm),
    PageBreak(),
    Paragraph("Detailed Breakdown", h1),
    Paragraph("…", body),
]
doc.build(story)
```

### Tables — wrap every cell in `Paragraph`

Plain strings inside `Table` cells don't wrap. Always wrap them, including headers and short values, and size columns proportionally.

```python
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Table, TableStyle

styles = getSampleStyleSheet()
cell = styles["BodyText"]

data = [
    [Paragraph("<b>ID</b>", cell), Paragraph("<b>Name</b>", cell),
     Paragraph("<b>Description</b>", cell)],
    [Paragraph("1", cell), Paragraph("Widget", cell),
     Paragraph("A long description that wraps within the column.", cell)],
    [Paragraph("2", cell), Paragraph("Gadget", cell),
     Paragraph("Another long description for the second row.", cell)],
]

# Total must fit printable area (A4 landscape with 2 cm margins ≈ 25 cm).
table = Table(data, colWidths=[1.5*cm, 4*cm, 11*cm], repeatRows=1)
table.setStyle(TableStyle([
    ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
]))

doc = SimpleDocTemplate("/workspace/output/table.pdf", pagesize=A4,
                       leftMargin=2*cm, rightMargin=2*cm)
doc.build([table])
```

### Subscripts/superscripts in reportlab

The default fonts have no Unicode `H₂O` glyphs — they render as black boxes. Use the inline tags `<sub>` and `<super>` inside `Paragraph`:

```python
Paragraph("H<sub>2</sub>O · E = mc<super>2</super>", styles["BodyText"])
```

For Canvas-drawn text, switch font size and `drawString` at a manual offset.

### Images

- `Image(path, width=W, height=H)` is a flowable; pass it to `doc.build([...])`.
- `c.drawImage(path, x, y, width=W, height=H, preserveAspectRatio=True, anchor="c")` is the Canvas equivalent. Origin is **bottom-left**, so `y = page_h - margin - target_h`.
- Compute `target_h = target_w * (img_h / img_w)` to keep aspect ratio when you only want to fix one side.
- Prefer `drawImage` for repeated images (the resource is shared in the PDF).

---

## LaTeX — Pipeline

Write a `.tex` file with `write_file`, then compile with `bash`. Output goes to `/workspace/temp/`, then move (or compile directly) to `/workspace/output/`.

### Engines

- **`pdflatex`** — default, fastest. Use for English/Italian text and standard LaTeX packages.
- **`xelatex`** — needed for `fontspec`, custom system fonts, native UTF-8 with non-Latin scripts.
- **`lualatex`** — same as xelatex but with Lua scripting and better Unicode math.

### Compile command

```bash
pdflatex -interaction=nonstopmode -halt-on-error -output-directory=/workspace/temp /workspace/temp/main.tex
```

For documents with cross-references, ToC, or `cleveref`, run **twice**:

```bash
pdflatex -interaction=nonstopmode -halt-on-error -output-directory=/workspace/temp /workspace/temp/main.tex
```
```bash
pdflatex -interaction=nonstopmode -halt-on-error -output-directory=/workspace/temp /workspace/temp/main.tex
```

For `biblatex` with a local `.bib`, run `biber` between the two passes:

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

Then move the result:

```bash
cp /workspace/temp/main.pdf /workspace/output/document.pdf
```

### Modern article preamble (copy-paste, adapt the body)

```latex
\documentclass[11pt,a4paper]{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[italian]{babel}        % or [english]
\usepackage{lmodern}
\usepackage{microtype}             % polished typography
\usepackage[margin=2.3cm]{geometry}
\usepackage{amsmath,amssymb,mathtools,bm}
\usepackage{siunitx}
\usepackage{booktabs,tabularx,longtable}
\usepackage{graphicx}
\usepackage{xcolor}
\usepackage[colorlinks=true,linkcolor=blue!50!black,urlcolor=blue!50!black,
            citecolor=blue!50!black]{hyperref}
\usepackage{cleveref}
\usepackage{tcolorbox}
\usepackage{enumitem}
\setlist{itemsep=2pt,topsep=4pt}

\title{My Title}
\author{GemiX}
\date{\today}

\begin{document}
\maketitle

\section{Introduction}
Body with \textbf{microtype} ligatures and protrusion.
A SI quantity: \SI{9.81}{m/s^2}.

\begin{equation}
  \int_{-\infty}^{\infty} e^{-x^2}\,\mathrm{d}x = \sqrt{\pi}
  \label{eq:gauss}
\end{equation}

See \cref{eq:gauss}.

\begin{tcolorbox}[colback=blue!5!white,colframe=blue!50!black,title=Note]
  Use \texttt{tcolorbox} for callouts.
\end{tcolorbox}

\begin{table}[h]
  \centering
  \begin{tabular}{lrr}
    \toprule
    Item & Q1 & Q2 \\
    \midrule
    Widgets & 120 & 135 \\
    Gadgets & 85  & 92  \\
    \bottomrule
  \end{tabular}
  \caption{Sales by quarter.}
  \label{tab:sales}
\end{table}

\end{document}
```

### Two-column scientific paper

Add `\documentclass[twocolumn,10pt,a4paper]{article}` and the figures will need `figure*` for full-width content:

```latex
\begin{figure*}[t]
  \centering
  \includegraphics[width=0.9\textwidth]{/workspace/temp/figure.pdf}
  \caption{Wide figure across both columns.}
  \label{fig:wide}
\end{figure*}
```

### Beamer slides

```latex
\documentclass{beamer}
\usetheme{Madrid}
\usecolortheme{seahorse}
\usepackage{microtype}

\title{Talk Title}
\author{GemiX}
\date{\today}

\begin{document}
\frame{\titlepage}
\begin{frame}{Outline}
  \tableofcontents
\end{frame}
\section{Intro}
\begin{frame}{Key Idea}
  \begin{itemize}
    \item First point
    \item Second point
  \end{itemize}
\end{frame}
\end{document}
```

Compile with `pdflatex` exactly like an article.

### Figures (matplotlib → LaTeX)

Save figures as PDF (vector) for LaTeX inclusion:

```python
# /workspace/code/figure.py
import numpy as np
import matplotlib.pyplot as plt

x = np.linspace(0, 10, 400)
fig, ax = plt.subplots(figsize=(5, 3))
ax.plot(x, np.sin(x), label=r"$\sin(x)$")
ax.plot(x, np.cos(x), label=r"$\cos(x)$")
ax.set_xlabel(r"$x$")
ax.set_ylabel("amplitude")
ax.legend()
ax.grid(True, alpha=0.3)
fig.savefig("/workspace/temp/figure.pdf", bbox_inches="tight")
plt.close(fig)
```

Then in the `.tex`: `\includegraphics[width=0.7\textwidth]{/workspace/temp/figure.pdf}`.

**Matplotlib rules**:
- Always call `plt.close(fig)` after `savefig` (otherwise the kernel keeps the figure in memory across calls).
- Use raw strings for LaTeX in labels: `r"$\alpha$"`, `r"$\frac{1}{2}$"`.
- Don't call `plt.style.use(...)` if you want LaTeX-rendered text — it overrides text settings.
- Don't use Unicode subscripts/superscripts in labels (`H₂O`); use LaTeX (`$H_2O$`) or plain digits.

### LaTeX pitfalls

- **Compile errors are fatal**: `pdflatex` exits non-zero on the first error with `-halt-on-error`. The `.log` file is in `/workspace/temp/main.log` — `read_file` it to diagnose.
- **Math mode required for special chars**: `_`, `^`, `&`, `%`, `#`, `$` outside math mode must be escaped (`\_`, `\^{}`, `\&`, `\%`, `\#`, `\$`).
- **Non-ASCII in pdflatex**: prefer `xelatex` if the document has accented characters not covered by `T1` font encoding.
- **`shell-escape` is required for `minted`**: add `-shell-escape` to the compile command if you use it.
- **Multiple passes**: ToC, cross-refs, citations, `cleveref` need 2 passes; `biblatex` needs 3 (pdflatex → biber → pdflatex → pdflatex).

---

## pypdf — Manipulation Cookbook

### Merge

```python
from pypdf import PdfReader, PdfWriter
w = PdfWriter()
for src in ["/readonly/history/a.pdf", "/readonly/history/b.pdf"]:
    for page in PdfReader(src).pages:
        w.add_page(page)
with open("/workspace/output/merged.pdf", "wb") as f:
    w.write(f)
```

### Split (one page per file)

```python
from pypdf import PdfReader, PdfWriter
r = PdfReader("/readonly/history/full.pdf")
for i, page in enumerate(r.pages, start=1):
    w = PdfWriter()
    w.add_page(page)
    with open(f"/workspace/output/page_{i:03d}.pdf", "wb") as f:
        w.write(f)
```

### Split by range

```python
from pypdf import PdfReader, PdfWriter
r = PdfReader("/readonly/history/full.pdf")
def slice_pdf(start, end, out):
    w = PdfWriter()
    for i in range(start - 1, end):
        w.add_page(r.pages[i])
    with open(out, "wb") as f:
        w.write(f)
slice_pdf(1, 5,  "/workspace/output/part1.pdf")
slice_pdf(6, 10, "/workspace/output/part2.pdf")
```

### Rotate

```python
from pypdf import PdfReader, PdfWriter
r = PdfReader("/readonly/history/landscape.pdf")
w = PdfWriter()
for page in r.pages:
    page.rotate(90)        # 90, 180, 270, -90, ...
    w.add_page(page)
with open("/workspace/output/rotated.pdf", "wb") as f:
    w.write(f)
```

### Encrypt / Decrypt

```python
# Encrypt
from pypdf import PdfReader, PdfWriter
r = PdfReader("/workspace/output/doc.pdf")
w = PdfWriter()
for p in r.pages: w.add_page(p)
w.encrypt(user_password="user", owner_password="owner")
with open("/workspace/output/secured.pdf", "wb") as f: w.write(f)
```

```python
# Decrypt (e.g., to enable read_file extraction)
from pypdf import PdfReader, PdfWriter
r = PdfReader("/readonly/history/secured.pdf")
if r.is_encrypted:
    r.decrypt("user")
w = PdfWriter()
for p in r.pages: w.add_page(p)
with open("/workspace/temp/clear.pdf", "wb") as f: w.write(f)
```

### Watermark (overlay an existing 1-page PDF on every page)

```python
from pypdf import PdfReader, PdfWriter
base = PdfReader("/readonly/history/contract.pdf")
mark = PdfReader("/workspace/temp/watermark.pdf").pages[0]
w = PdfWriter()
for page in base.pages:
    page.merge_page(mark)
    w.add_page(page)
with open("/workspace/output/contract_wm.pdf", "wb") as f:
    w.write(f)
```

The watermark PDF should have a transparent background and the same page size as the base.

### Crop

```python
from pypdf import PdfReader, PdfWriter
r = PdfReader("/readonly/history/scan.pdf")
w = PdfWriter()
for page in r.pages:
    # mediabox uses points (1 pt = 1/72 in). Coordinates are bottom-left origin.
    page.mediabox.left = 50
    page.mediabox.bottom = 50
    page.mediabox.right = 562   # 612 - 50
    page.mediabox.top = 742     # 792 - 50
    w.add_page(page)
with open("/workspace/output/cropped.pdf", "wb") as f:
    w.write(f)
```

### Metadata

```python
from pypdf import PdfReader, PdfWriter
r = PdfReader("/workspace/output/doc.pdf")
w = PdfWriter(clone_from=r)
w.add_metadata({
    "/Title": "Annual Report 2026",
    "/Author": "GemiX",
    "/Subject": "Q1–Q4 review",
})
with open("/workspace/output/doc_meta.pdf", "wb") as f:
    w.write(f)
```

---

## Poppler CLI — Quick Reference

### Render a page → PNG (visual QA, previews)

```bash
pdftoppm -png -r 300 -f 1 -l 1 /workspace/output/document.pdf /workspace/temp/preview
```

Produces `/workspace/temp/preview-1.png`. Use `-r 200` for previews, `-r 300` for QA, `-r 600` for highest fidelity.

For all pages:

```bash
pdftoppm -png -r 200 /workspace/output/document.pdf /workspace/temp/page
```

### Extract embedded raster images (originals, not page renders)

```bash
pdfimages -all /readonly/history/document.pdf /workspace/temp/img
```

Output: `/workspace/temp/img-000.<ext>`, `/workspace/temp/img-001.<ext>`, …

### Inspect metadata

```bash
pdfinfo /readonly/history/document.pdf
```

---

## Visual Verification

After producing or editing a PDF, render the relevant pages and inspect them with `read_file`. Catch font issues, layout overflow, mis-cropped images, and overlapping text:

```bash
pdftoppm -png -r 300 -f 1 -l 3 /workspace/output/document.pdf /workspace/temp/verify
```

```
read_file /workspace/temp/verify-1.png
read_file /workspace/temp/verify-2.png
read_file /workspace/temp/verify-3.png
```

For multi-page documents, render selectively (`-f 1 -l 1`, then later pages on demand) to keep the round small. **Do not** `read_file` the produced `.pdf` itself for QA — it would only run the parser on your own output and waste a round; rendering pages to PNG is faster and shows the real layout.

---

## Common Pitfalls

- **Spec characters in LaTeX**: `_ ^ & % # $ ~` outside math mode need escaping. Forgetting is the #1 compile failure.
- **Reportlab cell overflow**: never put a bare string in a `Table` cell; always wrap in `Paragraph`. Always set `colWidths` proportionally to expected content. Total `colWidths` must fit the printable area.
- **Reportlab Unicode subscripts**: use `<sub>` / `<super>` markup, never Unicode characters.
- **Matplotlib leaks**: every `savefig` must be followed by `plt.close(fig)`.
- **Vector vs raster figures for LaTeX**: save figures as `.pdf` (vector) when included via `\includegraphics`. Use `.png` only for raster artwork.
- **`pdftoppm` resolution**: `-r 100` for thumbnails, `-r 300` for QA, `-r 600` for highest fidelity. Higher values produce huge files for no benefit when a human is reading.
- **Path absolute always**: every script and every LaTeX `\includegraphics` path must start with `/workspace/` or `/readonly/`.
- **No `cat << EOF` for code generation**: write `.py`/`.tex`/`.json` via `write_file`, never via shell heredoc — it is more reliable than escaping content in the shell.
- **Image sourcing**: use `web_x_search` with `search_images=true` to fetch external imagery; reference the returned `/workspace/<file>` path verbatim.

---

## See Also

- `reference.md` — advanced reportlab Platypus (TOC, footers, custom canvas), LaTeX with TikZ/pgfplots and biblatex, Ghostscript compression, encrypted-file recovery, and troubleshooting.
