# Creating a Presentation from Scratch

Use this workflow when no `.pptx` is provided and you must build a deck. If the
user attached a `.pptx` to change, use [editing.md](editing.md) instead.

Decks are generated with **Node.js + pptxgenjs**. 20 professional templates ship
in `/skills/pptx/templates/` — prefer starting from one. They encode tested
layouts, font pairings, and color palettes, and produce far better results than
writing a deck from an empty canvas.

## Step 1 — Pick a template

The templates are indexed in `/skills/pptx/templates/template_taxonomy.json` by their
`color_scheme`, `typography`, `visual_density`, `background`, `accent_elements`,
`mood`, and `n_pages`. Do NOT `cat` that file or grep it — use the search
script, which ranks by relevance:

```bash
# Keyword search across all fields (name, color, mood, typography, ...)
python /skills/pptx/scripts/search_templates.py dark startup minimalist
python /skills/pptx/scripts/search_templates.py luxury premium serif

# Field-specific filters
python /skills/pptx/scripts/search_templates.py --mood corporate --color navy
python /skills/pptx/scripts/search_templates.py --typography serif --density balanced

# Combine keywords + filters, show more results
python /skills/pptx/scripts/search_templates.py fintech --mood startup --limit 10
```

Derive search terms from the request (topic, audience, tone, color preferences)
and run one or more queries.

**Choose by visual design, not by the template's original topic.** A template
built for a restaurant works fine for a SaaS pitch — what matters is whether its
palette, typography, density, and mood fit the deck you need. Evaluate all
candidates; do not just take the first result.

## Step 2 — Copy it into the workspace

```bash
cp /skills/pptx/templates/<chosen_template>.js /workspace/presentation.js
```

**Do not rewrite the deck from scratch.** Templates already encode working
backgrounds, contrast-safe palettes, and `addChrome()`. Surgical edits only
(text, numbers, image paths, slide copy). A full `write_file` rewrite routinely
drops `slide.background`, wastes 20+ rounds, and produces white slides with
light gray text.

## Step 3 — Adapt the content

Edit `/workspace/presentation.js`: replace titles, body text, data, labels, and
(optionally) accent colors with the real content. **Keep** the template's
`addChrome()`, `C.bg`, shadow factories, and `const pres = new pptxgen()` block
where the template places them. Keep text in the user's language and avoid
emojis (Office fonts render them as black boxes).

### Contrast & backgrounds (CRITICAL)

- **Every slide** must set a solid background — typically inside `addChrome()`:
  `slide.background = { color: C.bg };` (no `#` prefix on hex).
- **Dark brief → dark template.** Body text on dark slides: `C.white`, `C.fgMid`,
  accents — never pale `E8F4FF` / `9AAAB8` on white.
- **Light brief → light template.** Body text: `363636`, `1E293B` — not light
  gray on white.
- If the user asked for a dark / space / navy deck, pick a template whose
  `background` field is `dark` or `gradient` — do not use a light corporate
  template and only change text colors.

Every template accepts the output filename as the first CLI argument
(`process.argv[2]`), falling back to its own default name. Pass the name you
want in Step 4.

## Step 4 — Generate the .pptx

Pass the output filename as the argument so you control exactly what is produced:

```bash
cd /workspace && node presentation.js presentation.pptx
```

If a template uses icon libraries (`react-icons`, `sharp`, `react`,
`react-dom`), those are installed globally alongside `pptxgenjs`. Most templates
need only `pptxgenjs`.

## Step 5 — Visual QA (cap rounds)

```bash
cd /workspace && node presentation.js presentation.pptx
python /skills/pptx/scripts/inspect_pptx.py /workspace/presentation.pptx
python /skills/pptx/scripts/render_slides.py /workspace/presentation.pptx
```

1. **`inspect_pptx.py` must pass** before you deliver. If it fails with
   "no slide sets slide.background", restore the template's `addChrome()` on
   every slide function — do not deliver.
2. One `read_file` with `path: ["/workspace/contact-sheet.jpg"]` first. If slides look white but the
   brief was dark-themed, backgrounds failed — fix the `.js`, re-run node +
   inspect + render (one pass).
3. Add at most **1–3** `slide-NN.jpg` paths to the same `read_file` call where the contact
   sheet shows a defect. **Never** batch every slide — that wastes rounds and tokens.
4. At most **two** render cycles total unless the deck is still broken.

