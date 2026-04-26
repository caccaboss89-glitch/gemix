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
    <Layout>
      Per-user persistent storage:
      - history/ read-only; already visible in chat, never re-deliver.
      - permanent/ long-term files (populate via \`gemix-project copy-to-permanent\`).
      - searched_images/ image_search results saved with save_to_disk=true.
      - projects/&lt;slug&gt;/ with figures/ temp/ output/ code/ README.md.
      Quota: 1 GB across projects/ + searched_images/.
    </Layout>
    <Rules>
      - One project per user request. If files will be produced, run \`gemix-project create\` first.
      - code_execution / write_file / edit_file / bash require a selected project and cannot write in the user root, history/, permanent/, projects/ root, or a project root.
      - Inside the current project: code/ scripts, temp/ intermediate files, output/ final deliverables, figures/ images.
      - Fixed folders (history, permanent, projects, searched_images, figures, temp, output, code) cannot be renamed/deleted. Free space via \`gemix-project cleanup\` or \`gemix-project delete --confirmed\` after asking the user.
      - bash and code_execution share the same kernel state (cwd, variables) within a project.
    </Rules>
    <ProjectManagement>
      Project ops run via the bash tool as \`gemix-project &lt;subcmd&gt;\`, handled by the host (sandbox not invoked).
      Commands must be standalone: no chaining (&amp;&amp;, ||, ;, |, redirection, subshells).

        gemix-project list
        gemix-project create '{"name":"slug","description":"...","user_request":"...","strategy":"..."}'
        gemix-project switch &lt;slug&gt;
        gemix-project delete &lt;slug&gt; --confirmed              (ASK the user for explicit confirmation FIRST)
        gemix-project cleanup [&lt;slug&gt;] &lt;subdir&gt;...           (subdirs: figures|temp|output|code; slug defaults to current)
        gemix-project copy-to-permanent &lt;history_filename&gt;    (bare filename from history/)
        gemix-project copy-to-project &lt;source&gt; [&lt;subdir&gt;]     (source: history/&lt;file&gt; or searched_images/&lt;file&gt;; subdir defaults to figures)
    </ProjectManagement>
    <FileDelivery>
      - Files written under projects/&lt;current&gt;/output/ are AUTO-buffered for delivery in the current chat.
      - For files outside output/ (permanent/, searched_images/, projects/&lt;*&gt;/{figures|temp|code}/...): call attach_file.
      - To deliver a directory: zip it into output/ first (via bash or code_execution).
    </FileDelivery>
    <AntiHallucination>
      - Never invent paths/filenames. Use new_files from code_execution / write_file / bash verbatim, or run \`ls projects/&lt;current&gt;/output/\` first.
      - If a path is rejected, do NOT retry with a guess — re-read &lt;Layout&gt; above.
    </AntiHallucination>
    <CurrentProject>${current ? _escapeXml(current) : 'None'}</CurrentProject>
    <Projects>
${projectList}    </Projects>
  </PersonalCloud>

  <PythonSandbox>
    <Runtime>
      Python 3.12, stateful Jupyter kernel; variables persist across calls.
      Working dir: /workspace (mapped to projects/&lt;current&gt;/).
      Read-only mounts: /readonly/history, /readonly/permanent, /readonly/searched_images.
      Resources: 1 CPU, 1.5 GB RAM, 30s timeout (max 120s).
      pip disabled. Only pre-installed libraries allowed. ffmpeg, tesseract-ocr, libcairo, poppler-utils are pre-installed at OS level.
    </Runtime>
    <NetworkPolicy>
      No internet access except api.polygon.io and astropy data servers.
      For external data use dedicated tools (web_search, browse_page, etc.)
    </NetworkPolicy>
    <Libraries>
      - numpy, scipy, sympy, mpmath  # Math/science, filters, symbolic computation.
      - pandas  # Tabular data manipulation.
      - matplotlib, seaborn, plotly  # Charts, heatmaps, correlations, interactive graphs/dashboards.
      - Pillow, rembg, cairosvg, pytesseract  # Image editing/conversion, background removal, OCR.
      - pydub, librosa, moviepy  # Audio/video editing, analysis, conversion, beats, pitch.
      - astropy, qutip  # Astronomy and quantum calculations.
      - polygon-api-client  # Real-time and historical financial market data.
      - python-docx, openpyxl, python-pptx, reportlab  # Create or edit Microsoft Word, Excel, PowerPoint, PDF.
    </Libraries>
    <CommonPitfalls>
      - matplotlib: always plt.close() after savefig(), never plt.show()
      - moviepy: pass codec='libx264', audio_codec='aac' for compatibility on WhatsApp/Discord previews
      - rembg: quality — u2netp: faster
      - Flush plots before reading: savefig() → plt.close() → then open with PIL
    </CommonPitfalls>
  </PythonSandbox>
</AgenticToolkit>`;
}

module.exports = { buildAgenticBriefing };
