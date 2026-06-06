# Filling PDF Forms

Use this workflow to fill a PDF form the user supplied in `/workspace/` — for
example an application, registration, questionnaire, or any document with blanks
to complete. The values to enter come from the task (the user's data); the blank
form is whatever the user provided. No forms ship with this skill.

CRITICAL: complete these steps in order. Do not skip ahead to writing code.

The helper scripts live in `/skills/pdf/scripts/` (read-only). Run them with
`python /skills/pdf/scripts/<name>.py`, reading from and writing to absolute
paths under `/workspace/`. They are:

- `check_fillable_fields.py` — does the PDF have real (fillable) form fields?
- `extract_form_field_info.py` — list a fillable form's field IDs/types/pages.
- `fill_fillable_fields.py` — fill a fillable form from a values JSON.
- `extract_form_structure.py` — for flat PDFs: extract label/line/checkbox
  coordinates so you can place text by position.
- `check_bounding_boxes.py` — validate your coordinate JSON before filling.
- `fill_pdf_form_with_annotations.py` — fill a flat PDF by drawing text at the
  coordinates you defined.
- `convert_pdf_to_images.py` — render every page to PNG (for verification or
  visual estimation).
- `create_validation_image.py` — draw your bounding boxes onto a page image to
  eyeball them before filling.

First, check whether the PDF has fillable form fields:

```bash
python /skills/pdf/scripts/check_fillable_fields.py /workspace/form.pdf
```

Depending on the result, follow either "Fillable fields" or "Non-fillable
fields" below.

# Fillable fields

If the PDF has fillable form fields:

## Step 1: Extract field info
```bash
python /skills/pdf/scripts/extract_form_field_info.py /workspace/form.pdf /workspace/field_info.json
```

This writes a JSON list of every field. Each field has:
- `field_id` — the exact ID you must use when filling
- `label` — a human-readable description of the field (e.g. "First name",
  "Date of birth", "Email address"). Use it to decide which value goes where.
- `type` — "text", "checkbox", "radio_group", or "choice"
- `page` — page number (1-based)

Example extract output:
```json
[
  {"field_id": "f1_14[0]", "label": "First name", "type": "text", "page": 1},
  {"field_id": "f1_15[0]", "label": "Last name", "type": "text", "page": 1},
  {"field_id": "c2_1[0]",  "label": "Subscribe to newsletter", "type": "checkbox", "checked_value": "/1", "unchecked_value": "/Off", "page": 2}
]
```

## Step 2: Create the values JSON
Create `/workspace/field_values.json` using the SAME `field_id` and `page` from
the extract output. Add a `"value"` key to each field you want to fill:
```json
[
  {"field_id": "f1_14[0]", "page": 1, "value": "Andrew"},
  {"field_id": "f1_15[0]", "page": 1, "value": "Patterson"},
  {"field_id": "c2_1[0]",  "page": 2, "value": "/Off"}
]
```
For checkboxes, use `checked_value` to check or `unchecked_value` to leave
unchecked. For radio groups, use one of the values from `radio_options`.

## Step 3: Fill the form
```bash
python /skills/pdf/scripts/fill_fillable_fields.py /workspace/form.pdf /workspace/field_values.json /workspace/output.pdf
```
This validates all field IDs and values before filling. If it prints errors,
fix `field_values.json` and retry.

## Step 4: Verify visually
```bash
python /skills/pdf/scripts/convert_pdf_to_images.py /workspace/output.pdf /workspace/verify/
```
Then `read_file` the images in `/workspace/verify/` to confirm each value
appears in the correct field.

# Non-fillable fields

If the PDF has no fillable fields, you add text annotations by coordinate.
First try to extract coordinates from the PDF structure (more accurate), then
fall back to visual estimation if needed.

## Step 1: Try structure extraction first
```bash
python /skills/pdf/scripts/extract_form_structure.py /workspace/form.pdf /workspace/form_structure.json
```

This writes a JSON file containing:
- labels: every text element with exact coordinates (x0, top, x1, bottom in PDF points)
- lines: horizontal lines that define row boundaries
- checkboxes: small square rectangles (with center coordinates)
- row_boundaries: row top/bottom positions computed from horizontal lines

Check the result: if `form_structure.json` has meaningful labels, use
Approach A (Structure-Based Coordinates). If the PDF is scanned/image-based and
has few or no labels, use Approach B (Visual Estimation).

---

## Approach A: Structure-Based Coordinates (preferred)

Use this when `extract_form_structure.py` found text labels.

### A.1: Analyze the structure
Read `form_structure.json` and identify:
1. Label groups — adjacent text elements forming one label (e.g. "Last"+"Name")
2. Row structure — labels with similar `top` are in the same row
3. Field columns — entry areas start after the label ends (x0 = label.x1 + gap)
4. Checkboxes — use the checkbox coordinates directly from the structure

Coordinate system: PDF coordinates where y=0 is at the TOP of the page and y
increases downward.

### A.2: Check for missing elements
Structure extraction may miss circular checkboxes, decorative graphics, or
faint elements. If you see form fields in the rendered images that are not in
`form_structure.json`, use visual analysis for those specific fields (see the
Hybrid Approach below).

### A.3: Create fields.json with PDF coordinates
For each field, compute entry coordinates from the structure:

Text fields:
- entry x0 = label x1 + 5 (small gap after label)
- entry x1 = next label's x0, or row boundary
- entry top = same as label top
- entry bottom = row boundary line below, or label bottom + row height

Checkboxes:
- entry_bounding_box = [checkbox.x0, checkbox.top, checkbox.x1, checkbox.bottom]

Create `/workspace/fields.json` using `pdf_width`/`pdf_height` (this signals PDF
coordinates):
```json
{
  "pages": [
    {"page_number": 1, "pdf_width": 612, "pdf_height": 792}
  ],
  "form_fields": [
    {
      "page_number": 1,
      "description": "Last name entry field",
      "field_label": "Last Name",
      "label_bounding_box": [43, 63, 87, 73],
      "entry_bounding_box": [92, 63, 260, 79],
      "entry_text": {"text": "Smith", "font_size": 10}
    },
    {
      "page_number": 1,
      "description": "US Citizen Yes checkbox",
      "field_label": "Yes",
      "label_bounding_box": [260, 200, 280, 210],
      "entry_bounding_box": [285, 197, 292, 205],
      "entry_text": {"text": "X"}
    }
  ]
}
```

### A.4: Validate bounding boxes
```bash
python /skills/pdf/scripts/check_bounding_boxes.py /workspace/fields.json
```
This checks for intersecting bounding boxes and entry boxes too small for the
font size. Fix any reported errors before filling.

---

## Approach B: Visual Estimation (fallback)

Use this when the PDF is scanned/image-based and structure extraction found no
usable text labels (e.g. text shows as "(cid:X)" patterns).

### B.1: Convert PDF to images
```bash
python /skills/pdf/scripts/convert_pdf_to_images.py /workspace/form.pdf /workspace/images/
```
Then `read_file` each page image to see it.

### B.2: Initial field identification
From each page image, get rough estimates of field locations: labels, entry
areas (lines/boxes/blank spaces), and checkboxes. Note approximate pixel
coordinates — they do not need to be precise yet.

### B.3: Zoom refinement (critical for accuracy)
For each field, crop a region around the estimated position to refine the
coordinates. ImageMagick is not available here — use Pillow:

```python
from PIL import Image

img = Image.open("/workspace/images/page_1.png")
# box = (left, upper, right, lower) in pixels: your rough estimate minus padding
crop = img.crop((50, 120, 350, 200))
crop.save("/workspace/crops/name_field.png")
```

`read_file` the cropped image and determine precise coordinates:
1. The exact pixel where the entry area begins (after the label)
2. Where the entry area ends (before the next field or edge)
3. The top and bottom of the entry line/box

Convert crop coordinates back to full-image coordinates:
- full_x = crop_x + crop_offset_x   (crop_offset_x = the crop box's left)
- full_y = crop_y + crop_offset_y   (crop_offset_y = the crop box's upper)

Example: crop started at (50, 120) and the entry box starts at (52, 18) within
the crop → entry_x0 = 52 + 50 = 102, entry_top = 18 + 120 = 138.

Repeat for each field, grouping nearby fields into a single crop when possible.

### B.4: Create fields.json with refined coordinates
Use `image_width`/`image_height` (this signals image coordinates):
```json
{
  "pages": [
    {"page_number": 1, "image_width": 1700, "image_height": 2200}
  ],
  "form_fields": [
    {
      "page_number": 1,
      "description": "Last name entry field",
      "field_label": "Last Name",
      "label_bounding_box": [120, 175, 242, 198],
      "entry_bounding_box": [255, 175, 720, 218],
      "entry_text": {"text": "Smith", "font_size": 10}
    }
  ]
}
```

Optional: render your boxes onto a page image to eyeball them before filling:
```bash
python /skills/pdf/scripts/create_validation_image.py 1 /workspace/fields.json /workspace/images/page_1.png /workspace/validation_page_1.png
# then: read_file /workspace/validation_page_1.png
```

### B.5: Validate bounding boxes
```bash
python /skills/pdf/scripts/check_bounding_boxes.py /workspace/fields.json
```

---

## Hybrid Approach: Structure + Visual

Use when structure extraction works for most fields but misses some (circular
checkboxes, unusual controls).

1. Use Approach A for fields detected in `form_structure.json`.
2. Convert the PDF to images for visual analysis of the missing fields.
3. Use zoom refinement (Approach B) for those fields.
4. Combine coordinates into one system. For structure fields, use
   `pdf_width`/`pdf_height`. For visually-estimated fields, convert image →
   PDF coordinates:
   - pdf_x = image_x * (pdf_width / image_width)
   - pdf_y = image_y * (pdf_height / image_height)
5. Use a single coordinate system in `fields.json` — convert everything to PDF
   coordinates with `pdf_width`/`pdf_height`.

---

## Fill the form (non-fillable)

The fill script auto-detects the coordinate system and handles conversion:
```bash
python /skills/pdf/scripts/fill_pdf_form_with_annotations.py /workspace/form.pdf /workspace/fields.json /workspace/output.pdf
```

## Verify output

```bash
python /skills/pdf/scripts/convert_pdf_to_images.py /workspace/output.pdf /workspace/verify/
```
`read_file` the images and check text placement. If text is mispositioned:
- Approach A: confirm you used PDF coordinates with `pdf_width`/`pdf_height`.
- Approach B: confirm image dimensions match and the pixel coordinates are right.
- Hybrid: confirm the image→PDF coordinate conversions are correct.
