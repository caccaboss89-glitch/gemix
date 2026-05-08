---
name: xlsx
description: Spreadsheets (.xlsx, .xlsm, .csv, .tsv). Create, edit, clean, format, charts, dashboards, convert (csv↔xlsx, xlsx→pdf). NOT for Word/PDF/HTML.
---

# Spreadsheet Skill Guide

> [!IMPORTANT]
> **MANDATORY RULE**: Use ONLY the CLI flags explicitly documented for each script in this guide. **DO NOT invent flags**. If a flag is not listed here, it is NOT supported.

**Spreadsheets are NOT auto-parsed by the system** (unlike PDFs). To "see" the contents of an existing `.xlsx`, you MUST run `xlsx_inspect.py` first — `read_file` on a binary `.xlsx` will return garbage.

---

## Script Reference

| Script | Purpose | Use when |
| :--- | :--- | :--- |
| `xlsx_inspect.py` | Structured inspection (sheets, headers, formulas, errors) | ✅ **Always run first** on existing files |
| `xlsx_build.py` | JSON-driven workbook creation (data + formulas + styling + charts) | ✅ **Default for creating** new workbooks |
| `xlsx_recalc.py` | Headless LibreOffice recalc + error scan | ✅ **MANDATORY** after writing any formulas |
| `xlsx_qa.py` | Static QA validation (formula errors, empty cells, formatting issues) | ✅ **Optional QA check** before delivery |
| `xlsx_manipulate.py` | Merge / extract-sheet / split / info | Combining or breaking workbooks apart |
| `xlsx_convert.py` | csv↔xlsx, xlsx→pdf | Format conversion only |

### Execution Strategy

- **Reading existing file**: `xlsx_inspect.py` in `execution_phase: "before_all"` so the JSON sample lands before any subsequent edit logic. Then write your edits in Phase 3.
- **Creating new file**: `write_file` the JSON spec in Phase 2 + `xlsx_build.py` + `xlsx_recalc.py` in Phase 3 (same round, in this order — `xlsx_recalc.py` after `xlsx_build.py`).
- **Editing existing file**: Inspect (Phase 1) → edit script via `code_execution` (Phase 3) → `xlsx_recalc.py` (Phase 3, after the edit).
- **Conversion only**: Single `bash` call, no recalc needed unless formulas were touched.

**XLSX-Specific Rules**:
- **Binary format**: NEVER `read_file` an `.xlsx`/`.xlsm`. Use `xlsx_inspect.py`. Use `read_file` only on `.csv`/`.tsv`.
- **Formulas, not values**: When the user asks for totals/averages/growth, write Excel formulas (`=SUM(B2:B9)`), DO NOT compute the number in Python and hardcode it. The workbook must remain dynamic.
- **Always recalc**: `openpyxl` writes formulas as strings WITHOUT calculated values. Until you run `xlsx_recalc.py`, the cached values are empty and Excel/preview tools show blanks. Always recalc before delivering.
- **Readonly Recalc**: NEVER run `xlsx_recalc.py` on `/readonly/...` files. It saves in place, so `/readonly/history/...` and `/readonly/permanent/...` will fail. First copy the workbook to `/workspace/temp/` or `/workspace/output/`, then recalc the writable copy.
- **Absolute paths**: Strict enforcement of `/workspace/` or `/readonly/` prefixes. Output goes to `/workspace/output/`, intermediate JSON specs / inspections to `/workspace/temp/`.
- **NO code_execution on spec.json**: NEVER use `code_execution` to modify `spec.json`. Always rewrite the entire JSON using `write_file`. If you need to edit the spec, read it, modify in memory, then write the complete updated JSON with `write_file`.
- **NO code_execution for simple calculations**: Do NOT use `code_execution` for simple aggregations, growth rates, or basic math. Use Excel formulas in the spec. Only use `code_execution` for complex data processing, pandas operations, or custom formatting logic.
- **Consistent output filename**: When building a workbook, use a single consistent output filename (e.g., `/workspace/output/workbook.xlsx`). If you need to rebuild after QA, overwrite the same file — do NOT create new filenames. Only one `.xlsx` should be delivered to the user.
- **Read temp JSON via bash if needed**: If `read_file` cannot read a newly-created `/workspace/temp/*.json`, do NOT loop. Use a standalone `bash` call: `cat /workspace/temp/file.json`.
- **No `cat << EOF`**: Never build the JSON spec via bash heredoc; always `write_file`.
- **Scripts vs Tools**: All utilities are SCRIPTS, called via `bash`. DO NOT try to use them as tool names.
- **No Concatenation**: NEVER combine multiple xlsx scripts in a single `bash` command using `&&`/`;`. Emit them as separate tool calls.
- **Generated Filenames**: Scripts may sanitize sheet names. NEVER guess generated filenames after `split`; use the exact stdout paths from `xlsx_manipulate.py`, or run `ls /workspace/output/` before follow-up operations.
- **Pre-existing templates**: When EDITING a user-provided file, study its style with `xlsx_inspect.py` and EXACTLY match existing formatting. Existing template conventions ALWAYS override the defaults in this guide.

