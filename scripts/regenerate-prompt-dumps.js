/**
 * Regenerate all 15 system prompt dumps + validate formatting.
 *
 * Writes agent-tools/case01-dump.txt … case15-dump.txt (offline, no Hermes).
 *
 * Usage (from repo root):
 *   node scripts/regenerate-prompt-dumps.js
 */
const fs = require('fs');
const path = require('path');
const { buildSystemPrompt } = require('../src/ai/systemPrompt');
const { PLATFORM_WA_PERSONAL, PLATFORM_WA_DEDICATED, PLATFORM_DISCORD } = require('../src/config/constants');
const { ADMIN_NAME } = require('../src/config/env');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'agent-tools');

const ADMIN_FIRST_NAME = (ADMIN_NAME || 'Test Admin').split(/\s+/)[0];

const ACTIVE = {
  isActiveMember: true,
  isAdmin: true,
  member: { name: ADMIN_NAME, wa: 'admin@c.us', email: 'a@test.it' },
  taskFileId: 'member_test_admin',
};
const NON_ACTIVE = {
  isActiveMember: false,
  isAdmin: false,
  member: null,
  taskFileId: 'wa_3999999999',
};

const CASES = {
  1: {
    label: 'WA personal — admin/active, baseline',
    ctx: {
      platform: PLATFORM_WA_PERSONAL,
      isGroup: false,
      chatId: 'personal_chat@test',
      userName: ADMIN_NAME,
      userIdentity: ACTIVE,
      batchMultiSpeaker: false,
      groupMemory: null,
      userWorkspace: null,
    },
  },
  2: {
    label: 'WA personal — non-active caller',
    ctx: {
      platform: PLATFORM_WA_PERSONAL,
      isGroup: false,
      chatId: 'personal_chat@test',
      userName: 'Guest User',
      userIdentity: NON_ACTIVE,
      batchMultiSpeaker: false,
      groupMemory: null,
      userWorkspace: null,
    },
  },
  3: {
    label: 'WA personal — batch multi-speaker',
    ctx: {
      platform: PLATFORM_WA_PERSONAL,
      isGroup: false,
      chatId: 'personal_chat@test',
      userName: ADMIN_NAME,
      userIdentity: ACTIVE,
      batchMultiSpeaker: true,
      groupMemory: null,
      userWorkspace: null,
    },
  },
  4: {
    label: 'WA personal — custom shared memory',
    ctx: {
      platform: PLATFORM_WA_PERSONAL,
      isGroup: false,
      chatId: 'personal_chat@test',
      userName: ADMIN_NAME,
      userIdentity: ACTIVE,
      batchMultiSpeaker: false,
      groupMemory: 'Rispondi sempre in spagnolo per test.',
      userWorkspace: null,
    },
  },
  5: {
    label: 'WA personal — build workspace listed',
    ctx: {
      platform: PLATFORM_WA_PERSONAL,
      isGroup: false,
      chatId: 'personal_chat@test',
      userName: ADMIN_NAME,
      userIdentity: ACTIVE,
      batchMultiSpeaker: false,
      groupMemory: null,
      userWorkspace: {
        total: 2,
        files: [{ relPath: 'out/report.pdf' }, { relPath: 'chart.png' }],
        more: false,
      },
    },
  },
  6: {
    label: 'WA dedicated private — active',
    ctx: {
      platform: PLATFORM_WA_DEDICATED,
      isGroup: false,
      chatId: 'wa_priv@test',
      userName: ADMIN_NAME,
      userIdentity: ACTIVE,
      batchMultiSpeaker: false,
      userMemory: null,
      userWorkspace: null,
    },
  },
  7: {
    label: 'WA dedicated private — non-active',
    ctx: {
      platform: PLATFORM_WA_DEDICATED,
      isGroup: false,
      chatId: 'wa_priv@test',
      userName: 'Guest',
      userIdentity: NON_ACTIVE,
      batchMultiSpeaker: false,
      userMemory: null,
      userWorkspace: null,
    },
  },
  8: {
    label: 'WA dedicated private — custom user memory',
    ctx: {
      platform: PLATFORM_WA_DEDICATED,
      isGroup: false,
      chatId: 'wa_priv@test',
      userName: ADMIN_NAME,
      userIdentity: ACTIVE,
      batchMultiSpeaker: false,
      userMemory: 'Preferisci risposte brevi.',
      userWorkspace: null,
    },
  },
  9: {
    label: 'WA dedicated group — active',
    ctx: {
      platform: PLATFORM_WA_DEDICATED,
      isGroup: true,
      groupId: 'grp@test.g.us',
      groupName: 'Test Group',
      chatId: 'grp@test.g.us',
      userName: ADMIN_NAME,
      userIdentity: ACTIVE,
      batchMultiSpeaker: false,
      groupMemory: null,
      userWorkspace: null,
    },
  },
  10: {
    label: 'WA dedicated group — non-active',
    ctx: {
      platform: PLATFORM_WA_DEDICATED,
      isGroup: true,
      groupId: 'grp@test.g.us',
      groupName: 'Test Group',
      chatId: 'grp@test.g.us',
      userName: 'Guest',
      userIdentity: NON_ACTIVE,
      batchMultiSpeaker: false,
      groupMemory: null,
      userWorkspace: null,
    },
  },
  11: {
    label: 'WA dedicated group — batch multi-speaker',
    ctx: {
      platform: PLATFORM_WA_DEDICATED,
      isGroup: true,
      groupId: 'grp@test.g.us',
      groupName: 'Test Group',
      chatId: 'grp@test.g.us',
      userName: ADMIN_NAME,
      userIdentity: ACTIVE,
      batchMultiSpeaker: true,
      groupMemory: null,
      userWorkspace: null,
    },
  },
  12: {
    label: 'Discord — first turn',
    ctx: {
      platform: PLATFORM_DISCORD,
      isGroup: false,
      chatId: 'channel123',
      userName: ADMIN_FIRST_NAME,
      userIdentity: ACTIVE,
      isFirstTurn: true,
      batchMultiSpeaker: false,
      rulesContext: '[STATUTE EXCERPT PLACEHOLDER]',
      serverEvents: '',
      availableEmojis: '',
    },
  },
  13: {
    label: 'Discord — after GemiX replied',
    ctx: {
      platform: PLATFORM_DISCORD,
      isGroup: false,
      chatId: 'channel123',
      userName: ADMIN_FIRST_NAME,
      userIdentity: ACTIVE,
      isFirstTurn: false,
      batchMultiSpeaker: false,
      rulesContext: '[STATUTE EXCERPT PLACEHOLDER]',
      serverEvents: '',
      availableEmojis: '',
    },
  },
  14: {
    label: 'Discord — batch multi-speaker',
    ctx: {
      platform: PLATFORM_DISCORD,
      isGroup: false,
      chatId: 'channel123',
      userName: ADMIN_FIRST_NAME,
      userIdentity: ACTIVE,
      isFirstTurn: false,
      batchMultiSpeaker: true,
      rulesContext: '[STATUTE EXCERPT PLACEHOLDER]',
      serverEvents: 'No upcoming events.',
      availableEmojis: '',
    },
  },
  15: {
    label: 'Discord — guild emojis line present',
    ctx: {
      platform: PLATFORM_DISCORD,
      isGroup: false,
      chatId: 'channel123',
      userName: ADMIN_FIRST_NAME,
      userIdentity: ACTIVE,
      isFirstTurn: false,
      batchMultiSpeaker: false,
      rulesContext: '[STATUTE EXCERPT PLACEHOLDER]',
      serverEvents: 'Party - tomorrow',
      availableEmojis: '<:test:123>',
    },
  },
};

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
    if (/\bcurrent-turn buffer\b/i.test(tu[0]) && !/delivery buffer/i.test(tu[0])) {
      ISSUES.push({ caseId, msg: 'ToolUsage says "current-turn buffer" without "delivery buffer"' });
    }
  }

  const id = Number(caseId);
  if (id === 5) {
    if (!prompt.includes('<BuildWorkspace')) {
      ISSUES.push({ caseId, msg: 'case 5 missing BuildWorkspace block' });
    } else if (!/not in the delivery buffer/i.test(prompt)) {
      ISSUES.push({ caseId, msg: 'BuildWorkspace missing delivery-buffer wording' });
    }
    if (!prompt.includes('out/report.pdf')) {
      ISSUES.push({ caseId, msg: 'BuildWorkspace missing listed workspace paths' });
    }
  }
  if (id >= 12 && id <= 15 && tu && tu[0].includes('BuildWorkspace')) {
    ISSUES.push({ caseId, msg: 'Discord ToolUsage must not mention BuildWorkspace' });
  }
  if (/all audio\/video|tutti.*audio\/video/i.test(prompt) && /temp link|link temporaneo/i.test(prompt)) {
    ISSUES.push({ caseId, msg: 'obsolete proactive all A/V temp-link policy in prompt' });
  }

  const rules = prompt.match(/<Rules>[\s\S]*?<\/Rules>/);
  if (rules) {
    for (const tag of ['Output', 'Style', 'Grounding']) {
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
    // Visibility is a single-line tag at depth 1.
    if (!/ {4}<Visibility>[^\n]+<\/Visibility>/.test(rules[0])) {
      ISSUES.push({ caseId, msg: 'Rules <Visibility> line malformed' });
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

function renderCase(id) {
  const spec = CASES[id];
  const header = `=== CASE ${id} ${spec.label} ===`;
  const body = buildSystemPrompt(spec.ctx);
  const idx = body.indexOf('<Identity>');
  if (idx >= 0) return `${header}\n\n${body.slice(idx)}`;
  return `${header}\n\n${body}`;
}

if (fs.existsSync(OUT_DIR)) {
  for (const f of fs.readdirSync(OUT_DIR)) {
    fs.unlinkSync(path.join(OUT_DIR, f));
  }
} else {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

for (let id = 1; id <= 15; id++) {
  const out = renderCase(id);
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