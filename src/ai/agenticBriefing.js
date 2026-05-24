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
      - bash: standalone calls only — no \`&&\`, \`||\`, \`;\`, \`|\`, \`>\`, \`<\`, subshells. Emit multiple bash calls when you need several commands; they run in emission order, after any write_file/edit_file/read_file calls in the same round.
      - Atomic creation: if \`gemix-project create\` fails, all write_file calls in the same round fail.
      - SymPy → LaTeX: pass math expressions, not LaTeX, to \`sympy.latex(...)\`. \`a/b\` ✓, \`\\frac{a}{b}\` ✗. For hbar use \`from sympy.physics.quantum.constants import hbar\`; for grad/curl use \`sympy.vector\` or write the LaTeX directly.
      - Matplotlib: call \`plt.close()\` after every \`savefig()\`.
      - yt-dlp: bash CLI only, max 1080p, no proxy args. Domains: youtube.com, x.com, instagram.com, tiktok.com, facebook.com.
      - Image search for documents: set \`save_to_disk=true\` to persist to /readonly/searched_images/.
      - Raw strings for LaTeX/regex/paths: \`r"..."\`.
      - Escape backticks inside tool args: \\\`.
    </Pitfalls>
  </ProjectSandbox>

  <AgenticOrchestration>
    1. Skill + project: call read_file on the skill's Source AND gemix-project create in the SAME round, then stop to read the docs before continuing.
    2. Paths: always absolute — /workspace/{code|temp|output}/filename.
    3. Hygiene: deliverables → output/, intermediate/logs → temp/.
    4. Parallelism: pack as many tool calls as possible into one round. Within a round, write_file/edit_file/read_file always run before bash, and final-response delivery tools (send_voice_message, send_whatsapp_message) always run last — so you can write a script and execute it via bash in the same round.
  </AgenticOrchestration>
</AgenticToolkit>`;
}

module.exports = { buildAgenticBriefing };