---

## Output Quality Requirements

Every workbook delivered to the user MUST satisfy:

- **Zero formula errors**: No `#REF!`, `#DIV/0!`, `#VALUE!`, `#N/A`, `#NAME?` cells. Verify via `xlsx_recalc.py` JSON output.
- **Professional font**: Default to Arial 11pt unless the user/template says otherwise.
- **Headers always bold** with a fill background; freeze the header row.
- **Number formats** appropriate to data: currency `$#,##0`, percentages `0.0%`, multiples `0.0x`, years as text `"2024"`.
- **Negative numbers in parentheses** for financial models: `$#,##0;($#,##0);-`.
- **Column widths auto-fitted** (≥10, ≤40 chars) — `xlsx_build.py` does this automatically when you set `"auto_width": true`.
- **Consistent styling**: Use semantic coloring for inputs/formulas/links, apply conditional formatting for data visualization.
- **Data validation**: Use dropdown lists for constrained inputs, range validation for numbers.

### Advanced Cell Styling

`xlsx_build.py` now supports rich per-cell styling via object cell specs:

```json
{"value": 1200000, "semantic": "input", "gradient": {"start_color": "FFFFFF", "end_color": "E2E8F0", "angle": 90}}
{"value": "Note", "comment": "This is a cell comment", "border": {"top": "medium", "color": "000000"}}
{"value": "=A2+B2", "italic": true, "underline": "single", "alignment": {"horizontal": "center", "vertical": "middle", "wrap_text": true}}
{"value": 42, "locked": false}  // unlocked cell when sheet is protected
```

**Supported cell properties:**
- `gradient`: `{"start_color": "RRGGBB", "end_color": "RRGGBB", "angle": 0-360}` for linear gradient fills (fallback to solid fill if gradient fails)
- `border`: `{"left": "thin|medium|thick", "right": "...", "top": "...", "bottom": "...", "diagonal": "..."}` or `{"left": {"style": "thin", "color": "RRGGBB"}, ...}` (note: `diagonal_direction` not supported)
- `comment`: String comment text (author: "GemiX AI")
- `italic`: Boolean
- `underline`: `"single"` | `"double"` | `"singleAccounting"` | `"doubleAccounting"`
- `alignment`: String (`"left"`, `"center"`, `"right"`) or object with `horizontal`, `vertical`, `wrap_text`, `shrink_to_fit`
- `locked`: Boolean (default: true) — cell protection status when sheet is protected

### Financial Model Color Coding (industry standard)

Apply these in `xlsx_build.py` via `"semantic": "..."` per cell, OR via `xlsx_format.py`-style logic in your own `code_execution`:

| Semantic | RGB | Use for |
| :--- | :--- | :--- |
| `input` | Blue `0000FF` | Hardcoded inputs the user will change for scenarios |
| `formula` | Black `000000` | All calculations |
| `link` | Green `008000` | Cross-sheet references in the same workbook |
| `external` | Red `FF0000` | Links to other files |
| `assumption` | Yellow fill `FFFF00` | Key assumptions needing attention |

`xlsx_build.py` recognises `"semantic"` on every cell spec and applies font color + (for `assumption`) fill automatically.

### Quality Recipes

**Recipe 1: Professional Dashboard with Conditional Formatting**
```json
{
  "sheets": [{
    "name": "Dashboard",
    "freeze": "A2",
    "auto_width": true,
    "columns": [
      {"col": "A", "width": 20},
      {"col": "B", "number_format": "$#,##0"},
      {"col": "C", "number_format": "0.0%"}
    ],
    "rows": [
      {"values": ["KPI", "Value", "YoY Growth"], "header": true},
      {"values": ["Revenue", {"value": 1500000, "semantic": "input"}, {"value": "=B2/B1-1", "number_format": "0.0%"}]},
      {"values": ["Expenses", {"value": 900000, "semantic": "input"}, {"value": "=B3/B2-1", "number_format": "0.0%"}]}
    ],
    "conditional_formatting": [
      {"type": "data_bar", "range": "B2:B10", "color": "0063B1"},
      {"type": "color_scale", "range": "C2:C10", "start_color": "FF0000", "end_color": "00FF00"},
      {"type": "cell_is", "range": "C2:C10", "operator": "lessThan", "formula": "0", "fill": "FFC7CE", "font_color": "9C0006"}
    ],
    "charts": [
      {"type": "column", "title": "Revenue vs Expenses", "data_range": "A1:B3", "categories_range": "A2:A3", "anchor": "E2"}
    ]
  }]
}
```

**Recipe 2: Input Form with Data Validation**
```json
{
  "sheets": [{
    "name": "Input Form",
    "freeze": "A2",
    "auto_width": true,
    "rows": [
      {"values": ["Field", "Value"], "header": true},
      {"values": ["Region", {"value": "North", "comment": "Select from dropdown"}]},
      {"values": ["Quarter", {"value": "Q1", "comment": "Q1, Q2, Q3, or Q4"}]},
      {"values": ["Target", {"value": 100000, "semantic": "input", "number_format": "$#,##0", "comment": "Must be positive"}]}
    ],
    "data_validation": [
      {"type": "list", "range": "B2:B2", "formula1": "North,South,East,West", "prompt": "Select a region", "prompt_title": "Region", "show_dropdown": true},
      {"type": "whole", "range": "B3:B3", "operator": "between", "formula1": "0", "formula2": "100"},
      {"type": "decimal", "range": "B4:B4", "operator": "between", "formula1": "0", "formula2": "1"},
      {"type": "textLength", "range": "B5:B5", "operator": "between", "formula1": "1", "formula2": "50"},
      {"type": "custom", "range": "B6:B6", "formula1": "=AND(ISNUMBER(B6),B6>0)"}
    ],
    "protection": {
      "sheet": true,
      "formatCells": false,
      "insertRows": false,
      "deleteRows": false
    }
  }]
}
```

**Recipe 3: Combo Chart with Secondary Axis**
```json
{
  "sheets": [{
    "name": "Analysis",
    "freeze": "A2",
    "auto_width": true,
    "rows": [
      {"values": ["Month", "Revenue ($)", "Growth (%)"], "header": true},
      {"values": ["Jan", 100000, 5.2]},
      {"values": ["Feb", 120000, 8.1]},
      {"values": ["Mar", 115000, -2.3]}
    ],
    "charts": [
      {
        "type": "combo",
        "primary_type": "column",
        "primary_data_range": "A1:B4",
        "secondary_data_range": "A1:C4",
        "categories_range": "A2:A4",
        "anchor": "E2",
        "title": "Revenue vs Growth"
      }
    ]
  }]
}
```

