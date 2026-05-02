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
const { loadSkills, formatSkillsForPrompt } = require('../utils/skills');

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

  const skills = loadSkills();
  const skillsBlock = formatSkillsForPrompt(skills);

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
      - switch &lt;slug&gt;
      - quota
      - delete &lt;slug&gt; --confirmed  # ASK user for confirmation
      - cleanup [&lt;slug_default_current&gt;] &lt;subdir&gt;...  # subdirs: temp|output|code
      - copy-to-permanent &lt;history_filename&gt;
      - copy-to-project &lt;source&gt; [&lt;subdir_default_temp&gt;]
    </ProjectManagement>
    <FileDelivery>
      CRITICAL: output/ files are AUTO-DELIVERED (arrive AFTER (below) your text response). Do NOT call attach_file for them.
      - For files in other paths: call attach_file.
      - For directories OR 4+ output files: zip into output/ first, then deliver the zip.
    </FileDelivery>
    <CurrentProject>${current ? escapeXml(current) : 'None'}</CurrentProject>${readmeBlock}${projectFilesBlock}
    <LastProjectUsed>${last ? escapeXml(last) : 'None'}</LastProjectUsed>
    <Projects>
${projectList}    </Projects>
  </PersonalCloud>

${skillsBlock}
  <PythonSandbox>
    <Runtime>
      Python 3.12, stateful Jupyter kernel; variables persist across calls.
      Working dir: /workspace (mapped to projects/<current>/).
      Read-only mounts: /readonly/{history,permanent,searched_images,skills}.
      Resources: 1 CPU, 1.5 GB RAM, 30s timeout (max 120s).
      Network: NO INTERNET except api.polygon.io, astropy, yt-dlp servers.
      pip: DISABLED. Only pre-installed libraries.
    </Runtime>
    <OSTools>ffmpeg, tesseract-ocr, libcairo, poppler-utils</OSTools>
    <Libraries>numpy, scipy, sympy, mpmath, pandas, matplotlib, seaborn, plotly, Pillow, rembg, cairosvg, pytesseract, pydub, librosa, moviepy, astropy, qutip, polygon-api-client, python-docx, openpyxl, python-pptx, reportlab, pypdf, jinja2, PyYAML, yt-dlp</Libraries>
    <Pitfalls>
    - matplotlib: always plt.close() after savefig(), never plt.show()
    - moviepy: pass codec='libx264', audio_codec='aac' for WhatsApp/Discord previews
    - rembg: u2netp is faster
    - Flush plots: savefig() → plt.close() → then open with PIL
    - yt-dlp: MUST use bash CLI directly. NEVER use python -c or import yt_dlp. Always -o '/workspace/output/%(title)s.%(ext)s', limit resolution (-f "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best"). Only videos, no images. No proxy args.
      If yt-dlp fails with a network/connection error (sandbox proxy not working), do NOT retry — report via bug_report and inform the user.
    - mpmath: use \`mpmath.mp.dps\` for precision (avoid partial imports)
    </Pitfalls>
  </PythonSandbox>

  <ToolExecution>
  - ALWAYS OPTIMIZE ROUNDS: You MUST chain commands. Never use one round just to set up a project or unlock the toolkit.
  - COMPULSORY SKILLS: If a &lt;Skill&gt; is available, you MUST output a \`read_file\` call for its &lt;Source&gt; path. If you haven't read it yet, DO IT NOW alongside your next tool call. DO NOT write manual scripts or guess code before reading the skill.
  - FILE CREATION: NEVER use \`bash\` with \`cat << EOF\` or \`echo\` to create files. ALWAYS use the native \`write_file\` tool to avoid length limits and escaping bugs.
  - STATE DEPENDENCY EXCEPTION: You are GUARANTEED that if you call \`bash\` (project create) and \`write_file\` simultaneously, the system will execute the bash command first. DO NOT separate them into two rounds!
  - CHAINING EXAMPLES:
      * Round 1: \`agentic_unlock\` + \`read_file\` (skill documentation)
      * Round 2: \`bash\` (command: \`gemix-project create ...\`, execution_phase: before_all) + \`write_file\` (your first script) + \`bash\` (command: \`python script.py\`, execution_phase: after_all)
  - Execution Sequence (1-2-3):
      1. \`before_all\`: bash or code_execution (e.g. gemix-project create / switch)
      2. \`standard\`: write_file, edit_file, read_file, web_search, other bash or code_execution, etc.
      3. \`after_all\` (default): bash or code_execution (e.g. yt-dlp, python code/script.py)
  - Use \`background: true\` ONLY for slow tasks (>1 min) AND only if you have other tools to run in parallel.
  </ToolExecution>
</AgenticToolkit>`;
}

module.exports = { buildAgenticBriefing };
