---
name: pdf
description: PDFs: create/edit (LaTeX, reportlab, merge, split, rotate, encrypt). DO NOT use for reading/analysis; use read_file instead.
---

# PDF Skill Guide

> [!IMPORTANT]
> **MANDATORY RULE**: Use ONLY the CLI flags explicitly documented for each script in this guide. **DO NOT invent flags** (e.g., NEVER use `--no-env` or `--verbose`). If a flag is not listed here, it is NOT supported.

**PDF Analysis**: Use `read_file` for text, tables, and OCR (GemiX Hybrid Parser). This skill is for **creation and manipulation only**. If a PDF is password-protected, `read_file` will fail; use `pdf_manipulate.py decrypt` to create a clear version in `/workspace/temp/` before processing.

---

## LaTeX Pipeline (Professional & Scientific PDFs)

For complex documents (equations, multi-column, figures, high-end typography) use **LaTeX + Matplotlib**, not `reportlab`.

### Script Reference

| Script | Purpose | Use when |
| :--- | :--- | :--- |
| `unified_pdf_generator.py` | Full pipeline: figures → render → compile | ✅ **Default choice** |
| `render_latex_template.py` | Jinja2 template rendering only | Pre-existing figures with fixed paths |
| `generate_matplotlib_figure.py` | Standalone Matplotlib figure | Single figure, no template |
| `compile_tex.py` | `.tex` → `.pdf` compilation | Manual `.tex` already created |
| `latex_helper.py` | Generate LaTeX snippets (tables, SymPy equations) | Before rendering, Phase 1 |
| `pdf_manipulate.py` | Merge, split, rotate, encrypt PDFs | Post-generation cleanup |

> `latex_utils.py` is an internal utility used by the scripts above — ignore it.

### Execution Strategy

- **Default Choice**: Use `unified_pdf_generator.py` for standard documents and figures.
- **Low-Level**: Use individual scripts for manual debugging or custom compilation flags.
- **Workflow**: Combine `write_file` (JSON data) with `bash` (Python script) in the same round.

**PDF-Specific Rules**:
- **JSON Escaping**: LaTeX backslashes MUST be doubled in `.json` files (e.g., `"\\input"`).
- **No `cat << EOF`**: Never use bash to create LaTeX/JSON files; use `write_file`.
- **Snippet Phase**: Use `execution_phase: "before_all"` for `latex_helper.py` snippet generation.
- **No Pass-through JSON**: Never use `--data '{"json":...}'`. Always use `--data-file`.
- **Absolute Paths**: Strict enforcement of `/workspace/` or `/readonly/` prefixes.
- **Scripts vs Tools**: All utilities (like `latex_helper.py`, `pdf_manipulate.py`, etc.) are SCRIPTS. Call them via `bash`. DO NOT try to use them as tool names.
- **No Concatenation**: NEVER combine multiple PDF scripts in a single `bash` command using `&&` or `;`. Emit them as separate tool calls.
- **Unified Generator MANDATORY**: Use `unified_pdf_generator.py` for ALL professional documents. DO NOT manually chain `render_latex_template.py` and `compile_tex.py` unless the unified script is technically insufficient.
- **PDF Manipulation (Split)**: The `split` action generates files with a 3-digit zero-padded suffix (e.g., `prefix_001.pdf`). Always check the tool output for the exact filenames.
- **Image Search**: Include relevant images from internet when appropriate to enhance visual appeal and clarity. Use `image_search` with `save_to_disk=true` to make them available under `/readonly/searched_images/`. Use the EXACT path returned by the tool.

---

## Template Catalog

All templates use **Jinja2** with LaTeX-safe delimiters (`\VAR{}`, `\BLOCK{}`).

> **Field escaping**: `latex_escape` is applied automatically to all fields **not** marked **(Raw)**. Fields marked **(Raw)** accept raw LaTeX (math, `\input{}`, etc.) and are passed directly.

**Notation:** **(Raw)** = raw LaTeX · **(Optional)** = can be omitted · **(bool)** = `true`/`false` · **(Flat)** = plain string/path

---

### `scientific_template.tex` — Professional 2-column paper
- **Data**: `title`, `author`, `date`, `abstract` (Optional, Raw), `show_toc` (Optional, bool, default: `false`)
- **Sections**: Array of `{title, content (Raw)}` objects, and optionally one of:
  - `figure`: `{path (Flat), caption (Raw), label}`
  - `figure_path`: simple path (Flat, no caption)

### `beamer_presentation.tex` — Slides (Madrid theme)
- **Data**: `title`, `author`, `date`, `subtitle` (Optional), `institute` (Optional), `show_toc` (Optional, bool), `thank_you_slide` (Optional, bool)
- **Frames**: Array of `{title, content (Raw), options (Optional, e.g. "t"), figure_path (Optional, Flat), caption (Optional, Raw)}`