**Recipe 4: Print-Ready Report with Named Ranges**
```json
{
  "sheets": [{
    "name": "Report",
    "freeze": "A2",
    "auto_width": true,
    "rows": [
      {"values": ["Item", "Amount"], "header": true},
      {"values": ["Sales", {"value": "=SUM(SalesData)", "semantic": "formula"}]},
      {"values": ["Costs", {"value": "=SUM(CostsData)", "semantic": "formula"}]},
      {"values": ["Profit", {"value": "=B2-B3", "semantic": "formula", "bold": true}]}
    ],
    "named_ranges": [
      {"name": "SalesData", "range": "B10:B20"},
      {"name": "CostsData", "range": "C10:C20"}
    ],
    "print_settings": {
      "paperSize": 9,
      "orientation": "landscape",
      "fitToPage": true,
      "fitToWidth": 1,
      "fitToHeight": 0,
      "print_area": "A1:C4",
      "repeat_rows": "1:1"
    }
  }]
}
```

**Recipe 5: Gradient Headers with Advanced Styling**
```json
{
  "sheets": [{
    "name": "Styled",
    "freeze": "A2",
    "auto_width": true,
    "rows": [
      {
        "values": [
          {"value": "Title", "gradient": {"start_color": "4472C4", "end_color": "1F4E78", "angle": 90}, "font_color": "FFFFFF", "bold": true, "alignment": "center"},
          {"value": "Value", "gradient": {"start_color": "4472C4", "end_color": "1F4E78", "angle": 90}, "font_color": "FFFFFF", "bold": true, "alignment": "center"}
        ],
        "header": true
      },
      {
        "values": [
          {"value": "Metric", "border": {"top": "thin", "bottom": "thin", "left": "thin", "right": "thin"}},
          {"value": 42, "border": {"top": "thin", "bottom": "thin", "left": "thin", "right": "thin"}}
        ]
      }
    ]
  }]
}
```

---

## `xlsx_inspect.py` — Read an Existing Workbook

> Run this BEFORE editing or analysing any pre-existing `.xlsx`. Output is a single JSON document with sheet inventory, headers, formula count, error count, and a sample of rows.

```bash
# Phase 1 (before_all) — so the AI can read the JSON in the same round
python /readonly/skills/xlsx/scripts/xlsx_inspect.py \
  --input /readonly/history/<file>.xlsx \
  --rows-sample 10 \
  --output /workspace/temp/inspection.json
# Optional flags: --sheets "Sheet1,Sheet2" (subset), --rows-sample N (default: 5),
#                 --no-data-only (read formulas as strings instead of cached values)
```

**Inspection JSON schema:**
```json
{
  "file": "/readonly/history/budget.xlsx",
  "sheets": [
    {
      "name": "Sales",
      "max_row": 120,
      "max_col": 8,
      "headers": ["Region", "Q1", "Q2", "Q3", "Q4", "Total"],
      "formula_count": 24,
      "merged_cells": ["A1:F1"],
      "errors": {"#DIV/0!": ["F45"]},
      "sample_rows": [
        {"row": 2, "values": ["North", 1200, 1450, 1380, 1500, 5530]}
      ]
    }
  ]
}
```

> **Note**: `xlsx_inspect.py` opens with `data_only=True` by default → numeric cells show CACHED values. If the file was last saved by a tool that did not cache values (including any of these scripts before `xlsx_recalc.py`), formula cells will appear as `null`. Re-run `xlsx_recalc.py` if you need them.

---

## `xlsx_build.py` — Create a Workbook from a JSON Spec

The default tool for new workbooks. Pair `write_file` (Phase 2) with two Phase 3 `bash` calls (`xlsx_build.py` then `xlsx_recalc.py`).

