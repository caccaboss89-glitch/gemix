---
name: docx
description: Word documents (.docx, .dotx). Create, edit, inspect, convert. Triggers for "Word doc", ".docx", ".dotx", "Word template". NOT for spreadsheets/presentations/PDFs.
---

# Word Document Skill Guide

> [!IMPORTANT]
> **MANDATORY RULE**: Use ONLY the CLI flags explicitly documented for each script in this guide. **DO NOT invent flags**. If a flag is not listed here, it is NOT supported.

**Word documents are NOT auto-parsed by the system** (unlike PDFs). To "see" the contents of an existing `.docx`, you MUST run `docx_inspect.py` first — `read_file` on a binary `.docx`/`.dotx` will return garbage.

The sandbox has **no Node.js / no `docx-js` / no `pandoc`**. All creation, editing, and extraction goes through **`python-docx`** + the helper scripts in this skill. LibreOffice headless handles `.doc → .docx`, `.docx → .pdf`, and `.docx → .html` conversions.

> **Goal**: produce editorial-grade Word docs (cover with letterhead, headings with consistent style, tables with zebra rows + shaded headers, callouts for warnings/notes, TOC, page numbers, captioned images, multi-column sections) **in a single round** — write the JSON spec + run `docx_build.py` + `docx_qa.py` in the same Phase. Iterate only if QA flags real issues.

---

## Script Reference

| Script | Purpose | Use when |
| :--- | :--- | :--- |
| `docx_inspect.py` | Structured inspection (sections, headings, paragraphs, tables, images, comments, tracked changes, styles) | ✅ **Always run first** on existing files |
| `docx_build.py` | JSON-driven document creation (themes, blocks, headings, tables, images, TOC, headers/footers, columns) | ✅ **Default for creating** new documents |
| `docx_qa.py` | Static QA: leftover placeholders, heading-level skips, missing alt-text, low contrast, empty paragraphs, oversized tables, broken images | ✅ **MANDATORY** after writing/editing, before delivery |
| `docx_manipulate.py` | Merge / extract / split / info / replace-text / accept-changes | Combining, breaking, finding/replacing, finalizing tracked changes |
| `docx_convert.py` | `doc2docx`, `docx2pdf`, `docx2text`, `docx2html` | Legacy conversion + final delivery as PDF/HTML, or text dump |

### Execution Strategy

- **Reading existing file**: `docx_inspect.py` in `execution_phase: "before_all"` so the JSON sample lands before any subsequent edit logic. Then write your edits in Phase 3.
- **Creating new file**: `write_file` the JSON spec in Phase 2 + `docx_build.py` + `docx_qa.py` in Phase 3 (same round, in this order — `docx_qa.py` after `docx_build.py`).
- **Editing existing file**: Inspect (Phase 1) → `docx_manipulate.py replace-text` OR `code_execution` with `python-docx` (Phase 3) → `docx_qa.py` (Phase 3, after the edit).
- **Find/Replace only**: `docx_manipulate.py replace-text` in Phase 3, no QA needed if formatting is preserved by the run-aware replacer.
- **Conversion only**: Single `bash` call, no QA needed unless the document was just modified.
- **Legacy `.doc` files**: ALWAYS convert to `.docx` first via `docx_convert.py doc2docx` (Phase 1) — `python-docx` cannot open `.doc`.

**DOCX-Specific Rules**:
- **Binary format**: NEVER `read_file` a `.docx`/`.dotx`/`.doc`. Use `docx_inspect.py` for structure or `docx_convert.py docx2text` for a markdown dump.
- **`.dotx` works the same as `.docx`**: every script handles both extensions transparently. `.doc` (legacy) MUST be converted first.
- **Absolute paths**: Strict enforcement of `/workspace/` or `/readonly/` prefixes. Final document goes in `/workspace/output/`, JSON specs / inspections / extracted images in `/workspace/temp/`.
- **No `cat << EOF`**: Never build the JSON spec via bash heredoc; always `write_file`.
- **NO code_execution on spec.json**: NEVER use `code_execution` to modify `spec.json`. Always rewrite the entire JSON using `write_file`. If you need to edit the spec, read it, modify in memory, then write the complete updated JSON with `write_file`.
- **Color format**: ALWAYS use 6-character hex colors (RRGGBB) like `"FFFFFF"` or `"000000"`, or theme token names like `"accent"`, `"surface"`, `"title_color"`. NEVER use color names like `"white"`, `"black"`, `"red"` — these will cause build errors.
- **Consistent output filename**: When building a document, use a single consistent output filename (e.g., `/workspace/output/document.docx`). If you need to rebuild after QA, overwrite the same file — do NOT create new filenames. Only one `.docx` should be delivered to the user.
- **Read temp JSON via bash if needed**: If `read_file` cannot read a newly-created `/workspace/temp/*.json`, do NOT loop. Use a standalone `bash` call: `cat /workspace/temp/file.json`.
- **Scripts vs Tools**: All utilities are SCRIPTS, called via `bash`. DO NOT try to use them as tool names.
- **No Concatenation**: NEVER combine multiple docx scripts in a single `bash` command using `&&`/`;`/`|`. Emit them as separate tool calls in the same round.
- **Readonly writes**: NEVER write back to `/readonly/...`. To edit a user-provided document, first `cp /readonly/history/<file>.docx /workspace/temp/<file>.docx` in a standalone `bash` call, then operate on the writable copy.
- **Auto-delivery**: The final `.docx` (or its `.pdf` export) MUST end up in `/workspace/output/`. Anything in `/workspace/temp/` will NOT be auto-delivered to the user.
- **Pre-existing templates**: When EDITING a user-provided `.docx`/`.dotx` template, study its style with `docx_inspect.py` and EXACTLY match existing fonts, colors, page size, margins, and heading styles. Existing template conventions ALWAYS override the defaults in this guide.
- **Heading levels are 1-based** (1 to 9). Don't skip levels (H1 → H3); QA flags `heading_skip`.
- **Page sizes** in the spec accept names (`"letter"`, `"a4"`, `"a5"`, `"legal"`) OR explicit inches (`{"width_in": 8.5, "height_in": 11}`). Default: A4.
- **Image Search**: Include relevant images from internet when appropriate to enhance visual appeal and clarity. Use `image_search` with `save_to_disk=true` to make them available under `/readonly/searched_images/`. Use the EXACT path returned by the tool.

