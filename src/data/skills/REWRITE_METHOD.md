# Skill Rewrite Method

This document describes the convention for rewriting GemiX skills (`src/data/skills/<name>/`) starting from the corresponding xAI reference skill. Apply it to each skill (PDF done; DOCX, XLSX, PPTX pending) in turn, one PR at a time.

The goal of the rewrite is to drop legacy template-driven complexity (rigid JSON specs, fixed `.tex` templates, dozens of helper scripts) in favour of a **knowledge-base** style: the skill explains the right tools and gives copy-paste snippets, then leaves the AI free to compose the document the user actually asked for. This is possible because we no longer optimise for tool-rounds — Hermes proxy + SuperGrok subscription means each round is "free".

---

## Inputs you will receive

For each new skill you start working on, the user will provide:

1. The full xAI reference skill — typically in `src/data/NUOVE SKILL TEST/<name>/` and containing
   - `SKILL.md` (frontmatter + main guide),
   - sometimes `reference.md` / `forms.md` / other auxiliary `.md`,
   - a `scripts/` folder with Python/Bash helpers,
   - sometimes asset files (templates, samples).
2. The current GemiX skill at `src/data/skills/<name>/` to be rewritten / replaced.

You may inspect both. The xAI version is the **conceptual reference**; the GemiX rewrite must not be a 1:1 copy because the runtime and conventions differ (see "Adapting to GemiX" below).

---

## Output structure

The rewritten skill MUST live at `src/data/skills/<name>/` and contain:

```
src/data/skills/<name>/
├── SKILL.md         (entry-point, read by the AI on first match)
└── reference.md     (advanced patterns, troubleshooting, edge cases)
```

No `assets/`, no `scripts/`, no `templates/`. If you find yourself wanting to ship a Python helper, ask first: 99% of the time the AI can write equivalent code inline via `write_file`+`bash`, and the helper just adds a CLI surface to learn.

If a skill genuinely needs additional `.md` files (e.g. a heavy domain-specific subtopic), name them with lower-case `<topic>.md`, link them from `SKILL.md`'s "See Also" section, and keep the same frontmatter-free format used by `reference.md`.

---

## `SKILL.md` template

```markdown
---
name: <skill-name>                    # MUST match the folder name
description: <short, single-line>     # 1-2 sentences. The AI sees this in the
                                      # <Skills> block of the agentic briefing
                                      # and uses it to decide whether to call
                                      # read_file on the skill. Be explicit
                                      # about when NOT to use the skill if there
                                      # is an auto-handled equivalent (e.g.
                                      # "Skip this skill for plain reading of
                                      # unencrypted PDFs — auto-transcribed").
---

# <Skill> Skill Guide

> [!IMPORTANT]
> One-liner that anchors the skill's philosophy. For PDFs we wrote:
> "This skill is intentionally template-free. Pick the right engine for
> the request — no fixed templates, no rigid JSON specs."

## Don't Use This Skill For …                # only if applicable
…explanation of cases where the AI must NOT call this skill (e.g. PDF reading is auto-handled by the GemiX parser).

## When You Need The Original File           # only if applicable
…explanation of how user-provided files of this type appear in the runtime
(special folder layouts, where to copy them, how the parser materialises them).

## Paths & Layout
- Read-only inputs: `/readonly/history/`, `/readonly/searched_images/`, `/readonly/skills/<name>/`.
- Writable working dirs: `/workspace/code/`, `/workspace/temp/`, `/workspace/output/`.
- Never write outside `/workspace/{code|temp|output}/`. Never write back into `/readonly/`.

## Decision Matrix — Which Tool
| User request | Use | Why |
| :--- | :--- | :--- |
| Simple case A | tool/library X | reason |
| Complex case B | tool/library Y | reason |
| Manipulation only | tool Z | reason |
| Reading user-supplied <type> | …auto, OR specific tool | … |
…
**Rule of thumb**: <one-line heuristic so the AI doesn't have to re-read the table for trivial cases>.

## Available Toolchain (sandbox)
…see "Dependency truth-table" rules below…

## <Engine 1> — Cookbook
- Minimal example
- Common patterns (multi-page, tables, images, math, …)
- Engine-specific gotchas

## <Engine 2> — Pipeline
…same structure, repeated for every engine relevant to this skill…

## <Engine 3> — Manipulation Cookbook
- merge/split/rotate/encrypt/… style snippets

## CLI / Other Tools — Quick Reference
- 1-2 line examples of CLI tools that aren't full engines but are useful (e.g. `pdftoppm`, `gs`, `libreoffice --headless`).

## Visual Verification
How to render an output sample and check it before delivering. Always reference the actual GemiX flow (`bash` → `read_file` on PNG).

## Common Pitfalls
A short list of mistakes the AI cannot debug on its own from the error message. NOT a generic list — only things that are surprising or specific to this runtime.

## See Also
- `reference.md` — one-line summary of what's inside.
- Cross-references to other skills if relevant.
```