```bash
# Phase 3 (after_all) — pair with write_file in Phase 2 for spec.json
python /readonly/skills/xlsx/scripts/xlsx_build.py \
  --spec /workspace/temp/spec.json \
  --output /workspace/output/report.xlsx
# Optional flags: --font-name "Arial" (default), --font-size 11 (default)
```

**`spec.json` skeleton:**
```json
{
  "sheets": [
    {
      "name": "Summary",
      "freeze": "A2",
      "auto_width": true,
      "columns": [
        {"col": "A", "width": 22},
        {"col": "B", "number_format": "$#,##0;($#,##0);-"},
        {"col": "C", "number_format": "0.0%"}
      ],
      "rows": [
        {"values": ["Metric", "Value"], "header": true},
        {"values": [
          "Revenue",
          {"value": 1200000, "semantic": "input"}
        ]},
        {"values": [
          "Margin",
          {"value": "=B2*0.2", "semantic": "formula"}
        ]}
      ],
      "merges": ["A1:B1"],
      "conditional_formatting": [
        {"type": "data_bar", "range": "B2:B10", "color": "0063B1"}
      ],
      "data_validation": [
        {"type": "list", "range": "A2:A10", "formula1": '"Option1,Option2,Option3"'}
      ],
      "named_ranges": [
        {"name": "RevenueRange", "range": "B2:B10"}
      ],
      "charts": [
        {"type": "bar", "title": "Revenue", "data_range": "A1:B5",
         "categories_range": "A2:A5", "anchor": "D2"}
      ],
      "protection": {
        "sheet": true,
        "password": "secret",
        "formatCells": false
      },
      "print_settings": {
        "fitToPage": true,
        "orientation": "landscape",
        "print_area": "A1:F20"
      }
    }
  ],
  "properties": {"title": "Q4 Report", "creator": "GemiX AI"}
}
```

**Cell value forms accepted in `rows[].values[]`:**
- Plain scalar: `"text"`, `42`, `3.14`, `true` — written as-is, default formula style.
- Formula string: any value starting with `=` is treated as a formula.
- Object: `{"value": <scalar-or-formula>, "semantic": "input|formula|link|external|assumption", "number_format": "0.00", "bold": true, "fill": "FFFFCC"}`. All keys except `value` are optional.

**Chart types supported:** `bar`, `column`, `line`, `pie`, `scatter`, `area`, `combo`. `data_range` and `categories_range` use A1 notation referencing the same sheet.

**Advanced chart options:**
- `secondary_axis`: Boolean - limited support; currently hides primary gridlines but does not create a true second scale
- `trendline`: Boolean - adds linear trendlines to supported chart series (`trendline_type` can override the type)
- `combo` charts (simplified): openpyxl has limited combo chart support. The current implementation uses the primary chart type and adds secondary data as additional series to the same chart. Requires:
  - `primary_type`: "column", "bar", "line", "area"
  - `primary_data_range`: A1 range for primary series
  - `secondary_data_range`: A1 range for secondary series

> The script applies the configured font globally, marks header rows bold with a light-grey fill, freezes panes, auto-fits column widths when requested, and applies semantic colors. Errors in the spec (missing keys, unknown chart type, malformed range) print to stderr and exit non-zero.

---

## `xlsx_recalc.py` — MANDATORY After Writing Formulas

`openpyxl` does NOT evaluate formulas. Until this script runs, every formula cell has `null` cached value and Excel will show blanks until manually opened. This script invokes LibreOffice headless to recompute, saves the file in place, and scans for errors.

```bash
# Phase 3 (after_all) — emitted AFTER xlsx_build.py / your edit code
python /readonly/skills/xlsx/scripts/xlsx_recalc.py \
  --input /workspace/output/report.xlsx \
  --output /workspace/temp/recalc.json
# Optional flags: --timeout 90 (default seconds), --output <json-path> (default: stdout)
```

