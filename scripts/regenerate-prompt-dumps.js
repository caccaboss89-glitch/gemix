/**
 * TEST SCRIPT — regenerate all 15 system prompt dumps + validate formatting
 *
 * For each case 1–15, runs `dump-prompt-case.js`, writes
 * `agent-tools/case01-dump.txt` … `case15-dump.txt`, then checks:
 *   - Rules sub-tag bullets use 8-space indent; Platform children idem
 *   - Flat sections (Identity, ToolUsage, Limits, Capabilities) use 4-space indent
 *   - No stale prompt lines (footer in AccountOwner, read_music_stats in Capabilities, …)
 *
 * Exits non-zero if any check fails. Safe to run offline (loads members.json like the app).
 *
 * Usage (from repo root):
 *   node scripts/regenerate-prompt-dumps.js
 *
 * @see PLATFORM_BEHAVIOR.md — "Prompt audit scripts"
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'agent-tools');
const DUMP_SCRIPT = path.join(__dirname, 'dump-prompt-case.js');

const ISSUES = [];

function validatePrompt(text, caseId) {
  const lines = text.split(/\r?\n/);
  const promptStart = lines.findIndex(l => l.startsWith('<Identity>'));
  if (promptStart < 0) {
    ISSUES.push({ caseId, msg: 'missing <Identity>' });
    return;
  }
  const prompt = lines.slice(promptStart).join('\n');

  if (/\s+\n<\/[A-Za-z]+>/.test(prompt)) {
    ISSUES.push({ caseId, msg: 'trailing whitespace before a closing tag' });
  }
  if (prompt.includes('native processing via tunnel')) {
    ISSUES.push({ caseId, msg: 'contains native processing via tunnel' });
  }
  const cap = prompt.match(/<Capabilities>[\s\S]*?<\/Capabilities>/);
  if (cap) {
    if (cap[0].includes('read_music_stats')) {
      ISSUES.push({ caseId, msg: 'Capabilities mentions read_music_stats' });
    }
    if (cap[0].includes('read_server_rules')) {
      ISSUES.push({ caseId, msg: 'Capabilities mentions read_server_rules' });
    }
    if (cap[0].includes('scheduled reminders')) {
      ISSUES.push({ caseId, msg: 'Capabilities mentions scheduled reminders' });
    }
    if (/\bExample:/.test(cap[0])) {
      ISSUES.push({ caseId, msg: 'Capabilities still uses legacy Example: bullets' });
    }
  }
  const tu = prompt.match(/<ToolUsage>[\s\S]*?<\/ToolUsage>/);
  if (tu) {
    if (tu[0].includes('read_music_stats')) ISSUES.push({ caseId, msg: 'ToolUsage mentions read_music_stats' });
    if (tu[0].includes('read_server_rules')) ISSUES.push({ caseId, msg: 'ToolUsage mentions read_server_rules' });
  }

  const rules = prompt.match(/<Rules>[\s\S]*?<\/Rules>/);
  if (rules) {
    for (const tag of ['Output', 'Style', 'Grounding', 'Visibility']) {
      const re = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n    </${tag}>`);
      const m = rules[0].match(re);
      if (!m) {
        ISSUES.push({ caseId, msg: `Rules <${tag}> block malformed` });
        continue;
      }
      const bodyLines = m[1].split('\n').filter(l => l.trim());
      for (const bl of bodyLines) {
        if (!bl.startsWith('        ')) {
          ISSUES.push({ caseId, msg: `Rules <${tag}> line missing 8-space indent: ${bl.slice(0, 40)}` });
        }
      }
    }
  }

  if (prompt.includes('GemiX replies use the footer')) {
    ISSUES.push({ caseId, msg: 'AccountOwner still mentions footer' });
  }

  const convo = prompt.match(/<Conversation>[\s\S]*?<\/Conversation>/);
  if (convo) {
    const plat = convo[0].match(/<Platform[\s\S]*?<\/Platform>/);
    if (plat) {
      for (const pl of plat[0].split('\n').slice(1, -1)) {
        const t = pl.trim();
        if (!t || t.startsWith('</Platform>')) continue;
        if (!pl.startsWith('        ')) {
          ISSUES.push({ caseId, msg: `Platform child not 8-space indented: ${t.slice(0, 50)}` });
          break;
        }
      }
    }
  }

  for (const tag of ['Identity', 'ToolUsage', 'Limits', 'Capabilities']) {
    const re = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`);
    const m = prompt.match(re);
    if (!m) continue;
    for (const line of m[0].split('\n').slice(1, -1)) {
      if (!line.trim()) continue;
      if (!line.startsWith('    ') || line.startsWith('        ')) {
        ISSUES.push({ caseId, msg: `${tag} body not at 4-space indent` });
        break;
      }
    }
  }
}

if (fs.existsSync(OUT_DIR)) {
  for (const f of fs.readdirSync(OUT_DIR)) {
    fs.unlinkSync(path.join(OUT_DIR, f));
  }
} else {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

for (let id = 1; id <= 15; id++) {
  let out = execSync(`node "${DUMP_SCRIPT}" ${id}`, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  const idx = out.indexOf('<Identity>');
  if (idx >= 0) {
    const header = out.slice(0, idx).trim();
    out = (header ? `${header}\n\n` : '') + out.slice(idx);
  }
  const file = path.join(OUT_DIR, `case${String(id).padStart(2, '0')}-dump.txt`);
  fs.writeFileSync(file, out, 'utf8');
  validatePrompt(out, id);
  console.log(`Wrote ${file}`);
}

if (ISSUES.length) {
  console.error('\nValidation issues:');
  for (const i of ISSUES) console.error(`  case ${i.caseId}: ${i.msg}`);
  process.exit(1);
}
console.log('\nAll 15 dumps OK.');