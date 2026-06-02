// src/ai/tools.js
//
// Central registry of tool definitions for the main brain (function calling schema).
// Uses makeTool + validateToolArgs (lightweight hallucination guard, no ajv).
// getToolsForUser builds the per-user/platform list (hides admin-only, active-member-only, Discord-specific).
// The build tool description is generic and does not expose sub-agent internals.

const { PLATFORM_DISCORD, PLATFORM_WA_PERSONAL } = require('../config/constants');

// -- Helpers -------------------------------------------------------------

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

// -- Lightweight runtime arg validator -------------------------------------
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

// -- xAI code_interpreter - native server-side tool -----------------------
//
// Passed straight through to /v1/responses as `{type:'code_interpreter'}`.
// xAI runs the Python sandbox itself and folds the result back into the
// same response (no extra round trip in our outer loop). The bot does NOT
// implement a function tool with this name: the model invokes the native
// path, we never see it as a tool_call.
const TOOL_CODE_INTERPRETER_NATIVE = { type: 'code_interpreter' };

// -- Static tool definitions (schema never varies) -------------------------

const TOOL_WEB_X_SEARCH = makeTool({
  name: 'web_x_search',
  description:
    'Provides a research prompt to a specialized agent (or multi-agent team) that performs web and X searches. '
    + 'Use it for external/up-to-date information, fact-checking, or when web images are needed. '
    + 'By default a single fast model handles the request. Set full_team=true only for deep, multi-faceted research. '
    + 'Do NOT call multiple times in the same round.',
  properties: {
    prompt: {
      type: 'string',
      description: 'Detailed research brief: the exact question, any URLs to consult, desired output format, and constraints (date range, language, sources to prefer or avoid).',
    },
    full_team: {
      type: 'boolean',
      description: 'Set true for 4x multi-agent team (more deep); omit for fast single-model search (default).',
    },
    search_images: {
      type: 'boolean',
      description: 'Set true for include relevant images from the web (if requested or useful). Images are added to the delivery buffer. Omit for text-only research.',
    },
  },
  required: ['prompt'],
});

const TOOL_READ_FILE = makeTool({
  name: 'read_file',
  description: 'Read the content of a file from chat history (only for text/code, images, audio, video, PDF).',
  properties: {
    path: { type: 'string', description: 'Filename from chat history (e.g. "report.pdf").' },
  },
  required: ['path'],
});

const TOOL_READ_SERVER_RULES = makeTool({
  name: 'read_server_rules',
  description: 'Read the server rules (Statuto Albertino / Constitution). Use when you need the full statute text on WhatsApp.',
  properties: {},
});

// -- Discord conversation title (forced on the first turn) -----------------
//
// On the FIRST message of a Discord thread we expose this tool and force its use (tool_choice), so
// the thread title is set deterministically exactly once. It is NOT offered
// on later turns, so the model never second-guesses or rewrites the title.
const TOOL_SET_CONVERSATION_TITLE = makeTool({
  name: 'set_conversation_title',
  description: 'Set the title of this Discord conversation/thread. Called once at the start to name the conversation after its topic.',
  properties: {
    title: {
      type: 'string',
      description: 'Concise topic title (max ~80 chars), no emojis, in the user\'s language.',
    },
  },
  required: ['title'],
});

const TOOL_READ_MUSIC_STATS = makeTool({
  name: 'read_music_stats',
  description: 'Read music listening statistics.',
  properties: {},
});

function buildUpdateMemoryTool(isGroup, isPersonalChat = false) {
  const scope = isGroup
    ? 'the current group'
    : (isPersonalChat ? 'this shared personal chat (both participants)' : 'the current user');
  return makeTool({
    name: 'update_memory',
    description: `Update personalized memory for ${scope}, for long-term preferences only. Do NOT store transient context. If memory already contains information, rewrite existing entries and append new ones.`,
    properties: {
      content: {
        type: 'string',
        description: 'Full memory text (max 1000 chars, empty=clear). Always write in English. Keep it tidy and well-organised - it is a system component. If the current memory is disorganised, rewrite it in order even if not asked, without removing any information.',
      },
    },
    required: ['content'],
  });
}

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
  description: 'Generate a PDF for a formal request and push it to the delivery buffer. Never use emojis. Do NOT use markdown headings (# ## etc.) but you can use **bold**, *italic*, bullet lists. Date and filename are generated automatically. The footer "Generated by GemiX..." is added automatically by the system - do not include it.',
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

