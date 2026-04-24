// src/ai/tools.js
const fs = require('fs');
const path = require('path');
const { DATA_DIR, PLATFORM_DISCORD } = require('../config/constants');

// Tool definitions for AI function calling (OpenAI-compatible format).

// ── Helpers ──

function makeTool({ name, description, properties = {}, required = [] }) {
  const tool = {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties,
      },
    },
  };
  if (required.length > 0) {
    tool.function.parameters.required = required;
  }
  return tool;
}

// ── Static tool definitions (schema never varies) ──

const TOOL_WEB_SEARCH = makeTool({
  name: 'web_search',
  description: 'Search the web. Call multiple times with different queries for deep research. Supports operators: site:, -site:, after:YYYY-MM-DD, before:YYYY-MM-DD, filetype:, intitle:, inurl:, "exact phrase", OR/AND. Do not cite results with [web:N] tags — use information naturally.',
  properties: {
    query: { type: 'string', description: 'Search query (supports operators: site:, after:, before:, filetype:, "exact phrase", OR)' },
    num_results: { type: 'integer', description: 'Number of results (1-30, default 15)' },
    allowed_domains: {
      type: 'array',
      items: { type: 'string' },
      description: 'Restrict to these domains only (max 5). Example: ["github.com", "stackoverflow.com"]',
    },
    excluded_domains: {
      type: 'array',
      items: { type: 'string' },
      description: 'Exclude these domains (max 5). Example: ["pinterest.com", "quora.com"]',
    },
  },
  required: ['query'],
});

const TOOL_IMAGE_SEARCH = makeTool({
  name: 'image_search',
  description: 'Search for images. Returns visual previews you can SEE and evaluate. Images are buffered for delivery. If you dislike a result, use discard to remove it (and search again if needed). Call multiple times with different queries to refine.',
  properties: {
    query: {
      type: 'string',
      description: 'Specific image search query (e.g. "golden gate bridge sunset" not "bridge").',
    },
    count: {
      type: 'integer',
      description: 'Images to retrieve (1-2, default 1).',
    },
    language: {
      type: 'string',
      description: 'Language hint (default "it", use "en" for international results).',
    },
    image_type: {
      type: 'string',
      enum: ['any', 'photo', 'gif', 'clipart', 'lineart'],
      description: 'Filter by type (default "any"). Use "gif" for animated GIFs.',
    },
    discard: {
      type: 'array',
      items: { type: 'integer' },
      description: 'Image IDs to remove from buffer (from previous search results).',
    },
  },
  required: ['query'],
});

const TOOL_READ_FILE = makeTool({
  name: 'read_file',
  description: 'Read the contents of a file (text, images, audio, pdf) located in the user\'s folder or history. Use this to inspect files mentioned in the chat context or scripts.',
  properties: {
    path: { 
      type: 'string', 
      description: 'Path to the file to read. On Discord, paths are relative to history/ (e.g. "report.pdf"). On WhatsApp, paths are relative to your user folder (e.g. "history/report.pdf").' 
    },
  },
  required: ['path'],
});

const TOOL_READ_SERVER_RULES = makeTool({
  name: 'read_server_rules',
  description: 'Read the Discord server rules (aka Statuto Albertino).',
  properties: {},
});

const TOOL_BROWSE_PAGE = makeTool({
  name: 'browse_page',
  description: 'Fetch and analyze a web page. An LLM summarizer extracts/summarizes content based on your instructions. Use after web_search to deep-dive into promising URLs. Use mode "raw" only when you need the full unprocessed text.',
  properties: {
    url: {
      type: 'string',
      description: 'Full URL to fetch (must include https://).',
    },
    instructions: {
      type: 'string',
      description: 'What to extract or analyze from the page (e.g. "list all pricing tiers", "summarize the main argument", "extract all API endpoints"). Be specific for better results.',
    },
    mode: {
      type: 'string',
      enum: ['summary', 'raw', 'raw_html'],
      description: 'Processing mode (default "summary"). Use "raw" to get unprocessed extracted text without LLM summarization. Use "raw_html" to get the full HTML source.',
    },
  },
  required: ['url'],
});



const TOOL_READ_MUSIC_STATS = makeTool({
  name: 'read_music_stats',
  description: 'Read music listening statistics.',
  properties: {},
});

const TOOL_UPDATE_MEMORY = makeTool({
  name: 'update_memory',
  description: 'Update personalized memory (private or group-scoped based on current chat). If memory already contains information, rewrite existing entries and append new ones. If memory is nearly full, ask the user what to remove.',
  properties: {
    content: {
      type: 'string',
      description: 'Full memory text (max 500 chars, empty=clear)',
    },
  },
  required: ['content'],
});

const TOOL_TOGGLE_RELEASE_NOTIFY = makeTool({
  name: 'toggle_release_notify',
  description: 'Enable or disable new GemiX release notifications for this chat.',
  properties: {
    enabled: {
      type: 'boolean',
      description: 'true=enable, false=disable',
    },
  },
  required: ['enabled'],
});