**Result JSON:**
```json
{
  "status": "success",
  "total_formulas": 42,
  "total_errors": 0,
  "error_summary": {}
}
```

If `status == "errors_found"`, `error_summary` is keyed by error type with a list of locations:
```json
{"#DIV/0!": {"count": 1, "locations": ["Summary!C5"]}}
```

> **Sandbox quirk**: LibreOffice profiles get isolated in a per-run `--user-profile` to avoid `Unix socket` collisions. NEVER call `soffice` directly — the wrapper handles `-env:UserInstallation`.
> **Readonly rule**: `--input` MUST be under `/workspace/`, never `/readonly/`, because recalculation overwrites the workbook in place.

---

## `xlsx_qa.py` — Static QA Validation

Optional QA check to validate workbook quality before delivery. Checks for formula errors, empty cells, missing headers, inconsistent formats, and more.

```bash
# Phase 3 (after xlsx_recalc.py) — optional QA check
python /readonly/skills/xlsx/scripts/xlsx_qa.py \
  --input /workspace/output/report.xlsx \
  --output /workspace/temp/qa.json
# Optional: --config /workspace/temp/qa_config.json for sheet-specific checks
```

**QA config JSON (optional):**
```json
{
  "sheets": {
    "Dashboard": {
      "data_range": "A2:B20",
      "header_row": 1,
      "input_columns": ["B"],
      "numeric_columns": ["B", "C"]
    }
  }
}
```

**QA report JSON schema:**
```json
{
  "file": "/workspace/output/report.xlsx",
  "status": "passed",
  "total_issues": 0,
  "total_warnings": 2,
  "sheets": [
    {
      "sheet": "Dashboard",
      "issues": [],
      "warnings": [
        {
          "type": "no_freeze_panes",
          "severity": "info",
          "message": "Sheet has 25 rows but no freeze panes set"
        }
      ],
      "stats": {
        "max_row": 25,
        "max_col": 5,
        "has_freeze_panes": false,
        "has_print_settings": false
      }
    }
  ]
}
```

**QA check types:**
- `formula_error`: Critical - cells with #REF!, #DIV/0!, #VALUE!, #N/A, #NAME?
- `empty_cells`: Warning - empty cells in specified data range
- `missing_header`: Info - no header found in expected row
- `no_freeze_panes`: Info - sheet has >10 rows but no freeze panes
- `no_print_settings`: Info - sheet has >20 rows but no fit-to-page
- `no_data_validation`: Info - input column lacks data validation
- `inconsistent_formats`: Warning - column has multiple number formats

**QA Iteration Rules:**
- Run `xlsx_qa.py` after `xlsx_recalc.py` if you want to validate quality before delivery
- Only iterate on CRITICAL issues (formula errors) - warnings and info are optional improvements
- Use consistent output filename when rebuilding after QA - overwrite the same file
- QA is optional for simple workbooks but recommended for complex financial models or dashboards

---

## `xlsx_manipulate.py` — Combine / Split / Info

```bash
# Merge: take the FIRST sheet of each input and stack them as separate sheets
python /readonly/skills/xlsx/scripts/xlsx_manipulate.py merge \
  --inputs /workspace/temp/jan.xlsx /workspace/temp/feb.xlsx \
  --output /workspace/output/quarterly.xlsx
# Optional: --sheet-names "January,February" (default: input filenames)

# Extract one sheet to a new workbook
python /readonly/skills/xlsx/scripts/xlsx_manipulate.py extract-sheet \
  --input /workspace/output/full.xlsx --sheet "Sales" \
  --output /workspace/output/sales_only.xlsx
# IMPORTANT: --sheet expects the SHEET NAME (string), not an index. Use the exact name from inspection.

# Split: every sheet becomes its own workbook
python /readonly/skills/xlsx/scripts/xlsx_manipulate.py split \
  --input /workspace/output/full.xlsx \
  --output-prefix /workspace/temp/part
# Output: JSON with "outputs" list containing generated file paths

# Info: workbook metadata + sheet inventory (lighter than xlsx_inspect.py)
python /readonly/skills/xlsx/scripts/xlsx_manipulate.py info \
  --input /workspace/output/full.xlsx
```