### What MUST be in `SKILL.md`

1. **Frontmatter**: `name` and `description`, both short.
2. **Decision matrix** at the top so the AI picks an engine without reading the whole file.
3. **Available toolchain** section that lists EXACTLY what is preinstalled.
4. **Cookbook for each engine** with copy-paste minimal examples + a couple of common patterns.
5. **Visual verification** procedure tied to the GemiX runtime (PNG render + `read_file`).
6. **Common pitfalls**, kept short.

### What must NOT be in `SKILL.md`

- Rigid JSON specs / template syntax.
- References to scripts that don't exist (`unified_pdf_generator.py` style).
- Commercial wrappers and SaaS APIs.
- Dependencies that aren't actually preinstalled.
- Examples that import packages outside the truth-table.
- Phases / `execution_phase` / `Phase 1-3` (already removed system-wide).

---

## `reference.md` template

```markdown
# <Skill> — Advanced Reference

Use this when `SKILL.md` is not enough: <list of advanced topics>.

---

## <Engine 1> — Advanced Patterns
- Custom layouts, headers/footers, ToC, bookmarks.
- Things that need >1 short example to grasp.

## <Engine 2> — Advanced Patterns
- Domain-specific topics (TikZ, pgfplots, biblatex for PDF; pivot tables and conditional formatting for XLSX; etc.).

## <Tool> — Compression / Repair / Recovery
- Ghostscript / gs / qpdf / equivalent.

## Diagnostics & Recovery
- How to inspect logs, identify the failure point, and retry.

## Choosing — <Engine 1> × <Engine 2> × …
A small table that summarises when each engine is the right pick.

## License Reminders
Tracker for licensing of every preinstalled tool/library cited.
```

### Rules for `reference.md`

- No frontmatter — only `SKILL.md` carries it.
- Cite ONLY tools/libraries actually in the sandbox (cross-check with `sandbox/Dockerfile` + `sandbox/requirements-sandbox.txt`).
- Don't repeat content from `SKILL.md`. If a topic fits in the cookbook, it belongs there; if it's truly advanced or troubleshooting-level, it goes here.

---

## Dependency truth-table

The "Available Toolchain" section of `SKILL.md` must be derived from the two truth-tables in the repo:

- **Python packages**: `sandbox/requirements-sandbox.txt`.
- **OS packages**: the `apt-get install` block in `sandbox/Dockerfile`.

Process to follow when rewriting a skill:

1. Read both truth-tables.
2. List every library / CLI / package the rewritten skill cites.
3. For each cited dependency, verify it is in one of the two files.
4. If a dependency is missing, decide:
   - **Add it** to `Dockerfile` or `requirements-sandbox.txt` IF it passes the criteria below.
   - **Drop it from the skill** otherwise.
5. Re-state the toolchain in `SKILL.md` ("Available Toolchain (sandbox)") AND ensure every code snippet imports/uses only items from that list.

### When to add a dependency to the sandbox

Adding a dep is the exception, not the default. The sandbox image is shared by every skill and rebuilds are non-trivial (image size, Docker layer cache, deploy on the VPS). Apply ALL of the following filters in order before opening the change:

1. **Necessity** — the skill cannot deliver a documented user-facing capability without it. "Nice to have" or "shorter code" are not necessity. "Without this, an entire class of requests fails" is.
2. **No equivalent already installed** — check `sandbox/requirements-sandbox.txt` and `sandbox/Dockerfile` first. Examples of overlap to reject:
   - `pdfplumber` / `pypdfium2` / `pdf2image` — already covered by the GemiX hybrid PDF parser + poppler-utils + pypdf.
   - `qpdf` (CLI) — covered by `pypdf` (manipulation) and `ghostscript` (compression / repair / linearization).
   - `tesseract-ocr` — was removed; PDF OCR is handled by the GemiX parser, image OCR is not a documented GemiX capability.
   - `pdfkit` / `weasyprint` / `wkhtmltopdf` — covered by `reportlab` + LaTeX.
   - `markitdown` / `pandoc` (Python wrappers) — covered by `libreoffice --headless` for office formats.
3. **No GemiX runtime overlap** — if the GemiX runtime already does what the dep would automate (PDF parsing, audio transcription, video description, image search), the dep is redundant. Use the runtime feature.
4. **No internet at runtime** — the dep must work fully offline. Reject anything that needs to download stylesheets, models, fonts, or update lists at first use (e.g. `minted`+Pygments stylesheets, `nltk` data downloads, ML libraries that pull weights on import). For preloadable models, see `sandbox/preload_models.py` — the model weights must be baked into the image at build time.
5. **License compatibility** — prefer permissive (MIT, BSD, Apache, LPPL). AGPL is acceptable only for tools used as black boxes via CLI (e.g. Ghostscript). GPL is acceptable for CLI tools. Avoid LGPL Python libraries that would force re-licensing of the project.
6. **Maintenance health** — pinned major version is at most 2 years old, repo has commits in the last 12 months, no critical CVE open. For Python deps, prefer ones that publish wheels for `linux/amd64` on PyPI (no source build = faster image build, smaller image).
7. **Image size** — rough budget: a Python dep that adds <50 MB on disk is fine; 50–200 MB needs a clear justification; >200 MB only for foundational packages (e.g. `texlive-fonts-extra`). Use `docker image history` after a test build to verify.
8. **Security surface** — any dep that opens sockets, runs background daemons, or executes arbitrary code from input must be rejected unless it is the documented core of the skill. The sandbox is hardened (cap-drop, no-new-privileges, network-isolated, memory-capped) and a misbehaving dep can pierce that envelope.
9. **Non-overlapping with another skill in flight** — if you're rewriting skill X and consider adding dep Y, check whether the next skill in the queue could benefit too. Coordinate the addition (one image rebuild) instead of two consecutive ones.
10. Best pratice and in XAI Skill (evaluite it).

If a dep passes all 10 filters, add it AND:

- Pin the exact version (Python: `pkg==X.Y.Z`; Debian: rely on the distro version baked into the base image, no `=X.Y.Z` pinning unless reproducibility is at risk).
- For Python, group it under the right comment block in `requirements-sandbox.txt` (`# ── Image manipulation ──`, `# ── Document creation ──`, etc.).
- For Debian packages, add it to the `apt-get install` block in `Dockerfile` in alphabetical order within the relevant logical group (build tools / latex / fonts / libreoffice / etc.).
- If the dep needs initialisation (downloading model weights, building font caches), add it to `sandbox/preload_models.py` so the work happens at image build time, not at runtime.
- Document the addition in this file's "Skill changelog" section: which dep, which skill triggered it, and a one-line justification.

### When to remove a dependency

Removal is just as important. Apply the criteria when a skill rewrite reveals a previously-installed dep is unused:

- The dep is not cited by any active skill (`grep -r '<dep-name>' src/data/skills/`).
- The dep is not imported by any production code (`grep -r '<import-name>' src/`).
- Its removal does not break `sandbox/preload_models.py` or `entrypoint.sh`.

If all three hold, remove it (Dockerfile, requirements-sandbox.txt, preload script if applicable) and document the removal in the changelog.

### Bias toward "no new deps"

Ask first: *can the skill achieve the same result with what's already there?* For PDF we resisted adding `pdfplumber`, `pypdfium2`, `pdf2image`, `qpdf`, `tesseract-ocr` because the existing stack (poppler-utils + pypdf + reportlab + LaTeX + Ghostscript + GemiX's hybrid PDF parser) covers every documented case. The same instinct applies to DOCX, XLSX, PPTX — `python-docx`, `openpyxl`, `python-pptx`, plus `libreoffice --headless` for conversions, are usually enough.

