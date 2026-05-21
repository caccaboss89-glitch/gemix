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
  <Status>
    - Project: ${current || 'None'}
    - Last Used: ${last || 'None'}${readmeBlock}${projectFilesBlock}
  </Status>
  <Projects>
${projectList}  </Projects>

  <Layout>
    Quota: 1 GB.
    Read-only:  /readonly/history/  /readonly/searched_images/  /readonly/skills/
    Writable:   /workspace/code/  /workspace/temp/  /workspace/output/
    output/ → delivery buffer. Other paths: use attach_file. Zip 4+ files first.
  </Layout>

  <Constraints>
    - Backend only — users cannot see files or paths.
    - One project per request. Run \`gemix-project create\` before writing files.
    - Writes only inside code/ (scripts), temp/ (intermediate), output/ (deliverables).
    - List user files: \`ls -la /readonly/<dir>/\` via bash.
    - No audio/video editing (pydub, librosa, moviepy not supported).
  </Constraints>

  <ProjectManagement>
    Standalone \`gemix-project <subcmd>\` via bash (no chaining):
    - list
    - create '{"name":"slug","description":"...","user_request":"...","strategy":"..."}'
    - switch <slug>
    - quota
    - delete <slug> --confirmed
    - cleanup [<slug>] <subdir>...
    - copy-to-project </readonly/{history|searched_images}/path> [<subdir>]
    - delete-storage </readonly/searched_images/path> --confirmed
  </ProjectManagement>

${formatSkillsForPrompt(loadSkills())}

  <ProjectSandbox>
    <Runtime>Linux container. /workspace/ writable, /readonly/ read-only. No internet except yt-dlp domains. pip disabled.</Runtime>
    <OSTools>tesseract-ocr, libcairo, poppler-utils, libreoffice, pdflatex/xelatex/lualatex, ffmpeg, yt-dlp</OSTools>
    <Pitfalls>
      - bash: standalone calls only — no \`&&\`, \`||\`, \`;\`, \`|\`, \`>\`, \`<\`, subshells. Use multiple bash calls with execution_phase when order matters.
      - Atomic creation: if \`gemix-project create\` fails, all write_file calls in the same round fail.
      - SymPy: pass math expressions to latex_helper.py, not LaTeX. \`a/b\` ✓, \`\\frac{a}{b}\` ✗. For hbar/grad/curl use code_interpreter.
      - Matplotlib: call \`plt.close()\` after every \`savefig()\`.
      - yt-dlp: bash CLI only, max 1080p, no proxy args. Domains: youtube.com, x.com, instagram.com, tiktok.com, facebook.com.
      - Image search for documents: set \`save_to_disk=true\` to persist to /readonly/searched_images/.
      - Raw strings for LaTeX/regex/paths: \`r"..."\`.
      - Escape backticks inside tool args: \\\`.
    </Pitfalls>
  </ProjectSandbox>

  <AgenticOrchestration>
    <Rules>
      1. Skill + project: call read_file on the skill's Source AND gemix-project create in the SAME round, then stop to read the docs before continuing.
      2. Paths: always absolute — /workspace/{code|temp|output}/filename.
      3. Hygiene: deliverables → output/, intermediate/logs → temp/.
      4. Parallelism: pack as many tool calls as possible into one round.
    </Rules>

    <ExecutionPhases>
      execution_phase on bash collapses two steps into one round:

      "before_all" — bash runs BEFORE write_file/read_file.
        bash inspect.py --output /workspace/temp/out.json  (before_all)
        write_file /workspace/temp/spec.json               ← can use out.json

      "after_all" (default) — bash runs AFTER write_file/read_file.
        write_file /workspace/code/edit.py
        bash python /workspace/code/edit.py                ← runs after write_file

      Multiple bash calls in the same phase run in emission order.
    </ExecutionPhases>
  </AgenticOrchestration>
</AgenticToolkit>`;
}

module.exports = { buildAgenticBriefing };
