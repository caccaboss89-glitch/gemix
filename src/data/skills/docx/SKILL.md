---
name: docx
description: Create or edit Word .docx or .dotx in /workspace/. Not for PDF, LaTeX, plain Markdown, or spreadsheets.
---

# Word Document Guide

A guide for creating, editing, and inspecting Word documents inside the build
sandbox. Files live in `/workspace/` (read/write); this skill's files are
read-only under `/skills/docx/`.

## Images (use proactively)

For reports, memos with visuals, covers, and product sheets, **embed images**
(photo, diagram, logo, chart)—not text-only unless the user asked for plain text.

1. **Already in `/workspace/`** (attachments, charts from earlier steps) → `ImageRun`.
2. **None available** → one `web_search` for images; save URLs with `download_file` into
   `/workspace/`.
3. **Charts** → matplotlib → PNG → `ImageRun`.

`generate_image` / `generate_video` are **not** available inside build—only staged
files, your renders, or web search. After adding images, run `render_doc.py` and
`read_file` with `path: ["/workspace/doc_pages.jpg"]` to catch overflow or bad placement.

## Pitfalls (read before delivery)

- **Round budget**: typical report **12–22** tool calls — one `web_search`
  for facts, optional one `web_search` for images (`download_file` the URLs), one QA
  render (`render_doc.py` → `read_file` `path: ["/workspace/doc_pages.jpg"]`); fix once, re-render at most once.
  No Python loops dumping every paragraph unless debugging a specific bug.
- **Illustrated reports** (sport, history, product…): ≥1 `ImageRun` unless user
  asked text-only. No photos in `/workspace/` → `web_search` for images, then
  `download_file`. Before delivery, `inspect_docx.py` must not show
  `Inline images/shapes: 0`.
- **TOC**: manual index (plain paragraphs), not `TableOfContents` alone (raw
  `TOC \\h` until Word updates). If you used a TOC field, one LibreOffice pass—
  no Python TOC rewrite loops.
- Never `convert_doc.py --to docx` on a file already `.docx`.

A `.docx` is a ZIP of XML parts; a `.dotx` is a Word template, structurally the
same. This skill uses a small, deliberate toolchain — pick by task:

| Task | Tool | Why |
|------|------|-----|
| **Create** a document from scratch | **docx-js** (Node) | Native TOC, footnotes, columns, hyperlinks, precise tables — highest fidelity |
| **Fill a template** with placeholders/loops/conditionals | **docxtemplater** (Node) via `fill_template.js` | Real templating engine; keeps the template's design |
| **Literal find-and-replace** on a normal Word file | **python-docx** via `replace_text.py` | Simple value swaps preserving run formatting |
| **Inspect** structure/text/tables | **python-docx** via `inspect_docx.py` | Exact structure dumps; `read_file` gives a semantic overview only |
| **Convert / render / accept changes** | LibreOffice via the `.py` helpers | No Node/Python-lib equivalent |

## Companion files

- `references/editing.md` — the workflow for **editing or filling an existing document or
  template** the user supplied in `/workspace/` (docxtemplater for placeholder
  templates, `replace_text.py` for literal swaps, python-docx for structural
  edits, accepting tracked changes). **Read it first whenever a .docx/.dotx is
  attached.**
- `scripts/fill_template.js` — render a docxtemplater template (`{tags}`, loops,
  conditionals, dynamic table rows) with a JSON data file. (Node)
- `scripts/inspect_docx.py` — print a document's sections, styles, paragraphs,
  tables, headers/footers, and image count.
- `scripts/replace_text.py` — literal text replacement across runs/tables/
  headers/footers preserving formatting (no placeholder syntax needed).
- `scripts/render_doc.py` — render all pages into one labeled JPEG grid for a
  quick visual check.
- `scripts/convert_doc.py` — convert `.doc`/`.dotx` → `.docx`, or `.docx` →
  `pdf` / per-page images.
- `scripts/accept_changes.py` — produce a clean copy with all tracked changes
  accepted (headless LibreOffice).
