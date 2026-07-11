// src/ai/tools.js
//
// Central registry of tool definitions for the main brain (function calling schema).
// Uses makeTool + validateToolArgs (lightweight hallucination guard, no ajv).
// getToolsForUser builds the per-user/platform list (hides admin-only, active-member-only, Discord-specific).
// The build tool description is generic and does not expose sub-agent internals.

const { PLATFORM_DISCORD, PLATFORM_WA_PERSONAL, VIDEO_GEN_DURATION_S, VIDEO_GEN_RESOLUTION } = require('../config/constants');
const { LEGAL_NAME } = require('../config/env');
const { formatSkillNamesList } = require('../utils/skills');

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
 *   - all `required` properties are present and non-null (empty string allowed when `allowEmpty: true`)
 *   - top-level property types match the declared `type` (string/array/etc.)
 *   - enum constraints on top-level string properties
 *
 *   - one level of nested `required` fields on object properties (e.g. recipient)
 *   - shallow `required` on array items when items.type === 'object', plus one
 *     level of nested object `required` on those item fields (e.g. recurrence)
 *
 * Intentionally not fully recursive: deeper nesting inside array items is
 * validated by individual tool handlers.
 *
 * @param {object} args - Parsed tool-call arguments.
 * @param {object} toolDef - Tool definition (as returned by makeTool).
 * @returns {string|null}
 */
function _validateObjectRequired(value, propSchema, pathPrefix) {
  if (propSchema.type !== 'object' || typeof value !== 'object' || Array.isArray(value)) return null;
  const nestedRequired = Array.isArray(propSchema.required) ? propSchema.required : [];
  const nestedProps = propSchema.properties || {};
  for (const nestedKey of nestedRequired) {
    const nestedSchema = nestedProps[nestedKey];
    const allowEmpty = Boolean(nestedSchema && nestedSchema.allowEmpty);
    const nestedVal = value[nestedKey];
    if (nestedVal === undefined || nestedVal === null || (nestedVal === '' && !allowEmpty)) {
      return `Missing required argument "${pathPrefix}.${nestedKey}".`;
    }
  }
  return null;
}

function validateToolArgs(args, toolDef) {
  if (!toolDef || !toolDef.function || !toolDef.function.parameters) return null;
  const params = toolDef.function.parameters;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return 'Tool arguments must be a JSON object.';
  }
  const required = Array.isArray(params.required) ? params.required : [];
  const props = params.properties || {};
  for (const key of required) {
    const propSchema = props[key];
    const allowEmpty = Boolean(propSchema && propSchema.allowEmpty);
    const val = args[key];
    if (val === undefined || val === null || (val === '' && !allowEmpty)) {
      return `Missing required argument "${key}".`;
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const propSchema = props[key];
    if (!propSchema) continue; // unknown extra props are tolerated
    if (value === undefined || value === null) continue;
    if (propSchema.type === 'array' && required.includes(key) && Array.isArray(value) && value.length === 0) {
      return `Argument "${key}" must be a non-empty array.`;
    }
    if (!_matchesType(value, propSchema.type)) {
      return `Argument "${key}" has wrong type (expected ${propSchema.type}).`;
    }
    if (propSchema.type === 'object' && typeof value === 'object' && !Array.isArray(value)) {
      const nestedErr = _validateObjectRequired(value, propSchema, key);
      if (nestedErr) return nestedErr;
    }
    if (propSchema.type === 'array' && Array.isArray(value) && propSchema.items?.type === 'object') {
      const itemSchema = propSchema.items;
      const itemProps = itemSchema.properties || {};
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
          return `Argument "${key}[${i}]" must be an object.`;
        }
        const itemErr = _validateObjectRequired(item, itemSchema, `${key}[${i}]`);
        if (itemErr) return itemErr;
        for (const [itemKey, itemVal] of Object.entries(item)) {
          const fieldSchema = itemProps[itemKey];
          if (!fieldSchema || itemVal === undefined || itemVal === null) continue;
          if (fieldSchema.type === 'object' && typeof itemVal === 'object' && !Array.isArray(itemVal)) {
            const nestedErr = _validateObjectRequired(itemVal, fieldSchema, `${key}[${i}].${itemKey}`);
            if (nestedErr) return nestedErr;
          }
        }
      }
    }
    if (Array.isArray(propSchema.enum) && propSchema.enum.length > 0 && typeof value === 'string') {
      if (!propSchema.enum.includes(value)) {
        return `Argument "${key}" must be one of: ${propSchema.enum.join(', ')}.`;
      }
    }
  }
  return null;
}