---

## Output Quality Requirements

Every document delivered to the user MUST satisfy:

- **Editorial layout, not "wall of text"**: structured documents (reports, manuals, CVs) MUST use proper headings, lists, tables, and callouts — not one giant paragraph. Use `heading` blocks for sections, `list` blocks for enumerations, `table` blocks for structured data, `callout` blocks for notes/warnings.
- **Consistent visual identity**: same theme, same heading font, same accent color across all blocks. Pick one theme at the top of the spec and stick with it.
- **No leftover placeholder text**: zero matches for `lorem`, `ipsum`, `xxxx`, `tbd`, `todo`, `placeholder`, `{{...}}` (unfilled mustache), "click here". Verified by `docx_qa.py`.
- **Correct heading hierarchy**: don't skip levels (H1 → H3 is wrong; use H1 → H2 → H3). Required for working TOC and accessibility.
- **Readable font sizes**: body text ≥ 10pt, headings ≥ 12pt. QA flags anything smaller.
- **Sufficient contrast**: text luma must differ from background by at least 0.25 (QA threshold). Don't use yellow text on white or grey on grey.
- **Image alt-text mandatory**: every `image` block MUST include `alt_text`. Required for accessibility and flagged by QA when missing.
- **Aspect ratios preserved**: when adding images, set ONE of `width_in`/`height_in` and let the other be computed automatically from the source image's natural ratio. NEVER set both arbitrarily — distortion is flagged by QA.
- **Tables fit the page**: total `column_widths` must fit within the printable area (page width minus margins). QA computes overflow.
- **TOC requires proper heading styles**: `toc` block only works when content uses `heading` blocks (not bold paragraphs faking headings). The TOC is a Word field — open in Word/LibreOffice to refresh, OR run `docx_convert.py docx2pdf` (which auto-refreshes).

---

## Theme Tokens

`docx_build.py` ships with five themes, each exposing a full set of **semantic color tokens** that any block can reference by NAME (not hex) — e.g. `"color": "accent"`, `"fill": "surface"`. Use the token name to keep style consistent without hard-coding hex values.

| Theme | Background | Surface / Surface alt | Title / Body / Muted | Accent / Accent dark | Success / Warning / Danger | Default font |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `corporate` (default) | white | `F8FAFC` / `E2E8F0` | `0F172A` / `1F2937` / `64748B` | `2563EB` / `1E40AF` | `10B981` / `F59E0B` / `DC2626` | Calibri |
| `executive` | white | `F1F5F9` / `E2E8F0` | `0B1220` / `1F2937` / `475569` | `0F766E` / `134E4A` | `15803D` / `B45309` / `B91C1C` | Garamond (fallback Calibri) |
| `academic` | white | `F8F8F4` / `E7E5E4` | `1F1B16` / `292524` / `78716C` | `7C3AED` / `5B21B6` | `15803D` / `B45309` / `B91C1C` | Times New Roman |
| `minimal` | white | `FAFAFA` / `EEEEEE` | `111827` / `374151` / `6B7280` | `111827` / `000000` | `10B981` / `F59E0B` / `DC2626` | Helvetica (fallback Arial) |
| `modern` | white | `F8FAFC` / `E0F2FE` | `0F172A` / `1F2937` / `64748B` | `0EA5E9` / `0369A1` | `10B981` / `F59E0B` / `DC2626` | Calibri |

Every block accepts colors as either:
- a **token name** like `"accent"`, `"surface_alt"`, `"title_color"`, `"body_color"`, `"muted"`, `"success"`, `"on_accent"`, `"background"`, …
- a **6-char hex** like `"2563EB"` (no `#` prefix required, but allowed)

To override a token globally, set `defaults.<token>` in the spec; e.g. `"defaults": {"accent": "FF6B35", "font_name": "Inter"}`.

**Default to `corporate` for client-facing reports**, `executive` for board/CEO docs, `academic` for whitepapers/theses, `minimal` for internal memos, `modern` for tech/marketing.

---

## Block Catalog (recommended for any structured document)

A document is built from a flat list of `blocks` (or from `sections[]` if you need different page setups / multi-column layouts). Blocks render **in order**, top to bottom.

