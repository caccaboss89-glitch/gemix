---
name: pptx
description: Presentations (.pptx). Create, edit, extract content, convert (pptx→pdf/images/markdown). Triggers for "deck", "slides", "presentation". NOT for Word/PDF/HTML.
---

# Presentation Skill Guide

> [!IMPORTANT]
> **MANDATORY RULE**: Use ONLY the CLI flags explicitly documented for each script in this guide. **DO NOT invent flags**. If a flag is not listed here, it is NOT supported.

**Presentations are NOT auto-parsed by the system** (unlike PDFs). To "see" the contents of an existing `.pptx`, you MUST run `pptx_inspect.py` first — `read_file` on a binary `.pptx` will return garbage.

The sandbox has **no Node.js / no `pptxgenjs` / no `markitdown`**. All creation, editing, and extraction goes through `python-pptx` and the helper scripts in this skill.

> **Goal**: produce editorial-grade decks (hero with brand mark, team grids with avatar circles, progress lists with bars + status pills, KPI tiles, table+chart side-by-side, banner callouts) **in a single round** — write the JSON spec + run `pptx_build.py` + `pptx_qa.py` in the same Phase. Iterate only if QA flags real issues.

---

## Script Reference

| Script | Purpose | Use when |
| :--- | :--- | :--- |
| `pptx_inspect.py` | Structured inspection (slides, titles, shapes, text, tables, images, notes) | ✅ **Always run first** on existing files |
| `pptx_build.py` | JSON-driven deck creation (themes, blocks, layouts, charts) | ✅ **Default for creating** new decks |
| `pptx_qa.py` | Static QA: overlaps, off-slide shapes, leftover placeholders, tiny/low-contrast text | ✅ **MANDATORY** after writing/editing slides, before render |
| `pptx_render.py` | Slides → PNG/JPG via LibreOffice + Poppler (visual QA loop) | After `pptx_qa.py`, when a visual check is required |
| `pptx_manipulate.py` | Merge / extract / split / info | Combining or breaking decks apart |
| `pptx_convert.py` | `pptx2pdf` (LibreOffice), `pptx2text` (markdown extract) | Final delivery as PDF or text dump |

### Execution Strategy

- **Reading existing file**: `pptx_inspect.py` in `execution_phase: "before_all"` so the JSON sample lands before any subsequent edit logic. Then write your edits in Phase 3.
- **Creating new file**: `write_file` the JSON spec in Phase 2 + `pptx_build.py` + `pptx_qa.py` in Phase 3 (same round, in this order — `pptx_qa.py` after `pptx_build.py`).
- **Editing existing file**: Inspect (Phase 1) → edit script via `code_execution` (Phase 3) → `pptx_qa.py` (Phase 3, after the edit).
- **Visual verification**: `pptx_render.py` in Phase 3, then `read_file` the generated PNGs in the **next** round. Only when a visual check is genuinely needed (photographic content, intricate layout). Block-driven specs almost never need this.
- **Conversion only**: Single `bash` call, no QA needed unless the deck was just modified.

**PPTX-Specific Rules**:
- **Binary format**: NEVER `read_file` a `.pptx`. Use `pptx_inspect.py` for structure or `pptx_convert.py pptx2text` for a markdown dump.
- **Absolute paths**: Strict enforcement of `/workspace/` or `/readonly/` prefixes. Final deck goes in `/workspace/output/`, JSON specs / inspections / extracted images / rendered PNGs in `/workspace/temp/`.
- **No `cat << EOF`**: Never build the JSON spec via bash heredoc; always `write_file`.
- **NO code_execution on spec.json**: NEVER use `code_execution` to modify `spec.json`. Always rewrite the entire JSON using `write_file`. If you need to edit the spec, read it, modify in memory, then write the complete updated JSON with `write_file`.
- **Color format**: ALWAYS use 6-character hex colors (RRGGBB) like "FFFFFF" or "000000", or theme token names like "accent", "surface", "title_color". NEVER use color names like "white", "black", "red" — these will cause build errors.
- **Consistent output filename**: When building a presentation, use a single consistent output filename (e.g., `/workspace/output/deck.pptx`). If you need to rebuild after QA, overwrite the same file — do NOT create new filenames. Only one `.pptx` should be delivered to the user.
- **Read temp JSON via bash if needed**: If `read_file` cannot read a newly-created `/workspace/temp/*.json`, do NOT loop. Use a standalone `bash` call: `cat /workspace/temp/file.json`.
- **Scripts vs Tools**: All utilities are SCRIPTS, called via `bash`. DO NOT try to use them as tool names.
- **No Concatenation**: NEVER combine multiple pptx scripts in a single `bash` command using `&&`/`;`/`|`. Emit them as separate tool calls in the same round.
- **Readonly writes**: NEVER write back to `/readonly/...`. To edit a user-provided deck, first `cp /readonly/history/<file>.pptx /workspace/temp/<file>.pptx` in a standalone `bash call, then operate on the writable copy.
- **Auto-delivery**: The final `.pptx` (or its `.pdf` export) MUST end up in `/workspace/output/`. Anything in `/workspace/temp/` will NOT be auto-delivered to the user.
- **Pre-existing templates**: When EDITING a user-provided deck, study its style with `pptx_inspect.py` and EXACTLY match existing fonts, colors, slide size, and layout names. Existing template conventions ALWAYS override the defaults in this guide.
- **Slide indices are 1-based** in every script.
- **Image Search**: Include relevant images from internet when appropriate to enhance visual appeal and clarity. Use `image_search` with `save_to_disk=true` to make them available under `/readonly/searched_images/`. Use the EXACT path returned by the tool.

---

## Output Quality Requirements

Every deck delivered to the user MUST satisfy:

- **Editorial layout, not "two elements on a blank canvas"**: every slide that has structure (team, projects, results) MUST use the relevant block (`card_grid`, `progress_list`, `kpi_grid`, `chart`, `banner`) — NOT a bare bullet list. Bullet-only slides are reserved for the closing/agenda.
- **Consistent visual identity across slides**: same theme, same brand chip in the `header_bar`, same `footer_bar` on every content slide, same accent color on stripes/badges/charts.
- **No leftover placeholder text**: zero matches for `lorem`, `ipsum`, `xxxx`, `tbd`, `todo`, `placeholder`, "click to add". Verified by `pptx_qa.py`.
- **No off-slide shapes**: every shape's bounding box stays inside the slide canvas (≥ 0.05" margin on all sides).
- **No major overlaps**: text boxes do not stack on top of other text/images. `pptx_qa.py` flags overlapping pairs. (Cards inside a `card_grid` overlap by design with their child shapes; this is expected — see Troubleshooting.)
- **Readable font sizes**: body text ≥ 12pt, titles ≥ 24pt. The QA script flags anything below 10pt by default.
- **Sufficient contrast**: text luma must differ from the slide background by at least 0.25 (out of 1).
- **Aspect ratios preserved**: when adding images, compute the missing dimension from the source's natural aspect ratio. NEVER pass both `w` and `h` arbitrarily.

---

## Theme Tokens

`pptx_build.py` ships with five themes, each exposing a full set of **semantic color tokens** that any block can reference by NAME (not hex) — e.g. `"fill": "accent"`, `"color": "muted"`. Use the token name to keep style consistent without hard-coding hex values.

| Theme | Background | Surface / Surface alt | Title / Body / Muted | Accent / Accent dark | Success / Warning / Danger |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `minimal` | white | `F8FAFC` / `EEF2F6` | `111827` / `374151` / `6B7280` | `2563EB` / `1E40AF` | `10B981` / `F59E0B` / `DC2626` |
| `corporate` (default) | `F8FAFC` | white / `E2E8F0` | `0F172A` / `1F2937` / `64748B` | `0EA5E9` / `0369A1` | same |
| `executive` (dark editorial) | `0B1220` | `0F1A2D` / `1B2A44` | white / `D1D5DB` / `9CA3AF` | `14B8A6` / `0F766E` | same |
| `dark` | `0F172A` | `1E293B` / `334155` | `F8FAFC` / `CBD5E1` / `94A3B8` | `38BDF8` / `0EA5E9` | same |
| `mono` | white | `F5F5F5` / `E5E5E5` | black / `1F2937` / `6B7280` | `525252` / `1F2937` | same |

Every block accepts colors as either:
- a **token name** like `"accent"`, `"surface_alt"`, `"title_color"`, `"body_color"`, `"muted"`, `"success"`, `"on_accent"`, `"background"`, …
- a **6-char hex** like `"0EA5E9"` (no `#` prefix required, but allowed)