// -- xAI native server-side tools ------------------------------------------
//
// Passed straight through to /v1/responses as `{type:'<name>', ...}`.
// xAI runs them inside the same request and folds the results back into the
// response (zero extra rounds in our outer loop). The bot does NOT implement
// function tools with these names: the model invokes the native path, we
// never see them as tool_calls.
const TOOL_CODE_INTERPRETER_NATIVE = { type: 'code_interpreter' };

const TOOL_WEB_SEARCH_NATIVE = {
  type: 'web_search',
  num_results: 10,
  enable_image_understanding: true,
  enable_image_search: true,
};

const TOOL_X_SEARCH_NATIVE = {
  type: 'x_search',
  limit: 5,
  enable_image_understanding: true,
  enable_video_understanding: true,
};

/** Native server-side search tools (web + X), shared by main brain and build agent. */
const NATIVE_SEARCH_TOOLS = [TOOL_WEB_SEARCH_NATIVE, TOOL_X_SEARCH_NATIVE];

// -- Static tool definitions (schema never varies) -------------------------

const BUILD_TOOL_READ_FILE = makeTool({
  name: 'read_file',
  description: 'Load files from /workspace/ or /skills/.',
  properties: {
    path: {
      type: 'array',
      items: { type: 'string' },
      description: 'Paths under /workspace/ or /skills/, e.g. ["/skills/docx/SKILL.md", "/workspace/out/report.pdf"].',
    },
  },
  required: ['path'],
});

const TOOL_READ_SERVER_RULES = makeTool({
  name: 'read_server_rules',
  description: 'Read the server rules (Statuto Albertino / Constitution). Use when you need the full statute text.',
  properties: {},
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
    description: `Update personalized memory for ${scope}, for long-term preferences only. Do NOT store transient context.`,
    properties: {
      replace: {
        type: 'boolean',
        description: 'true = content replaces the full memory (rewrite/reorganize). false = append content to existing memory. Empty content always clears memory.',
      },
      content: {
        type: 'string',
        allowEmpty: true,
        description: 'Memory text (max 1000 chars total after save, empty=clear). Always write in English.',
      },
    },
    required: ['replace', 'content'],
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
    legalSignature: { type: 'string', description: `Legal advisor signature ("${LEGAL_NAME}" if requested by him in person, or "Nessuno")` },
  },
  required: ['fullName', 'title', 'motivation', 'requesterSignature'],
});