| Block | Purpose | Required fields | Notable options |
| :--- | :--- | :--- | :--- |
| `heading` | Section title (TOC-eligible) | `text`, `level` (1-9) | `align`, `color`, `size`, `bold`, `italic`, `page_break_before` |
| `paragraph` | Body text (text or rich runs) | `text` OR `runs[]` | `runs:[{text,bold,italic,underline,color,size,font,strike,subscript,superscript,highlight,hyperlink}]`, `align`, `style`, `indent_in`, `first_line_in`, `space_before_pt`, `space_after_pt`, `line_spacing` |
| `list` | Bullet/numbered list (nested) | `items[]` | `style:"bullet"\|"number"\|"check"`, `items:[str\|{text,level,bold,color,runs}]` |
| `table` | Styled table (header fill, zebra, borders) | `headers`, `rows` | `column_widths_in`, `header_fill`, `header_fg`, `zebra`, `body_size`, `align`, `header_align`, `borders`, `merge_cells:[[r1,c1,r2,c2]]`, `repeat_header`, `cell_padding_in` |
| `image` | Inline picture with caption + alt-text | `path`, `alt_text` | `width_in`, `height_in`, `align`, `caption`, `caption_align` |
| `page_break` | Force a new page | — | — |
| `divider` | Horizontal line | — | `color`, `thickness_pt`, `space_before_pt`, `space_after_pt` |
| `callout` | Shaded note/warning/info/danger box | `text` OR `lines[]` | `kind:"info"\|"success"\|"warning"\|"danger"\|"note"`, `icon`, `fill`, `fg`, `border_color`, `padding_in` |
| `toc` | Table of Contents (Word field) | — | `levels` (default 1-3), `title`, `hyperlink` (default true) |
| `quote` | Blockquote with citation | `text` | `citation`, `accent_color` |
| `code_block` | Monospace block | `text` | `language` (cosmetic), `fill`, `fg`, `font_size` |
| `kpi_grid` | Metric tiles (3-4 cols) | `items[]` | `columns`, `items:[{label,value,delta,delta_color,value_color}]` |
| `signature_block` | Signature line(s) | `signers[]` | `signers:[{name,role,date}]`, `columns` |
| `table_of_figures` | Field for list of captioned figures | — | `title`, `caption_label` (default "Figure") |
| `cover_page` | Hero cover (title + subtitle + meta) | `title` | `subtitle`, `author`, `date`, `accent_band`, `logo_path` |

> Coordinates for inline blocks are NOT free-form (Word is flow-based, not absolute like PowerPoint). Use `align`, `indent_in`, `first_line_in` for placement.

### Section-level options (top-level OR per-section)

| Field | Purpose | Default |
| :--- | :--- | :--- |
| `page_size` | Named (`"letter"`, `"a4"`, `"a5"`, `"legal"`) or `{width_in, height_in}` | `"a4"` |
| `orientation` | `"portrait"` or `"landscape"` | `"portrait"` |
| `margins_in` | `{top, right, bottom, left}` | `{1.0, 1.0, 1.0, 1.0}` |
| `columns` | Number of columns (1-4) | `1` |
| `column_space_in` | Gap between columns | `0.5` |
| `column_separator` | Vertical line between columns (bool) | `false` |
| `header` | Block list rendered in page header | none |
| `footer` | Block list rendered in page footer | none |
| `page_numbers` | `true` for default footer (`Page X of N`) or `{position, format}` | `false` |
| `different_first_page` | Different header/footer on page 1 | `false` |

---

## Quality Recipes (copy these patterns)