To override a token globally, set `defaults.<token>` in the spec; to change just one slide's background use `slide.background`.

**Default to `executive` for CEO/board decks**, `corporate` for client-facing, `minimal` for internal docs.

---

## Block Catalog (recommended for any structured slide)

A slide is built from a list of `blocks`. Each block has `type`, geometric coords (`x`, `y`, `w`, `h` in inches), and block-specific fields. Blocks render **in order**, so place backgrounds first and text/cards on top.

| Block | Purpose | Required fields | Notable options |
| :--- | :--- | :--- | :--- |
| `header_bar` | Slide-top dark bar with title + brand chip | `x,y,w,h`, `title` | `brand`, `brand_fill`, `brand_fg`, `fill`, `fg`, `size` |
| `accent_bar` | Solid colored stripe (vert/horiz) | `x,y,w,h` | `color` |
| `title` | Standalone large heading | `text` | `x,y,w,h`, `size`, `bold`, `color`, `align` |
| `text` | Paragraph(s) | `x,y,w,h`, `text` OR `lines` | `lines:[{text,size,bold,italic,color,align}]`, `align`, `anchor` |
| `pills` | Row of small rounded badges | `x,y,w,h`, `items[]` | `items:[str|{text,fill,fg}]`, `gap`, `padding`, `size`, `fill`, `fg` |
| `bullets` | Bullet list | `x,y,w,h`, `items[]` | `items:[str|{text,level,bold,color,size}]` |
| `card_grid` | NxM cards (team, features, members) | `x,y,w,h`, `cards[]` | `columns`, `gap`, `accent_stripe`, `cards:[{avatar:{initials,color,size},title,subtitle,badge:{text,fill,fg},accent}]` |
| `progress_list` | Vertical project list with bars | `x,y,w,h`, `items[]` | `items:[{title,description,percent,status:{text,fill,fg},accent,bar_color}]`, `text_ratio`, `bar_height` |
| `kpi_grid` | Metric tiles | `x,y,w,h`, `items[]` | `columns`, `items:[{label,value,delta,delta_color,value_color,value_size}]` |
| `table` | Styled table with header fill, zebra | `x,y,w,h`, `headers`, `rows` | `column_widths`, `zebra`, `header_fill`, `header_fg`, `body_size`, `align`, `header_align` |
| `chart` | Native chart (bar/column/line/pie/doughnut) | `x,y,w,h`, `kind`, `categories`, `series` | `series:[{name,values}]`, `colors[]`, `title`, `show_legend`, `show_values` |
| `banner` | Full-width callout with optional icon circle | `x,y,w,h`, `text` | `icon`, `icon_color`, `fill`, `fg`, `text:str|[{text,size,bold,color}]` |
| `footer_bar` | Thin bottom bar with left/right text | `x,y,w,h` | `left`, `right`, `fill`, `fg`, `size` |
| `image` | Picture (with optional caption) | `x,y,w,h`, `path` | `caption`, `caption_align`, `circle_mask`, `rotation`, `shadow`, `glow`, `hyperlink` |
| `shape` | Generic rect / rounded / oval (escape hatch) | `x,y,w,h` | `kind`, `fill`, `line`, `line_width`, `text`, `fg`, `font_size`, `bold`, `align`, `anchor`, `padding`, `gradient`, `shadow`, `glow`, `reflection`, `rotation`, `hyperlink` |
| `divider` | Thin horizontal line | `x,y,w` | `color`, `thickness` |
| `gradient_shape` | Shape with linear gradient fill | `x,y,w,h` | `kind` (rect/rounded/oval/circle), `stops:[{color,pos}]`, `angle`, `shadow`, `glow`, `reflection`, `rotation`, `text`, `hyperlink` |
| `background_image` | Full-slide image with optional overlay | `path` | `overlay_opacity` (0-1), `overlay_color` |
| `text_columns` | Multi-column text layout (2-4 columns) | `x,y,w,h`, `columns`, `content[]` | `gap`, `size` |
| `arrow_line` | Straight connector with arrow | `x1,y1,x2,y2` OR `x,y,w,h` | `color`, `width`, `arrow_end` |
| `curved_line` | Curved connector | `x1,y1,x2,y2` OR `x,y,w,h` | `color`, `width`, `arrow_end` |
| `watermark` | Overlay text/image (semi-transparent) | `x,y,w,h` | `text` OR `image`, `opacity` (0-1), `size` |
| `diagram` | Simple flowchart nodes with auto-layout | `x,y,w,h`, `nodes[]`, `edges[]` | `nodes:[{x,y,w,h,kind,fill,gradient,shadow,label,hyperlink}]`, `edges:[{from,to,curved,arrow_end,color,width}]` |

