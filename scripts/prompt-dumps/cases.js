// scripts/prompt-dumps/cases.js
//
// The prompt-dump corpus: one entry per platform / membership / runtime-state
// combination whose prompt we want on disk and under validation.
//
// Every case is a plain handler-shaped ctx. Cases without explicit `settings`
// render the program defaults, like a fresh chat. A case may also carry a
// `deployment`, which renders it as a different provider profile. The corpus
// baseline is a generic provider; explicit xAI cases cover its isolated
// replacement block and native tools, independently of
// whichever provider the developer's .env selects.
//
// Discord note: conversation_title sits in text.format on every turn (its rules
// live there only — Runtime just carries the current Thread title to compare
// against), so no case needs to model it.

import constants from '../../src/config/constants.js';
import envConfig from '../../src/config/env.js';

const { PLATFORM_WA_PERSONAL, PLATFORM_WA_DEDICATED, PLATFORM_DISCORD } = constants;
const ADMIN_FIRST_NAME = (envConfig.ADMIN_NAME || 'Test Admin').split(/\s+/)[0];

const ACTIVE = {
  isActiveMember: true,
  isAdmin: true,
  member: { name: envConfig.ADMIN_NAME, wa: 'admin@c.us', email: 'a@test.it', admin: true },
  taskFileId: 'member_test_admin'
};
const ACTIVE_NON_ADMIN = {
  isActiveMember: true,
  isAdmin: false,
  member: { name: 'Member User', wa: 'member@c.us', email: 'm@test.it' },
  taskFileId: 'member_test_member'
};
const NON_ACTIVE = {
  isActiveMember: false,
  isAdmin: false,
  member: null,
  taskFileId: 'wa_3999999999'
};

/** Stable, non-sensitive roster used by the offline prompt corpus. */
const MOCK_ACTIVE_MEMBERS = [
  {
    name: envConfig.ADMIN_NAME,
    nicks: ['test-admin'],
    email: 'admin@example.invalid',
    wa: '390000000001@c.us',
    admin: true
  },
  {
    name: 'Member User',
    nicks: ['test-member'],
    email: 'member@example.invalid',
    wa: '390000000002@c.us'
  }
];

/** Sample roster for group prompt dumps (mirrors waParticipants.js formatting). */
const MOCK_GROUP_PARTICIPANTS = [
  { number: '393331234567', name: 'Alice', isGemix: false },
  { number: '393339876543', name: 'Bob', isGemix: false },
  { number: '393330000001', name: 'GemiX', isGemix: true }
];

/** A successful, known-empty start-of-turn workspace snapshot. */
const EMPTY_WORKSPACE = Object.freeze({
  state: 'ready',
  total: 0,
  files: Object.freeze([]),
  dirs: Object.freeze([]),
  more: false
});

