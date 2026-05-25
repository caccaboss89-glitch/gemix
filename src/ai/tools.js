// src/ai/tools.js
const { PLATFORM_DISCORD, XAI_TTS_ENABLED } = require('../config/constants');

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

// ── Lightweight runtime arg validator ──────────────────────────────────────
//
// We do NOT pull in ajv: a few hundred bytes of inline checks cover the
// schemas we actually use (plain object with string/number/boolean/array
// properties + required[]). The goal is to catch obvious AI hallucinations
// (wrong types, missing required fields) at the dispatcher boundary so the
// tool implementations don't have to repeat the same defensive checks.

function _matchesType(value, schemaType) {
  if (!schemaType) return true; // unconstrained property
  switch (schemaType) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    default: return true;
  }
}

/**
 * Validate parsed args against the tool's JSON-schema-style parameters.
 * Returns null on success or a human-readable error string on failure.
 *
 * Checks:
 *   - args is an object
 *   - all `required` properties are present and non-null
 *   - top-level property types match the declared `type` (string/array/etc.)
 *   - enum constraints on top-level string properties
 *
 * Intentionally NOT recursive: nested objects (e.g. recipient { name, phone })
 * are validated by the individual tool handlers, which already have richer
 * domain rules. The point here is the cheap top-level guard.
 *
 * @param {object} args - Parsed tool-call arguments.
 * @param {object} toolDef - Tool definition (as returned by makeTool).
 * @returns {string|null}
 */
function validateToolArgs(args, toolDef) {
  if (!toolDef || !toolDef.function || !toolDef.function.parameters) return null;
  const params = toolDef.function.parameters;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return 'Tool arguments must be a JSON object.';
  }
  const required = Array.isArray(params.required) ? params.required : [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      return `Missing required argument "${key}".`;
    }
  }
  const props = params.properties || {};
  for (const [key, value] of Object.entries(args)) {
    const propSchema = props[key];
    if (!propSchema) continue; // unknown extra props are tolerated
    if (value === undefined || value === null) continue;
    if (!_matchesType(value, propSchema.type)) {
      return `Argument "${key}" has wrong type (expected ${propSchema.type}).`;
    }
    if (Array.isArray(propSchema.enum) && propSchema.enum.length > 0 && typeof value === 'string') {
      if (!propSchema.enum.includes(value)) {
        return `Argument "${key}" must be one of: ${propSchema.enum.join(', ')}.`;
      }
    }
  }
  return null;
}

// ── xAI code_interpreter — native server-side tool ────────────────────────
//
// Passed straight through to /v1/responses as `{type:'code_interpreter'}`.
// xAI runs the Python sandbox itself and folds the result back into the
// same response (no extra round trip in our outer loop). The bot does NOT
// implement a function tool with this name: the model invokes the native
// path, we never see it as a tool_call.
const TOOL_CODE_INTERPRETER_NATIVE = { type: 'code_interpreter' };

// ── Static tool definitions (schema never varies) ──

const TOOL_WEB_X_SEARCH = makeTool({
  name: 'web_x_search',
  description: 'Hand a research brief to the multi-agent research team (4x). The team conducts web searches, navigates pages, performs X/Twitter searches, monitors citations, and summarizes the results. Do not use this tool again for the same query.',
  properties: {
    prompt: {
      type: 'string',
      description: 'Detailed research brief for the team. Include the exact question, any URLs to consult, the desired output format, and constraints (date range, language, sources to prefer or avoid).',
    },
  },
  required: ['prompt'],
});

const TOOL_IMAGE_SEARCH = makeTool({
  name: 'image_search',
  description: 'Search for images and inspect the returned previews. Results are pushed to the delivery buffer.',
  properties: {
    query: { type: 'string', description: 'Specific image search query.' },
    count: { type: 'integer', description: 'Images to retrieve (1-4, default 1).' },
    language: { type: 'string', description: 'Language hint (default "it", use "en" for international results).' },
    image_type: {
      type: 'string',
      enum: ['any', 'photo', 'gif', 'clipart', 'lineart'],
      description: 'Filter by type (default "any").',
    },
  },
  required: ['query'],
});

const TOOL_READ_FILE = makeTool({
  name: 'read_file',
  description: 'Read the content of a file from chat history (text/code, images, audio, video, PDF).',
  properties: {
    path: { type: 'string', description: 'Filename from chat history (e.g. "report.pdf").' },
  },
  required: ['path'],
});

const TOOL_READ_SERVER_RULES = makeTool({
  name: 'read_server_rules',
  description: 'Read the Discord server rules (aka Statuto Albertino).',
  properties: {},
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
  description: 'Generate a PDF for a formal request and push it to the delivery buffer. Do NOT use markdown headings (# ## etc.) but you can use **bold**, *italic*, bullet lists. Date and filename are generated automatically. The footer "Generated by GemiX..." is added automatically by the system — do not include it.',
  properties: {
    fullName: { type: 'string', description: 'Full name of the requester' },
    title: { type: 'string', description: 'Request title' },
    motivation: { type: 'string', description: 'Detailed and well-argued motivation' },
    requesterSignature: { type: 'string', description: 'Requester signature' },
    legalSignature: { type: 'string', description: 'Legal advisor signature ("Lorenzo Passante" if requested by him in person, or "Nessuno")' },
  },
  required: ['fullName', 'title', 'motivation', 'requesterSignature'],
});