> **Coordinates are in inches.** Slide canvas: 16:9 = `13.333 × 7.5`, 4:3 = `10.0 × 7.5`, A4 = `11.69 × 8.27`.

---

## Advanced Effects

The following effects can be applied to most blocks (shape, gradient_shape, image, pills, cards, etc.):

### Gradient Fill

Apply linear gradient to shapes:

```json
{
  "type": "gradient_shape",
  "x": 0.5, "y": 1.5, "w": 5.0, "h": 3.0,
  "kind": "rounded",
  "stops": [
    {"color": "accent", "pos": 0.0},
    {"color": "accent_dark", "pos": 1.0}
  ],
  "angle": 135,
  "text": "Gradient Text"
}
```

- `stops`: Array of `{color, pos}` where `pos` is 0-1
- `angle`: Gradient direction in degrees (0-360)

### Shadow Effect

Add drop shadow to shapes/images:

```json
{
  "type": "shape",
  "x": 0.5, "y": 1.5, "w": 5.0, "h": 3.0,
  "fill": "accent",
  "shadow": {
    "blur": 12,
    "distance": 6,
    "angle": 270,
    "color": "000000",
    "transparency": 0.4
  }
}
```

- `blur`: Blur radius in points
- `distance`: Offset distance in points
- `angle`: Shadow angle in degrees
- `color`: Shadow color (hex or token)
- `transparency`: 0-1 opacity

### Glow Effect

Add outer glow to shapes/images:

```json
{
  "type": "shape",
  "x": 0.5, "y": 1.5, "w": 5.0, "h": 3.0,
  "fill": "accent",
  "glow": {
    "color": "accent",
    "radius": 18
  }
}
```

- `color`: Glow color (hex or token)
- `radius`: Glow radius in points

### Reflection Effect

Add reflection below shapes:

```json
{
  "type": "shape",
  "x": 0.5, "y": 1.5, "w": 5.0, "h": 3.0,
  "fill": "accent",
  "reflection": {
    "blur": 4,
    "size": 0.5,
    "direction": 90,
    "transparency": 0.35,
    "distance": 3
  }
}
```

### Rotation

Rotate shapes/images:

```json
{
  "type": "shape",
  "x": 0.5, "y": 1.5, "w": 5.0, "h": 3.0,
  "fill": "accent",
  "rotation": 45
}
```

- `rotation`: Degrees (0-360)

### Hyperlink

Add clickable link to shapes:

```json
{
  "type": "shape",
  "x": 0.5, "y": 1.5, "w": 5.0, "h": 3.0,
  "fill": "accent",
  "text": "Click Me",
  "hyperlink": "https://example.com"
}
```

### Image Circle Mask

Crop image to circle:

```json
{
  "type": "image",
  "x": 0.5, "y": 1.5, "w": 3.0, "h": 3.0,
  "path": "/readonly/searched_images/avatar.jpg",
  "circle_mask": true
}
```

---

## Quality Recipes (copy these patterns)

Each recipe below is the **minimum spec** to produce one editorial-grade slide. Combine them inside `slides[]` in any order. Coordinates are tuned for the **16:9 canvas** (`13.333 × 7.5`).

### Recipe A — Hero / cover slide

Dark band on the left + brand card on the right + meta pills under the title.

