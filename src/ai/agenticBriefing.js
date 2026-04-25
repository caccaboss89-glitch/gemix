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
      Python 3.12 — stateful Jupyter kernel per (user, project). Variables persist across code_execution calls.
      Working dir = /workspace (mapped to projects/&lt;current&gt;/). Read-only mounts: /readonly/history, /readonly/permanent, /readonly/searched_images.
      Resources per call: cpu=1, mem=1.5 GB, /tmp tmpfs=256 MB, default timeout 30s (max 120s), pids_limit=200, no-new-privileges, all caps dropped.
      pip is DISABLED at runtime — only the libraries listed below are usable. ffmpeg, tesseract-ocr, libcairo, poppler-utils are pre-installed at OS level.
    </Runtime>
    <NetworkPolicy>
      The sandbox has NO free internet. All HTTP traffic is forced through an egress proxy that allows ONLY:
        - api.polygon.io (finance OHLCV / news via polygon-api-client)
        - astropy data servers (tabular catalogs, ephemerides)
      Every other URL — APIs, scrapers, model downloads, npm/pypi mirrors — WILL FAIL with a connection error.
      For everything else use the dedicated tools at the top level: web_search, browse_page, image_search, read_file, attach_file. Do NOT reimplement web fetching with requests inside code_execution.
    </NetworkPolicy>
    <Libraries>
      Pinned versions (see sandbox/requirements-sandbox.txt). Practical examples per library:

      Math &amp; symbolic
      - numpy 2.1.3       → arr = np.linspace(0, 2*np.pi, 200); y = np.sin(arr); fft = np.fft.rfft(y)
      - scipy 1.14.1      → from scipy.optimize import minimize; from scipy.signal import butter, filtfilt; from scipy.stats import norm
      - sympy 1.13.3      → from sympy import symbols, solve, integrate, diff, latex, Matrix; x=symbols('x'); solve(x**2-3, x)
      - mpmath 1.3.0      → high-precision arithmetic: mpmath.mp.dps=50; mpmath.zeta(2)

      Data
      - pandas 2.2.3      → df = pd.read_csv('/workspace/code/in.csv'); df.groupby('cat').agg({'val':'mean'}).to_excel('output/summary.xlsx')

      Visualization (Agg backend, no GUI; save to figures/ or output/)
      - matplotlib 3.9.2  → import matplotlib.pyplot as plt; plt.plot(x,y); plt.savefig('figures/fig.png', dpi=160, bbox_inches='tight'); plt.close()
      - seaborn 0.13.2    → sns.heatmap(df.corr(), annot=True); plt.savefig('figures/heat.png')
      - plotly 5.24.1     → import plotly.express as px; fig=px.scatter(df,x='a',y='b',color='c'); fig.write_html('output/plot.html'); fig.write_image('figures/plot.png')

      Image manipulation
      - Pillow 11.0.0     → from PIL import Image, ImageDraw, ImageFilter; im=Image.open('/readonly/permanent/photo.jpg').convert('RGB'); im.thumbnail((1024,1024)); im.save('output/thumb.jpg', quality=85)
      - rembg 2.0.59      → from rembg import remove; out=remove(open('figures/in.png','rb').read()); open('output/no_bg.png','wb').write(out)   # u2net + u2netp pre-downloaded, OFFLINE
      - cairosvg 2.7.1    → cairosvg.svg2png(url='figures/icon.svg', write_to='output/icon.png', output_width=512)
      - pytesseract 0.3.13→ import pytesseract, PIL.Image as I; text=pytesseract.image_to_string(I.open('/readonly/history/scan.jpg'), lang='ita+eng')

      Audio / video (ffmpeg pre-installed)
      - pydub 0.25.1      → from pydub import AudioSegment; a=AudioSegment.from_file('/readonly/history/voice.ogg'); a[:30000].export('output/clip.mp3', format='mp3', bitrate='192k')
      - librosa 0.10.2    → y, sr = librosa.load('/readonly/history/song.mp3', sr=22050); tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
      - moviepy 1.0.3     → from moviepy.editor import VideoFileClip, concatenate_videoclips; clip=VideoFileClip('/readonly/history/in.mp4').subclip(0,10).resize(0.5); clip.write_videofile('output/short.mp4', codec='libx264', audio_codec='aac')

      Physics &amp; astronomy (controlled-API only)
      - astropy 6.1.5     → from astropy.coordinates import SkyCoord; from astropy import units as u; from astropy.io.votable import parse_single_table   # data fetch via simbad/vizier WHEN allowed by proxy
      - qutip 5.0.4       → import qutip as qt; psi=qt.basis(2,0); H=qt.sigmax(); res=qt.mesolve(H, psi, np.linspace(0,5,100), [], [qt.sigmaz()])

      Finance (api.polygon.io allowed)
      - polygon-api-client 1.14.5 → from polygon import RESTClient; c=RESTClient(api_key=os.environ.get('POLYGON_API_KEY','')); aggs=c.get_aggs('AAPL','1','day','2025-01-01','2025-04-01')

      Document creation
      - python-docx 1.1.2 → from docx import Document; d=Document(); d.add_heading('Report',0); d.add_paragraph('text'); d.save('output/report.docx')
      - openpyxl 3.1.5    → from openpyxl import Workbook; wb=Workbook(); ws=wb.active; ws.append(['col','val']); ws.append(['a',1]); wb.save('output/data.xlsx')
      - python-pptx 1.0.2 → from pptx import Presentation; p=Presentation(); s=p.slides.add_slide(p.slide_layouts[0]); s.shapes.title.text='Hi'; p.save('output/deck.pptx')
      - reportlab 4.2.5   → from reportlab.pdfgen import canvas; c=canvas.Canvas('output/doc.pdf'); c.setFont('Helvetica',14); c.drawString(72,800,'Title'); c.showPage(); c.save()

      Networking helper (proxy-restricted)
      - requests 2.32.3   → use ONLY for api.polygon.io / astropy data servers (proxy-allowed). Any other host fails — use web_search / browse_page tools instead.
    </Libraries>
    <CommonPitfalls>
      - matplotlib: always plt.close() after savefig to release memory; never plt.show().
      - moviepy: pass codec='libx264', audio_codec='aac' for compatibility on WhatsApp/Discord previews.
      - reportlab: produces low-quality wraps; for prose-heavy docs prefer python-docx + LibreOffice convert via bash if PDF needed.
      - rembg: heavy models — u2netp is ~5x faster on small images.
      - pandas writing Excel: use openpyxl engine implicitly; chart support requires explicit openpyxl.chart imports.
      - Always flush plot buffers before reading them back: plt.savefig(...); plt.close(); then read with PIL if you need to compose images.
    </CommonPitfalls>
  </PythonSandbox>
</AgenticToolkit>`;
}

module.exports = { buildAgenticBriefing };
