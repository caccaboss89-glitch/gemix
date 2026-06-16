---
name: pptx
description: Create or edit .pptx presentations in /workspace/. Not for Word, PDF, spreadsheets, or static images.
---

# PowerPoint Processing Guide

A guide for creating, editing, and reading presentations inside the build
sandbox. Files live in `/workspace/` (read-write); this skill's files are
read-only under `/skills/pptx/`.

## Workflow selection

| Situation | Workflow |
|-----------|----------|
| No `.pptx` given — build a deck from scratch | Creating — read [references/creating.md](references/creating.md) |
| The user attached/referenced a `.pptx` to change | Editing — read [references/editing.md](references/editing.md) |
| Just need to read/extract text from a `.pptx` | See "Reading a presentation" below |

Read the relevant companion file with one `read_file` call (e.g.
`path: ["/skills/pptx/references/creating.md"]`) when the task calls for it.

## Companion files

- `references/creating.md` — build a new deck from a pre-built `pptxgenjs` template (Node).
  20 professional templates ship in `/skills/pptx/templates/`, indexed by
  `/skills/pptx/templates/template_taxonomy.json` and searchable with
  `scripts/search_templates.py`.
- `references/editing.md` — modify an existing `.pptx` in place with `python-pptx`,
  preserving its layout, fonts, colors, and media.
- `scripts/search_templates.py` — rank templates by visual attributes (color,
  mood, typography, density). Use it instead of reading the taxonomy by hand.
- `scripts/render_slides.py` — render a `.pptx` to per-slide JPEGs plus a
  contact sheet, for visual QA.
- `scripts/inspect_pptx.py` — verify each slide has a solid background (catches
  white slides with light text before delivery).
- `scripts/soffice.py` — internal helper imported by `render_slides.py` to
  launch headless LibreOffice; you never run it directly.

## read_file vs. extract (CRITICAL)

`read_file` parses `.pptx` natively for **understanding**. For **exact** text/data
or programmatic edits, use `python-pptx` and print what you need. To QA the visual
result, render to images first (see below) and `read_file` with `path: ["/workspace/contact-sheet.jpg", …]`.

When you need a deck's exact text/data (to transform, copy, or summarize it),
extract it with `python-pptx`; do not retype what you think it says.

## Reading a presentation

```python
from pptx import Presentation

prs = Presentation("/workspace/deck.pptx")
print(f"{len(prs.slides)} slides, size {prs.slide_width} x {prs.slide_height} EMU")

for i, slide in enumerate(prs.slides, 1):
    print(f"\n--- Slide {i} ---")
    for shape in slide.shapes:
        if shape.has_text_frame:
            text = "\n".join(p.text for p in shape.text_frame.paragraphs)
            if text.strip():
                print(f"[{shape.shape_type}] {shape.name}: {text}")
        if shape.has_table:
            for row in shape.table.rows:
                print(" | ".join(c.text for c in row.cells))
```

Speaker notes:
```python
if slide.has_notes_slide:
    print(slide.notes_slide.notes_text_frame.text)
```

## Available tools

- Node.js + `pptxgenjs` (global) — the engine for **creating** decks from the
  `.js` templates. See `references/creating.md`.
- Python `python-pptx` (pre-installed) — for **reading and editing** existing
  `.pptx` files. See `references/editing.md`.
- Python `Pillow`, `matplotlib` — render charts/figures to PNG to embed.
- `web_search` — fetch image URLs; download with `curl -L -o /workspace/... URL` via bash.
- LibreOffice (headless) + `pdftoppm` (poppler) — drive `render_slides.py` for
  visual QA.

Not available: `python-pptx` cannot create the polished, template-grade visuals
that `pptxgenjs` templates do — use templates for creation. There is no
`markitdown` and no OOXML XSD-validation suite; you do not need them.

## Output requirements

- Put all text in the **user's language**.
- **No emojis** unless the user explicitly asks — Office/LibreOffice fonts
  render them as black boxes.
- When **editing** an existing deck, match its layout, fonts, colors, and
  conventions; do not impose a new style unless asked.
- Default slide size is 16:9 (`LAYOUT_16x9`) unless the task or template says
  otherwise. (Slides are screen media, so A4 does not apply here.)

## Images

Images you place can come from: files GemiX staged in `/workspace/` (uploads,
generated images, charts passed as attachments), PNGs you render yourself with
matplotlib, or images from `web_search` saved via `curl -L -o` — those land
in `/workspace/`. `generate_image`/`generate_video` do NOT exist inside the build
sandbox.

**Use images proactively** when they improve the result: a diagram, a photo, a
chart, a logo, a map. If the task doesn't supply one but a relevant image would
make a slide clearer or more professional, fetch it or render it.

**Always preserve the original aspect ratio.** Compute the missing dimension
from the source image's natural ratio instead of setting width and height
independently (which stretches the image).

## Visual QA (required, bounded)

After creating or editing a deck:

```bash
python /skills/pptx/scripts/inspect_pptx.py /workspace/output.pptx
python /skills/pptx/scripts/render_slides.py /workspace/output.pptx
```

`inspect_pptx.py` must exit 0 (every slide needs `slide.background` for dark
themes — otherwise PowerPoint shows white with pale text). Then one `read_file`
with `path: ["/workspace/contact-sheet.jpg"]` to scan the deck. Add individual
`slide-NN.jpg` paths to the same call only where the contact sheet shows a defect
(max 1–3 slides). Do **not** batch every slide — that burns rounds without improving quality.

Look for: **low contrast** (light text on white — fix backgrounds/palette);
text overflow; overlaps; bad margins; placeholder text; inconsistent styling.

At most **two** render passes. Prefer `edit_file` on the template `.js` over
rewriting the whole deck or `sed` bulk edits.

## Round discipline (all Office-style deliverables)

Typical deck: **12–22** tool calls, not 40+. Creating from a template: **one**
template search, **one** `web_search` for facts, optional **one** `web_search`
for images (`curl -L -o` the URLs), then build → inspect → render → deliver.
Do not re-read templates, list directories, or dump slide text in Python loops.
**Never** rewrite 500+ lines from scratch — `cp` a `/skills/pptx/templates/*.js`
and edit surgically. See `references/creating.md` for the full PPTX checklist.