```json
{
  "background": "background",
  "blocks": [
    {"type": "accent_bar",   "x": 0,    "y": 0,    "w": 0.25, "h": 7.5,  "color": "accent"},
    {"type": "title",        "x": 0.7,  "y": 1.6,  "w": 7.5,  "h": 1.4,  "text": "TEAM DI SVILUPPO", "size": 44, "color": "title_color"},
    {"type": "title",        "x": 0.7,  "y": 2.55, "w": 7.5,  "h": 0.9,  "text": "NEXLIFY TECH",     "size": 28, "color": "accent"},
    {"type": "text",         "x": 0.7,  "y": 3.5,  "w": 7.5,  "h": 0.5,  "text": "Presentazione al CEO", "size": 18, "bold": true, "color": "title_color"},
    {"type": "text",         "x": 0.7,  "y": 4.0,  "w": 7.5,  "h": 0.4,  "text": "Risultati Q4 2025 & Prospettive 2026", "size": 14, "color": "muted"},
    {"type": "divider",      "x": 0.7,  "y": 4.6,  "w": 4.0,  "color": "accent", "thickness": 0.04},
    {"type": "pills",        "x": 0.7,  "y": 5.0,  "h": 0.42, "size": 12,
        "items": ["5 Professionisti", "44+ Anni Esperienza Combinata", "12 Progetti Attivi"]},
    {"type": "shape",        "x": 9.2,  "y": 1.6,  "w": 3.5,  "h": 3.5, "kind": "rounded", "fill": "accent", "line": "none",
        "text": [
          {"text": "NEX",   "size": 56, "bold": true, "color": "on_accent"},
          {"text": "LIFY",  "size": 28, "bold": true, "color": "on_accent"},
          {"text": "TECH ●","size": 12, "color": "on_accent"}
        ]},
    {"type": "footer_bar",   "x": 0.7,  "y": 6.85, "w": 11.9, "h": 0.4,
        "left": "Maggio 2026  |  Sede Milano", "right": "CONFIDENTIAL", "fill": "none", "size": 10}
  ]
}
```

### Recipe B — Team grid (5 members in one row)

`card_grid` auto-distributes the cards. 5 cards → `columns: 5`. Cell `h` MUST be ≥ 2.6" so avatar + title + subtitle + badge fit without overlap.

```json
{
  "blocks": [
    {"type": "header_bar", "x": 0, "y": 0, "w": 13.333, "h": 0.9,
        "title": "Il Team di Sviluppo — Competenze e Esperienza", "brand": "NEXLIFY"},
    {"type": "text", "x": 0.5, "y": 1.1, "w": 12.3, "h": 0.5,
        "text": "5 Professionisti con oltre 44 anni di esperienza combinata",
        "size": 14, "italic": true, "color": "muted"},
    {"type": "card_grid", "x": 0.5, "y": 1.8, "w": 12.3, "h": 4.4, "columns": 5, "gap": 0.2,
        "cards": [
          {"avatar": {"initials": "ER", "color": "accent"},      "title": "Elena Rossi",   "subtitle": "Tech Lead & Architect",     "badge": {"text": "14 anni", "fill": "accent_dark"}},
          {"avatar": {"initials": "MB", "color": "accent"},      "title": "Marco Bianchi", "subtitle": "Senior Backend Developer",  "badge": {"text": "10 anni", "fill": "accent"}},
          {"avatar": {"initials": "SC", "color": "success"},     "title": "Sofia Conti",   "subtitle": "Frontend & UX Specialist",  "badge": {"text": "6 anni",  "fill": "success"}},
          {"avatar": {"initials": "LM", "color": "accent_dark"}, "title": "Luca Moretti",  "subtitle": "DevOps & Cloud Engineer",    "badge": {"text": "8 anni",  "fill": "accent_dark"}},
          {"avatar": {"initials": "CF", "color": "muted"},       "title": "Chiara Ferrari","subtitle": "QA & Test Automation",      "badge": {"text": "7 anni",  "fill": "accent_dark"}}
        ]},
    {"type": "banner", "x": 0.5, "y": 6.4, "w": 12.3, "h": 0.7, "fill": "title_color", "fg": "on_accent",
        "text": [{"text": "Competenze Chiave:  Java • Python • React/Next.js • Kubernetes • AWS/Azure • CI/CD • AI/ML • Test Automation • Agile/Scrum", "size": 12, "bold": true, "color": "on_accent"}]}
  ]
}
```

### Recipe C — Project list with progress bars

```json
{
  "blocks": [
    {"type": "header_bar", "x": 0, "y": 0, "w": 13.333, "h": 0.9,
        "title": "Progetti Principali in Corso — Stato Avanzamento Q4 2025", "brand": "NEXLIFY"},
    {"type": "progress_list", "x": 0.5, "y": 1.2, "w": 12.3, "h": 5.4, "gap": 0.18,
        "items": [
          {"title": "Piattaforma AI Predittiva Enterprise",  "description": "Sviluppo motore di raccomandazione e forecasting per 12 clienti enterprise",
              "percent": 82, "status": {"text": "In fase finale",   "fill": "accent"}},
          {"title": "Migrazione Microservizi su Kubernetes", "description": "Refactoring 5 microservizi legacy → cloud-native (3/5 completati)",
              "percent": 65, "status": {"text": "In rollout",       "fill": "accent"}},
          {"title": "App Mobile Clienti Premium",            "description": "Sviluppo Flutter app con biometric auth e offline-first (beta chiusa)",
              "percent": 95, "status": {"text": "Lancio Imminente", "fill": "success"}},
          {"title": "Integrazione API Partner Strategici",   "description": "4 nuove API REST/GraphQL con 2 partner (2 live, 2 in sviluppo)",
              "percent": 70, "status": {"text": "In sviluppo",      "fill": "warning"}}
        ]},
    {"type": "footer_bar", "x": 0, "y": 7.0, "w": 13.333, "h": 0.5, "fill": "title_color",
        "left": "NEXLIFY TECH   |   Confidential", "right": "3 / 5", "fg": "on_accent", "size": 10}
  ]
}
```

### Recipe D — KPI table + chart side-by-side

The KPI table sits on the left half, a `chart` sits on the right half — both at the same `y` and equal `h`.