const TOOL_GENERATE_FORMAL_REQUEST_PDF = makeTool({
  name: 'generate_formal_request_pdf',
  description: 'Generate a PDF for a formal request. Do NOT use markdown headings (# ## etc.) but you can use **bold**, *italic*, bullet lists. Date and filename are generated automatically. The footer "Generated by GemiX..." is added automatically by the system — do not include it.',
  properties: {
    fullName: { type: 'string', description: 'Full name of the requester' },
    title: { type: 'string', description: 'Request title' },
    motivation: { type: 'string', description: 'Detailed and well-argued motivation' },
    requesterSignature: { type: 'string', description: 'Requester signature' },
    legalSignature: { type: 'string', description: 'Legal advisor signature ("Lorenzo Passante" if requested by him in person, or "Nessuno")' },
  },
  required: ['fullName', 'title', 'motivation', 'requesterSignature'],
});

// ── Dynamic tool builders (schema varies by grade/platform) ──

function buildVoiceTool({ includeRecipientName = false, includeRecipientPhone = false } = {}) {
  const properties = {
    text: {
      type: 'string',
      description: 'TTS text (max 1000 chars), supports vocal effects. Inline tags: [pause] [long-pause] [hum-tune] [laugh] [chuckle] [giggle] [cry] [tsk] [tongue-click] [lip-smack] [breath] [inhale] [exhale] [sigh]. Wrapping tags: <soft> <whisper> <loud> <build-intensity> <decrease-intensity> <higher-pitch> <lower-pitch> <slow> <fast> <sing-song> <singing> <laugh-speak> <emphasis>.',
    },
  };

  if (includeRecipientName || includeRecipientPhone) {
    properties.includeAttachments = {
      type: 'boolean',
      description: 'Attach buffered files (default true)',
    };
    const recipientProps = {};
    if (includeRecipientName) {
      recipientProps.name = {
        type: 'string',
        description: 'Member name (omit=current chat)',
      };
    }
    if (includeRecipientPhone) {
      recipientProps.phone = {
        type: 'string',
        description: 'Phone number with country code (e.g. +393XXXXXXXXX)',
      };
    }
    properties.recipient = {
      type: 'object',
      description: 'Specific recipient',
      properties: recipientProps,
    };
  }

  return makeTool({
    name: 'send_voice_message',
    description: 'Delivery tool — Send a voice message.',
    properties,
    required: ['text'],
  });
}

function buildWhatsAppTool(isAdmin) {
  const recipientProps = {
    name: {
      type: 'string',
      description: 'Recipient member name',
    },
  };

  if (isAdmin) {
    recipientProps.phone = {
      type: 'string',
      description: 'Phone number with country code (e.g. +393XXXXXXXXX)',
    };
  }

  const properties = {
    message: { type: 'string', description: 'Message text' },
    includeAttachments: {
      type: 'boolean',
      description: 'Attach buffered files (default true)',
    },
    recipient: {
      type: 'object',
      description: 'Recipient',
      properties: recipientProps,
      required: isAdmin ? [] : ['name'],
    },
  };

  return makeTool({
    name: 'send_whatsapp_message',
    description: 'Delivery tool — Send a WhatsApp message.',
    properties,
    required: isAdmin ? ['message'] : ['recipient', 'message'],
  });
}

function buildEmailTool(isAdmin) {
  const recipientProps = {
    name: {
      type: 'string',
      description: 'Member name (email resolved from name)',
    },
  };

  if (isAdmin) {
    recipientProps.email = {
      type: 'string',
      description: 'Direct recipient email address',
    };
  }

  const properties = {
    subject: { type: 'string', description: 'Email subject' },
    body: { type: 'string', description: 'HTML body (no markdown)' },
    includeAttachments: {
      type: 'boolean',
      description: 'Attach buffered files (default true)',
    },
    recipient: {
      type: 'object',
      description: 'Recipient',
      properties: recipientProps,
      required: isAdmin ? [] : ['name'],
    },
  };

  return makeTool({
    name: 'send_email',
    description: 'Delivery tool — Send an email.',
    properties,
    required: isAdmin ? ['subject', 'body'] : ['recipient', 'subject', 'body'],
  });
}

