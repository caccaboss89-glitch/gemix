# Editing an Existing Presentation

Use this workflow when the user supplies a `.pptx` to change. Edit it **in
place** with `python-pptx`, preserving its design. Do NOT rebuild it from
scratch with pptxgenjs — gradients, embedded media, custom shapes, theme
colors, and layout relationships are lost when you start from an empty deck, so
the result always looks worse than editing the original.

## Golden rules

1. **Edit the file you were given.** Even if its original content is unrelated
   to the new topic (a quiz template for a portfolio review, a holiday card for
   a product launch), replace the text and keep every visual element:
   backgrounds, shapes, images, colors, fonts, positions, sizes. The visual
   style IS the template.
2. **Match the existing style.** Reuse the deck's colors, fonts, and layout
   patterns. Don't recolor or re-font to "suit" the new topic, and don't impose
   a new theme unless the user explicitly asks to restyle.
3. **Preserve font declarations.** Keep each run's existing typeface even if it
   isn't installed in the sandbox — it renders correctly on the recipient's
   machine. When adding text, copy the typeface from surrounding runs on the
   same slide. (Render QA may show a substitute font locally; that's expected.)
4. **Replace EVERY piece of template text**, not just the obvious titles —
   footers, captions, subtitles, text inside grouped shapes and tables. Inspect
   each slide and remove any leftover placeholder text.
5. **Match item counts.** If the template has 4 team cards but you have 3
   people, delete the entire 4th group (shapes + text), don't just blank its
   text.

## Inspect first

`read_file` cannot open a `.pptx`. Inspect structure with `python-pptx`:

```python
from pptx import Presentation
from pptx.util import Emu

prs = Presentation("/workspace/template.pptx")
print(f"{len(prs.slides)} slides, {Emu(prs.slide_width).inches:.2f}\" x {Emu(prs.slide_height).inches:.2f}\"")

for i, slide in enumerate(prs.slides):
    print(f"\n--- slide index {i} (layout: {slide.slide_layout.name}) ---")
    for shape in slide.shapes:
        kind = shape.shape_type
        pos = f'({Emu(shape.left).inches:.1f}",{Emu(shape.top).inches:.1f}") {Emu(shape.width).inches:.1f}x{Emu(shape.height).inches:.1f}"' if shape.left is not None else "(no pos)"
        if shape.has_text_frame and shape.text_frame.text.strip():
            print(f"  [{shape.shape_id}] {shape.name} {kind} {pos}: {shape.text_frame.text!r}")
        else:
            print(f"  [{shape.shape_id}] {shape.name} {kind} {pos}")
```

Also render a visual overview so you know what each slide looks like before you
edit (see SKILL.md "Visual QA"):

```bash
python /skills/pptx/scripts/render_slides.py /workspace/template.pptx
```

## Replace text while preserving formatting

Edit at the **run** level so the template's font, size, and color survive. If
you set `paragraph.text` or `shape.text_frame.text`, you wipe all runs and their
formatting — avoid that for styled text.

```python
def replace_in_runs(text_frame, old, new):
    """Replace text run-by-run, keeping each run's formatting."""
    for para in text_frame.paragraphs:
        for run in para.runs:
            if old in run.text:
                run.text = run.text.replace(old, new)

for slide in prs.slides:
    for shape in slide.shapes:
        if shape.has_text_frame:
            replace_in_runs(shape.text_frame, "Old Title", "New Title")
```

If your replacement spans multiple runs (template split "Chapter Title" across
runs), set the first run's text to the full replacement and clear the others:

```python
def set_paragraph_text(para, new_text):
    if not para.runs:
        return
    para.runs[0].text = new_text
    for run in para.runs[1:]:
        run.text = ""
```

To restyle a run you're adding, copy attributes from a neighbor instead of
inventing new ones:

```python
src = para.runs[0]
run = para.add_run()
run.text = "New label"
run.font.name = src.font.name
run.font.size = src.font.size
run.font.bold = src.font.bold
if src.font.color and src.font.color.type is not None:
    run.font.color.rgb = src.font.color.rgb
```

## Tables

```python
for shape in slide.shapes:
    if shape.has_table:
        tbl = shape.table
        tbl.cell(0, 0).text = "Header"          # plain text (loses run styling)
        # to keep styling, edit runs inside the cell's text_frame:
        replace_in_runs(tbl.cell(1, 2).text_frame, "OLD", "NEW")
```

## Images

Replace an existing picture's bytes while keeping its position/size, or add a
new one:

```python
from pptx.util import Inches

# Add a new picture (preserve aspect ratio: set width OR height, not both)
slide.shapes.add_picture("/workspace/photo.jpg", Inches(5.0), Inches(1.2), height=Inches(3.0))
```

To swap a picture in place, read its position, remove the old shape's XML
element, and add the new picture at the same coordinates:

```python
def swap_picture(slide, pic_shape, new_path):
    l, t, w, h = pic_shape.left, pic_shape.top, pic_shape.width, pic_shape.height
    pic_shape._element.getparent().remove(pic_shape._element)
    slide.shapes.add_picture(new_path, l, t, width=w, height=h)
```

Image sources: files GemiX staged in `/workspace/`, PNGs you render with
matplotlib, or images from `web_search` saved via `curl -L -o` (bash). Use images
proactively when they improve the slide.

## Add / remove / reorder slides

`python-pptx` has no high-level slide delete/reorder, so operate on the slide ID
list. Helpers:

```python
import copy
from pptx.oxml.ns import qn

def delete_slide(prs, index):
    """Remove the slide at the given 0-based index."""
    sldIdLst = prs.slides._sldIdLst
    sldId = list(sldIdLst)[index]
    rId = sldId.get(qn("r:id"))
    prs.part.drop_rel(rId)          # drop the relationship
    sldIdLst.remove(sldId)          # remove from the order

def move_slide(prs, old_index, new_index):
    sldIdLst = prs.slides._sldIdLst
    slides = list(sldIdLst)
    sldIdLst.remove(slides[old_index])
    sldIdLst.insert(new_index, slides[old_index])
```

Duplicating a slide is not natively supported and is fragile; prefer adding a
new slide from a layout the deck already uses:

```python
layout = prs.slides[0].slide_layout      # reuse an existing layout
slide = prs.slides.add_slide(layout)     # appended at the end
# then move_slide(prs, len(prs.slides)-1, target_index) if needed
```

## Text overflow

PPTX shapes have fixed positions and don't reflow like HTML, so longer
replacement text can overflow or overlap. Options, in order of preference:

1. Enable auto-shrink on the text frame:
   ```python
   from pptx.enum.text import MSO_AUTO_SIZE
   shape.text_frame.word_wrap = True
   shape.text_frame.auto_size = MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE
   ```
2. Grow or move the shape (`shape.height = Inches(3.5)`, `shape.top -= Inches(0.3)`).
3. Reduce the run font size (`run.font.size = Pt(16)`).
4. Shorten the text to respect the template's design.

## Save and QA

```python
prs.save("/workspace/output.pptx")
```

Then render and inspect (see SKILL.md "Visual QA"):

```bash
python /skills/pptx/scripts/render_slides.py /workspace/output.pptx
```

`read_file` with `path: ["/workspace/contact-sheet.jpg"]`, then scan each slide for leftover template
text, overflow, overlaps, and broken layouts. Fix, re-save, and re-render until
a full pass is clean.
