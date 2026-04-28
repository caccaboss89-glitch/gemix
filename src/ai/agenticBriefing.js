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
    : projects.map(p => `    <Project name="${_escapeXml(p.name)}"${p.name === current ? ' current="true"' : ''}>${_escapeXml(p.description || '')}</Project>\n`).join('');

  const projectFilesBlock = current
    ? (projectFiles.length > 0
        ? `\n    <ProjectFiles>\n${projectFiles.map(f => `      ${_escapeXml(f)}`).join('\n')}\n    </ProjectFiles>`
        : '\n    <ProjectFiles/>')
    : '';

  const readmeBlock = (current && readmeContent)
    ? `\n    <ProjectReadme>\n${_escapeXml(readmeContent.trim())}\n    </ProjectReadme>`
    : '';

  return `<AgenticToolkit unlocked="true">
  <PersonalCloud>
    <Layout>
      Quota: 1 GB total.
      Core folders (cannot be renamed/deleted):
      - history/ : read-only, never re-deliver.
      - permanent/ long-term cloud storage.
      - searched_images/ image_search results saved with save_to_disk=true.
      - projects/&lt;slug&gt;/ contains code/, temp/, output/, README.md.
    </Layout>
    <Rules>
      - One project per user request. Run \`gemix-project create\` before producing files.
      - bash and code_execution: can run WITHOUT a selected project (for quick calculations, checks), but CANNOT create or modify files in this mode. To produce files (downloads, plots, scripts), you MUST create or switch to a project first.
      - Write/edit access ONLY inside current project: code/ (scripts), temp/ (intermediate), output/ (deliverables).
      - Zip directories into output/ to deliver them (for many files).
      - ALWAYS use report_to_user before multi-step operations (+3 tools).
    </Rules>
    <ProjectManagement>
      Run via \`bash\` as standalone \`gemix-project &lt;subcmd&gt;\` (no chaining/redirection).
      Commands:
       - list # list all projects
       - create '{"name":"slug","description":"...","user_request":"...","strategy":"..."}' # create a new project
       - switch &lt;slug&gt; # re-enter an existing project
       - quota # show used/free space and per-project sizes
       - delete &lt;slug&gt; --confirmed # ASK the user for confirmation
       - cleanup [&lt;slug_default_current&gt;] &lt;subdir&gt;... # subdirs: temp|output|code
       - copy-to-permanent &lt;history_filename&gt; # move file to cloud
       - copy-to-project &lt;source&gt; [&lt;subdir_default_temp&gt;] # move file to project
    </ProjectManagement>
    <FileDelivery>
      - Files written under projects/&lt;current&gt;/output/ are AUTO-buffered AND AUTO-DELIVERED in the current chat. NOT call attach_file.
      - For files in other paths (if user needs them): call attach_file.
      - To deliver a directory: zip it into output/ first (via bash or code_execution).
    </FileDelivery>
    <CurrentProject>${current ? _escapeXml(current) : 'None'}</CurrentProject>${readmeBlock}${projectFilesBlock}
    <LastProjectUsed>${last ? _escapeXml(last) : 'None'}</LastProjectUsed>
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
      Network: NO INTERNET except api.polygon.io, astropy servers, YouTube CDN (yt-dlp only). Do NOT pip install.
    </Runtime>
    <Libraries>
      numpy, scipy, sympy, mpmath, pandas, matplotlib, seaborn, plotly, Pillow, rembg, cairosvg, pytesseract, pydub, librosa, moviepy, astropy, qutip, polygon-api-client, python-docx, openpyxl, python-pptx, reportlab, yt-dlp.
    </Libraries>
    <Pitfalls>
      - matplotlib: always plt.close() after savefig(), never plt.show()
      - moviepy: pass codec='libx264', audio_codec='aac' for compatibility on WhatsApp/Discord previews
      - rembg: quality — u2netp: faster
      - Flush plots before reading: savefig() → plt.close() → then open with PIL
      - yt-dlp: outtmpl='/workspace/output/%(title)s.%(ext)s'.
    </Pitfalls>
  </PythonSandbox>
  <ToolExecution>
    - In the same round you can run write_file/edit_file and bash/code_execution to optimize rounds. write_file/edit_file are always executed BEFORE bash/code_execution. You can create files and run them in one call.
    - Use only bash background=true for long tasks when you have other operations to perform simultaneously. For normal commands or if you don't need to invoke other tools in the meantime, leave it off.
  </ToolExecution>
</AgenticToolkit>`;
}

module.exports = { buildAgenticBriefing };
