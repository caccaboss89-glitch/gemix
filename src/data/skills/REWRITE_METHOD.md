# Skill Rewrite Method

This document describes the convention for rewriting GemiX skills (`src/data/skills/<name>/`) starting from the corresponding xAI reference skill. Apply it to each skill (PDF, DOCX, XLSX, PPTX) one PR at a time.

The goal of the rewrite is to drop legacy template-driven complexity (rigid JSON specs, fixed `.tex` templates, dozens of helper scripts) in favour of a **knowledge-base** style: the skill explains the right tools and gives copy-paste snippets, then leaves the agent free to compose the document the user actually asked for. This is possible because we no longer optimise for tool-rounds — Hermes proxy + SuperGrok subscription means each round is "free".

---

## Runtime context (READ THIS FIRST)

Skills are loaded by the **engineering sub-agent** (`build`), NOT by the main GemiX brain. When the user asks for a deliverable, the main brain calls the `build` tool; the agent receives an isolated environment and reads the relevant skill on demand. The skill therefore writes for the agent, not for the chat brain.

Hard facts about the environment:

- **One flat workspace** mounted read-write at `/workspace/`. No subdir convention. No `temp/`/`output/`/`code/`. No projects. The agent writes anywhere it wants under `/workspace/` and announces deliverables with `<DELIVER>file1, file2</DELIVER>` at the end of its final reply.
- **Skills mounted read-only** at `/skills/<name>/`. Read full content via `read_file` on `/skills/<name>/SKILL.md` (or `/skills/<name>/reference.md`).
- **Attachments** the user passed to the `build` call are already in `/workspace/` root when the agent starts. The agent finds them via `<WorkspaceState>` (refreshed each round). On filename collision, the host renames to `name(1).ext` and notes it in `<AttachmentNotes>`.
- **No PDF/audio/video parser microservice anymore.** xAI ingests PDF/audio/video natively from `input_file` URLs (the `read_file` agent tool exposes binary files via the public attachment tunnel automatically). For PDFs the agent receives `<DOCUMENT>` content (text + images + structure, OCR included) directly.
- **`/skills/` files are read-only `.md`.** No more `scripts/` shipped with the skill — the agent writes equivalent code inline via `write_file` + `bash`.
- **`code_interpreter`** is a server-side xAI native tool exposed to the agent for ad-hoc Python without filesystem access. For anything that touches `/workspace/` files use `write_file` / `edit_file` / `bash`.
- **Sandbox toolchain** is Python 3.12 + LibreOffice + Ghostscript + TeX Live + every dep in `sandbox/requirements-sandbox.txt`. No internet by default; outbound traffic only via the egress proxy (yt-dlp allowlist).
- **`<DELIVER>`** is REQUIRED on the final reply. Files NOT listed there are silently dropped from the user-facing response.

---

## Inputs you will receive

For each new skill the user provides:

1. The full xAI reference skill — `SKILL.md`, sometimes `reference.md` / `forms.md`, and a `scripts/` folder with Python helpers.
2. The current GemiX skill at `src/data/skills/<name>/` to be replaced.

You may inspect both. The xAI version is the **conceptual reference**; the GemiX rewrite is not a 1:1 copy because the runtime and conventions differ (see "Adapting to GemiX" below).

---

## Output structure

The rewritten skill MUST live at `src/data/skills/<name>/` and contain:

```
src/data/skills/<name>/
├── SKILL.md         (entry-point)
└── reference.md     (advanced patterns, troubleshooting, edge cases)
```

No `assets/`, no `scripts/`, no `templates/`. If a skill genuinely needs additional `.md` files (a heavy domain-specific subtopic), name them with lower-case `<topic>.md`, link them from `SKILL.md`'s "See Also" section, and use the same frontmatter-free format as `reference.md`.

---

## `SKILL.md` template