### `modern_cv_professional.tex` — Elegant CV
- **Data**: `name`, `title`, `email` (Optional), `phone` (Optional), `linkedin` (Optional), `location` (Optional), `summary` (Optional, Raw)
- **Sections**: Array of `{title, type}` where `type` is one of:
  - `"experience"` → `entries`: `[{position, company, dates, location, description (Raw)}]`
  - `"education"` → `entries`: `[{degree, institution, dates, location, description (Raw)}]`
  - `"skills"` → `categories`: `[{name, items (String or List)}]`
  - `"other"` → `content` (Raw)

### `technical_report.tex` — Single-column report (`\chapter` per section)
- **Data**: `title`, `author`, `date`, `subtitle` (Optional), `abstract` (Optional, Raw), `conclusion` (Optional, Raw)
- **Sections**: Array of `{title, content (Raw), figures (Optional Array of {path, caption, label})}`

### `business_invoice.tex` — Business invoice
- **Data**: `invoice_number`, `date`, `due_date`, `subtotal`, `total`, `logo_path` (Optional, Flat), `tax_rate` (Optional), `tax_amount` (Optional), `notes` (Optional, Raw)
- **sender** / **recipient**: Objects with `{name, address, city, zip, vat (Optional), email (Optional)}`
- **items**: Array of `{description, quantity, unit_price, amount}`
- **payment_info**: Object with `{method, bank_details (Raw)}`

---

## Unified Generator — Command & Data Format

```bash
# Phase 3 (after_all) — pair with write_file in Phase 2
python /readonly/skills/pdf/scripts/unified_pdf_generator.py \
  --template /readonly/skills/pdf/assets/templates/scientific_template.tex \
  --data-file /workspace/temp/data.json \
  --output /workspace/output/document.pdf \
  --verify
# Optional flags: --figures-dir <subdir> (default: temp), --snippets <dir>...
#                 --engine pdflatex|xelatex|lualatex (default: pdflatex)
```

**`data.json` skeleton (scientific example):**
```json
{
  "title": "General Relativity: Black Holes",
  "author": "GemiX AI",
  "date": "2026",
  "figures": [
    {
      "filename": "veff.pdf",
      "code": "import numpy as np\nimport matplotlib.pyplot as plt\n# ... plot code ...",
      "title": "Effective Potential"
    }
  ],
  "sections": [
    {"title": "Introduction", "content": "Raw LaTeX content...", "figure_path": "veff.pdf"}
  ]
}
```
> **Note**: The script handles `plt.savefig()` and `plt.close()` automatically.

**Linking figures**: reference the `filename` from the `figures` array inside sections via `"figure_path": "filename.pdf"` or `"figure": {"path": "filename.pdf"}`. Filenames are resolved to absolute paths automatically.

---

## Math & Physics Cheat Sheet (`latex_helper.py` vs custom Python)

The AI often fails by passing LaTeX to SymPy or using undefined symbols. Use this table as a strict guide.

| Goal | Tool | ❌ WRONG (LaTeX/Undefined) | ✅ RIGHT (Math Expression) |
| :--- | :--- | :--- | :--- |
| Simple fraction | `latex_helper` | `--expr "\frac{a}{b}"` | `--expr "a/b"` |
| Power/Superscript | `latex_helper` | `--expr "e^{x}"` | `--expr "exp(x)"` or `"e**x"` |
| Schrödinger Eq | `latex_helper` | `--expr "H\Psi = E\Psi"` | `--expr "H*Psi = E*Psi"` |
| Derivative | `latex_helper` | `--expr "\frac{d}{dx}f(x)"` | `--expr "diff(f(x), x)"` |
| Equality | `latex_helper` | `--expr "a == b"` | `--expr "a = b"` or `"Eq(a, b)"` |
| Complex physics | `write_file` + `bash python` | `from sympy import hbar` | `from sympy.physics.quantum.constants import hbar` |

### 💡 The "Emergency LaTeX" Strategy
If `latex_helper.py` fails with a conversion error, **DO NOT RETRY**. Write the raw LaTeX to a file directly via `write_file`:

```python
# Phase 2 — write_file `/workspace/temp/equation.tex` directly with the raw LaTeX content.
# (No bash/python detour needed.)
```
Then proceed to compilation/rendering as usual.

---

## Troubleshooting & Common Fails

### 1. "Command failed" in `unified_pdf_generator.py`
This is often a **race condition** (file not yet flushed to disk).
- **Check Stderr**: If it says "Waiting for referenced file...", it's a synchronization delay.
- **Solution**: The script now has an auto-retry, but if it still fails, run the generator alone in a dedicated round.

### 2. "ImportError" in a workspace Python script
- `hbar` is NOT in the main `sympy` namespace. Use: `from sympy.physics.quantum.constants import hbar`.
- `grad`, `div`, `curl` are NOT standard functions. Use `diff()` or `sympy.vector`.

---

## LaTeX Snippets & Tables (`latex_helper.py`)

Run in **Phase 1** (`before_all`), then include output via `\input{/workspace/temp/snippet.tex}` in any **(Raw)** field.