- `scripts/soffice.py` — internal helper imported by the conversion/render/
  accept scripts to launch LibreOffice; you never run it directly.

Read `references/editing.md` with one `read_file` call — `path:
["/skills/docx/references/editing.md"]` — only when the task is about an existing
document.

## Inspecting a document (read vs. extract)

`read_file` parses `.docx`/`.dotx` natively for **understanding** (semantic view).
For **exact** text/values or structural inspection, use the scripts — never retype
what you saw:

- Structure / text / tables: run `python /skills/docx/scripts/inspect_docx.py
  file.docx` (add `--text` for the full paragraph list, `--tables` for full
  table dumps).
- Visual layout: `python /skills/docx/scripts/render_doc.py file.docx` → a
  labeled page grid you then `read_file` with `path: ["/workspace/doc_pages.jpg"]`, or `convert_doc.py --to
  pdf` and `read_file` with `path: ["/workspace/file.pdf"]`.

Read-vs-extract rule: use `read_file` or the scripts above to *understand* a
document; to copy its exact text/values into another file, pull them with
`python-docx` (`Document(...).paragraphs`, `table.rows`), never by retyping.

## Available tools

Node (pre-installed globally, resolvable from `/workspace/` — no `npm` at
runtime): `docx` (docx-js, create from scratch), `docxtemplater` + `pizzip` +
`angular-expressions` (template filling, via `fill_template.js`).

Python (pre-installed, no `pip` at runtime): `python-docx` (inspect, literal
replace, structural edits), `Pillow`/`matplotlib` (prepare/measure images,
render charts), `pandas` (tabular data), `cairosvg` (SVG→PNG).

Command line: `libreoffice`/`soffice` (headless — conversion, accept tracked
changes, page rendering, TOC/field updates) and `pdftoppm` (page images), both
driven by the helper scripts.

Not available (do not reach for these): the old raw-XML pipeline (`pandoc`,
`defusedxml`, unpack/pack/XSD validators); `qpdf`/`pdftk`/ImageMagick. There is
no need to hand-edit OOXML — docx-js and docxtemplater produce valid files.

## Output requirements

- Any text inside the document (body, headings, tables, captions, header/footer)
  goes in the **user's language**, with **no emojis** unless the user explicitly
  asks — document fonts often render them as black boxes.
- Generated documents default to **A4** with sensible margins (we are in an
  EU/Italian context), not US Letter.
- When editing an existing document, **match its layout, fonts, styles, and
  conventions** instead of imposing your own — see `references/editing.md`.

---

## Creating a new document — docx-js (Node)

Write a Node script in `/workspace/` and run it with `node`. The global modules
resolve automatically (`NODE_PATH` is set); do not run `npm install`.

```javascript
// /workspace/build_doc.js
const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
} = require("docx");

const doc = new Document({
  sections: [{
    properties: {
      page: {
        // A4 in DXA (1440 DXA = 1 inch). A4 = 11906 x 16838.
        size: { width: 11906, height: 16838 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
      },
    },
    children: [
      new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun("Report Title")] }),
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Introduction")] }),
      new Paragraph({ children: [
        new TextRun("Body text in the user's language. "),
        new TextRun({ text: "Bold part.", bold: true }),
      ]}),
    ],
  }],
});

Packer.toBuffer(doc).then((buf) => fs.writeFileSync("/workspace/report.docx", buf));
```

Run: `node /workspace/build_doc.js`.

### Page size (default A4) and orientation

```javascript
// A4 portrait (default for us):  width 11906, height 16838 DXA
// Landscape: docx-js swaps width/height internally — pass PORTRAIT dims and set orientation.
const { PageOrientation } = require("docx");
page: {
  size: { width: 11906, height: 16838, orientation: PageOrientation.LANDSCAPE },
  margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
}
// Content width = long edge (16838) minus left+right margins when landscape.
```

| Paper | Width (DXA) | Height (DXA) | Content width @1" margins |
|-------|-------------|--------------|---------------------------|
| A4 (default) | 11906 | 16838 | 9026 |
| US Letter | 12240 | 15840 | 9360 |