const TOOL_MUSIC_CREATOR = makeTool({
  name: 'music_creator',
  description: 'Create a 30-second music clip from a prompt. Result is pushed to the delivery buffer.',
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
// Available on WhatsApp (dedicated + personal); image/video generation likewise.
//
// Reference images: each entry is a filename with extension from the delivery
// buffer or chat history, or a public https URL. Filenames resolve buffer-first,
// then history; local files are exposed as public URLs for xAI.

const TOOL_GENERATE_IMAGE = makeTool({
  name: 'generate_image',
  description: 'Generate an image from a textual prompt, optionally guided by up to 3 reference images (editing, composition, style transfer). Result is pushed to the delivery buffer.',
  properties: {
    prompt: {
      type: 'string',
      description: 'Image description: subject, style, lighting, mood, composition. When passing reference images, refer to them ALWAYS as <IMAGE_0>, <IMAGE_1>, <IMAGE_2> in array order - never by filename.',
    },
    reference_images: {
      type: 'array',
      items: { type: 'string' },
      description: 'Up to 3. Each entry: filename with extension from the delivery buffer or chat history, or a public https URL. Order matters (<IMAGE_0> = first). 1 = edit/transform; 2-3 = combine or style transfer. Omit for pure text-to-image.',
    },
    aspect_ratio: {
      type: 'string',
      enum: ['1:1', '16:9', '9:16', '4:3', '3:4'],
      description: 'Aspect ratio for pure text-to-image. Omit for automatic. Ignored with reference images (output follows the input image).',
    },
  },
  required: ['prompt'],
});

const TOOL_GENERATE_VIDEO = makeTool({
  name: 'generate_video',
  description: `Generate a ${VIDEO_GEN_DURATION_S}-second ${VIDEO_GEN_RESOLUTION} video from a textual prompt, optionally guided by reference images. It can NOT modify or extend an existing video - only reference IMAGES are accepted. Result is pushed to the delivery buffer.`,
  properties: {
    prompt: {
      type: 'string',
      description: 'Video description: subject, action, camera movement, style, lighting. When passing reference images, refer to them ALWAYS as <IMAGE_0>, <IMAGE_1>, ... in array order - never by filename.',
    },
    reference_images: {
      type: 'array',
      items: { type: 'string' },
      description: 'Up to 7. Each entry: filename with extension from the delivery buffer or chat history, or a public https URL. 1 = animate as first frame; 2-7 = style/subject guides. Omit for pure text-to-video.',
    },
    aspect_ratio: {
      type: 'string',
      enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3'],
      description: 'Aspect ratio. Default 16:9. With a single reference image, omit to respect the input image.',
    },
  },
  required: ['prompt'],
});

// -- Dynamic tool builders (schema varies by grade/platform) -------------

// Optional attachments on delivery tools and on the fixed JSON reply schema.
const DELIVERY_ATTACHMENTS_PROP = {
  type: 'array',
  items: { type: 'string' },
  description:
    'OPTIONAL. Same entry types as reply attachments: buffer/history filename or direct https file URL. Omit if none.',
};

function buildWhatsAppTool(isAdmin) {
  // Admin: address members directly by phone (roster in <ActiveMembers>).
  // Active non-admin: name only (the backend resolves it to the member).
  // This tool never targets the current chat — replies there use structured output.
  const recipientProps = {};
  if (isAdmin) {
    recipientProps.phone = {
      type: 'string',
      description: 'Recipient phone with country code (e.g. +393XXXXXXXXX), from the &lt;ActiveMembers&gt; roster or given by the user. Required — external number only.',
    };
  } else {
    recipientProps.name = {
      type: 'string',
      description: 'Recipient active member name (not yourself).',
    };
  }

  const properties = {
    message: { type: 'string', description: 'Message text. Use only the formatting declared in the system prompt Format line.' },
    recipient: {
      type: 'object',
      description: isAdmin
        ? 'Target recipient (phone). Required — external number only; never the current chat.'
        : 'Target active member. Required — never the current chat.',
      properties: recipientProps,
      required: isAdmin ? ['phone'] : ['name'],
    },
    attachments: DELIVERY_ATTACHMENTS_PROP,
  };

  return makeTool({
    name: 'send_whatsapp_message',
    description: 'Delivery tool — send a message to a specific phone number. Never for intermediate updates in the current chat. Start by saying on behalf of which user you\'re writing, e.g. "Marco mi ha chiesto di dirti..."',
    properties,
    required: ['recipient', 'message'],
  });
}

function buildEmailTool(isAdmin) {
  const recipientProps = {};
  if (isAdmin) {
    recipientProps.email = {
      type: 'string',
      description: 'Recipient email address, from the &lt;ActiveMembers&gt; roster or given by the user.',
    };
  } else {
    recipientProps.name = {
      type: 'string',
      description: 'Member name (email resolved from name)',
    };
  }

  const properties = {
    subject: { type: 'string', description: 'Email subject' },
    body: { type: 'string', description: 'HTML body (no markdown)' },
    recipient: {
      type: 'object',
      description: isAdmin ? 'Target recipient (email).' : 'Recipient',
      properties: recipientProps,
      required: isAdmin ? ['email'] : ['name'],
    },
    attachments: DELIVERY_ATTACHMENTS_PROP,
  };

  return makeTool({
    name: 'send_email',
    description: 'Delivery tool - send an email. If the user asked you to send it on behalf of someone else start by saying on behalf of which user you\'re writing, e.g. "Marco mi ha chiesto di dirti..."',
    properties,
    required: ['recipient', 'subject', 'body'],
  });
}

function buildScheduleTasksTool(isActiveMember, isAdmin, isWhatsAppGroup) {
  const canTargetOthers = isAdmin || isActiveMember;
  const here = isWhatsAppGroup ? 'group' : 'chat';
  const waProps = {};

  if (isAdmin) {
    // Mirror send_whatsapp_message/send_email: the admin only associates a
    // phone (from the <ActiveMembers> roster or given by the user). No
    // toPrivate/toGroup flags — omit recipient = current chat/group; set
    // recipient = the scheduler delivers privately to that number (it treats a
    // bare recipient as a private reminder).
    waProps.recipient = {
      type: 'object',
      description: `Target recipient (phone) — someone other than the current ${here}.`,
      properties: {
        phone: {
          type: 'string',
          description: 'Recipient phone with country code (e.g. +393XXXXXXXXX), from the &lt;ActiveMembers&gt; roster or given by the user.',
        },
      },
    };
  } else {
    if (isWhatsAppGroup) {
      waProps.toGroup = {
        type: 'boolean',
        description: 'Send this reminder to the current group.',
      };
    }

    if (isActiveMember) {
      waProps.toPrivate = {
        type: 'boolean',
        description: 'Send this reminder as a private message (to recipient if set, otherwise to the current user).',
      };
    } else if (isWhatsAppGroup) {
      waProps.toPrivate = {
        type: 'boolean',
        description: 'Deliver as a private DM to you instead of in the group.',
      };
    }

    // Active non-admin members target a recipient by name only (the backend
    // resolves it to the member). Active members never address raw phone
    // numbers — a safety mechanism against unwanted sends to anyone.
    if (isActiveMember) {
      waProps.recipient = {
        type: 'object',
        description: 'Active member to remind. REQUIRED with toPrivate when reminding someone other than the current chat.',
        properties: {
          name: {
            type: 'string',
            description: 'Active member name to remind.',
          },
        },
      };
    }
  }

  const contentDesc = canTargetOthers
    ? 'Reminder text for the recipient at delivery time (not instructions to yourself). Use only the formatting declared in the system prompt Format line.'
    : (isWhatsAppGroup
      ? 'Reminder text for the group or for you in DM, per whatsapp settings. Use only the formatting declared in the system prompt Format line.'
      : 'Reminder text delivered to you at the scheduled time. Use only the formatting declared in the system prompt Format line.');

  const taskItemProps = {
    content: {
      type: 'string',
      description: contentDesc,
    },
    scheduledAt: {
      type: 'string',
      description: 'Execution time in ISO 8601 (e.g. 2026-06-05T14:30:00). System uses the correct timezone.',
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

  if (canTargetOthers || isWhatsAppGroup) {
    taskItemProps.whatsapp = {
      type: 'object',
      description: isAdmin
        ? `Delivery destination. Omit = current ${here}. Set recipient = private reminder to that phone.`
        : (canTargetOthers
          ? (isWhatsAppGroup
            ? 'Destination. Omit = current group. For a private reminder set toPrivate; add recipient to send it to someone else (without recipient it goes to the current user).'
            : 'Destination. Omit = current chat. To remind someone else, set toPrivate and add recipient.')
          : 'Omit = current group. Set toPrivate for a reminder to you only (private DM).'),
      properties: waProps,
    };
  }

  return makeTool({
    name: 'schedule_tasks',
    description: isAdmin
      ? 'Schedule reminders for the current chat, other active members or external contacts. The reminder is DELIVERED at the scheduled time to whoever you set as recipient — set it whenever the target is not the current chat. One task per person.'
      : isActiveMember
        ? 'Schedule reminders for the current chat or other active members. The reminder is DELIVERED to the recipient you set — set it whenever the target is not the current chat. One task per person.'
        : 'Schedule personal reminders for the current chat.',
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
    description: 'Show scheduled reminders.',
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
    description: 'Remove scheduled reminders.',
    properties,
    required: ['taskIds'],
  });
}

const TOOL_BUG_REPORT = makeTool({
  name: 'bug_report',
  description: 'Report a bug/failure. Use for tool error DOES NOT state the Admin was already notified, general logical bugs or issues with system components e.g. unclear instructions, unexpected behaviors, bugs noted in the history... Inform the user in your final response.',
  properties: {
    description: {
      type: 'string',
      description: 'Brief but clear description of the problem (what failed, where, and any relevant context).',
    },
  },
  required: ['description'],
});

// -- Build sub-agent (build tool) ------------------------------------
//
// Isolated sub-agent (/workspace/, bash, yt-dlp, ffmpeg). No chat history —
// stage inputs via attachments[]. Native web/X search on the sub-agent side.

function buildBuildTool(isGroup) {
  const scope = isGroup ? 'the current group' : 'the current user';
  const skillNames = formatSkillNamesList();
  const skillsHint = skillNames ? ` Skills: ${skillNames}.` : '';
  return makeTool({
    name: 'build',
    description:
      'Delegate file deliverables to an isolated build sub-agent (/workspace/, bash, yt-dlp, ffmpeg). '
      + 'Not for fetchable X/web media — use search + final attachments. '
      + 'Isolated turn — no chat history; it sees only your prompt, &lt;BuildWorkspace&gt; files, and attachments[]. '
      + 'Stage in attachments[] anything it must use that is not already in the workspace; generate image, video, or music first when needed. '
      + 'Autonomous web/X search on the sub-agent. '
      + `Workspace for ${scope}, 4h TTL, 500 MB, once per round.${skillsHint}`,
    properties: {
      prompt: {
        type: 'string',
        description: 'Brief for the sub-agent: deliverable, format, naming, and constraints.',
      },
      attachments: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Each entry: buffer/history filename or public https URL. Omit if already in workspace or not needed.',
      },
    },
    required: ['prompt'],
  });
}

// -- Main builder: constructs tool list in a single pass -------------------

function getToolsForUser(isActiveMember, isAdmin, userCtx = {}) {
  const isWhatsApp = userCtx.platform && userCtx.platform.startsWith('whatsapp');
  const isWhatsAppGroup = isWhatsApp && userCtx.isGroup;
  const isDiscord = userCtx.platform === PLATFORM_DISCORD;

  const tools = [];

  // 1. Search & Information Retrieval. web_search and x_search are native
  // xAI server-side tools (zero round cost), available on every platform.
  // History files are attached natively on user-side entries (no read_file on
  // the main brain). Assistant-side entries stay [Attachment] tags only.
  tools.push(
    ...NATIVE_SEARCH_TOOLS,
  );
  if (isWhatsApp) {
    tools.push(TOOL_MUSIC_CREATOR);
  }

  // 1b. Grok Imagine - image and video generation (WhatsApp only).
  // Per-round caps live in PER_ROUND_TOOL_LIMITS (toolCallExecution.js).
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

  // 3. Communication & Delivery. Voice replies are NOT a tool: GemiX sets the
  // `voice` flag in its structured reply (WA dedicated only — see responseSchema).
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

/**
 * Collect function tool names plus native server-side tool types for prompt caps.
 * @param {Array} tools
 * @returns {Set<string>}
 */
function toolNamesToSet(tools) {
  const names = new Set();
  for (const t of tools) {
    if (t?.function?.name) names.add(t.function.name);
    else if (typeof t?.type === 'string' && t.type !== 'function') names.add(t.type);
  }
  return names;
}

/**
 * Build userCtx for a platform profile (member + admin tools included).
 * @param {object} cap - CAPS[profile] entry
 * @param {object} [overrides]
 */
function userCtxForProfile(cap, overrides = {}) {
  return {
    platform: cap.platform,
    isGroup: Boolean(cap.isGroup),
    chatId: overrides.chatId ?? null,
  };
}

/**
 * Sync CAPS[].tools from getToolsForUser so static caps cannot drift from the registry.
 * @param {object} caps - CAPS map from platformCapabilities
 * @param {object} profileEnum - PROFILE enum from platformCapabilities
 */
function syncProfileToolSets(caps, profileEnum) {
  for (const profile of Object.values(profileEnum)) {
    const cap = caps[profile];
    if (!cap) continue;
    const tools = getToolsForUser(true, false, userCtxForProfile(cap));
    cap.tools = toolNamesToSet(tools);
  }
}

/**
 * Unified tool gate: optional per-round name subset, then live schema check.
 * @param {string} toolName
 * @param {object} userCtx
 * @param {object} [opts]
 * @param {Set<string>|null} [opts.allowedRoundNames] - names exposed to the model this round
 * @param {Function} [opts.unavailableMessage] - (toolName, userCtx) => string
 * @returns {string|null} Error message when blocked, else null.
 */
function getToolAccessError(toolName, userCtx, opts = {}) {
  const allowedRound = opts.allowedRoundNames;
  if (allowedRound && !allowedRound.has(toolName)) {
    if (typeof opts.unavailableMessage === 'function') {
      return opts.unavailableMessage(toolName, userCtx);
    }
    return `Tool "${toolName}" is not available in the current round.`;
  }
  if (!isToolAllowedForUser(toolName, userCtx)) {
    if (typeof opts.unavailableMessage === 'function') {
      return opts.unavailableMessage(toolName, userCtx);
    }
    return `Tool "${toolName}" is not available in the current context.`;
  }
  return null;
}

module.exports = {
  getToolsForUser,
  getToolAccessError,
  syncProfileToolSets,
  toolNamesToSet,
  validateToolArgs,
  NATIVE_SEARCH_TOOLS,
  BUILD_TOOL_READ_FILE,
};