// -- Grok Imagine - image and video generation ---------------------------
//
// Available to all users (active or not) on every platform except Discord.
//
// Reference images are supported: pass filenames already visible to the model
// - a file the user just sent ([Attachment: name] tag), a file from chat
// history, an image returned by web_x_search (search_images=true; its
// image_filenames are reported), or an image produced by an earlier
// generate_image call (its filename is reported in the result). The backend
// resolves each filename (current-turn delivery buffer first, then chat
// history), exposes it through the public attachment tunnel, and hands the
// URL to xAI, which fetches it server-side and uses it as a visual reference
// (image-to-image / image-to-video / reference-to-video).

const TOOL_GENERATE_IMAGE = makeTool({
  name: 'generate_image',
  description: 'Generate an image from a textual prompt, optionally guided by reference images. Result is pushed to the delivery buffer.',
  properties: {
    prompt: {
      type: 'string',
      description: 'Image description: subject, style, lighting, mood, composition. If you pass reference images, mention them here by filename (e.g. "place the subject of photo.jpg into a beach scene").',
    },
    reference_images: {
      type: 'array',
      items: { type: 'string' },
      description: 'Up to 3 image filenames WITH extension (e.g. "photo.jpg"). Sources: a file the user just sent, a chat-history file, a web_x_search result image, or a previously generated image. The exact filename must already appear in the conversation. Omit for pure text-to-image.',
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
  description: 'Generate a 10-second 720p video from a textual prompt, optionally guided by reference images. Result is pushed to the delivery buffer.',
  properties: {
    prompt: {
      type: 'string',
      description: 'Video description: subject, action, camera movement, style, lighting. If you pass reference images, mention them here by filename.',
    },
    reference_images: {
      type: 'array',
      items: { type: 'string' },
      description: 'Up to 7 image filenames WITH extension (e.g. "photo.jpg"). 1 image = animate that exact image (image-to-video); 2–7 = keep those subjects/style consistent (reference-to-video). Sources: a file the user just sent, a chat-history file, a web_x_search result image, or a previously generated image. The exact filename must already appear in the conversation. Omit for pure text-to-video.',
    },
    aspect_ratio: {
      type: 'string',
      enum: ['16:9', '9:16', '1:1'],
      description: 'Aspect ratio. Default 16:9.',
    },
  },
  required: ['prompt'],
});

// -- Dynamic tool builders (schema varies by grade/platform) -------------

function buildVoiceTool({ includeRecipientName = false, includeRecipientPhone = false } = {}) {
  const properties = {
    text: {
      type: 'string',
      description: 'Plain text to speak (max 1000 chars). Do NOT add vocal effect tags - TTS adds them automatically. Just write the message in the language you want. No emoji.',
    },
  };

  if (includeRecipientName || includeRecipientPhone) {
    properties.includeAttachments = {
      type: 'boolean',
      description: 'Forward buffered files together with the voice (default true). Ignored when the recipient is omitted or is the current chat.',
    };
    const recipientProps = {};
    if (includeRecipientName) {
      recipientProps.name = {
        type: 'string',
        description: 'Member name. Omit to reply in the current chat.',
      };
    }
    if (includeRecipientPhone) {
      recipientProps.phone = {
        type: 'string',
        description: 'Phone number with country code (e.g. +393XXXXXXXXX). Omit to reply in the current chat.',
      };
    }
    properties.recipient = {
      type: 'object',
      description: 'Specific recipient. Omit to reply in the current chat.',
      properties: recipientProps,
    };
  }

  return makeTool({
    name: 'send_voice_message',
    description: 'Delivery tool - send a voice message. Without "recipient" replies in the current chat; with a different recipient, sends to that recipient.',
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
    description: 'Delivery tool - send a WhatsApp message to a specific recipient (never the current chat; never use for intermediate updates).',
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
    description: 'Delivery tool - send an email.',
    properties,
    required: isAdmin ? ['subject', 'body'] : ['recipient', 'subject', 'body'],
  });
}

function buildScheduleTasksTool(isActiveMember, isAdmin, isWhatsAppGroup) {
  const waProps = {};

  if (isWhatsAppGroup) {
    waProps.toGroup = {
      type: 'boolean',
      description: 'Send this reminder to the current group.',
    };
  }

  waProps.toPrivate = {
    type: 'boolean',
    description: 'Send this reminder as a private message.',
  };

  const recipientWaProps = {};
  if (isActiveMember) {
    recipientWaProps.name = {
      type: 'string',
      description: 'Active member name.',
    };
  }
  if (isAdmin) {
    recipientWaProps.phone = {
      type: 'string',
      description: 'Phone number with country code (e.g. +393XXXXXXXXX).',
    };
  }

  if (Object.keys(recipientWaProps).length > 0) {
    waProps.recipient = {
      type: 'object',
      description: isAdmin
        ? 'Recipient (name for active members or phone for external).'
        : 'Active member name to remind.',
      properties: recipientWaProps,
    };
  }

  const taskItemProps = {
    content: {
      type: 'string',
      description: 'The reminder message to deliver.',
    },
    scheduledAt: {
      type: 'string',
      description: 'Execution time in ISO 8601 (e.g. 2026-06-05T14:30:00). System uses the correct timezone.',
    },
    whatsapp: {
      type: 'object',
      description: isWhatsAppGroup
        ? 'Where to send. Omit = current group. Use toPrivate + recipient to send privately.'
        : 'Where to send. Omit = current user. Use toPrivate + recipient to send to someone else.',
      properties: waProps,
    },
    recurrence: {
      type: 'object',
      description: 'Optional recurrence settings.',
      properties: {
        freq: { type: 'string', enum: ['hourly', 'daily', 'weekly', 'monthly'] },
        endAt: { type: 'string', description: 'End date (ISO 8601).' },
      },
      required: ['freq', 'endAt'],
    },
  };

  return makeTool({
    name: 'schedule_tasks',
    description: isAdmin
      ? 'Schedule reminders for current chat, other active members or external contacts. To remind multiple people: one task per person with its own whatsapp.recipient.'
      : isActiveMember
        ? 'Schedule reminders for current chat or other active members. To remind multiple people: one task per person with its own whatsapp.recipient.'
        : 'Schedule personal reminders for current chat.',
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

// -- Build sub-agent (engineering tool) ------------------------------------
//
// Delegates complex file write, shell, document or multi-step tasks to an
// isolated engineering sub-agent with its own workspace. The sub-agent returns
// text + any files announced via <DELIVER>. Pass relevant assets via attachments[].
// The sub-agent has its own isolated context (no chat history).

function buildBuildTool(isGroup) {
  const scope = isGroup ? 'the current group' : 'the current user';
  return makeTool({
    name: 'build',
    description:
      'Hand a build/code/document task to the engineering sub-agent. '
      + `Persistent isolated workspace for ${scope} (4h inactivity TTL, 500 MB). `
      + 'If you need a specific asset (image/video/song) inside the build task, generate it FIRST in the main loop, then pass it via attachments[].',
    properties: {
      prompt: {
        type: 'string',
        description: 'Detailed task instructions. Include desired output format, constraints, and how each attached file should be used. The sub-agent works from the provided prompt and workspace state only.',
      },
      attachments: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filenames (with extension) referring to files in the current-turn buffer or chat history. Empty/omit if no files are needed.',
      },
    },
    required: ['prompt'],
  });
}

// -- Active-member-only tool check (runtime permission guard) --------------

const ACTIVE_MEMBER_ONLY_TOOLS = new Set([
  'read_server_rules',
  'read_music_stats',
  'send_email',
  'send_whatsapp_message',
]);

function isActiveMemberOnlyTool(toolName) {
  return ACTIVE_MEMBER_ONLY_TOOLS.has(toolName);
}

// -- Main builder: constructs tool list in a single pass -------------------

function getToolsForUser(isActiveMember, isAdmin, userCtx = {}) {
  const isWhatsApp = userCtx.platform && userCtx.platform.startsWith('whatsapp');
  const isWhatsAppGroup = isWhatsApp && userCtx.isGroup;
  const isDiscord = userCtx.platform === PLATFORM_DISCORD;

  const tools = [];

  // 1. Search & Information Retrieval
  tools.push(
    TOOL_WEB_X_SEARCH,
    TOOL_READ_FILE,
  );
  if (isWhatsApp) {
    tools.push(TOOL_MUSIC_CREATOR);
  }

  // 1b. Grok Imagine - image and video generation. Available only on
  // WhatsApp since both produce binary media that is delivered through
  // the WA attachment pipeline. Both go in the ONCE_PER_ROUND_TOOLS set
  // in tools/index.js.
  if (isWhatsApp) {
    tools.push(TOOL_GENERATE_IMAGE, TOOL_GENERATE_VIDEO);
  }

  // 1c. xAI server-side code interpreter - native Responses tool, executed
  // by xAI inside its own isolated sandbox. Available outside Discord.
  // Round cost: zero (server-side).
  if (!isDiscord) {
    tools.push(TOOL_CODE_INTERPRETER_NATIVE);
  }

  // 2. Build sub-agent - single delegation point for any task that needs
  // to write/edit files, run shell commands, or assemble deliverables.
  // Available outside Discord.
  if (!isDiscord) {
    tools.push(buildBuildTool(isWhatsAppGroup));
  }

  // 3. Communication & Delivery (no voice on personal WA: replies are text + attachments only)
  if (!isDiscord && userCtx.platform !== PLATFORM_WA_PERSONAL) {
    tools.push(buildVoiceTool({
      includeRecipientName: isAdmin || (isActiveMember && isWhatsApp),
      includeRecipientPhone: isAdmin,
    }));
  }
  if (isDiscord) {
    tools.push(TOOL_GENERATE_FORMAL_REQUEST_PDF);
    // First message of a thread: offer (and force, via tool_choice in the
    // handler) the title-setter so the conversation gets named exactly once.
    if (userCtx.isFirstTurn) {
      tools.push(TOOL_SET_CONVERSATION_TITLE);
    }
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

  // 5. Memory, Meta & Stats (no long-term memory on Discord)
  if (!isDiscord) {
    const isPersonalChat = userCtx.platform === PLATFORM_WA_PERSONAL;
    tools.push(buildUpdateMemoryTool(isWhatsAppGroup, isPersonalChat));
  }
  if (!isDiscord) {
    tools.push(TOOL_TOGGLE_RELEASE_NOTIFY);
  }
  // Statute tool: active WA members only (Discord has RulesContext in the system prompt).
  if (isActiveMember && isWhatsApp) {
    tools.push(TOOL_READ_SERVER_RULES);
  }
  if (isActiveMember && isWhatsApp) {
    tools.push(TOOL_READ_MUSIC_STATS);
  }

  // 6. Bug Report (all platforms, all modes)
  tools.push(TOOL_BUG_REPORT);

  return tools;
}

/** Whether the tool is in the live list for this user (same rules as the model schema). */
function isToolAllowedForUser(toolName, userCtx) {
  const isActiveMember = Boolean(userCtx?.isActiveMember);
  const isAdmin = Boolean(userCtx?.isAdmin);
  const tools = getToolsForUser(isActiveMember, isAdmin, userCtx);
  return tools.some(t => t?.function?.name === toolName);
}

module.exports = {
  getToolsForUser,
  isToolAllowedForUser,
  isActiveMemberOnlyTool,
  validateToolArgs,
  SET_CONVERSATION_TITLE_TOOL: 'set_conversation_title',
};