Each recipe below is the **minimum spec** to produce one editorial-grade document segment. Combine them inside `blocks[]` (or a section's `blocks[]`) in any order.

### Recipe A — Cover page + executive summary

```json
{
  "theme": "executive",
  "page_size": "a4",
  "margins_in": {"top": 1.0, "right": 1.0, "bottom": 1.0, "left": 1.0},
  "properties": {"title": "Q4 2025 Performance Report", "author": "GemiX AI"},
  "blocks": [
    {"type": "cover_page",
        "title": "Q4 2025 Performance Report",
        "subtitle": "Strategic Review & 2026 Outlook",
        "author": "Strategy Office",
        "date": "May 2026",
        "accent_band": true},
    {"type": "page_break"},
    {"type": "heading", "text": "Executive Summary", "level": 1},
    {"type": "paragraph",
        "runs": [
          {"text": "Q4 2025 closed with "},
          {"text": "record revenue of €12.4M", "bold": true, "color": "accent"},
          {"text": " (+18% YoY) and the strongest customer-retention quarter on file. "},
          {"text": "All three strategic objectives", "italic": true},
          {"text": " were exceeded; the board is asked to approve the proposed 2026 capacity expansion."}
        ],
        "align": "justify"},
    {"type": "callout", "kind": "success",
        "text": "Headline: 4 of 4 OKRs achieved · NPS at all-time high (72) · Cash position +€3.1M vs forecast."},
    {"type": "kpi_grid", "columns": 4,
        "items": [
          {"label": "REVENUE",   "value": "€12.4M", "delta": "+18% YoY", "delta_color": "success"},
          {"label": "EBITDA",    "value": "€3.1M",  "delta": "+22% YoY", "delta_color": "success"},
          {"label": "NEW CUSTOMERS", "value": "47", "delta": "+12 vs Q3"},
          {"label": "NPS",       "value": "72",     "delta": "+9 pts",   "delta_color": "success"}
        ]}
  ]
}
```

### Recipe B — TOC + multi-level headings

```json
{
  "blocks": [
    {"type": "heading", "text": "Table of Contents", "level": 1},
    {"type": "toc", "levels": [1, 2, 3], "hyperlink": true},
    {"type": "page_break"},
    {"type": "heading", "text": "1. Introduction", "level": 1},
    {"type": "paragraph", "text": "This report covers the period from October 1 to December 31, 2025...", "align": "justify"},
    {"type": "heading", "text": "1.1 Scope", "level": 2},
    {"type": "paragraph", "text": "All commercial entities owned by Acme S.p.A. are in scope, except the Brazilian subsidiary..."},
    {"type": "heading", "text": "1.1.1 Currency", "level": 3},
    {"type": "paragraph", "text": "All figures are reported in EUR. Conversion rates are taken from the closing rates of December 31, 2025."}
  ]
}
```

### Recipe C — Professional table with zebra rows + shaded header

```json
{
  "blocks": [
    {"type": "heading", "text": "2. Financial Highlights", "level": 1},
    {"type": "paragraph", "text": "The table below summarizes the consolidated income statement against budget."},
    {"type": "table",
        "headers": ["Metric", "Q4 2025", "Budget", "Δ vs Budget", "vs Q4 2024"],
        "rows": [
          ["Revenue",        "€12.4M",  "€11.0M", "+12.7%",  "+18%"],
          ["Gross Margin",   "62.1%",   "60.0%",  "+2.1 pp", "+1.8 pp"],
          ["Operating Cost", "€4.6M",   "€4.8M",  "−4.2%",   "+3%"],
          ["EBITDA",         "€3.1M",   "€2.4M",  "+29.2%",  "+22%"],
          ["Net Income",     "€2.0M",   "€1.5M",  "+33.3%",  "+27%"]
        ],
        "column_widths_in": [1.6, 1.0, 1.0, 1.2, 1.0],
        "header_fill": "accent",
        "header_fg": "on_accent",
        "header_align": "center",
        "align": "center",
        "zebra": true,
        "body_size": 11,
        "borders": {"all": "thin", "color": "muted"},
        "repeat_header": true},
    {"type": "paragraph",
        "runs": [
          {"text": "Note: ", "bold": true, "color": "muted"},
          {"text": "all figures are unaudited and may be subject to year-end adjustments.", "italic": true, "color": "muted", "size": 9}
        ]}
  ]
}
```

### Recipe D — Image with caption + numbered list

```json
{
  "blocks": [
    {"type": "heading", "text": "3. Strategic Initiatives", "level": 1},
    {"type": "paragraph", "text": "Four strategic workstreams progressed during Q4:"},
    {"type": "list", "style": "number",
        "items": [
          "Customer expansion in DACH region (Germany, Austria, Switzerland)",
          "Migration of legacy infrastructure to AWS",
          {"text": "Launch of GemiX 2.0 platform with multi-tenant support", "bold": true},
          "Acquisition of TalentSquare (closed 18 December 2025)"
        ]},
    {"type": "image",
        "path": "/readonly/searched_images/q4_revenue_chart.png",
        "alt_text": "Revenue by region — Q4 2025: DACH €5.2M, Italy €4.8M, Iberia €1.6M, France €0.8M",
        "width_in": 5.5,
        "align": "center",
        "caption": "Figure 1 — Revenue split by region in Q4 2025 (€M)"},
    {"type": "paragraph",
        "text": "DACH expansion delivered the largest YoY contribution thanks to two new framework agreements signed in October.",
        "align": "justify"}
  ]
}
```

### Recipe E — Callouts (info / warning / danger / success / note)

```json
{
  "blocks": [
    {"type": "heading", "text": "4. Risks & Mitigations", "level": 1},
    {"type": "callout", "kind": "warning",
        "text": "FX exposure to USD increased to 22% of total revenue. A natural hedge through USD-denominated AWS spend covers ~40% of this exposure; the remainder is hedged via 6-month forward contracts."},
    {"type": "callout", "kind": "danger",
        "text": "One key customer (12% of recurring revenue) issued a non-renewal notice on 3 January 2026. Account team is engaged; estimated probability of renewal: 55%."},
    {"type": "callout", "kind": "info",
        "text": "GDPR audit scheduled for March 2026. Internal pre-audit completed with zero critical findings."},
    {"type": "callout", "kind": "success",
        "text": "ISO 27001 re-certification completed on 12 December 2025 with no non-conformities."},
    {"type": "callout", "kind": "note",
        "text": "All figures in this section are management estimates and not audited."}
  ]
}
```

### Recipe F — Two-column section + signature block

```json
{
  "sections": [
    {
      "page_size": "a4",
      "blocks": [/* cover + summary */]
    },
    {
      "page_size": "a4",
      "columns": 2,
      "column_space_in": 0.4,
      "column_separator": false,
      "blocks": [
        {"type": "heading", "text": "Press Release Body", "level": 1},
        {"type": "paragraph", "text": "Milan, May 7, 2026 — Acme S.p.A. announced today record results for Q4 2025...", "align": "justify"},
        {"type": "paragraph", "text": "The board approved a special dividend of €0.45 per share, payable on June 15, 2026.", "align": "justify"}
      ]
    },
    {
      "page_size": "a4",
      "columns": 1,
      "blocks": [
        {"type": "heading", "text": "Approvals", "level": 2},
        {"type": "signature_block", "columns": 2,
            "signers": [
              {"name": "Maria Rossi",  "role": "Chief Executive Officer", "date": "May 7, 2026"},
              {"name": "Luigi Bianchi", "role": "Chief Financial Officer", "date": "May 7, 2026"}
            ]}
      ]
    }
  ]
}
```

### Recipe G — Letterhead with header/footer + page numbers

```json
{
  "theme": "corporate",
  "page_size": "a4",
  "margins_in": {"top": 1.2, "right": 1.0, "bottom": 1.0, "left": 1.0},
  "header": [
    {"type": "table",
        "headers": [],
        "rows": [["Acme S.p.A.", "Confidential — Internal use only"]],
        "column_widths_in": [3.2, 3.2],
        "borders": {"none": true},
        "align": "left",
        "header_align": "left",
        "body_size": 9}
  ],
  "footer": [
    {"type": "paragraph",
        "runs": [
          {"text": "Acme S.p.A. · Via Roma 1 · 20121 Milano · "},
          {"text": "Page ", "color": "muted"},
          {"text": "{PAGE}",  "color": "muted"},
          {"text": " of ",   "color": "muted"},
          {"text": "{PAGES}","color": "muted"}
        ],
        "align": "center",
        "size": 9,
        "color": "muted"}
  ],
  "page_numbers": true,
  "blocks": [/* document body */]
}
```

> **Field placeholders inside paragraph runs**: `{PAGE}` → current page number, `{PAGES}` → total page count, `{DATE}` → today's date, `{TIME}` → current time. Resolved as Word fields (refresh on open).

---

## Full Example — Single-round Executive Report

The recipes above can be stitched into one spec to produce a board-grade Word document in **one tool round**. Pattern:

```
Phase 2 (write_file)        →  /workspace/temp/spec.json   (full spec, all sections)
Phase 3 (bash, in order)    →  docx_build.py + docx_qa.py
```

**Build + QA in the same Phase-3 round:**
```bash
python /readonly/skills/docx/scripts/docx_build.py \
  --spec /workspace/temp/spec.json \
  --output /workspace/output/report.docx
```
```bash
python /readonly/skills/docx/scripts/docx_qa.py \
  --input /workspace/output/report.docx \
  --output /workspace/temp/qa.json
```

If the user asked for a **PDF** rather than a `.docx`, append a third standalone call:
```bash
python /readonly/skills/docx/scripts/docx_convert.py docx2pdf \
  --input /workspace/output/report.docx \
  --output /workspace/output/report.pdf
```

> The PDF conversion auto-refreshes Word fields (TOC, page numbers, table of figures), so the final PDF always shows resolved fields even though the `.docx` itself stores them as field codes.

---

## `docx_inspect.py` — Read an Existing Document

> Run this BEFORE editing or analysing any pre-existing `.docx`/`.dotx`. Output is a single JSON document with section/page setup, headings, paragraph samples, tables, image inventory, comments, tracked changes, and style names.

```bash
python /readonly/skills/docx/scripts/docx_inspect.py \
  --input /readonly/history/<file>.docx \
  --paragraphs-sample 50 \
  --output /workspace/temp/inspection.json
# Optional flags:
#   --extract-images /workspace/temp/extracted/    # save embedded images for re-use
#   --text-only                                    # skip tables/images, just text
#   --paragraphs-sample N                          # default 30 (global limit, not per-section)
```

**Inspection JSON schema:**
```json
{
  "file": "/readonly/history/contract.docx",
  "page_setup": {"page_size": "a4", "page_width_in": 8.27, "page_height_in": 11.69, "orientation": "portrait", "margins_in": {"top": 1, "right": 1, "bottom": 1, "left": 1}},
  "section_count": 2,
  "paragraph_count": 142,
  "heading_outline": [
    {"level": 1, "text": "1. Introduction", "index": 4},
    {"level": 2, "text": "1.1 Scope", "index": 7}
  ],
  "tables": [
    {"index": 0, "rows": 6, "cols": 4, "header_row": ["Metric", "Q4", "Budget", "Δ"]}
  ],
  "images": [
    {"name": "image1.png", "ext": "png", "size_bytes": 482103}
  ],
  "comments": [{"id": 0, "author": "Mario", "text": "Verify Q3 number"}],
  "tracked_changes": {"insertions": 3, "deletions": 1},
  "styles_used": ["Heading 1", "Heading 2", "Normal", "List Bullet"],
  "paragraphs_sample": [
    {"index": 0, "style": "Heading 1", "text": "Q4 2025 Report"}
  ]
}
```

> **Note**: `docx_inspect.py` does NOT execute Word fields (TOC, page numbers). It reports the field code as-is. To see resolved values, convert to PDF first via `docx_convert.py docx2pdf`.

---

## `docx_build.py` — Create a Document from a JSON Spec

The default tool for new documents. Pair `write_file` (Phase 2) with two Phase 3 `bash` calls (`docx_build.py` then `docx_qa.py`).

```bash
python /readonly/skills/docx/scripts/docx_build.py \
  --spec /workspace/temp/spec.json \
  --output /workspace/output/document.docx
# Optional flags: --font-name "Calibri" (overrides theme default)
#                 --font-size 11 (overrides theme default)
#                 --refresh-fields  (try to update TOC/PAGE fields via LibreOffice headless convert-to)
```

**Top-level spec keys** (every key is optional except `blocks` or `sections`):

| Key | Purpose |
| :--- | :--- |
| `theme` | One of `corporate\|executive\|academic\|minimal\|modern` (default `corporate`) |
| `page_size` | `"letter"`, `"a4"`, `"a5"`, `"legal"`, or `{"width_in":N, "height_in":N}` |
| `orientation` | `"portrait"` (default) or `"landscape"` |
| `margins_in` | `{"top":1, "right":1, "bottom":1, "left":1}` (defaults: 1 inch all sides) |
| `properties` | `{title, author, subject, keywords, comments}` |
| `defaults` | Override theme tokens AND `font_name`, `font_size`, `heading_font`, `title_size`, `body_size` |
| `header` / `footer` | Block list rendered in EVERY page header/footer (top-level shortcut) |
| `page_numbers` | `true` to add `Page X of N` footer, OR `{position:"left\|center\|right", format:"X"\|"X / N"\|"Page X of N"}` |
| `different_first_page` | Different header/footer on page 1 (e.g., cover page without footer) |
| `blocks` | Flat list of blocks for a single-section document |
| `sections` | List of `{page_size, orientation, margins_in, columns, column_space_in, column_separator, header, footer, blocks}` for multi-section documents |

> Use `blocks` for simple flowing documents; switch to `sections` only when you need landscape pages, multi-column layouts, or different headers/footers per section.

---

## `docx_qa.py` — MANDATORY After Building or Editing

Catches the most common authoring bugs WITHOUT the cost of rendering. Run it in the same Phase 3 as `docx_build.py` (or your edit script), emitted **after** the writer.

```bash
python /readonly/skills/docx/scripts/docx_qa.py \
  --input /workspace/output/document.docx \
  --output /workspace/temp/qa.json
# Optional flags:
#   --min-font-pt 10
#   --contrast-threshold 0.25
#   --max-table-cols 12
#   --max-paragraph-chars 4000
```

**QA report JSON schema:**
```json
{
  "file": "/workspace/output/document.docx",
  "status": "passed",
  "total_issues": 0,
  "total_warnings": 2,
  "issues": [],
  "warnings": [
    {"type": "long_paragraph", "severity": "info", "location": "p#42",
     "message": "Paragraph exceeds 4000 chars; consider splitting"}
  ],
  "stats": {
    "paragraph_count": 156, "heading_count": 18, "table_count": 6,
    "image_count": 4, "comment_count": 0, "section_count": 2
  }
}
```

**Issue types** (severity = critical, fix before delivery):
- `placeholder_text`: matches for `lorem`, `ipsum`, `xxxx`, `tbd`, `todo`, `placeholder`, `{{...}}` (unfilled mustache), "click here"
- `tiny_font`: text below `--min-font-pt`
- `low_contrast`: text vs background luma delta < `--contrast-threshold`
- `image_missing_alt`: `image` block without `alt_text`
- `image_distorted`: image with width/height ratio that does NOT match the source's natural ratio (tolerance ±5%)
- `table_overflow`: total `column_widths_in` exceeds the printable area
- `heading_skip`: heading level jumped (e.g., H1 → H3 with no H2)
- `broken_image_path`: image relationship exists but embedded blob is missing or media file not found
- `unfilled_field`: TOC field code present but never refreshed (warning, not critical — opens correctly in Word/LibreOffice)
- `empty_required_block`: `heading.text` or `cover_page.title` is empty

**Warning types** (severity = info/warning, optional improvements):
- `long_paragraph`: paragraph > `--max-paragraph-chars`
- `wide_table`: table > `--max-table-cols` columns
- `inconsistent_heading_font`: heading uses a font that differs from `defaults.heading_font`
- `no_toc`: document has 5+ headings but no TOC

**QA Iteration Rules:**
- Run `docx_qa.py` after `docx_build.py` if you want to validate quality before delivery.
- Only iterate on CRITICAL issues — warnings are optional improvements.
- Use consistent output filename when rebuilding after QA — overwrite the same file.

> **Single-round goal**: Build + QA in the same round. Deliver the document even if QA reports warnings. Only iterate for real bugs.

---

## `docx_manipulate.py` — Merge / Extract / Split / Info / Replace-text / Accept-changes

```bash
# Merge: concatenate multiple .docx files in order (page break between each)
python /readonly/skills/docx/scripts/docx_manipulate.py merge \
  --inputs /workspace/temp/cover.docx /workspace/temp/body.docx /workspace/temp/appendix.docx \
  --output /workspace/output/full.docx
# Optional: --no-page-break (concat without inserting a page break between docs)

# Extract: pick paragraph range OR sections by index range
python /readonly/skills/docx/scripts/docx_manipulate.py extract \
  --input /workspace/output/full.docx \
  --paragraphs "10-50" \
  --output /workspace/output/excerpt.docx
# OR
python /readonly/skills/docx/scripts/docx_manipulate.py extract \
  --input /workspace/output/full.docx \
  --sections "1,3" \
  --output /workspace/output/excerpt.docx

# Split: every section becomes its own .docx (zero-padded suffix)
python /readonly/skills/docx/scripts/docx_manipulate.py split \
  --input /workspace/output/full.docx \
  --output-prefix /workspace/temp/part
# Generates part_001.docx, part_002.docx, ...

# Info: lightweight metadata (faster than docx_inspect.py)
python /readonly/skills/docx/scripts/docx_manipulate.py info \
  --input /workspace/output/full.docx

# Replace-text: literal find/replace (LIMITATION: merges all text into first run, losing mixed formatting)
python /readonly/skills/docx/scripts/docx_manipulate.py replace-text \
  --input /workspace/temp/template.docx \
  --replacements /workspace/temp/replacements.json \
  --output /workspace/output/filled.docx
# replacements.json: {"{{COMPANY}}": "Acme S.p.A.", "{{DATE}}": "May 7, 2026"}
# Optional: --regex (treat keys as regex patterns)
#           --case-insensitive (default: case-sensitive)
#           --no-headers-footers  (default: includes header/footer paragraphs)
#           --no-tables           (default: includes paragraphs inside tables)

# Accept-changes: accept ALL tracked changes (insertions kept, deletions removed)
python /readonly/skills/docx/scripts/docx_manipulate.py accept-changes \
  --input /workspace/temp/draft.docx \
  --output /workspace/output/clean.docx
# Optional: --reject (reject all instead of accepting)
#           --strip-comments (also remove all comments)
```

> **Limitation**: `merge` uses python-docx + lxml deepcopy of body XML onto a fresh document. Explicit text/tables/images survive; styles RESOLVE against the FIRST input's styles map. For 100% theme-faithful merges, ensure all inputs share the same template, OR convert each to PDF via `docx_convert.py docx2pdf` and stitch them with `pdf_manipulate.py merge` (PDF skill) instead.
>
> **Limitation**: `extract --paragraphs` works at the body-paragraph level (1-based count). Tables count as 1 paragraph slot each. Use `docx_inspect.py` first to find the correct indices.

---

## `docx_convert.py` — Format Conversion

```bash
# DOC → DOCX (legacy convert, REQUIRED before python-docx can open .doc/.rtf)
python /readonly/skills/docx/scripts/docx_convert.py doc2docx \
  --input /readonly/history/legacy.doc \
  --output /workspace/temp/legacy.docx
# Also supports .rtf files
# Optional: --timeout 120

# DOCX → PDF (LibreOffice headless; refreshes TOC/PAGE fields automatically)
python /readonly/skills/docx/scripts/docx_convert.py docx2pdf \
  --input /workspace/output/report.docx \
  --output /workspace/output/report.pdf
# Optional: --timeout 120

# DOCX → markdown text (headings, paragraphs, tables, lists; lossy, no images)
python /readonly/skills/docx/scripts/docx_convert.py docx2text \
  --input /readonly/history/<file>.docx \
  --output /workspace/temp/transcript.md
# Optional: --include-images-as-refs (write `![alt](image_N.ext)` placeholders)

# DOCX → HTML (LibreOffice headless; preserves most styling and inline images)
python /readonly/skills/docx/scripts/docx_convert.py docx2html \
  --input /workspace/output/report.docx \
  --output /workspace/output/report.html
# Optional: --timeout 120
```

> When the user asks to "read the document as text" or "summarise the doc", `docx2text` is faster than `docx_inspect.py` (which is structural) and produces a markdown-ready transcript.

---

## Editing an Existing File (Common Pattern)

### A) Find/replace template fields (preferred — formatting is preserved)

```bash
# Phase 1 — inspect (so the JSON lands in the same round)
python /readonly/skills/docx/scripts/docx_inspect.py \
  --input /readonly/history/template.docx \
  --output /workspace/temp/inspection.json
```
```bash
# Phase 1 — copy the readonly source to a writable location (parallel with inspect)
cp /readonly/history/template.docx /workspace/temp/working.docx
```
```
# Phase 2 — write_file the replacements map
write_file -> /workspace/temp/replacements.json
{"{{COMPANY}}":"Acme S.p.A.","{{CEO}}":"Maria Rossi","{{DATE}}":"7 maggio 2026"}
```
```bash
# Phase 3 — replace + QA in the same round
python /readonly/skills/docx/scripts/docx_manipulate.py replace-text \
  --input /workspace/temp/working.docx \
  --replacements /workspace/temp/replacements.json \
  --output /workspace/output/contract.docx
```
```bash
python /readonly/skills/docx/scripts/docx_qa.py \
  --input /workspace/output/contract.docx \
  --output /workspace/temp/qa.json
```

### B) Programmatic editing via `python-docx`

```python
# Phase 3 — code_execution: open, edit, save into /workspace/output/
from docx import Document
doc = Document("/workspace/temp/working.docx")
for para in doc.paragraphs:
    if "DRAFT" in para.text:
        for run in para.runs:
            run.text = run.text.replace("DRAFT", "FINAL")
# Add a new paragraph at the end
doc.add_heading("Approved on 7 May 2026", level=2)
doc.save("/workspace/output/contract.docx")
```
```bash
# Phase 3 — QA the edit (emitted after the code_execution above, same round)
python /readonly/skills/docx/scripts/docx_qa.py \
  --input /workspace/output/contract.docx \
  --output /workspace/temp/qa.json
```

> **KEEP the original run object** when replacing text. Do NOT delete the run and re-add a new one — the new run loses the source font/size/color settings. The `replace-text` subcommand of `docx_manipulate.py` already handles this correctly.

> **Run-splitting caveat**: Word may store the literal `{{COMPANY}}` across MULTIPLE adjacent runs (because of authoring history). `docx_manipulate.py replace-text` automatically merges adjacent runs in each paragraph BEFORE searching, so the placeholder is found even if it's split. If you write your own loop, do the same merge first or matches will silently fail.

---

## Math / Layout / Image Cheat Sheet

The AI often distorts images, breaks tables, or stuffs everything in one paragraph. Use this table as a strict guide.

| Goal | ❌ WRONG | ✅ RIGHT |
| :--- | :--- | :--- |
| Resize image (preserve ratio) | `"width_in": 5, "height_in": 5` (random) | `"width_in": 5` only — height auto-computed from natural ratio |
| Web image in document | `image_search ... save_to_disk=false` | `image_search ... save_to_disk=true`, then path under `/readonly/searched_images/` |
| User-provided image | guess dimensions | Use `Pillow` to read natural size, then set ONE dimension |
| Table fitting page width | sum > printable area | Sum `column_widths_in` ≤ (page width − left − right margins) |
| Bullet/numbered list | manually type `• ` or `1. ` | Use `list` block with `style:"bullet"` or `style:"number"` |
| Section heading | bold paragraph faking H1 | Use `heading` block with `level:1` (REQUIRED for TOC) |
| Page break | many empty paragraphs | Use `page_break` block |
| Two-column layout | manual tabs | Use `sections[].columns: 2` |
| Right-align text on same line | `\t\t\t\tDate` | Use `runs` with a tab + tab-stop, or `signature_block` |

**Aspect-ratio safe sizing inside a `code_execution` cell:**
```python
from PIL import Image
src = Image.open("/readonly/searched_images/photo.jpg")
nat_w, nat_h = src.size
target_w = 5.5  # inches
target_h = round(target_w * (nat_h / nat_w), 3)
# pass into spec.json image block: {"path":"...", "width_in": target_w, "height_in": target_h, "alt_text":"..."}
# OR (preferred): pass only width_in and let docx_build.py compute height automatically
```

---

## Reading & Extracting Content

For pure analysis (no styling/output), use `docx_convert.py docx2text` (markdown-friendly) or `docx_inspect.py` (structured JSON).

### Quick text dump
```bash
python /readonly/skills/docx/scripts/docx_convert.py docx2text \
  --input /readonly/history/manual.docx \
  --output /workspace/temp/transcript.md
```

### Programmatic extraction via `python-docx`
```python
from docx import Document
doc = Document("/readonly/history/<file>.docx")

# All paragraphs
for para in doc.paragraphs:
    if para.style.name.startswith("Heading"):
        print(f"## {para.text}")
    else:
        print(para.text)

# All tables
for tbl in doc.tables:
    for row in tbl.rows:
        print(" | ".join(c.text.strip() for c in row.cells))

# All embedded images (raw bytes)
for rel_id, rel in doc.part.rels.items():
    if "image" in rel.reltype:
        img_blob = rel.target_part.blob
        # write img_blob to /workspace/temp/img_<id>.<ext>
```

---

## Troubleshooting & Common Fails

### 1. TOC shows empty / "right-click → update field"
The TOC block writes a Word field code. The values are populated by Word/LibreOffice when the file is opened, NOT by python-docx.
- **Fix (deliverable as PDF)**: Run `docx_convert.py docx2pdf` — LibreOffice refreshes fields automatically during conversion. The PDF will show the resolved TOC.
- **Fix (deliverable as DOCX)**: Pass `--refresh-fields` to `docx_build.py` (invokes `soffice --headless --calc-fields`), OR tell the user to press F9 / right-click → "Update Field" in Word.

### 2. `replace-text` finds nothing even though the placeholder is visible
The placeholder is split across multiple runs (Word stores authoring history as separate runs). `docx_manipulate.py replace-text` already merges adjacent runs per paragraph. If you wrote your own loop, do the same merge first.
- **Fix**: Use `docx_manipulate.py replace-text` instead of a hand-written `code_execution` loop.

### 3. Table renders with no borders / black backgrounds
- python-docx applies default table style `"Table Grid"` if no style is set. Specify `"borders": {"all": "thin", "color": "muted"}` explicitly to avoid surprises.
- Cell shading must use solid color hex (or theme tokens), NEVER named colors.

### 4. Image distorted (squashed / stretched)
You set both `width_in` AND `height_in` to arbitrary numbers.
- **Fix**: Set ONE dimension and leave the other null/unset. `docx_build.py` reads the source image with `Pillow` and computes the missing dimension from the natural aspect ratio.

### 5. Heading 4+ doesn't appear in TOC
The default TOC field code is `\o "1-3"` (levels 1–3 only).
- **Fix**: In your `toc` block, set `"levels": [1, 2, 3, 4, 5, 6]` to include deeper headings.

### 6. Document opens with the wrong page size (A4 instead of US Letter or vice versa)
The user expected a specific page size and you didn't set it.
- **Fix**: Always set `page_size` explicitly in the spec — `"a4"` or `"letter"` (the script defaults to `a4`).

### 7. Multi-column layout: text doesn't flow into the second column
The section has only one block, or the column count is wrong.
- **Fix**: Multi-column flow requires `sections[].columns >= 2` AND enough text content to fill the first column. Check `column_space_in` is reasonable (0.3–0.5 inches). For forced column breaks use a separate section with `columns: 1`.

### 8. `docx_convert.py docx2pdf` times out
LibreOffice cold-start is slow (~5–10s on the first call in a kernel session). On a complex document with many fields it can take 30–60s.
- **Fix**: Bump `--timeout 180`. Subsequent calls in the same kernel session reuse the profile and finish faster.

### 9. `accept-changes` left some changes in place
The XML-only processing accepts insertions, removes deletions, and drops format change records. Move operations are not handled and may leave artifacts.
- **Fix**: Pass `--strip-comments` for a cleaner result, or open in Word once and accept manually.

### 10. `Sandbox quirk` — `Unix socket` collision when running multiple LibreOffice calls
Two `soffice` processes share a default profile and one fails.
- **Fix**: All `docx_convert.py` and `docx_manipulate.py accept-changes` invocations isolate to a per-run `--user-profile`. NEVER call `soffice` directly — use the wrappers.

### 11. `File not found` after `docx_manipulate.py split`
Output filenames are zero-padded to 3 digits (`part_001.docx`, `part_002.docx`, ...). Always parse the script's stdout (a JSON `outputs` list) instead of guessing.

### 12. `low_contrast` flagged by QA on dark-mode tokens
You overrode `defaults.body_color` to a value too close to `defaults.background`.
- **Fix**: Pick a body color whose luma differs from the background by ≥ 0.25. Word documents are usually printed on white — keep the body dark.

### 13. Bullets show as literal `•` characters with no indentation
You manually wrote `"text": "• Item 1"` instead of using a `list` block.
- **Fix**: Use `{"type": "list", "style": "bullet", "items": ["Item 1", "Item 2"]}`.

---

## Library Selection Quick Reference

- **`docx_build.py`** with **blocks**: Default for any structured document (report, letter, manual, CV).
- **`docx_manipulate.py replace-text`**: Default for filling pre-existing `.docx`/`.dotx` templates.
- **`python-docx`** (via `code_execution`): Editing existing files paragraph-by-paragraph, custom run formatting, programmatic generation when blocks aren't enough.
- **`docx_qa.py`**: ALWAYS after any document write. Cheaper than rendering.
- **`docx_inspect.py`**: ALWAYS before any read of an existing `.docx`/`.dotx`.
- **`docx_convert.py docx2pdf`**: Final delivery when the user asked for a PDF, OR to refresh Word fields (TOC, page numbers) into resolved values.
- **`docx_convert.py docx2text`**: When the user asked to summarise, quote, or analyse a Word document's text.
- **`docx_convert.py doc2docx`**: ALWAYS first when a legacy `.doc` file is provided — `python-docx` cannot open `.doc` natively.

> **DO NOT** mix tools in one cell: e.g. don't open the same `.docx` with `python-docx` while `docx_qa.py` is running on it, or call `soffice` directly while `docx_convert.py` is converting another file. Use separate `bash` calls in the same round.