```json
{
  "blocks": [
    {"type": "header_bar", "x": 0, "y": 0, "w": 13.333, "h": 0.9,
        "title": "Risultati Q4 2025 — Performance Record", "brand": "NEXLIFY"},
    {"type": "banner", "x": 0.5, "y": 1.15, "w": 12.3, "h": 0.6, "fill": "surface", "icon": "✓", "icon_color": "success",
        "text": [{"text": "Q4 2025: Tutti i target superati — +18% produttività vs Q3", "size": 14, "bold": true, "color": "success"}]},
    {"type": "table", "x": 0.5, "y": 2.0, "w": 6.5, "h": 4.4,
        "headers": ["Metrica", "Q4 2025", "Target", "vs Target", "Status"],
        "rows": [
          ["Velocity (pts/sprint)", "52",   "45",  "+15.6%", "✓ Sopra"],
          ["Bug Resolution Rate",   "98.2%","95%", "+3.2pp", "✓ Sopra"],
          ["Feature Delivered",     "14",   "12",  "+16.7%", "✓ Sopra"],
          ["Code Coverage",         "91%",  "85%", "+6pp",   "✓ Sopra"],
          ["NPS Team Interno",      "81",   "72",  "+9",     "✓ Sopra"]
        ],
        "column_widths": [2.0, 1.1, 1.0, 1.2, 1.2],
        "header_fill": "title_color", "header_fg": "on_accent",
        "zebra": true, "body_size": 12, "align": "center", "header_align": "center"
    },
    {"type": "chart", "x": 7.3, "y": 2.0, "w": 5.5, "h": 4.4, "kind": "column",
        "title": "Performance Q4 vs Target (%)",
        "categories": ["Velocity", "Bug Fix", "Features", "Coverage", "NPS"],
        "series": [{"name": "% del target", "values": [116, 103, 117, 107, 113]}],
        "colors": ["accent"], "show_legend": false, "show_values": true},
    {"type": "banner", "x": 0.5, "y": 6.5, "w": 12.3, "h": 0.6, "fill": "title_color", "fg": "on_accent",
        "icon": "✓", "icon_color": "success",
        "text": [{"text": "Risultati Chiave: +22% velocità team • 0 incidenti critici in produzione • 100% sprint completati in tempo • 3 promozioni interne", "size": 12, "bold": true, "color": "on_accent"}]}
  ]
}
```

### Recipe E — Closing slide (next steps)

```json
{
  "blocks": [
    {"type": "header_bar", "x": 0, "y": 0, "w": 13.333, "h": 0.9, "title": "Conclusioni & Next Steps 2026", "brand": "NEXLIFY"},
    {"type": "kpi_grid", "x": 0.5, "y": 1.2, "w": 12.3, "h": 1.8, "columns": 3, "gap": 0.2,
        "items": [
          {"label": "TEAM SCALING",     "value": "+2",  "delta": "Nuovi Full-Stack Q1 2026",  "value_color": "accent"},
          {"label": "TARGET 2026",      "value": "+30%","delta": "Velocity vs 2025",          "value_color": "success"},
          {"label": "MIGRAZIONE CLOUD", "value": "100%","delta": "Serverless entro Q2",       "value_color": "accent_dark"}
        ]},
    {"type": "title", "x": 0.5, "y": 3.3, "w": 12.3, "h": 0.6, "text": "Roadmap H1 2026", "size": 22, "color": "title_color"},
    {"type": "bullets", "x": 0.5, "y": 4.0, "w": 12.3, "h": 2.6, "size": 16,
        "items": [
          {"text": "Q1 — Onboarding 2 senior full-stack & rilascio Piattaforma AI Predittiva v2", "bold": true},
          {"text": "Crescita capacity stimata: +25% pts/sprint", "level": 1},
          {"text": "Q2 — Completamento migrazione Serverless + GA App Mobile Premium",            "bold": true},
          {"text": "Riduzione costi infra attesa: −18% TCO",      "level": 1}
        ]},
    {"type": "footer_bar", "x": 0, "y": 7.0, "w": 13.333, "h": 0.5, "fill": "title_color",
        "left": "NEXLIFY TECH   |   Confidential", "right": "5 / 5", "fg": "on_accent", "size": 10}
  ]
}
```

### Recipe F — Background image with overlay (hero with photo)

```json
{
  "blocks": [
    {"type": "background_image", "path": "/readonly/searched_images/office.jpg",
        "overlay_opacity": 0.4, "overlay_color": "000000"},
    {"type": "watermark", "x": 0, "y": 0, "w": 13.333, "h": 7.5, "text": "NEXLIFY", "size": 96,
        "opacity": 0.08, "color": "accent"},
    {"type": "title", "x": 0.7, "y": 1.8, "w": 11.9, "h": 1.4, "text": "IL FUTURO È QUI",
        "size": 52, "color": "FFFFFF", "bold": true},
    {"type": "title", "x": 0.7, "y": 2.9, "w": 11.9, "h": 0.8, "text": "Innovazione continua per il successo",
        "size": 24, "color": "CBD5E1"},
    {"type": "gradient_shape", "x": 0.7, "y": 4.2, "w": 4.0, "h": 0.6, "kind": "rounded",
        "stops": [{"color": "accent", "pos": 0}, {"color": "accent_dark", "pos": 1}],
        "text": "SCOPRI DI PIÙ", "fg": "FFFFFF", "font_size": 16, "bold": true,
        "shadow": {"blur": 12, "distance": 6, "color": "000000", "transparency": 0.4},
        "hyperlink": "https://example.com"}
  ]
}
```

### Recipe G — Gradient shape with glow effect