```bash
# SymPy expression → LaTeX equation file
python /readonly/skills/pdf/scripts/latex_helper.py sympy \
  --expr "diff(x**2 * sin(x), x)" \
  --output /workspace/temp/derivative.tex
# Flags: --no-simplify (skip simplification), --inline ($...$ wrapper)

# Booktabs table from JSON data
python /readonly/skills/pdf/scripts/latex_helper.py table \
  --data-file /workspace/temp/results.json \
  --output /workspace/temp/table.tex \
  --caption "Model comparison" \
  --label "tab:comparison" \
  --alignment "Xll" 
# Flags: --alignment "lcr" or "Xll", --caption, --label
```

---

## Low-Level Workflow (Alternative)

Emit all `bash` calls in **Phase 3**. Figure paths must be hardcoded in `data.json` **before** rendering.

**1. Render template:**
```bash
python /readonly/skills/pdf/scripts/render_latex_template.py \
  /readonly/skills/pdf/assets/templates/scientific_template.tex \
  --data-file /workspace/temp/data.json \
  --output /workspace/temp/main.tex
```

**2. Generate figure:**
```bash
python /readonly/skills/pdf/scripts/generate_matplotlib_figure.py \
  --code "x = np.linspace(0, 10, 100); plt.plot(x, np.sin(x))" \
  --output /workspace/temp/my_fig.pdf \
  --title "Sine Wave"
# Note: plt/np are pre-injected. Script handles savefig/close.
# Flags: --caption, --no-usetex, --params-file
```

**3. Compile:**
```bash
python /readonly/skills/pdf/scripts/compile_tex.py /workspace/temp/main.tex
# Flags: --engine pdflatex|xelatex|lualatex, --no-clean (keep aux files)
```

---

## Professional Aesthetics

The templates include `microtype`, `siunitx`, `cleveref`, and `bm` by default.

### Matplotlib Figure Quality
- **Colors**: Use `import seaborn as sns; sns.set_palette("muted")`. 
- **Style**: DO NOT use `plt.style.use()`; it overrides the publication-grade script defaults.
- **Layout**: `bbox_inches='tight'` is automatic. DO NOT call `plt.tight_layout()`.

### LaTeX Table Quality
- **Lines**: Never use vertical lines (`|`). `booktabs` (via `latex_helper.py`) handles rules correctly.
- **Alignment**: Use `--alignment "Xrr"` for text-left / numbers-right layout.

### Visual Verification
Render a 300 DPI preview in the same round as compilation, using separate standalone `bash` calls:
```bash
mkdir -p /workspace/temp/verify
```
```bash
pdftoppm -png -r 300 -f 1 -l 1 /workspace/output/document.pdf /workspace/temp/verify/page
```

---

## PDF Manipulation (`pdf_manipulate.py`)

Do NOT use `qpdf` directly or write custom scripts. Use the provided script:

```bash
# Merge
python /readonly/skills/pdf/scripts/pdf_manipulate.py merge \
  --inputs /workspace/output/doc1.pdf /workspace/output/doc2.pdf \
  --output /workspace/output/merged.pdf

# Split (page ranges)
python /readonly/skills/pdf/scripts/pdf_manipulate.py split \
  --input /workspace/output/full.pdf --pages 1-5,7-10 \
  --output-prefix /workspace/temp/part

# Rotate (angle: 90, 180, 270, -90, -180, -270)
python /readonly/skills/pdf/scripts/pdf_manipulate.py rotate \
  --input /workspace/output/doc.pdf --pages 1,3-5 --angle 90 \
  --output /workspace/output/rotated.pdf

# Encrypt / Decrypt
python /readonly/skills/pdf/scripts/pdf_manipulate.py encrypt \
  --input /workspace/output/doc.pdf --password "secret" --output /workspace/output/secure.pdf
python /readonly/skills/pdf/scripts/pdf_manipulate.py decrypt \
  --input /workspace/output/secure.pdf --password "secret" --output /workspace/output/doc.pdf

# Watermark
python /readonly/skills/pdf/scripts/pdf_manipulate.py watermark \
  --input /workspace/output/doc.pdf --watermark /workspace/temp/wm.pdf \
  --output /workspace/output/doc_wm.pdf

# Info
python /readonly/skills/pdf/scripts/pdf_manipulate.py info --input /workspace/output/doc.pdf
```

---

## Basic PDF Creation (ReportLab)

For simple documents without complex math or layout:

```python
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

c = canvas.Canvas("/workspace/output/hello.pdf", pagesize=letter)
w, h = letter
c.drawString(100, h - 100, "Hello World!")
c.line(100, h - 140, 400, h - 140)
c.save()
```

**With image:**
```python
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

c = canvas.Canvas("/workspace/output/doc.pdf", pagesize=letter)
w, h = letter
img = ImageReader("/workspace/temp/chart.png")  # or /readonly/searched_images/<file>
iw, ih = img.getSize()
tw = 4.5 * inch
th = tw * (ih / iw)
c.drawImage(img, inch, h - inch - th, width=tw, height=th)
c.save()
```