### Styles (override the built-in headings)

Use a widely-available font (e.g. Arial/Calibri). Keep heading text dark for
readability.

```javascript
const doc = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 24 } } }, // 24 half-pts = 12pt
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 0 } }, // outlineLevel required for TOC
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 180, after: 120 }, outlineLevel: 1 } },
    ],
  },
  sections: [{ children: [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Title")] }),
  ]}],
});
```

### Lists (never type bullet characters)

```javascript
const { LevelFormat, AlignmentType } = require("docx");

const doc = new Document({
  numbering: { config: [
    { reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "\u2022",
      alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    { reference: "numbers", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.",
      alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
  ]},
  sections: [{ children: [
    new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("Bullet item")] }),
    new Paragraph({ numbering: { reference: "numbers", level: 0 }, children: [new TextRun("Numbered item")] }),
  ]}],
});
// Same reference continues numbering (1,2,3,4); a new reference restarts at 1.
```

### Tables

Set the table width AND each cell width, both in DXA; use `ShadingType.CLEAR`
(never SOLID) for cell fills; add cell margins for padding.

```javascript
const { Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType } = require("docx");

const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };

new Table({
  width: { size: 9026, type: WidthType.DXA },   // A4 content width
  columnWidths: [4513, 4513],                    // must sum to table width
  rows: [
    new TableRow({ children: [
      new TableCell({
        borders, width: { size: 4513, type: WidthType.DXA },
        shading: { fill: "D5E8F0", type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({ children: [new TextRun({ text: "Header", bold: true })] })],
      }),
      new TableCell({ borders, width: { size: 4513, type: WidthType.DXA },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({ children: [new TextRun("Value")] })] }),
    ]}),
  ],
})
```

Rules: always `WidthType.DXA` (never PERCENTAGE — it breaks in some viewers);
table width = sum of `columnWidths`; cell `width` matches its column; never use
tables as horizontal rules (use a paragraph bottom border instead).

### Images

`ImageRun` takes raw bytes via `data` (not a path/URL); `type` is required;
preserve the aspect ratio by computing one dimension from the other.

```javascript
const fs = require("fs");
const { ImageRun, Paragraph, AlignmentType } = require("docx");

const data = fs.readFileSync("/workspace/chart.png");
const origW = 1978, origH = 923, targetW = 450;
const targetH = Math.round(targetW * (origH / origW));   // keep ratio

new Paragraph({
  alignment: AlignmentType.CENTER,
  children: [new ImageRun({
    type: "png",                                   // png | jpg | jpeg | gif | bmp | svg
    data,
    transformation: { width: targetW, height: targetH },
    altText: { name: "Quarterly chart", description: "Revenue by quarter", title: "Chart" },
  })],
})
// SVG also needs a PNG fallback: { type: "svg", data: svgBytes, fallback: { type: "png", data: pngBytes } }
```

Where images come from (see **Images (use proactively)** above): staged files,
matplotlib PNGs, or `web_search` images saved via `download_file`. SVG: `type: "svg"`
with PNG fallback, or `cairosvg.svg2png(...)`.

### Headers, footers, page numbers

```javascript
const { Header, Footer, PageNumber, Paragraph, TextRun } = require("docx");

sections: [{
  headers: { default: new Header({ children: [new Paragraph({ children: [new TextRun("Company Name")] })] }) },
  footers: { default: new Footer({ children: [new Paragraph({ children: [
    new TextRun("Page "), new TextRun({ children: [PageNumber.CURRENT] }),
    new TextRun(" of "),   new TextRun({ children: [PageNumber.TOTAL_PAGES] }),
  ]})] }) },
  children: [/* ... */],
}]
```

### Table of contents, footnotes, hyperlinks, columns