```json
{
  "blocks": [
    {"type": "header_bar", "x": 0, "y": 0, "w": 13.333, "h": 0.9,
        "title": "Premium Features", "brand": "NEXLIFY"},
    {"type": "gradient_shape", "x": 0.5, "y": 1.5, "w": 5.5, "h": 4.0, "kind": "rounded",
        "stops": [{"color": "accent", "pos": 0}, {"color": "accent_dark", "pos": 1}],
        "angle": 135,
        "shadow": {"blur": 15, "distance": 8, "color": "000000", "transparency": 0.3},
        "glow": {"color": "accent", "radius": 18},
        "text": [
          {"text": "AI-Powered", "size": 36, "bold": true, "color": "FFFFFF"},
          {"text": "Analytics", "size": 36, "bold": true, "color": "FFFFFF"},
          {"text": "Machine learning algorithms for real-time insights", "size": 16, "color": "E2E8F0"}
        ]},
    {"type": "text_columns", "x": 6.5, "y": 1.5, "w": 6.3, "h": 4.0, "columns": 2, "gap": 0.4, "size": 14,
        "content": [
          [
            {"text": "Predictive Models", "bold": true, "color": "title_color"},
            "Advanced ML algorithms trained on your data",
            "Real-time forecasting with 95% accuracy",
            {"text": "Automated Insights", "bold": true, "color": "title_color"},
            "Natural language explanations",
            "Actionable recommendations"
          ],
          [
            {"text": "Custom Dashboards", "bold": true, "color": "title_color"},
            "Drag-and-drop builder",
            "50+ pre-built templates",
            {"text": "API Integration", "bold": true, "color": "title_color"},
            "REST & GraphQL endpoints",
            "Webhook notifications"
          ]
        ]}
  ]
}
```

### Recipe H — Simple flowchart diagram

```json
{
  "blocks": [
    {"type": "header_bar", "x": 0, "y": 0, "w": 13.333, "h": 0.9, "title": "Process Flow", "brand": "NEXLIFY"},
    {"type": "diagram", "x": 0.5, "y": 1.5, "w": 12.3, "h": 5.0,
        "nodes": [
          {"x": 0, "y": 0, "w": 2.0, "h": 1.0, "kind": "rounded", "fill": "accent",
           "label": "START", "size": 14, "fg": "on_accent", "bold": true},
          {"x": 3.5, "y": 0, "w": 2.0, "h": 1.0, "kind": "rounded", "fill": "surface",
           "label": "Process A", "size": 12},
          {"x": 7.0, "y": 0, "w": 2.0, "h": 1.0, "kind": "diamond", "fill": "warning",
           "label": "Decision?", "size": 12, "fg": "000000"},
          {"x": 3.5, "y": 2.0, "w": 2.0, "h": 1.0, "kind": "rounded", "fill": "success",
           "label": "Process B", "size": 12, "fg": "on_accent"},
          {"x": 7.0, "y": 2.0, "w": 2.0, "h": 1.0, "kind": "rounded", "fill": "danger",
           "label": "Process C", "size": 12, "fg": "on_accent"},
          {"x": 3.5, "y": 3.5, "w": 2.0, "h": 1.0, "kind": "rounded", "fill": "accent_dark",
           "label": "END", "size": 14, "fg": "on_accent", "bold": true}
        ],
        "edges": [
          {"from": 0, "to": 1, "curved": true, "arrow_end": true, "color": "muted"},
          {"from": 1, "to": 2, "curved": true, "arrow_end": true, "color": "muted"},
          {"from": 2, "to": 3, "curved": true, "arrow_end": true, "color": "success"},
          {"from": 2, "to": 4, "curved": true, "arrow_end": true, "color": "danger"},
          {"from": 3, "to": 5, "curved": true, "arrow_end": true, "color": "muted"},
          {"from": 4, "to": 5, "curved": true, "arrow_end": true, "color": "muted"}
        ]}
  ]
}
```

---

## Full Example — Single-round CEO Deck

The eight recipes above (A-H) can be stitched into one spec to produce a deck of Grok-grade quality in **one tool round**. Pattern:

```
Phase 2 (write_file)        →  /workspace/temp/spec.json   (full spec, 8 slides)
Phase 3 (bash, in order)    →  pptx_build.py + pptx_qa.py
```

**`spec.json` skeleton:**
```json
{
  "theme": "executive",
  "slide_size": "16:9",
  "properties": {"title": "Team Sviluppo Q4 2025", "author": "GemiX AI"},
  "defaults": {"font_name": "Calibri", "title_size": 32, "body_size": 16},
  "slides": [
    /* Recipe A (cover) */,
    /* Recipe B (team grid) */,
    /* Recipe C (projects) */,
    /* Recipe D (KPI + chart) */,
    /* Recipe E (closing) */,
    /* Recipe F (background image) */,
    /* Recipe G (gradient + glow) */,
    /* Recipe H (diagram) */
  ]
}
```

**Build + QA in the same Phase-3 round:**
```bash
python /readonly/skills/pptx/scripts/pptx_build.py \
  --spec /workspace/temp/spec.json \
  --output /workspace/output/deck.pptx
```
```bash
python /readonly/skills/pptx/scripts/pptx_qa.py \
  --input /workspace/output/deck.pptx \
  --output /workspace/temp/qa.json
```

Only escalate to `pptx_render.py` if QA flags a real issue you can't diagnose from the spec alone.

---

## `pptx_inspect.py` — Read an Existing Deck

> Run this BEFORE editing or analysing any pre-existing `.pptx`. Output is a single JSON document with slide inventory, layout names, titles, every shape's geometry/text, tables, image metadata, and speaker notes.

```bash
python /readonly/skills/pptx/scripts/pptx_inspect.py \
  --input /readonly/history/<file>.pptx \
  --output /workspace/temp/inspection.json
# Optional flags:
#   --extract-images /workspace/temp/extracted/   # save embedded images for re-use
#   --text-only                                   # skip pictures/tables/charts
```

`shape.kind` is one of `placeholder|text_box|picture|table|chart|group|auto_shape|line|media|freeform|unknown`. Use it to decide whether a shape needs text editing (`text_box`/`placeholder`) or asset replacement (`picture`/`table`).

---

## `pptx_build.py` — CLI

```bash
python /readonly/skills/pptx/scripts/pptx_build.py \
  --spec /workspace/temp/spec.json \
  --output /workspace/output/deck.pptx
```