### Bias toward "rely on GemiX runtime features"

GemiX has runtime features that some xAI skills duplicate. Use the runtime features and SKIP the duplicate guidance:

- **PDF reading (incl. scans)** — handled by the GemiX PDF parser. Skill should say "do not parse PDFs yourself, the parser does it" and not include any tesseract/pdfplumber/pypdfium2 examples for reading PDFs.
- **DOCX / XLSX / PPTX reading** — currently NOT auto-parsed; the skill must explicitly say "binary, run `<inspect-script>` first" or, after rewrite, "use the right Python loader and dump structured JSON".
- **Audio / Video / Image** — handled at the chat ingestion level (transcription / description / inline base64). Skill snippets that pre-process media for analysis are usually wrong.
- **Image search** — skills must NOT generate code that hits the internet for images. Skills must instruct the AI to use the host-side `image_search` tool with `save_to_disk=true`, then reference `/readonly/searched_images/<file>`.

When in doubt, search for hooks in the codebase:

```
grep -r "type=\"<your-skill>-transcription\"" src/  # auto-parsing envelope?
grep -r "<file>auto" src/utils/                    # auto-handled?
```

If the GemiX runtime already does what the xAI skill wants the AI to do, REMOVE that section entirely.

---

## Adapting to GemiX (delta vs xAI)

These are the recurring transformations to apply when porting an xAI skill into GemiX:

| xAI assumption | GemiX truth | Action |
| :--- | :--- | :--- |
| Paths like `/root/.grok/skills/…` or relative paths | Skills live at `/readonly/skills/<name>/`. Workspace is `/workspace/{code,temp,output}/` | Rewrite every path. |
| JS libraries (`pdf-lib`, `pdfjs-dist`, `pptxgenjs`, …) | Sandbox is Python-only. No Node, no `npm`. | Drop the JS section entirely. |
| Tax forms / locale-specific deliverables (US 1040, US payslips, …) | GemiX users are Italian-speaking. | Remove tax/forms entirely; keep generic forms guidance only if applicable. |
| `pip install <pkg>` in the snippet | Sandbox has `pip` disabled. | Remove the install line; if the package isn't preinstalled, decide between adding it to `requirements-sandbox.txt` or dropping the example. |
| `apt-get install <pkg>` | No internet, container is built once. | Same logic as above against `Dockerfile`. |
| External fonts downloaded at runtime | No internet. | Either rely on `fonts-dejavu-core` / TeX Live's bundled fonts, or add a `fonts-*` Debian package to `Dockerfile`. |
| Examples that hit external URLs | No internet from sandbox. | Replace with `image_search → save_to_disk=true → /readonly/searched_images/...` flow. |
| Helper-script CLI (e.g. `python /readonly/skills/<name>/scripts/<helper>.py …`) | After the rewrite the `scripts/` folder is gone. | Replace with inline equivalent code inside a `write_file`+`bash` snippet. |
| Phases / `execution_phase` / `Phase 1-3` | Already removed system-wide. | Remove every mention; the runtime now runs `write_file/edit_file/read_file → bash → delivery` automatically in a single round. |
| Single-engine assumption | GemiX skills typically expose 2-4 engines (e.g. PDF: reportlab vs LaTeX vs pypdf). | Add a Decision Matrix and split the cookbook accordingly. |

---

## Tone and style

