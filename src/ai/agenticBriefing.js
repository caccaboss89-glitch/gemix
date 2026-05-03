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
      Global folders (read-only): /readonly/ (contains history/ (chat history), permanent/ (user(s) cloud), searched_images/ (searched images saved with save_to_disk=true), skills/).
      Project folders (writable): /workspace/ (contains code/, temp/, output/).
    </Layout>
    <Rules>
      - One project per user request. Use \`gemix-project create\` before writing files.
      - Write/edit access ONLY inside the current project: code/ (scripts), temp/ (intermediate), output/ (final files).
      - Standard Paths: ALWAYS use \`/workspace/{code|temp|output}/file\` for project files and \`/readonly/{history|permanent|searched_images|skills}/file\` for global storage.
    </Rules>
    <ProjectManagement>
      Run via \`bash\` as standalone \`gemix-project <subcmd>\` (no shell concatenation or piping).
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
      Python 3.12, stateful. Root: /workspace/. Read-only: /readonly/.
      Resources: 1.5GB RAM, 120s timeout. Network: NO INTERNET except specific domains used by: Polygon API, astropy data services, yt-dlp (video/media domains). pip: DISABLED. Only pre-installed libraries.
    </Runtime>
    <OSTools>ffmpeg, tesseract-ocr, libcairo, poppler-utils</OSTools>
    <Libraries>numpy, scipy, sympy, mpmath, pandas, matplotlib, seaborn, plotly, Pillow, rembg, cairosvg, pytesseract, pydub, librosa, moviepy, astropy, qutip, polygon-api-client, docx, openpyxl, pptx, reportlab, pypdf, jinja2, PyYAML</Libraries>
    <Pitfalls>
      - Project Management: \`gemix-project\` commands MUST run as a standalone bash command. NO shell concatenation (\`&&\`, \`||\`, \`;\`, \`|\`, redirection). Concatenation causes an immediate error.
      - Atomic Creation: If \`gemix-project create\` fails in a round (e.g., due to invalid JSON or shell concatenation), ALL subsequent \`write_file\` calls in that same round will fail with "No project selected".
      - SymPy Syntax: Input for \`latex_helper.py sympy\` MUST be a mathematical expression, NOT LaTeX code.
        • WRONG: \`\\frac{a}{b} = c\` (LaTeX)
        • RIGHT: \`a/b = c\` (Math expression)
        • If you need physical constants (hbar, grad, etc.) and the tool fails, use \`code_execution\` for explicit definitions.
      - PDF Generation Timing: The system now has a 2s auto-wait for files. If \`unified_pdf_generator.py\` still fails in a phased round with "missing file" warnings, retry it in a dedicated round.
      - Matplotlib: Always call \`plt.close()\` after \`savefig()\`.
      - yt-dlp: MUST use bash CLI directly. Limit resolution, no proxy args.
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

      Within the same phase, tools execute in emission order.
      Tool B can read a FILE written by Tool A in a previous phase, but NOT its textual output.
    </ExecutionPhases>
  </AgenticOrchestration>
</AgenticToolkit>`;
}

module.exports = { buildAgenticBriefing };