function buildScheduleTasksTool(isActiveMember, isAdmin, isWhatsAppGroup) {
  const waProps = {};
  if (isWhatsAppGroup) {
    waProps.toGroup = {
      type: 'boolean',
      description: 'Send to current group',
    };
  }
  waProps.toPrivate = {
    type: 'boolean',
    description: 'Send privately via WhatsApp',
  };

  const recipientWaProps = {};
  if (isActiveMember) {
    recipientWaProps.name = {
      type: 'string',
      description: 'Recipient member name',
    };
  }
  if (isAdmin) {
    recipientWaProps.phone = {
      type: 'string',
      description: 'Phone number for non-member recipient',
    };
  }

  if (Object.keys(recipientWaProps).length > 0) {
    waProps.recipient = {
      type: 'object',
      description: 'Recipient',
      properties: recipientWaProps,
    };
  }

  const taskItemProps = {
    content: {
      type: 'string',
      description: 'Text to send to the user',
    },
    scheduledAt: {
      type: 'string',
      description: 'Date and time in ISO 8601. The system will process it with the user\'s correct timezone. Example: 2026-04-17T16:30:00.',
    },
    whatsapp: {
      type: 'object',
      description: 'WhatsApp destination',
      properties: waProps,
    },
    recurrence: {
      type: 'object',
      description: 'Optional recurrence (scheduledAt=first execution). Available to all users.',
      properties: {
        freq: { type: 'string', enum: ['hourly', 'daily', 'weekly', 'monthly'], description: 'Frequency' },
        endAt: { type: 'string', description: 'Date and time in ISO 8601 of the last allowed execution (inclusive). The system will process it with the user\'s correct timezone. Example: 2026-12-31T23:59:00' },
      },
      required: ['freq', 'endAt'],
    },
  };

  return makeTool({
    name: 'schedule_tasks',
    description: isAdmin
      ? 'Schedule reminders/tasks (one-time or recurring) for yourself, other active members (by name), or contacts (by phone). Write each reminder as if it were being sent at the scheduled date/time. If scheduling tasks for recipients other than the current user, make sure to set the correct recipients.'
      : (isActiveMember
        ? 'Schedule reminders/tasks (one-time or recurring) for yourself or other active members (by name). Write each reminder as if it were being sent at the scheduled date/time. If scheduling tasks for recipients other than the current user, make sure to set the correct recipients.'
        : 'Schedule personal reminders and future tasks (one-time or recurring) for yourself. Write each reminder as if it were being sent at the scheduled date/time.'),
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: taskItemProps,
          required: ['content', 'scheduledAt'],
        },
      },
    },
    required: ['tasks'],
  });
}

function buildReadMyTasksTool(isWhatsAppGroup) {
  const properties = {};
  if (isWhatsAppGroup) {
    properties.includeGroupTasks = {
      type: 'boolean',
      description: 'Include group tasks',
    };
  }
  return makeTool({
    name: 'read_my_tasks',
    description: 'Show scheduled tasks.',
    properties,
  });
}

function buildRemoveMyTasksTool(isWhatsAppGroup) {
  const properties = {
    taskIds: {
      type: 'array',
      items: { type: 'string' },
      description: 'Task IDs to remove',
    },
  };
  if (isWhatsAppGroup) {
    properties.fromGroup = {
      type: 'boolean',
      description: 'Remove from group instead of personal',
    };
  }
  return makeTool({
    name: 'remove_my_tasks',
    description: 'Remove scheduled tasks.',
    properties,
    required: ['taskIds'],
  });
}

// ── Active-member-only tool check (runtime permission guard) ──

const ACTIVE_MEMBER_ONLY_TOOLS = new Set([
  'read_server_rules',
  'send_email',
  'send_whatsapp_message',
  'read_music_stats',
]);

function isActiveMemberOnlyTool(toolName) {
  return ACTIVE_MEMBER_ONLY_TOOLS.has(toolName);
}

// ── Main builder: constructs tool list in a single pass ──

function getToolsForUser(isActiveMember, isAdmin, userCtx = {}) {
  const isWhatsApp = userCtx.platform && userCtx.platform.startsWith('whatsapp');
  const isWhatsAppGroup = isWhatsApp && userCtx.isGroup;
  const isDiscord = userCtx.platform === PLATFORM_DISCORD;

  const tools = [];

  // ── All users, all platforms ──
  tools.push(TOOL_WEB_SEARCH, TOOL_IMAGE_SEARCH, TOOL_BROWSE_PAGE, TOOL_READ_FILE);

  // ── WhatsApp only: voice, tasks, release notify ──
  if (!isDiscord) {

    tools.push(buildVoiceTool({
      includeRecipientName: isAdmin || (isActiveMember && isWhatsApp),
      includeRecipientPhone: isAdmin,
    }));

    tools.push(buildScheduleTasksTool(isActiveMember, isAdmin, isWhatsAppGroup));
    tools.push(buildReadMyTasksTool(isWhatsAppGroup));
    tools.push(buildRemoveMyTasksTool(isWhatsAppGroup));

    tools.push(TOOL_TOGGLE_RELEASE_NOTIFY);
  }

  // ── Discord: formal request PDF (all members) ──
  if (isDiscord) {
    tools.push(TOOL_GENERATE_FORMAL_REQUEST_PDF);
  }

  // ── Personalized memory: WhatsApp all, Discord active only ──
  if (!isDiscord || isActiveMember) {
    tools.push(TOOL_UPDATE_MEMORY);
  }

  // ── Active members only ──
  if (isActiveMember) {
    if (!isDiscord) {
      tools.push(TOOL_READ_SERVER_RULES, TOOL_READ_MUSIC_STATS);
    }
    tools.push(buildEmailTool(isAdmin));
    tools.push(buildWhatsAppTool(isAdmin));
  }

  return tools;
}

module.exports = {
  getToolsForUser,
  isActiveMemberOnlyTool,
};
