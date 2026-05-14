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
  <Layout>
    Quota: 1 GB.
    Global Absolute Paths (read-only):
    - /readonly/history/ (Chat history logs)
    - /readonly/searched_images/ (Searched images with save_to_disk=true)
    - /readonly/skills/ (Global skill catalogs)

    Project Absolute Paths (writable, active project):
    - /workspace/code/ (Scripts and project code files)
    - /workspace/temp/ (Intermediate files, graphs and logs)
    - /workspace/output/ (Final deliverables; files here are AUTO-DELIVERED to the user)
  </Layout>
  <Rules>
    - Everything you access (files, folders, server paths) is strictly backend; users have zero visibility.
    - One project per user request. Use \`gemix-project create\` before writing files.
    - Write/edit access ONLY inside the current project: code/ (scripts), temp/ (intermediate), output/ (final files).
    - Standard Paths: ALWAYS use \`/workspace/{code|temp|output}/file\` for project files and \`/readonly/{history|searched_images|skills}/file\` for global storage.
    - Server Files: If the user refers to files run \`ls -la /readonly/directory_name/\` via bash. To attach files (to show them to the user) call \`attach_file\`.
    - NOTE: GemiX does NOT support audio/video editing or creation. Do not attempt to use pydub, librosa, or moviepy for media editing tasks.
  </Rules>
  <ProjectManagement>
    Run via \`bash\` as standalone \`gemix-project <subcmd>\` (no shell concatenation or piping).
    Commands:
    - list
    - create '{"name":"slug","description":"...","user_request":"...","strategy":"..."}' # JSON
    - switch <slug>
    - quota
    - delete <slug> --confirmed  # deletes an entire project only; ASK user for confirmation
    - cleanup [<slug_default_current>] <subdir>...  # deletes contents of project subdirs only;
    - copy-to-project </readonly/{history|searched_images}/file_or_history_pdf_folder> [<subdir_default_temp>]  # dirs allowed only for parsed PDF folders in history
    - delete-storage </readonly/searched_images/file_or_folder> --confirmed  # deletes a search-image file; ASK user for confirmation
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
${projectList}  </Projects>

${formatSkillsForPrompt(loadSkills())}

  <PythonSandbox>
    <Runtime>
      Python 3.12, stateful. Root: /workspace/. Read-only: /readonly/.
      Resources: 1.5GB RAM, 120s timeout. Network: NO INTERNET except specific domains used by: yt-dlp (video/media domains). pip: DISABLED. Only pre-installed libraries.
    </Runtime>
    <OSTools>tesseract-ocr, libcairo, poppler-utils, libreoffice</OSTools>
    <Libraries>numpy, scipy, sympy, mpmath, matplotlib, seaborn, plotly, Pillow, rembg, cairosvg, pytesseract, docx, openpyxl, pandas, pptx, reportlab, pypdf, jinja2, PyYAML</Libraries>
    <Pitfalls>
      - Bash Tool: Every shell command, Python script, or heavy command MUST run as a standalone \`bash\` call. NEVER use shell concatenation/piping/redirection (\`&&\`, \`||\`, \`;\`, \`|\`, \`>\`, \`<\`, \`()\`...) to combine steps in one tool call. Emit multiple \`bash\` calls in the same round, using \`execution_phase\` when ordering is needed.
      - Atomic Creation: If \`gemix-project create\` fails in a round, ALL subsequent \`write_file\` calls in that same round will fail with "No project selected".
      - SymPy Syntax: Input for \`latex_helper.py sympy\` MUST be a mathematical expression, NOT LaTeX code.
        • WRONG: \`\\frac{a}{b} = c\` (LaTeX), \`a == b\` (Comparison)
        • RIGHT: \`a/b = c\` (Math expression), \`Eq(a, b)\` (Explicit SymPy)
        • For physical constants (hbar, grad, etc.), use \`code_execution\`.
      - Matplotlib: Always call \`plt.close()\` after \`savefig()\`.
      - yt-dlp: MUST use bash CLI directly. Max 1080p resolution, no proxy args. Allowed domains: youtube.com, twitter.com, x.com, instagram.com, tiktok.com, facebook.com (and their CDNs).
      - Image Search: When searching for images intended for modification or inclusion in documents, ALWAYS set \`save_to_disk=true\`. This saves ALL images to /readonly/searched_images/ regardless of your final selection (with [image:N] tags).
      - Strings: Use raw strings (\`r"..."\`) for LaTeX/regex/paths.
      - Escaping: ALWAYS escape backticks (\`) with a backslash (\\\`) inside tool arguments or strings to avoid breaking the prompt/JSON structure.
    </Pitfalls>
  </PythonSandbox>

  <AgenticOrchestration>
    <OrchestrationRules>
      1. SKILL & PROJECT: If a task matches a skill and requires workspace actions, call \`read_file\` on its \`<Source>\` path AND \`gemix-project create\` in the SAME round. STOP the round after these calls to process the documentation before proceeding.
      2. PROJECT PATHS: Always use \`/workspace/{code|temp|output}/filename\`.
      3. HYGIENE: Final deliverables in \`/workspace/output/\`. Logs, figures, and snippets in \`/workspace/temp/\`.
      4. PARALLEL EFFICIENCY: Emit MULTIPLE tool calls in the SAME round whenever possible (e.g. \`gemix-project create\` + \`write_file\` + \`bash/code\`). Run verification checks (\`ls\`, \`cat\`, \`read_file\`) in the SAME round as the tool that creates/executes them (use \`after_all\` for verification).
    </OrchestrationRules>

    <ExecutionPhases>
      The \`execution_phase\` parameter exists ONLY for \`bash\` and \`code_execution\`. 
      The order in a multi-tool round is:
      - Phase 1 [before_all]: \`bash\`/\`code_execution\` with \`execution_phase="before_all"\`.
      - Phase 2 [standard]: ALL other tools (\`write_file\`, \`edit_file\`, \`read_file\`, \`web_search\`, etc.) — automatic, no parameter to set.
      - Phase 3 [after_all]: \`bash\`/\`code_execution\` without \`execution_phase\` (default) or with \`execution_phase="after_all"\`.
      - Phase 4 [final_response]: \`send_voice_message\`, \`send_whatsapp_message\` — always last.

      Within the same phase, tools execute in emission order.
      Tool B can read a FILE written by Tool A in a previous phase, but NOT its textual output.
    </ExecutionPhases>
  </AgenticOrchestration>
</AgenticToolkit>`;
}

module.exports = { buildAgenticBriefing };
