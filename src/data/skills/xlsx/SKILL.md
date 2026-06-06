---
name: xlsx
description: Create or edit spreadsheets (.xlsx, .xlsm, .csv, .tsv) in /workspace/. Not for Word, PDF, or presentations.
---

# Spreadsheet Processing Guide

A guide for creating, editing, and analysing spreadsheets inside the build
sandbox. Files live in `/workspace/`; this skill's files are read-only under
`/skills/xlsx/`.

## Companion files

- `scripts/recalc.py` — recalculates every formula in an .xlsx via headless
  LibreOffice and reports any formula errors as JSON. Run it after writing
  formulas with openpyxl (see "Recalculating formulas"). Use it only when the
  workbook contains formulas.
- `scripts/soffice.py` — internal helper imported by `recalc.py` to launch
  LibreOffice; you never run it directly.

## Inspecting a spreadsheet

`read_file` does NOT render spreadsheets — only PDF, images, audio, video, and
plain-text files are supported. So:

- `.xlsx` / `.xlsm`: do NOT `read_file` them (it will fail). Inspect them by
  loading with `pandas` or `openpyxl` and printing what you need (`df.head()`,
  `df.info()`, cell values, sheet names).
- `.csv` / `.tsv`: these are plain text, so `read_file` works for a quick look —
  but to compute on or transform the data, load it with `pandas` so the values
  are exact (never retype numbers you eyeballed).

## Available tools

Python (pre-installed, no `pip` at runtime): `openpyxl` (formulas, formatting,
Excel-specific features), `pandas` (data analysis and bulk operations),
`Pillow`/`matplotlib` (charts you embed as images).

Formula recalculation: headless LibreOffice (`soffice`), driven by
`scripts/recalc.py`. No internet access in the sandbox.

## Output requirements

- Professional, consistent font unless the user asks otherwise (e.g. Calibri,
  Arial). Match an existing file's formatting and conventions exactly when
  editing it — never impose your own style on an established template.

## Round budget (typical workbook: 10–18 tool calls)