const TOOL_MUSIC_CREATOR = makeTool({
  name: 'music_creator',
  description: 'Create a 30-second music clip from a prompt.',
  properties: {
    prompt: {
      type: 'string',
      description: 'Detailed description of style, instruments, and mood.',
    },
  },
  required: ['prompt'],
});

// ── Grok Imagine — image and video generation ──
//
// Available to all users (active or not) on every platform except Discord.
//
// IMPORTANT: the current Hermes bridge (CLI-based, see bridge/imagine.sh)
// does NOT support reference images. The model must rely entirely on the
// textual prompt to describe the desired look. If/when reference image
// support is restored, the schema can grow back a `reference_images` field.

const TOOL_GENERATE_IMAGE = makeTool({
  name: 'generate_image',
  description: 'Generate an image from a textual prompt. Result is pushed to the delivery buffer. Reference images are not supported.',
  properties: {
    prompt: {
      type: 'string',
      description: 'Image description: subject, style, lighting, mood, composition.',
    },
    aspect_ratio: {
      type: 'string',
      enum: ['1:1', '16:9', '9:16', '4:3', '3:4'],
      description: 'Aspect ratio. Omit for automatic.',
    },
  },
  required: ['prompt'],
});

const TOOL_GENERATE_VIDEO = makeTool({
  name: 'generate_video',
  description: 'Generate a 10-second 720p video from a textual prompt. Result is pushed to the delivery buffer. Reference images are not supported.',
  properties: {
    prompt: {
      type: 'string',
      description: 'Video description: subject, action, camera movement, style, lighting.',
    },
    aspect_ratio: {
      type: 'string',
      enum: ['16:9', '9:16', '1:1'],
      description: 'Aspect ratio. Default 16:9.',
    },
  },
  required: ['prompt'],
});

// ── Dynamic tool builders (schema varies by grade/platform) ──