> All operations preserve formulas (not values). If the user expects to open the file and see numbers, run `xlsx_recalc.py` on the output afterwards.

---

## `xlsx_convert.py` — Format Conversion

```bash
# CSV → XLSX
python /readonly/skills/xlsx/scripts/xlsx_convert.py csv2xlsx \
  --input /readonly/history/data.csv \
  --output /workspace/output/data.xlsx
# Optional: --delimiter "," (default: auto-detect , ; tab |), --sheet-name "Data",
#           --no-header (treat first row as data, not headers)

# XLSX → CSV (one sheet, or all sheets to a directory)
python /readonly/skills/xlsx/scripts/xlsx_convert.py xlsx2csv \
  --input /workspace/output/full.xlsx --sheet "Sales" \
  --output /workspace/output/sales.csv
# To export every sheet:
python /readonly/skills/xlsx/scripts/xlsx_convert.py xlsx2csv \
  --input /workspace/output/full.xlsx --all \
  --output-dir /workspace/output/csv/
# Optional: --delimiter ",", --data-only (export cached values; default true)

# XLSX → PDF (LibreOffice headless, one PDF per workbook)
python /readonly/skills/xlsx/scripts/xlsx_convert.py xlsx2pdf \
  --input /workspace/output/report.xlsx \
  --output /workspace/output/report.pdf
# Optional: --timeout 90 (seconds)
```

---

## Math / Data Cheat Sheet (formulas vs Python)

The AI often computes values in Python and hardcodes them — this destroys the workbook's dynamic nature. Use this table as a strict guide.

| Goal | ❌ WRONG (hardcoded) | ✅ RIGHT (formula) |
| :--- | :--- | :--- |
| Sum a column | `sheet['B10'] = df['Sales'].sum()` | `sheet['B10'] = '=SUM(B2:B9)'` |
| Average | `sheet['D20'] = sum(v)/len(v)` | `sheet['D20'] = '=AVERAGE(D2:D19)'` |
| Growth rate | `sheet['C5'] = (a-b)/b` | `sheet['C5'] = '=(C4-C2)/C2'` |
| Cross-sheet | `sheet['A1'] = other['B10'].value` | `sheet['A1'] = '=Detail!B10'` |
| Conditional | `sheet['E2'] = a if x else b` | `sheet['E2'] = '=IF(D2>0, A2, B2)'` |
| Lookup | manual dict | `=VLOOKUP(A2, Lookup!A:B, 2, FALSE)` |

Hardcode ONLY raw inputs (the numbers that drive the model). Color them blue (`semantic: "input"`).

---

## Troubleshooting & Common Fails

### 1. "Workbook opens with empty cells"
Formulas were written but never recalculated.
- **Fix**: Run `xlsx_recalc.py` and confirm `status: success`.

### 2. `#REF!` after extracting/splitting sheets
Cross-sheet references break when their target sheet is removed.
- **Fix**: Either include the referenced sheet in the extract, or accept/report that the standalone split sheet has broken cross-sheet links. If the user asked for clean standalone files, copy `/readonly/...` to `/workspace/temp/`, run `xlsx_recalc.py` on the copy, then create a values-only workbook from `load_workbook(copy, data_only=True)` instead of preserving formulas.

### 3. `Read-only file system` in `xlsx_recalc.py`
You tried to recalculate a file in `/readonly/...`.
- **Fix**: Copy it first with a standalone `bash` call such as `cp /readonly/history/file.xlsx /workspace/temp/file.xlsx`, then run `xlsx_recalc.py --input /workspace/temp/file.xlsx`.