- **Short, technical, no marketing language.** No "powerful", "professional-grade", "amazing".
- **Imperative voice** ("Wrap every cell in `Paragraph`", "Always call `plt.close(fig)`").
- **English** (consistent with the rest of the agentic briefing and tool descriptions).
- **No emojis** in skill files.
- **Code blocks**: language-tagged (` ```python `, ` ```bash `, ` ```latex `). Paths absolute. Comments only when non-obvious.
- **Tables** for decision matrices and cheatsheets; bullets for short lists; prose only when explaining a runtime behaviour.
- **No hyperbole** about output quality. State what the engine does and let the AI judge fitness.

---

## Per-skill checklist

Before opening the rewrite for review, confirm:

- [ ] `SKILL.md` frontmatter `name` matches the folder name.
- [ ] `SKILL.md` description is 1-2 sentences and explicitly mentions when NOT to use the skill (if applicable).
- [ ] No references to `execution_phase`, `Phase 1-3`, `before_all`, `after_all`.
- [ ] No references to scripts/templates that have been deleted.
- [ ] Every Python import in every snippet is in `requirements-sandbox.txt`.
- [ ] Every CLI tool in every snippet is in `Dockerfile`'s `apt-get` block.
- [ ] Every LaTeX `\usepackage{…}` (PDF skill only) is provided by an installed `texlive-*` package or by an explicit Debian package (`lmodern`, …).
- [ ] No `pip install`, `apt-get install`, `npm install`, `tlmgr` lines.
- [ ] No external URLs in example code (only `image_search → /readonly/searched_images/`).
- [ ] All paths absolute under `/workspace/{code|temp|output}/` or `/readonly/{history|searched_images|skills}/`.
- [ ] `assets/` and `scripts/` folders deleted from the skill directory.
- [ ] Diagnostics (`getDiagnostics`) clean on the new `SKILL.md` and `reference.md`.
- [ ] Run a real-world prompt through GemiX and verify the deliverable lands in `/workspace/output/` and is auto-attached.

---

## Skill changelog

Track here every dependency added/removed during rewrites, and which skill triggered the change.

### PDF (done)
**Removed:**
- `src/data/skills/pdf/assets/templates/` — 5 `.tex` templates (rigid Jinja2-based scaffolds).
- `src/data/skills/pdf/scripts/` — 7 Python wrappers (`unified_pdf_generator.py`, `render_latex_template.py`, `generate_matplotlib_figure.py`, `compile_tex.py`, `latex_helper.py`, `latex_utils.py`, `pdf_manipulate.py`).

**Added (sandbox):**
- `lmodern` (Debian package) — Computer Modern font family. `texlive-fonts-recommended` no longer ships it on Bookworm.
- `texlive-lang-italian` (Debian package) — Italian babel support. Required because GemiX is an Italian-language bot.

**Removed (sandbox):**
- `tesseract-ocr` (Debian package) and `pytesseract==0.3.13` (Python) — unused. PDF OCR is handled by the GemiX hybrid PDF parser; image OCR is not a documented GemiX capability. The OS-tool list in `agenticBriefing.js` was updated accordingly.

**Considered but rejected:**
- `pdfplumber`, `pypdfium2`, `pdf2image` — duplicate functionality already covered by the GemiX hybrid PDF parser + poppler-utils + pypdf.
- `qpdf` (CLI) — `pypdf` and `gs` cover the same operations.

**Notes:**
- LaTeX path is the recommended default for math/scientific docs (TeX Live full + science + cm-super installed).
- reportlab path is the default for office-style docs (faster, no compile step).
- pypdf covers all common PDF manipulation (merge/split/rotate/crop/encrypt/watermark).

### DOCX (pending)
*(to be filled when rewrite is started)*

### XLSX (pending)
*(to be filled when rewrite is started)*

### PPTX (pending)
*(to be filled when rewrite is started)*

---

## Quick recipe to start the next rewrite

1. User drops the xAI reference at `src/data/NUOVE SKILL TEST/<name>/`.
2. Read both the xAI reference and the current GemiX skill at `src/data/skills/<name>/`.
3. Cross-reference dependencies against `sandbox/requirements-sandbox.txt` + `sandbox/Dockerfile`.
4. Decide which dependencies to add (if any), which to drop, which to keep.
5. Write the new `SKILL.md` + `reference.md` following the templates above.
6. Delete `src/data/skills/<name>/assets/` and `src/data/skills/<name>/scripts/` if present.
7. Delete `src/data/NUOVE SKILL TEST/<name>/` once the rewrite is complete.
8. Run `getDiagnostics` on the new files.
9. Update the "Skill changelog" section of THIS file with what changed.
10. Test with a real-world prompt against the live bot and iterate on whatever the AI gets wrong.