### Round budget (typical deck: 12–20 tool calls, not 40+)

| Once | Avoid |
|------|--------|
| One `read_file` `path: ["/skills/pptx/SKILL.md", "/skills/pptx/references/creating.md"]` | Re-reading the same guides |
| One `search_templates.py` query (best keywords) | Second search + `ls`/`grep` templates |
| One `web_search` for facts | Extra research passes for subtopics |
| One `web_search` for images + `curl -L -o` if photos needed | Third overlapping search |
| `cp` template → `edit_file` content → `node` → inspect → render | `write_file` 500+ line rewrite; `tail`/`wc` on templates |
| One `read_file` `path: ["/workspace/contact-sheet.jpg", …]` (+ up to 3 slide JPEGs) | Batching all `slide-*.jpg`; python loops dumping every slide's text |
| One targeted `edit_file` + re-render if QA fails | `sed -i` bulk edits on `.js`; 3+ full re-renders |

---

# PptxGenJS Reference

Use this when adapting a template or, if no template fits, building slides
directly. All coordinates are in inches.

## Setup & layout

```javascript
const pptxgen = require("pptxgenjs");

const pres = new pptxgen();
pres.layout = "LAYOUT_16x9";  // 10" x 5.625" (default). Also: LAYOUT_16x10, LAYOUT_4x3, LAYOUT_WIDE (13.3" x 7.5")
pres.author = "GemiX";
pres.title = "Presentation Title";

const slide = pres.addSlide();
slide.addText("Hello", { x: 0.5, y: 0.5, fontSize: 36, color: "363636" });

pres.writeFile({ fileName: "Presentation.pptx" });   // relative -> current dir
```

Each presentation needs a fresh `new pptxgen()` instance — don't reuse one.

## Text

```javascript
slide.addText("Title", {
  x: 1, y: 1, w: 8, h: 2, fontSize: 24, fontFace: "Arial",
  color: "363636", bold: true, align: "center", valign: "middle",
  margin: 0,  // set 0 when aligning text precisely with shapes/lines/icons
});

// Multi-line / rich text — each item needs breakLine: true (except the last)
slide.addText([
  { text: "Line 1", options: { breakLine: true } },
  { text: "Bold word ", options: { bold: true } },
  { text: "Line 2" },
], { x: 0.5, y: 0.5, w: 8, h: 2 });
```

## Lists & bullets

```javascript
// CORRECT — proper bullets
slide.addText([
  { text: "First", options: { bullet: true, breakLine: true } },
  { text: "Second", options: { bullet: true, breakLine: true } },
  { text: "Sub-item", options: { bullet: true, indentLevel: 1, breakLine: true } },
  { text: "Numbered", options: { bullet: { type: "number" } } },
], { x: 0.5, y: 0.5, w: 8, h: 3 });

// WRONG — never hardcode a unicode bullet; it creates double bullets
// slide.addText("• First item", { ... });
```

Avoid `lineSpacing` with bullets (excessive gaps) — use `paraSpaceAfter`.

## Shapes

```javascript
slide.addShape(pres.shapes.RECTANGLE, {
  x: 0.5, y: 0.8, w: 1.5, h: 3.0,
  fill: { color: "0088CC", transparency: 50 }, line: { color: "000000", width: 2 },
});
slide.addShape(pres.shapes.OVAL, { x: 4, y: 1, w: 2, h: 2, fill: { color: "0000FF" } });
slide.addShape(pres.shapes.LINE, { x: 1, y: 3, w: 5, h: 0, line: { color: "FF0000", width: 3 } });

// Rounded rectangle — rectRadius only works on ROUNDED_RECTANGLE
slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 1, y: 1, w: 3, h: 2, fill: { color: "FFFFFF" }, rectRadius: 0.1 });

// Shadow — use opacity for transparency, NEVER an 8-char hex color
slide.addShape(pres.shapes.RECTANGLE, {
  x: 1, y: 1, w: 3, h: 2, fill: { color: "FFFFFF" },
  shadow: { type: "outer", color: "000000", blur: 6, offset: 2, angle: 135, opacity: 0.15 },
});
```

Shadow `offset` must be non-negative (negatives corrupt the file). To cast a
shadow upward, use `angle: 270` with a positive offset. Gradient fills are not
supported — use a gradient background image instead.

## Images

