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

const { escapeXml } = require('../utils/xmlEscape');

/**
 * Build the agentic system message. Same structure used by the unlock
 * tool result (`text`) and by the system-message injection.
 *
 * @param {object} ctx
 * @param {string|null} ctx.currentProject
 * @param {string|null} [ctx.lastProjectUsed]
 * @param {Array<{name:string, description?:string}>} ctx.projects
 * @param {string[]} [ctx.projectFiles]    - relative file paths inside the current project
 * @param {string|null} [ctx.readmeContent] - README.md content of the current project
 */
function buildAgenticBriefing(ctx = {}) {
  const current = ctx.currentProject || null;
  const last = ctx.lastProjectUsed || null;
  const projects = Array.isArray(ctx.projects) ? ctx.projects : [];
  const projectFiles = Array.isArray(ctx.projectFiles) ? ctx.projectFiles : [];
  const readmeContent = ctx.readmeContent || null;

  const projectList = projects.length === 0
    ? '    <None/>\n'
    : projects.map(p => `    <Project name="${escapeXml(p.name)}"${p.name === current ? ' current="true"' : ''}>${escapeXml(p.description || '')}</Project>\n`).join('');

  const projectFilesBlock = current
    ? (projectFiles.length > 0
      ? `\n    <ProjectFiles>\n${projectFiles.map(f => `      ${escapeXml(f)}`).join('\n')}\n    </ProjectFiles>`
      : '\n    <ProjectFiles/>')
    : '';

  const readmeBlock = (current && readmeContent)
    ? `\n    <ProjectReadme>\n${escapeXml(readmeContent.trim())}\n    </ProjectReadme>`
    : '';

  return `<AgenticToolkit unlocked="true">
  <PersonalCloud>
    <Layout>
      Quota: 1 GB.
      Core folders (immutable):
      - history/          (read-only, never re-deliver)
      - permanent/        (long-term storage)
      - searched_images/  (image_search saves with save_to_disk=true)
      - projects/<slug>/  (code/, temp/, output/, README.md)
    </Layout>
    <Rules>
- One project per user request. Run \`gemix-project create\` before producing files.
- bash and code_execution: can run WITHOUT a project (quick calculations, checks), but CANNOT create/modify files without one.
- Write/edit access ONLY inside current project: code/ (scripts), temp/ (intermediate), output/ (deliverables).
- Zip directories into output/ to deliver them.
    </Rules>
    <ProjectManagement>
      Run via \`bash\` as standalone \`gemix-project <subcmd>\` (no chaining/redirection).
      Commands:
       - list
       - create '{"name":"slug","description":"...","user_request":"...","strategy":"..."}'
       - switch <slug>
       - quota
       - delete <slug> --confirmed  # ASK user for confirmation
       - cleanup [<slug_default_current>] <subdir>...  # subdirs: temp|output|code
       - copy-to-permanent <history_filename>
       - copy-to-project <source> [<subdir_default_temp>]
    </ProjectManagement>
    <FileDelivery>
      CRITICAL: output/ files are AUTO-DELIVERED — do NOT call attach_file for them.
      - For files in other paths: call attach_file.
      - For directories: zip into output/ first.
    </FileDelivery>
    <CurrentProject>${current ? escapeXml(current) : 'None'}</CurrentProject>${readmeBlock}${projectFilesBlock}
    <LastProjectUsed>${last ? escapeXml(last) : 'None'}</LastProjectUsed>
    <Projects>
${projectList}    </Projects>
  </PersonalCloud>

  <PythonSandbox>
    <Runtime>
      Python 3.12, stateful Jupyter kernel; variables persist across calls.
      Working dir: /workspace (mapped to projects/<current>/).
      Read-only mounts: /readonly/{history,permanent,searched_images}.
      Resources: 1 CPU, 1.5 GB RAM, 30s timeout (max 120s).
      Network: NO INTERNET except api.polygon.io, astropy, yt-dlp, X (Twitter), Instagram, TikTok, Facebook.
      pip: DISABLED. Only pre-installed libraries.
    </Runtime>
    <OSTools>ffmpeg, tesseract-ocr, libcairo, poppler-utils</OSTools>
    <Libraries>numpy, scipy, sympy, mpmath, pandas, matplotlib, seaborn, plotly, Pillow, rembg, cairosvg, pytesseract, pydub, librosa, moviepy, astropy, qutip, polygon-api-client, python-docx, openpyxl, python-pptx, reportlab, yt-dlp</Libraries>
    <Pitfalls>
    - matplotlib: always plt.close() after savefig(), never plt.show()
    - moviepy: pass codec='libx264', audio_codec='aac' for WhatsApp/Discord previews
    - rembg: u2netp is faster
    - Flush plots: savefig() → plt.close() → then open with PIL
    - yt-dlp: MUST use bash CLI directly. Supports YouTube, X (Twitter), Instagram, TikTok, Facebook. Always -o '/workspace/output/%(title)s.%(ext)s', limit resolution (e.g. -f "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best"). Never pass proxy arguments.
    - mpmath: use \`mpmath.mp.dps\` for precision (avoid partial imports)
    </Pitfalls>
  </PythonSandbox>

  <ToolExecution>
- ALWAYS OPTIMIZE ROUNDS: chain \`gemix-project create\` or \`gemix-project switch\` (phase: before_all) with your first action (phase: after_all) in the same round. Never wait for a separate round just to set up the project.
- Execution Sequence (1-2-3):
    1. \`before_all\`: bash or code_execution (e.g. gemix-project create / switch)
    2. \`standard\`: write_file, edit_file, read_file, web_search, other bash or code_execution, etc.
    3. \`after_all\` (default): bash or code_execution (e.g. yt-dlp, python code/script.py)
- Use \`background: true\` ONLY for slow tasks (>1 min) AND only if you have other tools to run in parallel.
  </ToolExecution>
</AgenticToolkit>`;
}

module.exports = { buildAgenticBriefing };