function buildVoiceTool({ includeRecipientName = false, includeRecipientPhone = false } = {}) {
  const properties = {
    text: {
      type: 'string',
      description: XAI_TTS_ENABLED
        ? 'TTS text (max 1000 chars), supports vocal effects. Inline tags: [pause] [long-pause] [hum-tune] [laugh] [chuckle] [giggle] [cry] [tsk] [tongue-click] [lip-smack] [breath] [inhale] [exhale] [sigh]. Wrapping tags: <soft> <whisper> <loud> <build-intensity> <decrease-intensity> <higher-pitch> <lower-pitch> <slow> <fast> <sing-song> <singing> <laugh-speak> <emphasis>.'
        : 'TTS text (max 1000 chars). Note: vocal effects/tags are NOT supported at the moment.',
    },
  };

  if (includeRecipientName || includeRecipientPhone) {
    properties.includeAttachments = {
      type: 'boolean',
      description: 'Forward buffered files to this recipient (default true).',
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
    description: 'Delivery tool — send a voice message. Without "recipient" replies in the current chat; with it, sends to that recipient.',
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
      description: 'Forward buffered files to this recipient (default true).',
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
    description: 'Delivery tool — send a WhatsApp message to a specific recipient (never the current user; never use for intermediate updates).',
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
      description: 'Forward buffered files to this recipient (default true).',
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
    description: 'Delivery tool — send an email.',
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
    description: 'Send privately to the user',
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
      description: 'Text to send directly to the user at the scheduled date/time.',
    },
    scheduledAt: {
      type: 'string',
      description: 'Date and time in ISO 8601 without timezone offset (e.g. 2026-04-17T16:30:00).',
    },
    whatsapp: {
      type: 'object',
      description: 'WhatsApp destination',
      properties: waProps,
    },
    recurrence: {
      type: 'object',
      description: 'Optional recurrence (scheduledAt=first execution).',
      properties: {
        freq: { type: 'string', enum: ['hourly', 'daily', 'weekly', 'monthly'], description: 'Frequency' },
        endAt: { type: 'string', description: 'Date and time in ISO 8601 of the last allowed execution (inclusive) without timezone offset.' },
      },
      required: ['freq', 'endAt'],
    },
  };

  return makeTool({
    name: 'schedule_tasks',
    description: isAdmin
      ? 'Schedule reminders/tasks (one-time or recurring) for user, other active members (by name), or contacts (by phone number). Not use timezone offset, system will process it with the user\'s correct timezone.'
      : (isActiveMember
        ? 'Schedule reminders/tasks (one-time or recurring) for user or other active members (by name). Not use timezone offset, system will process it with the user\'s correct timezone.'
        : 'Schedule personal reminders and future tasks (one-time or recurring) for user. Not use timezone offset, system will process it with the user\'s correct timezone.'),
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

const TOOL_BUG_REPORT = makeTool({
  name: 'bug_report',
  description: 'Report a bug/failure. Use ONLY if the tool error DOES NOT state the Admin was already notified, or for general logical bugs. Inform the user in your final response.',
  properties: {
    source: { type: 'string', description: 'Component or context where the issue occurred (e.g. "build", "yt-dlp", "proxy", "attachments")' },
    details: { type: 'string', description: 'Brief but clear description of the problem' },
  },
  required: ['source', 'details'],
});

// ── Build sub-agent (engineering tool) ─────────────────────────────────────
//
// Invokes the engineering sub-agent. The agent has its own isolated workspace
// persistent across calls within the same session (4h inactivity TTL,
// 500 MB quota), and returns task result text plus any deliverable files
// announced via <DELIVER>.
//
// Tools available INSIDE build (not visible from the main brain):
//   write_file, edit_file, bash, read_file, image_search, web_x_search,
//   code_interpreter (xAI server-side, zero round cost).
// NOT available inside build:
//   generate_image, generate_video, music_creator, send_*  — main brain
//   prepares those assets and passes them via attachments[].

const TOOL_BUILD = makeTool({
  name: 'build',
  description:
    'Hand a build/code/document task to the engineering sub-agent. '
    + 'Persistent isolated workspace per user/group (4h inactivity TTL, 500 MB). '
    + 'Tools available INSIDE build: write_file, edit_file, bash, read_file, image_search, web_x_search, code_interpreter. '
    + 'If you need a generated asset (image/video/song) inside the build task, generate it FIRST in the main loop, then pass it via attachments[].',
  properties: {
    prompt: {
      type: 'string',
      description: 'Detailed task instructions. Include desired output format, constraints, and how each attached file should be used. The agent does NOT see chat history — only this prompt and the workspace state.',
    },
    attachments: {
      type: 'array',
      items: { type: 'string' },
      description: 'Filenames (with extension) referring to files in the current-turn buffer or chat history. Host fetches each one, places it in /workspace/, renames on collision. Empty/omit if no files are needed.',
    },
  },
  required: ['prompt'],
});

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

  // 1. Search & Information Retrieval
  tools.push(
    TOOL_WEB_X_SEARCH,
    TOOL_IMAGE_SEARCH,
    TOOL_READ_FILE,
  );
  if (isWhatsApp) {
    tools.push(TOOL_MUSIC_CREATOR);
  }

  // 1b. Grok Imagine — image and video generation. Available only on
  // WhatsApp since both produce binary media that is delivered through
  // the WA attachment pipeline. Both go in the ONCE_PER_ROUND_TOOLS set
  // in tools/index.js.
  if (isWhatsApp) {
    tools.push(TOOL_GENERATE_IMAGE, TOOL_GENERATE_VIDEO);
  }

  // 1c. xAI server-side code interpreter — native Responses tool, executed
  // by xAI inside its own isolated sandbox. Available outside Discord.
  // Round cost: zero (server-side).
  if (!isDiscord) {
    tools.push(TOOL_CODE_INTERPRETER_NATIVE);
  }

  // 2. Build sub-agent — single delegation point for any task that needs
  // to write/edit files, run shell commands, or assemble deliverables.
  // Available outside Discord.
  if (!isDiscord) {
    tools.push(TOOL_BUILD);
  }

  // 3. Communication & Delivery
  if (!isDiscord) {
    tools.push(buildVoiceTool({
      includeRecipientName: isAdmin || (isActiveMember && isWhatsApp),
      includeRecipientPhone: isAdmin,
    }));
  }
  if (isDiscord) {
    tools.push(TOOL_GENERATE_FORMAL_REQUEST_PDF);
  }
  if (isActiveMember) {
    tools.push(buildEmailTool(isAdmin));
    tools.push(buildWhatsAppTool(isAdmin));
  }

  // 4. Task Management
  if (!isDiscord) {
    tools.push(buildScheduleTasksTool(isActiveMember, isAdmin, isWhatsAppGroup));
    tools.push(buildReadMyTasksTool(isWhatsAppGroup));
    tools.push(buildRemoveMyTasksTool(isWhatsAppGroup));
  }

  // 5. Memory, Meta & Stats
  // Note: On Discord, all users are active members, so no need to check isActiveMember.
  tools.push(TOOL_UPDATE_MEMORY);
  if (!isDiscord) {
    tools.push(TOOL_TOGGLE_RELEASE_NOTIFY);
  }
  // Rules and Stats are for all Discord users (members) or active WA members.
  if (isDiscord || isActiveMember) {
    tools.push(TOOL_READ_SERVER_RULES, TOOL_READ_MUSIC_STATS);
  }

  // 6. Bug Report (all platforms, all modes)
  tools.push(TOOL_BUG_REPORT);

  return tools;
}

module.exports = {
  getToolsForUser,
  isActiveMemberOnlyTool,
  validateToolArgs,
};