Top-level spec keys:
- `theme` — one of `minimal|corporate|executive|dark|mono` (default `corporate`)
- `slide_size` — `16:9` (default), `widescreen`, `4:3`, `a4`
- `properties` — `{title, author, subject}` for the file metadata
- `defaults` — overrides for any theme token (`background`, `surface`, `surface_alt`, `title_color`, `body_color`, `muted`, `accent`, `accent_dark`, `success`, `warning`, `danger`, `on_accent`, `font_name`) plus `title_size`, `body_size`
- `slides[]` — array of slide specs

Each slide accepts:
- `background` — slide-level background color (token or hex)
- `blocks[]` — **recommended path**, the block catalog above
- `layout` + `title`/`subtitle`/`content`/`left`/`right`/`image`/`table` — legacy quick-shot for trivial slides (`title|title_content|two_content|section|picture|blank`)
- `footer` — short string drawn in the bottom margin (legacy)
- `page_number` — `true` to draw `i / N` in the bottom-right (legacy)
- `notes` — speaker notes string

> Rule of thumb: if the slide has structure (team, projects, KPIs, charts, callouts) use `blocks`. If it's a pure bullet recap or section divider, the legacy layout is fine.

---

## `pptx_qa.py` — MANDATORY After Building or Editing

Catches the most common visual bugs WITHOUT the cost of rendering. Run it in the same Phase 3 as `pptx_build.py` (or your edit script), emitted **after** the writer.

```bash
python /readonly/skills/pptx/scripts/pptx_qa.py \
  --input /workspace/output/deck.pptx \
  --output /workspace/temp/qa.json
# Optional flags:
#   --min-font-pt 10
#   --max-density 85
#   --contrast-threshold 0.25
```

If `status == "issues_found"`, **ONLY iterate if there are REAL issues**:
- **Off-slide shapes**: shapes with bounding boxes outside the slide canvas
- **Tiny fonts**: text below 10pt
- **Placeholder text**: matches for `lorem`, `ipsum`, `xxxx`, `tbd`, `todo`, `placeholder`, "click to add"
- **Low contrast**: text luma difference < 0.25 from background

**DO NOT iterate for expected overlaps**: `card_grid`, `progress_list`, `kpi_grid`, and `banner` blocks intentionally layer text on top of rounded-rect shapes. QA WILL report these as `overlaps` — this is by design and should be ignored. The pairs that matter are: text-vs-text on different parents, text-vs-image, or anything overflowing the slide canvas.

> **Single-round goal**: Build + QA in the same round. Deliver the presentation even if QA reports expected overlaps. Only iterate for real bugs.

---

## `pptx_render.py` — Visual QA (Slides → Images)

Use only when the user explicitly asked for a visual proof, or when QA flagged something you can't diagnose from the spec.

```bash
python /readonly/skills/pptx/scripts/pptx_render.py \
  --input /workspace/output/deck.pptx \
  --output-dir /workspace/temp/preview \
  --dpi 150 --format png
# Optional:
#   --pages "1-3"
#   --keep-pdf
#   --timeout 90
```

**Verification loop** (across 2 rounds, NOT in the same round):
1. Round N: `pptx_build.py` → `pptx_qa.py` → `pptx_render.py`.
2. Round N+1: `read_file` on `/workspace/temp/preview/deck-01.png`, `deck-02.png`, … and inspect.
3. If issues remain → patch the spec → re-run from step 1.

---

## `pptx_manipulate.py` — Merge / Extract / Split / Info

```bash
# Merge: concatenate slides from multiple decks (slide size inherited from input #1)
python /readonly/skills/pptx/scripts/pptx_manipulate.py merge \
  --inputs /workspace/temp/intro.pptx /workspace/temp/body.pptx /workspace/temp/closing.pptx \
  --output /workspace/output/full_deck.pptx
# Optional: --slide-size-from 2 (1-based index)

# Extract: pick specific slides by index range
python /readonly/skills/pptx/scripts/pptx_manipulate.py extract \
  --input /workspace/output/full_deck.pptx \
  --slides "1,3-5,8" \
  --output /workspace/output/selected.pptx

# Split: every slide becomes its own .pptx (zero-padded 3-digit suffix)
python /readonly/skills/pptx/scripts/pptx_manipulate.py split \
  --input /workspace/output/full_deck.pptx \
  --output-prefix /workspace/temp/part

# Info: metadata + slide inventory (lighter than pptx_inspect.py)
python /readonly/skills/pptx/scripts/pptx_manipulate.py info \
  --input /workspace/output/full_deck.pptx
```

> **Limitation**: slide copying uses XML deepcopy onto a blank layout. Explicit colors/fonts/Pt sizes are preserved, but theme-resolved colors and embedded charts/SmartArt may degrade. For 100% theme-faithful merges, convert each input to PDF with `pptx_convert.py pptx2pdf` and stitch them with `pdf_manipulate.py merge` (PDF skill) instead.

---

## `pptx_convert.py` — Format Conversion

```bash
# PPTX → PDF (LibreOffice headless)
python /readonly/skills/pptx/scripts/pptx_convert.py pptx2pdf \
  --input /workspace/output/deck.pptx \
  --output /workspace/output/deck.pdf
# Optional: --timeout 120

# PPTX → markdown text (titles, bullets, tables, notes — lossy, no images)
python /readonly/skills/pptx/scripts/pptx_convert.py pptx2text \
  --input /readonly/history/<file>.pptx \
  --output /workspace/temp/transcript.md
```

> When the user asks to "read the slides as text" or "summarise the deck", `pptx2text` is faster than `pptx_inspect.py`.

---

## Editing an Existing File (Common Pattern)