### 4. `#NAME?` after building the file
Function name typo or locale issue (LibreOffice expects English names internally — they ARE English even in Italian Excel).
- **Fix**: Verify spelling. Common offenders: `MEDIA` (use `AVERAGE`), `CERCA.VERT` (use `VLOOKUP`), `SE` (use `IF`).

### 5. `#DIV/0!`
Division denominators must be guarded.
- **Fix**: Wrap with `IFERROR` or `IF`: `=IFERROR(A2/B2, 0)` or `=IF(B2=0, 0, A2/B2)`.

### 6. "Formula stored as text" (Excel shows the literal `=SUM(...)`)
The cell's `data_type` was forced to text or the value lacked the leading `=`.
- **Fix**: Always pass formulas as strings starting with `=`. DO NOT pre-format the cell as text (`@`) before writing a formula.

### 7. Date columns show as integers
openpyxl returns datetimes for true date cells, but CSV imports often produce strings.
- **Fix**: When building, set `"number_format": "yyyy-mm-dd"` on the column, and pass real `datetime.date(...)` objects (or ISO strings → `xlsx_build.py` parses them automatically when the column number_format is a date format).

### 8. Wrong column letter (e.g. column 64 = BL, not BK)
Off-by-one in manual A1 generation.
- **Fix**: Use `openpyxl.utils.get_column_letter(idx)` — never compute letters by hand.

---

## Editing an Existing File (Common Pattern)

```bash
# Phase 1 — inspect
python /readonly/skills/xlsx/scripts/xlsx_inspect.py \
  --input /readonly/history/budget.xlsx --rows-sample 8 \
  --output /workspace/temp/inspection.json
```
```python
# Phase 3 — code_execution: open, edit, save
from openpyxl import load_workbook
wb = load_workbook("/readonly/history/budget.xlsx")
ws = wb["P&L"]
ws["G1"] = "Q4 Forecast"
for row in range(2, ws.max_row + 1):
    ws.cell(row=row, column=7, value=f"=F{row}*(1+$B$25)")
wb.save("/workspace/output/budget_v2.xlsx")
```
```bash
# Phase 3 — recalc (emitted after the code_execution above, same round)
python /readonly/skills/xlsx/scripts/xlsx_recalc.py \
  --input /workspace/output/budget_v2.xlsx \
  --output /workspace/temp/recalc.json
```

> **Reminder**: `xlsx_inspect.py` runs BEFORE in Phase 1; `code_execution` and the `xlsx_recalc.py` call both run in Phase 3, with `code_execution` emitted FIRST so the file exists when recalc opens it.

---

## Reading & Analysing Data (pandas)

For pure analysis (no styling/formula output), `pandas` is faster than `openpyxl`:

```python
import pandas as pd
df = pd.read_excel("/readonly/history/sales.xlsx", sheet_name=None)  # dict of DataFrames
print({k: v.shape for k, v in df.items()})
print(df["Sales"].describe())
```

If the deliverable is a quick CSV / printed summary (no formatting required), pandas + `to_excel(index=False)` is enough — no recalc needed because there are no formulas. As soon as you need formulas, formatting, charts, or color coding, switch to `xlsx_build.py` or hand-written `openpyxl`.

---

## Library Selection Quick Reference

- **`xlsx_build.py`**: Default for creating workbooks (data + formulas + styling + charts).
- **`openpyxl`** (via `code_execution`): Editing existing files cell-by-cell, custom formatting, conditional formatting, data validation.
- **`pandas`**: Reading for analysis, bulk numeric operations, CSV import/export without styling.
- **`xlsx_recalc.py`**: ALWAYS after any formula write.
- **`xlsx_inspect.py`**: ALWAYS before any read of an existing `.xlsx`.

> **DO NOT** mix tools in one cell: e.g. don't `pd.read_excel(..., engine="openpyxl")` and then immediately try to access `.formula` on the result — pandas drops formulas on import.
