/**
 * TEST SCRIPT — system prompt snapshot (single case)
 *
 * Builds the same `buildSystemPrompt(ctx)` used on a real API call, with synthetic
 * `ctx` objects that mirror the 15 audit scenarios (WA personal/dedicated, Discord,
 * active vs non-active caller, batch, custom memory, workspace, first turn, emojis).
 *
 * Does not start the bot, call Hermes, or write files. Use for quick diff while editing
 * `systemPrompt.js` / `platformCapabilities.js`.
 *
 * Usage (from repo root):
 *   node scripts/dump-prompt-case.js <1-15>
 *
 * Output: header `=== CASE N … ===` then the prompt from `<Identity>` onward.
 * Case definitions must stay aligned with `regenerate-prompt-dumps.js`.
 *
 * @see PLATFORM_BEHAVIOR.md — "Prompt audit scripts"
 */
const { buildSystemPrompt } = require('../src/ai/systemPrompt');
const { PLATFORM_WA_PERSONAL, PLATFORM_WA_DEDICATED, PLATFORM_DISCORD } = require('../src/config/constants');

const ACTIVE = {
  isActiveMember: true,
  isAdmin: true,
  member: { name: 'Alberto Gagliardi', wa: 'admin@c.us', email: 'a@test.it' },
  taskFileId: 'member_alberto_gagliardi',
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
      userName: 'Alberto Gagliardi',
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
      userName: 'Alberto Gagliardi',
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
      userName: 'Alberto Gagliardi',
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
      userName: 'Alberto Gagliardi',
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
      userName: 'Alberto Gagliardi',
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
      userName: 'Alberto Gagliardi',
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
      userName: 'Alberto Gagliardi',
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
      userName: 'Alberto Gagliardi',
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
      userName: 'Alberto',
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
      userName: 'Alberto',
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
      userName: 'Alberto',
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
      userName: 'Alberto',
      userIdentity: ACTIVE,
      isFirstTurn: false,
      batchMultiSpeaker: false,
      rulesContext: '[STATUTE EXCERPT PLACEHOLDER]',
      serverEvents: 'Party - tomorrow',
      availableEmojis: '<:test:123>',
    },
  },
};

const id = process.argv[2];
const spec = CASES[id];
if (!spec) {
  console.error('Unknown case. Use 1-15.');
  process.exit(1);
}
console.log('=== CASE', id, spec.label, '===');
console.log(buildSystemPrompt(spec.ctx));