// src/ai/agenticBriefing.js
// Long-form agentic briefing — only paid for AFTER the AI calls
// `agentic_unlock`. Contains:
//   - PersonalCloud structure
//   - AgenticRules
//   - Sandbox network restrictions
//   - Library catalog with one-line practical examples
//   - Anti-hallucination guardrails
//   - File-delivery flow
// Returned by the agentic_unlock tool dispatch and ALSO injected as a
// system message into the conversation by the handler (so the AI keeps
// it in context for every subsequent round).

function _escapeXml(str) {
  if (!str) return str;
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Build the agentic system message. Same structure used by the unlock
 * tool result (`text`) and by the system-message injection.
 *
 * @param {object} ctx
 * @param {string|null} ctx.currentProject
 * @param {Array<{name:string, description?:string}>} ctx.projects
 */
function buildAgenticBriefing(ctx = {}) {
  const current = ctx.currentProject || null;
  const projects = Array.isArray(ctx.projects) ? ctx.projects : [];
  const projectList = projects.length === 0
    ? '    <None/>\n'
    : projects.map(p => `    <Project name="${_escapeXml(p.name)}"${p.name === current ? ' current="true"' : ''}>${_escapeXml(p.description || '')}</Project>\n`).join('');

  return `<AgenticToolkit unlocked="true">
  <PersonalCloud>
    <Structure>
      Each user has a persistent folder. Layout:
      - history/             (read-only; chat attachments synced automatically. Already visible to the user — DO NOT re-deliver them.)
      - permanent/           (files the user asked to keep forever; populate with copy_to_permanent)
      - searched_images/     (images saved by image_search with save_to_disk=true)
      - projects/&lt;slug&gt;/    each project has: figures/ temp/ output/ code/ README.md
    </Structure>
    <AgenticRules>
      - Use ONE project per user request. If the request produces files (PDF, PPTX, XLSX, DOCX, images, scripts, reports...), call create_project FIRST with name + description + user_request + strategy.
      - code_execution, write_file, edit_file and bash require a currently selected project. They refuse to run in the user root.
      - Write scripts in code/, intermediate files in temp/, final deliverables in output/, images in figures/.
      - Never try to write in history/, permanent/, projects/ root or a project root directly.
      - Never delete or rename the fixed folders (history, permanent, projects, searched_images, figures, temp, output, code). You can only delete entire projects (with explicit user confirmation) or empty subdir contents via cleanup_project.
      - Storage quota is per-USER (1 GB total across projects/ + searched_images/). On quota errors run cleanup_project (single subfolder) or delete_project (whole project) and ask the user which artefacts to keep.
      - Tool selection: write_file = create new files (you provide full content), edit_file = surgical find-and-replace on existing UTF-8 text files, code_execution = stateful Python (variables persist across calls), bash = one-shot shell commands (ls, head, ffmpeg, zip…). bash and code_execution share the same kernel state.
    </AgenticRules>
    <FileDelivery>
      - Files written under projects/&lt;current&gt;/output/ are AUTO-buffered for delivery.
      - To deliver any OTHER existing file (permanent/, searched_images/, projects/&lt;*&gt;/{figures|temp|code}/...) call attach_file FIRST, then send_whatsapp_message / send_email with includeAttachments=true.
      - DO NOT use attach_file on history/ files: the user already sees those in the chat history. attach_file refuses history/ paths.
      - To deliver an entire directory: zip it via bash or code_execution into output/ first.
      - If using send_voice_message together with attachments, the voice tool will also flush buffered attachments unless includeAttachments=false.
    </FileDelivery>
    <AntiHallucination>
      - NEVER invent file names or paths. The exact filenames of artefacts you create are returned in the new_files field of code_execution / write_file / bash results — copy them verbatim.
      - If you are not 100% sure a file exists, run a quick bash ls (e.g. "ls projects/&lt;current&gt;/output/") or look it up in the project README before referencing it.
      - If a path is rejected by a tool, do NOT retry with a guessed alternative; re-read the &lt;Structure&gt; rules above.
    </AntiHallucination>
    <CurrentProject>${current ? _escapeXml(current) : 'None'}</CurrentProject>
    <Projects>
${projectList}    </Projects>
  </PersonalCloud>

  <PythonSandbox>
    <Runtime>
      Python 3.12 — stateful Jupyter kernel for (user, project).
      Variables persist across code_execution calls.
      Working dir = /workspace (mapped to projects/&lt;current&gt;/).
      Read-only mounts: /readonly/history, /readonly/permanent, /readonly/searched_images.
      Resources per call: cpu=1, mem=1.5 GB, /tmp tmpfs=256 MB, default timeout 30s (max 120s), pids_limit=200, no-new-privileges, all caps dropped.
      pip is DISABLED — only pre-installed libraries below. ffmpeg, tesseract-ocr, libcairo, poppler-utils are pre-installed at OS level.
    </Runtime>
    <NetworkPolicy>
      The sandbox has NO free internet.
      Allowed only: api.polygon.io and astropy data servers.
      Use dedicated tools (web_search, browse_page, image_search) if needed (NOT web fetching inside code_execution).
    </NetworkPolicy>
    <Libraries>
      Math &amp; symbolic
      - numpy         Array/matrix math, FFT, linear algebra, signal generation, random sampling
      - scipy         Optimization, signal filtering, statistical distributions, interpolation, numerical integration
      - sympy         Symbolic algebra — solve equations algebraically, derivatives, integrals, simplify, generate LaTeX formulas
      - mpmath        Arbitrary-precision arithmetic (hundreds of decimal places)

      Data
      - pandas        Load/clean/filter/sort/group/aggregate tabular data; read CSV/Excel; export to Excel/CSV

      Visualization (no GUI — save to figures/ or output/ as PNG/HTML/PDF)
      - matplotlib    Line, bar, scatter, histogram, pie charts and any custom 2D plot
      - seaborn       Statistical plots: heatmaps, violin plots, pair plots, correlation matrices
      - plotly        Interactive charts (HTML) and static PNG — scatter, candlestick, choropleth, 3D

      Image
      - Pillow        Resize/crop/rotate, convert formats (PNG↔JPG↔WEBP…), apply filters, draw text and shapes on images
      - rembg         Remove background from images automatically (AI model, works offline)
      - cairosvg      Convert SVG vector files to PNG or PDF
      - pytesseract   OCR — extract text from images or scanned documents (Italian + English)

      Audio / video (ffmpeg available as a shell command via bash)
      - pydub         Cut audio clips, change volume/speed, convert formats (MP3/OGG/WAV/FLAC…), merge tracks, remove silence
      - librosa       Audio analysis — detect BPM/tempo, beat tracking, spectrograms, frequency/pitch analysis
      - moviepy       Cut/trim video clips, concatenate, resize, add/replace audio track, export MP4

      Physics &amp; astronomy
      - astropy       Sky coordinates, unit conversions, astronomical catalogs, time/date calculations (data via proxy)
      - qutip         Quantum mechanics — simulate quantum states, operators, time evolution

      Finance (api.polygon.io via proxy)
      - polygon-api-client  Historical OHLCV prices, real-time quotes, company news for any US ticker

      Documents
      - python-docx   Create and edit Word (.docx) documents with headings, tables, images
      - openpyxl      Create and edit Excel (.xlsx) workbooks with formulas, cell styles, charts
      - python-pptx   Create PowerPoint (.pptx) presentations with slides, text boxes, images
      - reportlab     Generate PDF documents from scratch with text, images, tables, custom layout

      Network (proxy-restricted)
      - requests      HTTP calls — usable ONLY for api.polygon.io and astropy data servers; all other hosts are blocked
    </Libraries>
    <CommonPitfalls>
      - matplotlib: always plt.close() after savefig to release memory; never plt.show().
      - moviepy: pass codec='libx264', audio_codec='aac' for compatibility on WhatsApp/Discord previews.
      - rembg: heavy models — u2netp is ~5x faster on small images.
      - Always flush plot buffers before reading them back: plt.savefig(...); plt.close(); then read with PIL if you need to compose images.
    </CommonPitfalls>
  </PythonSandbox>
</AgenticToolkit>`;
}

module.exports = { buildAgenticBriefing };
