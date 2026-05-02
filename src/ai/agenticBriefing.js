// src/ai/agenticBriefing.js
const { escapeXml } = require('../utils/xmlEscape');
const { loadSkills, formatSkillsForPrompt } = require('../utils/skills');

function buildAgenticBriefing(ctx = {}) {
  const current = ctx.currentProject || null;
  const last = ctx.lastProjectUsed || null;
  const projects = Array.isArray(ctx.projects) ? ctx.projects : [];
  const projectFiles = Array.isArray(ctx.projectFiles) ? ctx.projectFiles : [];
  const readmeContent = ctx.readmeContent || null;

  const projectList = projects.length === 0
    ? '    <None/>\n'
    : projects.map(p => `    <Project name="${escapeXml(p.name)}"${p.name === current ? ' current="true"' : ''}>${escapeXml(p.description || '')}</Project>\n`).join('');

  const projectFilesBlock = (current && projectFiles.length > 0)
    ? `\n    <ProjectFiles>\n${projectFiles.map(f => `      ${escapeXml(f)}`).join('\n')}\n    </ProjectFiles>`
    : '';

  const readmeBlock = (current && readmeContent)
    ? `\n    <ProjectReadme>\n${escapeXml(readmeContent.trim())}\n    </ProjectReadme>`
    : '';

  return `<AgenticToolkit unlocked="true">
  <PersonalCloud>
    <Layout>
      Quota: 1 GB.
      Immutable folders: history/ (read-only), permanent/ (storage), searched_images/ (image_search saves with save_to_disk=true).
      Project folders: projects/<slug>/ (contains code/, temp/, output/).
    </Layout>
    <Rules>
      - One project per user request. Use \`gemix-project create\` before writing files.
      - Write/edit access ONLY inside the current project: code/ (scripts), temp/ (intermediate), output/ (final files).
      - Sandbox root (\`/workspace\`) is mapped to the current project.
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
      CRITICAL: Files in output/ are AUTO-DELIVERED after your text response. 
      - For files in other paths: call attach_file. 
      - For 4+ files or directories: zip them into output/ first.
    </FileDelivery>
    <Status>
      - Selected Project: ${current || 'None'}
      - Last Used: ${last || 'None'}${readmeBlock}${projectFilesBlock}
    </Status>
    <Projects>
${projectList}    </Projects>
  </PersonalCloud>

${formatSkillsForPrompt(loadSkills())}

  <PythonSandbox>
    <Runtime>
      Python 3.12, stateful. Root /workspace is your project. Read-only: /readonly/.
      Resources: 1.5GB RAM, 120s timeout. Network: NO INTERNET except Polygon API, astropy, yt-dlp. pip: DISABLED. Only pre-installed libraries.
    </Runtime>
    <OSTools>ffmpeg, tesseract-ocr, libcairo, poppler-utils</OSTools>
    <Libraries>numpy, scipy, sympy, mpmath, pandas, matplotlib, seaborn, plotly, Pillow, rembg, cairosvg, pytesseract, pydub, librosa, moviepy, astropy, qutip, polygon-api-client, docx, openpyxl, pptx, reportlab, pypdf, jinja2, PyYAML, yt-dlp</Libraries>
    <Pitfalls>
      - Matplotlib: Always call plt.close() after savefig().
      - Moviepy: Use codec='libx264' and audio_codec='aac'.
      - Flush plots: savefig() → plt.close() → then open with PIL.
      - yt-dlp: MUST use bash CLI directly. NEVER use python -c or import yt_dlp. Always -o '/workspace/output/%(title)s.%(ext)s', limit resolution (-f "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best"). Only videos, no images. No proxy args. If fails with a network/connection error (sandbox proxy not working), do NOT retry — report via bug_report and inform the user.
      - Python Strings: ALWAYS use raw strings (r"...") for LaTeX equations, regex, or paths with backslashes.
    </Pitfalls>
  </PythonSandbox>

  <ToolExecution>
    - **GOLDEN RULE 1: READ SKILL FIRST**. If a request matches a skill, you **MUST** call \`read_file\` on its \`<Source>\` path. DO NOT do any other work in that round.
    - **GOLDEN RULE 2: PATHS**. \`read_file\`, \`write_file\`, \`edit_file\` **ALWAYS** need the full path: \`projects/<slug>/{code|temp|output}/filename\`. NEVER omit the \`path\` argument.
    - **GOLDEN RULE 3: PROJECT CREATION**. Use \`gemix-project create '{\"name\":\"slug\",\"user_request\":\"...\"}'\`. You **MUST** use single quotes \`'\` around the JSON and double quotes \`"\` inside. Ensure the JSON is valid and complete.
    - **GOLDEN RULE 4: 1-ROUND PIPELINE**. After reading the skill, you can do everything in ONE round using phases:
        1. \`before_all\`: \`gemix-project create\`
        2. \`standard\`: \`write_file\` (use full paths!)
        3. \`after_all\`: \`bash\` (execution)
    - **GOLDEN RULE 5: OUTPUT HYGIENE**. Only put the FINAL PDF/Video in \`output/\`. Put figures, logs, and temp files in \`temp/\`. Garbage in \`output/\` results in garbage delivered to the user.
    - **GOLDEN RULE 6: SYMPY**. Use \`sp.symbols('hbar')\` or sottomodules like \`sympy.physics.units\`. \`sp.hbar\` does NOT exist.
    - **SANDBOX PATHS**: Inside \`bash\` or \`code_execution\`, the project is already at \`/workspace\`. Use \`code/file.py\` or \`temp/data.json\`.
    - **EXECUTION PHASES**: 1. \`before_all\` (setup) | 2. \`standard\` (I/O) | 3. \`after_all\` (run/compile).
  </ToolExecution>
</AgenticToolkit>`;
}

module.exports = { buildAgenticBriefing };