```markdown
---
name: <skill-name>                    # MUST match the folder name
description: <short, single-line>     # 1-2 sentences. Explicit about when
                                      # this skill is the right pick.
---

# <Skill> Skill Guide

> [!IMPORTANT]
> One-liner that anchors the skill's philosophy.

## When to use this skill
Concrete triggers (file types, user intents). Keep it short — the agent
already knows it should use a skill, this section disambiguates between
adjacent skills (e.g. PDF generation vs DOCX vs PPTX).

## Decision matrix — which engine
| User request | Use | Why |
| :--- | :--- | :--- |
| Simple case A | tool/library X | reason |
| Complex case B | tool/library Y | reason |
| Manipulation only | tool Z | reason |
| Reading user-supplied <type> | … | … |

**Rule of thumb**: <one-line heuristic>.

## Available toolchain (sandbox)
…see "Dependency truth-table" rules below…

## Working with attached files
- Files attached to the `build` call are in `/workspace/` root.
- If the agent received an `<AttachmentNotes>` rename, use the renamed name.
- For binary PDFs / audio / video, call `read_file /workspace/<name>` once;
  xAI fetches the file via the tunnel and on the next round you receive
  parsed content (`<DOCUMENT>` for PDF, transcription for audio, frames +
  voice for video). Do NOT try to parse PDFs with pdfplumber / pypdf2 first.

## <Engine 1> — Cookbook
- Minimal example
- Common patterns (multi-page, tables, images, math, …)
- Engine-specific gotchas

## <Engine 2> — Cookbook
…same structure, repeated for every engine relevant to this skill…

## CLI / Other tools — Quick reference
1-2 line examples of CLI tools that aren't full engines but are useful
(e.g. `pdftoppm`, `gs`, `libreoffice --headless`).

## Visual verification
How to render an output sample and check it before delivering. Always
reference the actual GemiX flow (`bash` to render → `read_file` on the
PNG → emit `<DELIVER>`).

## Common pitfalls
A short list of mistakes that aren't obvious from the error message.

## See also
- `reference.md` — one-line summary.
- Cross-references to other skills if relevant.
```

### What MUST be in `SKILL.md`

1. **Frontmatter**: `name` and `description`, both short.
2. **When to use this skill** — disambiguates from sibling skills.
3. **Decision matrix** at the top so the agent picks an engine without reading the whole file.
4. **Available toolchain** section that lists EXACTLY what is preinstalled.
5. **Working with attached files** — how user-provided files appear in the workspace and how to read binaries.
6. **Cookbook for each engine** with copy-paste minimal examples + a couple of common patterns.
7. **Visual verification** procedure tied to the GemiX runtime.
8. **Common pitfalls**, kept short.

### What must NOT be in `SKILL.md`

- Rigid JSON specs / template syntax.
- References to scripts that don't exist.
- Commercial wrappers and SaaS APIs.
- Dependencies that aren't actually preinstalled.
- Examples that import packages outside the truth-table.
- Phases / `execution_phase` / `Phase 1-3`.
- References to legacy paths: `/readonly/history/`, `/readonly/searched_images/`, `/workspace/{temp|output|code}/`.
- References to projects, `gemix-project`, `agentic_unlock`, `attach_file`, the GemiX PDF parser microservice — they don't exist.
- Sections like "Don't Use This Skill For Plain Reading" or "When You Need The Original PDF File" — those existed because the host PDF parser intercepted PDFs before the AI saw them. The host no longer does any PDF pre-processing; the agent receives the file as `input_file` and must operate on it directly.

---

## `reference.md` template

```markdown
# <Skill> — Advanced Reference

Use this when `SKILL.md` is not enough.

## <Engine 1> — Advanced patterns
- Custom layouts, headers/footers, ToC, bookmarks.

## <Engine 2> — Advanced patterns
- Domain-specific topics (TikZ / pgfplots / biblatex for PDF; pivot tables and conditional formatting for XLSX; etc.).

## <Tool> — Compression / Repair / Recovery
- Ghostscript / qpdf / equivalent.

## Diagnostics & recovery
- How to inspect logs, identify the failure point, and retry.

## Choosing — <Engine 1> × <Engine 2> × …
A small table that summarises when each engine is the right pick.

## License reminders
Tracker for licensing of every preinstalled tool/library cited.
```

### Rules for `reference.md`

