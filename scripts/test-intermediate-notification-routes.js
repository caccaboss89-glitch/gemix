#!/usr/bin/env node
// Verifies intermediate-notification delivery targets for every platform shape.

const {
  PLATFORM_DISCORD,
  PLATFORM_WA_PERSONAL,
  PLATFORM_WA_DEDICATED,
} = require('../src/config/constants');
const { resolveIntermediateNotificationTarget } = require('../src/utils/intermediateNotification');
const { hasFooter } = require('../src/utils/footer');

// Mirror delivery formatting (personal WA needs footer for GemiX block detection).
function formatWaText(message, platform) {
  const { normalizeMarkdown } = require('../src/utils/text');
  const { removeDiscordEmoji } = require('../src/utils/discord');
  const { addFooter } = require('../src/utils/footer');
  let text = normalizeMarkdown(removeDiscordEmoji(message));
  if (platform === PLATFORM_WA_PERSONAL) text = addFooter(text, 'GemiX');
  return text;
}

const chat = { sendMessage: async () => {} };
const discordChannel = { send: async () => {} };

const cases = [
  {
    label: 'Discord thread',
    ctx: { platform: PLATFORM_DISCORD, discordChannel },
    want: 'discord',
  },
  {
    label: 'Discord missing channel',
    ctx: { platform: PLATFORM_DISCORD },
    want: null,
  },
  {
    label: 'WA personal with presence.chat',
    ctx: { platform: PLATFORM_WA_PERSONAL, presence: { chat }, chatId: '233@lid' },
    want: 'wa_chat',
  },
  {
    label: 'WA personal without chat (must not use dedicated JID)',
    ctx: { platform: PLATFORM_WA_PERSONAL, chatId: '233@lid', waJid: '393@c.us' },
    want: null,
  },
  {
    label: 'WA dedicated DM with chat',
    ctx: { platform: PLATFORM_WA_DEDICATED, presence: { chat }, chatId: '393@c.us' },
    want: 'wa_chat',
  },
  {
    label: 'WA dedicated group with chat',
    ctx: {
      platform: PLATFORM_WA_DEDICATED,
      isGroup: true,
      presence: { chat },
      chatId: '120@g.us',
      groupId: '120@g.us',
    },
    want: 'wa_chat',
  },
  {
    label: 'WA dedicated JID fallback (no presence)',
    ctx: { platform: PLATFORM_WA_DEDICATED, chatId: '393@c.us' },
    want: 'wa_dedicated_jid',
  },
  {
    label: 'WA dedicated group JID fallback',
    ctx: { platform: PLATFORM_WA_DEDICATED, groupId: '120@g.us' },
    want: 'wa_dedicated_jid',
  },
];

let failed = 0;
for (const c of cases) {
  const target = resolveIntermediateNotificationTarget(c.ctx);
  const got = target?.channel ?? null;
  if (got !== c.want) {
    console.error(`FAIL [${c.label}]: expected ${c.want}, got ${got}`);
    failed++;
  } else {
    console.log(`ok  [${c.label}] → ${got}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}
const sample = formatWaText('Sto delegando…', PLATFORM_WA_PERSONAL);
if (!hasFooter(sample)) {
  console.error('FAIL [WA personal footer on intermediate text]');
  process.exit(1);
}
console.log('ok  [WA personal intermediate has GemiX footer]');

console.log(`\nAll ${cases.length} routing cases passed.`);