```javascript
slide.addImage({ path: "chart.png", x: 1, y: 1, w: 5, h: 3 });        // file
slide.addImage({ data: "image/png;base64,iVBOR...", x: 1, y: 1, w: 5, h: 3 }); // base64

// Preserve aspect ratio: compute one dimension from the source's natural ratio
const origW = 1978, origH = 923, maxH = 3.0;
const calcW = maxH * (origW / origH);
slide.addImage({ path: "image.png", x: (10 - calcW) / 2, y: 1.2, w: calcW, h: maxH });

// Sizing modes
slide.addImage({ path: "img.png", x: 1, y: 1, sizing: { type: "cover", w: 4, h: 3 } });   // fill, may crop
slide.addImage({ path: "img.png", x: 1, y: 1, sizing: { type: "contain", w: 4, h: 3 } }); // fit inside
```

Supported: PNG, JPG, GIF, and SVG (modern PowerPoint). For an SVG you must
rasterize, convert with `cairosvg` to PNG first.

## Tables

```javascript
slide.addTable([
  [{ text: "Header 1", options: { bold: true, color: "FFFFFF", fill: { color: "6699CC" } } }, "Header 2"],
  ["Cell 1", "Cell 2"],
], { x: 1, y: 1, w: 8, colW: [4, 4], border: { pt: 1, color: "999999" } });
```

## Charts

```javascript
slide.addChart(pres.charts.BAR, [
  { name: "Sales", labels: ["Q1", "Q2", "Q3", "Q4"], values: [4500, 5500, 6200, 7100] },
], {
  x: 0.5, y: 1, w: 9, h: 4, barDir: "col",
  chartColors: ["0D9488", "14B8A6", "5EEAD4"],     // match your palette
  showValue: true, dataLabelPosition: "outEnd", dataLabelColor: "1E293B",
  catGridLine: { style: "none" }, valGridLine: { color: "E2E8F0", size: 0.5 },
  showLegend: false,
});
```

Chart types: BAR, LINE, PIE, DOUGHNUT, SCATTER, BUBBLE, RADAR. Default styling
looks dated — set `chartColors`, hide unneeded gridlines/legends, and use muted
axis label colors for a modern look.

## Backgrounds

```javascript
slide.background = { color: "F1F1F1" };  // required on EVERY slide for themed decks
slide.background = { path: "bg.jpg" };                       // image file
slide.background = { data: "image/png;base64,iVBOR..." };    // base64
```

Templates set this inside `addChrome()` — if you remove or skip `addChrome` on a
slide, PowerPoint defaults to **white** while your palette may still use light
text colors (`E8F4FF`, `9AAAB8`) → unreadable output. Run `inspect_pptx.py`
before delivering.

## Common pitfalls (cause corruption or visual bugs)

1. **Never prefix hex colors with `#`** — `"FF0000"` ✅, `"#FF0000"` ✗ (corrupts the file).
2. **Never encode opacity in an 8-char hex** — use the `opacity` property.
3. **Use `bullet: true`**, never a literal "•".
4. **Use `breakLine: true`** between text runs/array items.
5. **Don't reuse an options object across calls** — pptxgenjs mutates it in place
   (e.g. converting shadow values to EMU), corrupting the second shape. Build a
   fresh object each call (e.g. a `makeShadow()` factory).
6. **Don't pair `ROUNDED_RECTANGLE` with rectangular accent overlays** — the bar
   won't cover the rounded corners; use `RECTANGLE`.

## Design principles (only when building slides directly, NOT when using a template)

When using a template, follow its existing style — do not override its layouts,
fonts, or colors. These guidelines are for hand-built slides only:

- **Every slide needs a visual element** — image, chart, icon, or shape. Avoid
  text-only slides.
- **Pick an interesting font pairing** (e.g. Georgia + Calibri, Cambria +
  Calibri, Trebuchet MS + Calibri) — don't default to Arial.
- **Size contrast**: titles 36–44pt bold, section headers 20–24pt bold, body
  14–16pt, captions 10–12pt muted.
- **Spacing**: ≥ 0.5" margins, 0.3–0.5" between blocks (consistent), leave
  breathing room.
- **Left-align** paragraphs and lists; center only titles.
- **Vary layouts** across slides (two-column, icon rows, grids, stat callouts) —
  don't repeat one layout.
- Don't default to blue; pick colors that fit the topic.
- **Never put accent lines directly under titles** — a hallmark of AI-looking
  slides; use whitespace or a background color block instead.