- No frontmatter — only `SKILL.md` carries it.
- Cite ONLY tools/libraries actually in the sandbox (cross-check `sandbox/Dockerfile` + `sandbox/requirements-sandbox.txt`).
- Don't repeat content from `SKILL.md`. If a topic fits in the cookbook, it belongs there; if it's troubleshooting-level, it goes here.

---

## Dependency truth-table

The "Available toolchain" section of `SKILL.md` must be derived from the two truth-tables in the repo:

- **Python packages**: `sandbox/requirements-sandbox.txt`.
- **OS packages**: the `apt-get install` block in `sandbox/Dockerfile`.

Process when rewriting a skill:

1. Read both truth-tables.
2. List every library / CLI / package the rewritten skill cites.
3. For each cited dependency, verify it is in one of the two files.
4. If a dependency is missing, decide:
   - **Add it** to `Dockerfile` or `requirements-sandbox.txt` IF it passes the criteria below.
   - **Drop it from the skill** otherwise.
5. Re-state the toolchain in `SKILL.md` AND ensure every code snippet imports/uses only items from that list.

### When to add a dependency to the sandbox

Adding a dep is the exception. The sandbox image is shared by every skill and rebuilds are non-trivial (image size, deploy on the VPS). Apply ALL of the following filters in order:

1. **Necessity** — the skill cannot deliver a documented user-facing capability without it. "Nice to have" or "shorter code" are not necessity.
2. **No equivalent already installed** — check `sandbox/requirements-sandbox.txt` and `sandbox/Dockerfile` first. Examples of overlap to reject: `pdfplumber` / `pypdfium2` / `pdf2image` (covered by `pypdf` + `poppler-utils`); `qpdf` CLI (covered by `pypdf` + `ghostscript`); `pdfkit` / `weasyprint` (covered by `reportlab` + LaTeX); `markitdown` / Pandoc Python wrappers (covered by `libreoffice --headless`).
3. **No internet at runtime** — the dep must work fully offline. Reject anything that pulls down stylesheets, models, fonts, or update lists at first use. For preloadable models, see `sandbox/preload_models.py` — model weights must be baked into the image at build time.
4. **License compatibility** — prefer permissive (MIT, BSD, Apache, LPPL). AGPL acceptable only for tools used as black boxes via CLI (e.g. Ghostscript). GPL acceptable for CLI tools. Avoid LGPL Python libraries that would force re-licensing.
5. **Maintenance health** — pinned major version is at most 2 years old, repo has commits in the last 12 months, no critical CVE open. For Python, prefer ones that publish wheels for `linux/amd64` on PyPI.
6. **Image size** — rough budget: a Python dep that adds <50 MB on disk is fine; 50–200 MB needs justification; >200 MB only for foundational packages (e.g. `texlive-fonts-extra`).
7. **Security surface** — any dep that opens sockets, runs background daemons, or executes arbitrary code from input must be rejected unless it is the documented core of the skill.
8. **Non-overlapping with the next skill** — if you're rewriting skill X and consider adding dep Y, check whether the next skill could benefit too. Coordinate the addition (one image rebuild) instead of two.

If a dep passes all filters, add it AND:

- Pin the exact version (Python: `pkg==X.Y.Z`; Debian: rely on the distro version baked into the base image, no `=X.Y.Z` pinning unless reproducibility is at risk).
- For Python, group it under the right comment block in `requirements-sandbox.txt`.
- For Debian packages, add it to the `apt-get install` block in `Dockerfile` in alphabetical order within the relevant logical group.
- If the dep needs initialisation (downloading model weights, building font caches), add it to `sandbox/preload_models.py` so the work happens at image build time.
- Document the addition in this file's "Skill changelog" section.

### When to remove a dependency

Removal is just as important. Apply the criteria when a skill rewrite reveals a previously-installed dep is unused:

- The dep is not cited by any active skill (`grep -r '<dep-name>' src/data/skills/`).
- The dep is not imported by any production code (`grep -r '<import-name>' src/`).
- Its removal does not break `sandbox/preload_models.py`.