```javascript
const { TableOfContents, FootnoteReferenceRun, ExternalHyperlink, TextRun, Paragraph } = require("docx");

// TOC — headings must use HeadingLevel (with outlineLevel in the style) only.
new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-3" });

// Footnotes — declare on the Document, reference inline.
// new Document({ footnotes: { 1: { children: [new Paragraph("Source: ...")] } }, sections: [...] })
new Paragraph({ children: [new TextRun("Revenue grew"), new FootnoteReferenceRun(1)] });

// External hyperlink
new Paragraph({ children: [new ExternalHyperlink({
  children: [new TextRun({ text: "Open site", style: "Hyperlink" })], link: "https://example.com",
})]});

// Multi-column section
// properties: { column: { count: 2, space: 720, equalWidth: true, separate: true } }
```

The TOC field shows a placeholder until a Word/LibreOffice recalculation fills
it. To deliver it already populated, round-trip the file through LibreOffice
(`convert_doc.py --to pdf` for a PDF deliverable, or open→save via the convert
helper) before delivery.

### docx-js gotchas

- Set the page size explicitly (default is A4 — fine for us; set Letter only on
  request). Landscape: pass portrait dims + `orientation: LANDSCAPE`.
- Never use `\n` for line breaks — use separate `Paragraph`s or `new TextRun({ break: 1 })`.
- Never type bullet characters — use a `numbering` config with `LevelFormat.BULLET`.
- `PageBreak` must sit inside a `Paragraph`.
- `ImageRun` needs `type` and `data` (bytes), not a path; SVG needs a `fallback`.
- Tables: `WidthType.DXA`, table width = Σ column widths, `ShadingType.CLEAR`.
- TOC entries require real heading styles with `outlineLevel`.

---

## Filling a template with logic — docxtemplater (Node)

When the user supplies a template that contains placeholders (`{name}`), loops
(`{#items}...{/items}`), or conditionals (`{#flag}...{/flag}`), render it with
the helper instead of editing by hand:

```bash
node /skills/docx/scripts/fill_template.js /workspace/template.docx /workspace/data.json /workspace/out.docx
```

`data.json` is the object the template reads:

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

Template tag reference (authored inside the Word document):
`{company}` value · `{#items}{name} x{qty}{/items}` loop (put `{#items}` in a
table row to repeat the row) · `{#hasDiscount}...{/hasDiscount}` conditional ·
`{^hasDiscount}...{/hasDiscount}` inverted · `{price | upper}` filter. Image
placeholders are not supported — add images afterwards with python-docx or build
from scratch with docx-js. See `references/editing.md` for the full template workflow.

---

## Editing or filling an existing document

When the user attaches a `.docx`/`.dotx`, **read it with one `read_file` call** —
`path: ["/skills/docx/references/editing.md"]` — and follow that guide. The rule
is to edit/fill the supplied file (keeping its design) rather than rebuilding it
from scratch.

## Visual verification (before delivering)

After creating or editing a document, render it and look at it — do NOT trust
the structure alone, and do not rely on `read_file` alone for pixel-perfect QA:

```bash
python /skills/docx/scripts/render_doc.py /workspace/output.docx
# then: read_file path: ["/workspace/doc_pages.jpg"]
```

This catches overflowing tables, wrong fonts, misplaced images, empty
placeholders, and bad page breaks that are invisible in the raw structure. For a
single long document, `convert_doc.py --to pdf` then `read_file` with `path: ["/workspace/file.pdf"]` also
works. **One** page grid is enough — do not re-render more than twice.

## Round budget (typical report: 12–22 tool calls)

| Once | Avoid |
|------|--------|
| One `read_file` `path: ["/skills/docx/SKILL.md", "/skills/docx/references/editing.md"]` (omit editing.md when not filling/editing an attachment) | Re-reading the same guides |
| One `web_search` for facts | Multiple overlapping research calls |
| One `web_search` for images + `download_file` if visuals needed | Extra image-only searches |
| `inspect_docx.py` before deliver on illustrated docs | Skipping image-count check |
| `render_doc.py` → one `read_file` `path: ["/workspace/doc_pages.jpg"]` | Per-page `read_file` loops; 3+ renders |
| `edit_file` / `fill_template.js` surgical fixes | Rebuilding the whole document from memory |

Match heading/body contrast to the template (dark cover → light text on dark fill;
light body pages → dark text on white — never light gray on white).