const CASES = {
  1: {
    label: 'WA personal — admin/active, baseline',
    ctx: {
      platform: PLATFORM_WA_PERSONAL,
      isGroup: false,
      chatId: 'personal_chat@test',
      userName: envConfig.ADMIN_NAME,
      userIdentity: ACTIVE,
      userWorkspace: EMPTY_WORKSPACE
    }
  },
  2: {
    label: 'WA personal — non-active caller',
    ctx: {
      platform: PLATFORM_WA_PERSONAL,
      isGroup: false,
      chatId: 'personal_chat@test',
      userName: 'Guest User',
      userIdentity: NON_ACTIVE,
      userWorkspace: EMPTY_WORKSPACE
    }
  },
  3: {
    label: 'WA personal — non-admin active caller (roster names only)',
    ctx: {
      platform: PLATFORM_WA_PERSONAL,
      isGroup: false,
      chatId: 'personal_chat@test',
      userName: 'Member User',
      userIdentity: ACTIVE_NON_ADMIN,
      userWorkspace: EMPTY_WORKSPACE
    }
  },
  4: {
    label: 'WA personal — custom shared settings (memory + language)',
    ctx: {
      platform: PLATFORM_WA_PERSONAL,
      isGroup: false,
      chatId: 'personal_chat@test',
      userName: envConfig.ADMIN_NAME,
      userIdentity: ACTIVE,
      settings: {
        language: 'es-ES',
        memory: 'Rispondi sempre in spagnolo per test.',
        updatedAt: '2026-07-20T10:00:00+02:00'
      },
      userWorkspace: EMPTY_WORKSPACE
    }
  },
  5: {
    label: 'WA personal — workspace files listed',
    ctx: {
      platform: PLATFORM_WA_PERSONAL,
      isGroup: false,
      chatId: 'personal_chat@test',
      userName: envConfig.ADMIN_NAME,
      userIdentity: ACTIVE,
      userWorkspace: {
        state: 'ready',
        total: 2,
        files: [{ relPath: 'out/report.pdf' }, { relPath: 'chart.png' }],
        dirs: [],
        more: false
      }
    }
  },
  6: {
    label: 'WA dedicated private — xAI active',
    deployment: { provider: 'xai', cloudflare: true },
    ctx: {
      platform: PLATFORM_WA_DEDICATED,
      isGroup: false,
      chatId: 'wa_priv@test',
      userName: envConfig.ADMIN_NAME,
      userIdentity: ACTIVE,
      userWorkspace: EMPTY_WORKSPACE
    }
  },
  7: {
    label: 'WA dedicated private — non-active',
    ctx: {
      platform: PLATFORM_WA_DEDICATED,
      isGroup: false,
      chatId: 'wa_priv@test',
      userName: 'Guest',
      userIdentity: NON_ACTIVE,
      userWorkspace: EMPTY_WORKSPACE
    }
  },
  8: {
    label: 'WA dedicated private — xAI custom user settings (voice + effort + memory)',
    deployment: { provider: 'xai', cloudflare: true },
    ctx: {
      platform: PLATFORM_WA_DEDICATED,
      isGroup: false,
      chatId: 'wa_priv@test',
      userName: envConfig.ADMIN_NAME,
      userIdentity: ACTIVE,
      settings: {
        voice: 'female',
        effort: 'low',
        memory: 'Preferisci risposte brevi.',
        updatedAt: '2026-07-24T18:30:00+02:00'
      },
      userWorkspace: EMPTY_WORKSPACE
    }
  },
  9: {
    label: 'WA dedicated group — xAI active',
    deployment: { provider: 'xai', cloudflare: true },
    ctx: {
      platform: PLATFORM_WA_DEDICATED,
      isGroup: true,
      groupId: 'grp@test.g.us',
      groupName: 'Test Group',
      chatId: 'grp@test.g.us',
      userName: envConfig.ADMIN_NAME,
      userIdentity: ACTIVE,
      userWorkspace: EMPTY_WORKSPACE,
      groupParticipants: MOCK_GROUP_PARTICIPANTS
    }
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
      userWorkspace: EMPTY_WORKSPACE,
      groupParticipants: MOCK_GROUP_PARTICIPANTS
    }
  },
  11: {
    label: 'WA dedicated group — non-admin active (roster names only)',
    ctx: {
      platform: PLATFORM_WA_DEDICATED,
      isGroup: true,
      groupId: 'grp@test.g.us',
      groupName: 'Test Group',
      chatId: 'grp@test.g.us',
      userName: 'Member User',
      userIdentity: ACTIVE_NON_ADMIN,
      userWorkspace: EMPTY_WORKSPACE,
      groupParticipants: MOCK_GROUP_PARTICIPANTS
    }
  },
  12: {
    label: 'Discord — xAI new thread (placeholder title ".")',
    deployment: { provider: 'xai', cloudflare: true },
    ctx: {
      platform: PLATFORM_DISCORD,
      isGroup: false,
      chatId: 'channel123',
      userName: ADMIN_FIRST_NAME,
      userIdentity: ACTIVE,
      threadName: '.',
      rulesContext: '[STATUTE EXCERPT PLACEHOLDER]',
      serverEvents: '',
      availableEmojis: ''
    }
  },
  13: {
    label: 'Discord — after GemiX replied (thread title set)',
    ctx: {
      platform: PLATFORM_DISCORD,
      isGroup: false,
      chatId: 'channel123',
      userName: ADMIN_FIRST_NAME,
      userIdentity: ACTIVE,
      threadName: 'Statute question',
      rulesContext: '[STATUTE EXCERPT PLACEHOLDER]',
      serverEvents: '',
      availableEmojis: ''
    }
  },
  14: {
    label: 'Discord — server events line present',
    ctx: {
      platform: PLATFORM_DISCORD,
      isGroup: false,
      chatId: 'channel123',
      userName: ADMIN_FIRST_NAME,
      userIdentity: ACTIVE,
      threadName: 'Group discussion',
      rulesContext: '[STATUTE EXCERPT PLACEHOLDER]',
      serverEvents: 'No upcoming events.',
      availableEmojis: ''
    }
  },
  15: {
    label: 'Discord — guild emojis line present',
    ctx: {
      platform: PLATFORM_DISCORD,
      isGroup: false,
      chatId: 'channel123',
      userName: ADMIN_FIRST_NAME,
      userIdentity: ACTIVE,
      threadName: 'Emoji test',
      rulesContext: '[STATUTE EXCERPT PLACEHOLDER]',
      serverEvents: 'Party - tomorrow',
      availableEmojis: '<:test:123>'
    }
  },
  16: {
    label: 'WA dedicated private — non-admin active (media quota, no phone field)',
    ctx: {
      platform: PLATFORM_WA_DEDICATED,
      isGroup: false,
      chatId: 'wa_priv@test',
      userName: 'Member User',
      userIdentity: ACTIVE_NON_ADMIN,
      userWorkspace: EMPTY_WORKSPACE
    }
  },
  17: {
    label: 'WA dedicated private — custom settings older than a month (renewal notice due)',
    ctx: {
      platform: PLATFORM_WA_DEDICATED,
      isGroup: false,
      chatId: 'wa_priv@test',
      userName: envConfig.ADMIN_NAME,
      userIdentity: ACTIVE,
      settings: {
        voice: 'female',
        memory: 'Sto pianificando il piano di allenamento del mese.',
        updatedAt: '2026-06-01T09:00:00+02:00',
        reviewedAt: '2026-06-01T09:00:00+02:00'
      },
      settingsReviewDue: true,
      userWorkspace: EMPTY_WORKSPACE
    }
  },
  // Everyone on Discord is an active member (userIdentifier.js: the server is
  // private), so the non-active branch is unreachable there — but a non-admin
  // member is not, and gets the names-only roster.
  18: {
    label: 'Discord — non-admin active member (roster names only)',
    ctx: {
      platform: PLATFORM_DISCORD,
      isGroup: false,
      chatId: 'channel123',
      userName: 'Member',
      userIdentity: ACTIVE_NON_ADMIN,
      threadName: 'Statute question',
      rulesContext: '[STATUTE EXCERPT PLACEHOLDER]',
      serverEvents: '',
      availableEmojis: ''
    }
  },
  19: {
    label: 'WA dedicated private — generic provider (baseline media backends)',
    // Same chat as xAI case 6, on a provider with no X search and no video service:
    // those tools are absent rather than present-and-failing, and generate_image
    // shows the Cloudflare schema instead of the Grok Imagine one.
    deployment: { provider: 'chatgpt', cloudflare: true },
    ctx: {
      platform: PLATFORM_WA_DEDICATED,
      isGroup: false,
      chatId: 'wa_priv@test',
      userName: envConfig.ADMIN_NAME,
      userIdentity: ACTIVE,
      userWorkspace: EMPTY_WORKSPACE
    }
  }
};

export { CASES, MOCK_ACTIVE_MEMBERS };