If all three hold, remove it (Dockerfile, requirements-sandbox.txt, preload script if applicable) and document the removal in the changelog.

### Bias toward "no new deps"

Ask first: *can the skill achieve the same result with what's already there?* For PDF we resisted adding `pdfplumber`, `pypdfium2`, `pdf2image`, `qpdf`, `tesseract-ocr` because the existing stack covers every documented case. The same instinct applies to DOCX, XLSX, PPTX — `python-docx`, `openpyxl`, `python-pptx`, plus `libreoffice --headless` for conversions, are usually enough.

### Bias toward "rely on xAI native ingestion"

xAI's Responses endpoint already handles file ingestion server-side. Skills must NOT duplicate it:

- **PDF reading (incl. scans)** — `read_file` on a workspace PDF exposes it via the tunnel; xAI returns `<DOCUMENT>` with text + images + OCR. Skills must say "do not parse PDFs with pdfplumber/pypdf2 first — use the model's view of `<DOCUMENT>`" and only suggest `pypdf` / Ghostscript when the agent needs to **manipulate** (merge/split/rotate/encrypt) or **compress** the file.
- **DOCX / XLSX / PPTX reading** — currently NOT auto-parsed by xAI. The skill must use `python-docx` / `openpyxl` / `python-pptx` to extract structured content. After extraction, write a JSON dump to `/workspace/` and let the agent reason on it.
- **Audio / Video / Image** — handled at the chat ingestion level (xAI's STT / frame extraction / image understanding). The agent receives transcriptions / descriptions automatically when `read_file` is called on a media file. Skills should not pre-process media for analysis.

When in doubt, search the codebase: `grep -r "input_file" src/` and `grep -r "image_url" src/`.

---

## Adapting to GemiX (delta vs xAI)

These are the recurring transformations to apply when porting an xAI skill into GemiX:

| xAI assumption | GemiX truth | Action |
| :--- | :--- | :--- |
| Paths like `/root/.grok/skills/…` or relative paths | Skills live at `/skills/<name>/`. Workspace is `/workspace/` (flat). | Rewrite every path. |
| JS libraries (`pdf-lib`, `pdfjs-dist`, `pptxgenjs`, …) | Sandbox is Python-only. No Node, no `npm`. | Drop the JS section entirely. |
| Tax forms / locale-specific deliverables (US 1040, US payslips, …) | GemiX users are Italian-speaking. | Remove tax/forms entirely; keep generic forms guidance only if applicable. |
| `pip install <pkg>` in the snippet | Sandbox has `pip` disabled at runtime. | Remove the install line; if the package isn't preinstalled, decide between adding it to `requirements-sandbox.txt` or dropping the example. |
| `apt-get install <pkg>` | No internet, container is built once. | Same logic against `Dockerfile`. |
| External fonts downloaded at runtime | No internet. | Either rely on `fonts-dejavu-core` / TeX Live's bundled fonts, or add a `fonts-*` Debian package to `Dockerfile`. |
| Examples that hit external URLs | No internet from sandbox unless via egress proxy. | If the URL is for media (yt-dlp), the proxy allows YouTube/X/Instagram/TikTok/Facebook out of the box. Anything else: fail clean and tell the user. |
| Helper-script CLI (`python /readonly/skills/<name>/scripts/<helper>.py …`) | After the rewrite the `scripts/` folder is gone. | Replace with inline equivalent code inside a `write_file`+`bash` snippet. |
| Phases / `execution_phase` / `Phase 1-3` | Already removed system-wide. | Remove every mention; the agent runs `write_file` / `edit_file` / `read_file` / `bash` in any order across rounds and emits `<DELIVER>` on the final reply. |
| Single-engine assumption | GemiX skills typically expose 2-4 engines (e.g. PDF: reportlab vs LaTeX vs pypdf). | Add a Decision Matrix and split the cookbook accordingly. |

---

## Tone and style

- **Short, technical, no marketing language.** No "powerful", "professional-grade", "amazing".
- **Imperative voice** ("Wrap every cell in `Paragraph`", "Always call `plt.close(fig)`").
- **English** (consistent with the rest of the agent prompts and tool descriptions).
- **No emojis** in skill files.
- **Code blocks**: language-tagged (` ```python `, ` ```bash `, ` ```latex `). Paths absolute. Comments only when non-obvious.
- **Tables** for decision matrices and cheatsheets; bullets for short lists; prose only when explaining a runtime behaviour.
- **No hyperbole** about output quality. State what the engine does and let the agent judge fitness.

---

## Per-skill checklist

Before opening the rewrite for review, confirm:

- [ ] `SKILL.md` frontmatter `name` matches the folder name.
- [ ] `SKILL.md` description is 1-2 sentences and disambiguates from sibling skills.
- [ ] No references to `execution_phase`, `Phase 1-3`, `before_all`, `after_all`.
- [ ] No references to scripts/templates that have been deleted.
- [ ] No references to `/readonly/`, `/workspace/{temp|output|code}/`, projects, `gemix-project`, `agentic_unlock`, `attach_file`, the GemiX PDF parser.
- [ ] Every Python import in every snippet is in `requirements-sandbox.txt`.
- [ ] Every CLI tool in every snippet is in `Dockerfile`'s `apt-get` block.
- [ ] Every LaTeX `\usepackage{…}` (PDF skill only) is provided by an installed `texlive-*` package or by an explicit Debian package (`lmodern`, …).
- [ ] No `pip install`, `apt-get install`, `npm install`, `tlmgr` lines.
- [ ] No external URLs in example code (the sandbox has no general internet).
- [ ] All paths absolute under `/workspace/` or `/skills/<name>/`.
- [ ] `assets/` and `scripts/` folders deleted from the skill directory.
- [ ] Diagnostics (`getDiagnostics`) clean on the new `SKILL.md` and `reference.md`.
- [ ] Run a real-world prompt through GemiX (via `build`) and verify the deliverable lands in `/workspace/` and is announced via `<DELIVER>`.

---

## Skill changelog

Track here every dependency added/removed during rewrites, and which skill triggered the change.

### PDF (rewrite required)

The current `src/data/skills/pdf/` was rewritten under the OLD architecture (parser microservice, project tree, `/readonly/`). It needs a second pass:

- Drop sections like "Don't Use This Skill For Plain Reading" and "When You Need The Original PDF File" — the parser microservice is gone, the agent always operates on the file directly via `<DOCUMENT>` after `read_file`.
- Path migration: `/readonly/history/` → workspace attachments, `/workspace/{temp|output|code}/` → `/workspace/`.
- Remove every reference to the GemiX PDF parser as a runtime feature.
- Keep the reportlab vs LaTeX vs pypdf decision matrix.

**Sandbox state to preserve:**
- `lmodern` (Debian) — Computer Modern font family.
- `texlive-lang-italian` (Debian) — Italian babel support.

**Sandbox state already removed (PR1):**
- `tesseract-ocr` (Debian) and `pytesseract==0.3.13` (Python) — unused. xAI's `<DOCUMENT>` envelope already includes OCR for scanned PDFs.

### DOCX (pending)
*(to be filled when rewrite is started)*

### XLSX (pending)
*(to be filled when rewrite is started)*

### PPTX (pending)
*(to be filled when rewrite is started)*

---

## Quick recipe to start the next rewrite

1. User drops the xAI reference at a temp location (e.g. `src/data/NUOVE SKILL TEST/<name>/`).
2. Read both the xAI reference and the current GemiX skill at `src/data/skills/<name>/`.
3. Cross-reference dependencies against `sandbox/requirements-sandbox.txt` + `sandbox/Dockerfile`.
4. Decide which dependencies to add (if any), which to drop, which to keep.
5. Write the new `SKILL.md` + `reference.md` following the templates above.
6. Delete `src/data/skills/<name>/assets/` and `src/data/skills/<name>/scripts/` if present.
7. Delete the temp xAI reference once the rewrite is complete.
8. Run `getDiagnostics` on the new files.
9. Update the "Skill changelog" section of THIS file with what changed.
10. Test with a real-world prompt against the live bot and iterate on whatever the agent gets wrong.