```bash
# Phase 1 — inspect (so the JSON lands in the same round)
python /readonly/skills/pptx/scripts/pptx_inspect.py \
  --input /readonly/history/template.pptx \
  --output /workspace/temp/inspection.json
```
```bash
# Phase 1 — copy the readonly source to a writable location (parallel with inspect)
cp /readonly/history/template.pptx /workspace/temp/working.pptx
```
```python
# Phase 3 — code_execution: open, edit, save into /workspace/output/
from pptx import Presentation
prs = Presentation("/workspace/temp/working.pptx")
for slide in prs.slides:
    for shape in slide.shapes:
        if shape.has_text_frame and "{{COMPANY}}" in shape.text_frame.text:
            for para in shape.text_frame.paragraphs:
                for run in para.runs:
                    run.text = run.text.replace("{{COMPANY}}", "Acme S.p.A.")
prs.save("/workspace/output/template_filled.pptx")
```
```bash
# Phase 3 — QA the edit (emitted after the code_execution above, same round)
python /readonly/skills/pptx/scripts/pptx_qa.py \
  --input /workspace/output/template_filled.pptx \
  --output /workspace/temp/qa.json
```

> **KEEP the original run object** when replacing text. Do NOT delete the run and re-add a new one — the new run loses the master's font/size/color settings.

---

## Image Handling Cheat Sheet

| Goal | ❌ WRONG | ✅ RIGHT |
| :--- | :--- | :--- |
| Web image in deck | `image_search ... save_to_disk=false` | `image_search ... save_to_disk=true` then path under `/readonly/searched_images/` |
| Resize while keeping ratio | `"w": 6, "h": 6` (random) | Compute missing dim from natural ratio (snippet below) |
| User-provided image | `read_file` then guess dimensions | `pptx_inspect.py --extract-images` if it came from a deck, or use the path directly |
| Background image | full-bleed `add_picture` covering text | Use `slide.background` color or place image BEHIND text via `_spTree` reorder |

**Aspect-ratio safe sizing inside a `code_execution` cell:**
```python
from PIL import Image
src = Image.open("/readonly/searched_images/photo.jpg")
nat_w, nat_h = src.size
target_h = 4.0  # inches
target_w = round(target_h * (nat_w / nat_h), 3)
# pass into spec.json image block: {"x": 1.0, "y": 1.5, "w": target_w, "h": target_h, "path": "..."}
```

---

## Troubleshooting & Common Fails

### 1. `pptx_qa.py` reports many `overlaps` inside `card_grid` / `progress_list` / `banner`
Expected. These blocks layer text-frames on top of background shapes by design. Look only at:
- overlaps between **distinct** content groups (e.g. two cards' text frames, or text-vs-image)
- shapes flagged in `off_slide` — those ARE real bugs

### 2. Card content overflows the card box
You sized the `card_grid.h` too small. With an avatar (≈1.0"), title, subtitle, and bottom badge, allow `h ≥ 2.6"` per row. Reduce `avatar.size` to gain headroom.

### 3. `Unknown block type 'X'`
The block catalog is closed — there is no auto-discovery. Use one of: `title|text|header_bar|accent_bar|shape|pills|bullets|card_grid|progress_list|kpi_grid|table|chart|banner|footer_bar|image|divider`.

### 4. "Invalid color" / "Unsupported layout"
Colors must be either a theme token (`accent`, `surface`, …) or a 6-char hex (`RRGGBB`). Layouts (legacy mode only) must be one of `title|title_content|two_content|section|picture|blank`. Themes must be one of `minimal|corporate|executive|dark|mono`.

### 5. `image not found` from `pptx_build.py`
The image path in `spec.json` did not exist when the script ran. Causes:
- `image_search` was called with `save_to_disk=false`.
- Image was generated AFTER `pptx_build.py` in the same Phase-3 batch — emit the generator BEFORE the build call.
- Verify with `ls /readonly/searched_images/` or `ls /workspace/temp/` in the previous round.

### 6. Edited deck looks unstyled
You loaded a templated `.pptx`, replaced the text, but the new run inherited a default font.
- KEEP the original `run` object and only change `run.text`. Do NOT delete + re-add.

### 7. `pptx_manipulate.py merge` lost the source theme
Expected — see the limitation in that section. Use the `pdf_manipulate.py` route via `pptx_convert.py pptx2pdf` for theme-faithful merges.

### 8. `File not found` after `pptx_manipulate.py split`
Output filenames are zero-padded to 3 digits (`part_001.pptx`). Always parse the script's stdout (a JSON `outputs` list).

### 9. `low_contrast` flagged on the `executive` / `dark` theme
The `executive` theme uses `body_color: D1D5DB` on `background: 0B1220` — the luma delta is around 0.7, well above threshold. If QA flags it, you probably overrode `defaults.body_color` to something close to the background. Revert or pick a body color whose luma differs from the background by ≥ 0.25.

### 10. `chart` renders without value labels / wrong colors
- Set `"show_values": true` to get data labels.
- Pass `"colors": ["accent", "accent_dark", ...]` to override the default palette. Tokens are auto-resolved.
- Pie/doughnut charts only honor the first series; multiple series are ignored by python-pptx.

---

## Library Selection Quick Reference

- **`pptx_build.py`** with **blocks**: Default for any structured deck (team, project, KPI, chart, callout).
- **`pptx_build.py`** with **layout-only fields**: Trivial recap/agenda slides only.
- **`python-pptx`** (via `code_execution`): Editing existing files cell-by-cell, preserving master/theme, custom shapes (`MSO_SHAPE`), connectors, animations metadata.
- **`pptx_qa.py`**: ALWAYS after any deck write. Cheaper than rendering.
- **`pptx_render.py`**: Visual QA only — sparingly, because LibreOffice cold-start is slow.
- **`pptx_inspect.py`**: ALWAYS before any read of an existing `.pptx`.
- **`pptx_convert.py pptx2pdf`**: Final delivery when the user asked for a PDF, or as a stepping stone for PDF-skill operations.
- **`pptx_convert.py pptx2text`**: When the user asked to summarise or quote a deck.

> **DO NOT** mix tools in one cell: e.g. don't open the same `.pptx` with `python-pptx` while `pptx_qa.py` is running on it.