| Once | Avoid |
|------|--------|
| `pandas`/`openpyxl` inspect (head, sheet names, dtypes) | `read_file` on `.xlsx` (fails) |
| One `web_x_search` only if external facts are required | Multiple research calls for static data |
| `recalc.py` after writing formulas | Re-running recalc after every tiny edit |
| One export/QA pass | Rebuilding the whole workbook from scratch when a file was supplied |
- Zero formula errors in the delivered file (#REF!, #DIV/0!, #VALUE!, #N/A,
  #NAME?, #NULL!, #NUM!). Verify with `scripts/recalc.py`.
- Any user-facing text inside the sheet (labels, headers, notes) goes in the
  user's language, without emojis unless the user asked for them.

## Reading and analysing data

Use **pandas** for analysis and bulk operations:

```python
import pandas as pd

df = pd.read_excel("/workspace/file.xlsx")                       # first sheet
all_sheets = pd.read_excel("/workspace/file.xlsx", sheet_name=None)  # dict of all sheets

df.head()       # preview
df.info()       # column types
df.describe()   # statistics

df.to_excel("/workspace/output.xlsx", index=False)
```

CSV / TSV:
```python
df = pd.read_csv("/workspace/data.csv")
df = pd.read_csv("/workspace/data.tsv", sep="\t")
df.to_csv("/workspace/clean.csv", index=False)
```

## Use formulas, not hardcoded values

When a cell is a calculation, write the Excel formula — do NOT compute the
number in Python and paste the result. This keeps the spreadsheet live: it
recalculates when the source data changes.

```python
# WRONG — hardcodes the computed result
sheet["B10"] = df["Sales"].sum()          # e.g. writes 5000
sheet["C5"]  = (c4 - c2) / c2             # e.g. writes 0.15

# CORRECT — Excel computes it
sheet["B10"] = "=SUM(B2:B9)"
sheet["C5"]  = "=(C4-C2)/C2"
sheet["D20"] = "=AVERAGE(D2:D19)"
```

This applies to all totals, percentages, ratios, and differences. Place
assumptions (rates, factors, constants, etc.) in their own cells and reference
them (`=B5*(1+$B$6)`), instead of baking constants into formulas (`=B5*1.05`).

## Creating a new workbook (openpyxl)

```python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment

wb = Workbook()
sheet = wb.active

sheet["A1"] = "Hello"
sheet["B1"] = "World"
sheet.append(["Row", "of", "data"])

sheet["B2"] = "=SUM(A1:A10)"               # formula as a string

sheet["A1"].font = Font(bold=True, color="FF0000")
sheet["A1"].fill = PatternFill("solid", start_color="FFFF00")
sheet["A1"].alignment = Alignment(horizontal="center")
sheet.column_dimensions["A"].width = 20

wb.save("/workspace/output.xlsx")
```

## Editing an existing workbook (openpyxl)

`openpyxl` preserves existing formulas and formatting, so prefer it over pandas
when you must keep the file's structure.

```python
from openpyxl import load_workbook

wb = load_workbook("/workspace/existing.xlsx")
sheet = wb.active                          # or wb["SheetName"]

for sheet_name in wb.sheetnames:           # iterate sheets
    ws = wb[sheet_name]

sheet["A1"] = "New Value"
sheet.insert_rows(2)
sheet.delete_cols(3)

new_sheet = wb.create_sheet("Summary")
new_sheet["A1"] = "Data"

wb.save("/workspace/modified.xlsx")
```

## Charts

Two options:
- Native Excel chart with openpyxl (`openpyxl.chart`) — stays editable inside
  the spreadsheet.
- Or render a chart image with matplotlib and embed it with
  `openpyxl.drawing.image.Image` (a static picture, not editable).

Images you embed can come from: files GemiX staged in `/workspace/` (uploads,
generated images), PNGs you render with matplotlib, or images fetched from the
web with `web_x_search` (`search_images=true`), which land in `/workspace/`.
**Use images proactively** when they improve the result: a chart, a logo, a
photo, a diagram. If the task doesn't supply one but a relevant image would make
the spreadsheet clearer or more useful, fetch it or render it.

```python
from openpyxl import Workbook
from openpyxl.chart import BarChart, Reference

wb = Workbook()
ws = wb.active
ws.append(["Month", "Sales"])
for row in [["Jan", 100], ["Feb", 140], ["Mar", 90]]:
    ws.append(row)

chart = BarChart()
data = Reference(ws, min_col=2, min_row=1, max_row=4)
cats = Reference(ws, min_col=1, min_row=2, max_row=4)
chart.add_data(data, titles_from_data=True)
chart.set_categories(cats)
ws.add_chart(chart, "D2")

wb.save("/workspace/chart.xlsx")
```

To embed a matplotlib PNG instead:
```python
from openpyxl import Workbook
from openpyxl.drawing.image import Image

wb = Workbook()
ws = wb.active
# ... save your figure first: fig.savefig("/workspace/plot.png"); plt.close(fig)
ws.add_image(Image("/workspace/plot.png"), "D2")
wb.save("/workspace/with_image.xlsx")
```

## Recalculating formulas (mandatory when the file has formulas)

openpyxl writes formulas as text but does not compute them — the file has no
cached results until something recalculates it. After writing formulas, run:

```bash
python /skills/xlsx/scripts/recalc.py /workspace/output.xlsx
```

The script recalculates all formulas in all sheets via headless LibreOffice,
saves the file, scans every cell for Excel errors, and prints JSON:

```json
{
  "status": "success",
  "total_errors": 0,
  "total_formulas": 42,
  "error_summary": {}
}
```

If `status` is `errors_found`, `error_summary` lists each error type with its
cell locations. Fix the formulas and run `recalc.py` again until clean. An
optional second argument sets the timeout in seconds (default 30):

```bash
python /skills/xlsx/scripts/recalc.py /workspace/output.xlsx 60
```

## Verifying formulas

- Read calculated values back with `load_workbook("/workspace/file.xlsx",
  data_only=True)`. Warning: if you open with `data_only=True` and then save,
  the formulas are replaced by their values and lost — only use it for reading.
- openpyxl is 1-based (`row=1, column=1` is A1); a pandas DataFrame row 5 maps
  to Excel row 6 once a header row is present.
- Guard against `#DIV/0!` (check denominators) and `#REF!` (verify every
  reference points where you intend). Cross-sheet references use
  `SheetName!A1`.
- Test a couple of formulas on a small range before applying them across the
  whole sheet.

## Best practices

- pandas for analysis and bulk export; openpyxl for formulas, formatting, and
  Excel-specific features.
- Specify dtypes to avoid inference surprises:
  `pd.read_excel("/workspace/f.xlsx", dtype={"id": str})`.
- Large files: `pd.read_excel(..., usecols=[...])` to read only needed columns,
  or `load_workbook(..., read_only=True)` for streaming reads.
- Parse dates explicitly: `pd.read_excel(..., parse_dates=["date_column"])`.
- Inside the spreadsheet, add cell comments to document non-obvious formulas or
  the source of any hardcoded value.
