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

// ── xAI code_interpreter — exposed as a function tool ──
//
// Hermes /chat/completions only accepts type:'function' or type:'live_search'.
// We expose code_interpreter as a regular function tool; when the model calls
// it, the dispatcher in tools/index.js forwards the request to xAI /v1/responses
// (same path as web_x_search) where code_interpreter IS a valid server-side tool.
function buildCodeInterpreterTool(agenticUnlocked = false) {
  const description = agenticUnlocked
    ? 'Run Python for calculations, data analysis, plots, or any ad-hoc script. Isolated sandbox — no access to user workspace. For project files use write_file + bash instead.'
    : 'Run Python for calculations, data analysis, plots, or any ad-hoc script. Isolated sandbox — no access to user workspace.';
  return makeTool({
    name: 'code_interpreter',
    description,
    properties: {
      code: {
        type: 'string',
        description: 'Python code to execute.',
      },
    },
    required: ['code'],
  });
}

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

function buildImageSearchTool(agenticUnlocked = false) {
  const properties = {
    query: { type: 'string', description: 'Specific image search query.' },
    count: { type: 'integer', description: 'Images to retrieve (1-4, default 1).' },
    language: { type: 'string', description: 'Language hint (default "it", use "en" for international results).' },
    image_type: {
      type: 'string',
      enum: ['any', 'photo', 'gif', 'clipart', 'lineart'],
      description: 'Filter by type (default "any").',
    },
  };

  if (agenticUnlocked) {
    properties.save_to_disk = {
      type: 'boolean',
      description: 'If true, ALL images are saved to searched_images/. Default false.',
    };
  }

  return makeTool({
    name: 'image_search',
    description: 'Search for images and inspect the returned previews. Results are pushed to the delivery buffer.',
    properties,
    required: ['query'],
  });
}

const TOOL_ATTACH_FILE = makeTool({
  name: 'attach_file',
  description: 'Push an existing file (from /readonly/ or /workspace/) into the delivery buffer.',
  properties: {
    path: { type: 'string', description: 'Unified path: "/readonly/searched_images/file.txt" or "/workspace/code/main.py".' },
  },
  required: ['path'],
});


const TOOL_AGENTIC_UNLOCK = makeTool({
  name: 'agentic_unlock',
  description: 'Unlock the agentic toolkit (bash, write_file, edit_file, project management, downloads, OCR, charts) on the user-scoped /workspace + /readonly filesystem. Full toolkit becomes available in the next round. Do NOT call for chat replies, web search, voice, scheduling, memory, or pure calculations (use code_interpreter for those — it has no /workspace access).',
  properties: {},
});

function buildReadFileTool(isDiscord, agenticUnlocked = false) {
  const description = !agenticUnlocked
    ? 'Read the contents of a file from chat history (text, code, images, video, audio, pdf).'
    : 'Read the contents of a file from chat history, searched images or project artefacts (text, code, images, video, audio, pdf).';

  let pathDesc = !agenticUnlocked
    ? 'Filename from chat history (e.g. "report.pdf").'
    : 'Absolute path: /readonly/{history|searched_images|skills}/<file> or /workspace/{temp|output|code}/<file>. Bare filenames (no slash) are resolved to chat history automatically.';

  if (!isDiscord && agenticUnlocked) {
    pathDesc += ' Use skills:<name>.md to read a skill guide.';
  }

  return makeTool({
    name: 'read_file',
    description,
    properties: { path: { type: 'string', description: pathDesc } },
    required: ['path'],
  });
}

// ── Agentic toolkit (WhatsApp only, gated behind agentic_unlock) ──

const TOOL_WRITE_FILE = makeTool({
  name: 'write_file',
  description: 'Create or overwrite a file in the current project ({temp|output|code}). Files in /workspace/output/ are pushed to the delivery buffer.',
  properties: {
    path: { type: 'string', description: 'Path under current project: "/workspace/{temp|output|code}/file".' },
    content: { type: 'string', description: 'File content (max 5 MB).' },
    encoding: { type: 'string', enum: ['utf-8', 'base64'], description: 'Content encoding (default "utf-8").' },
    mode: { type: 'string', enum: ['overwrite', 'append'], description: 'Write mode (default "overwrite").' },
  },
  required: ['path', 'content'],
});

const TOOL_EDIT_FILE = makeTool({
  name: 'edit_file',
  description: 'Edit an existing UTF-8 text file in the current project by replacing old_string with new_string. old_string must be unique unless replace_all=true. Same path limits as write_file.',
  properties: {
    path: { type: 'string', description: 'Path under current project: "/workspace/{temp|output|code}/file".' },
    old_string: { type: 'string', description: 'Exact text to replace. Must appear at least once. Provide enough surrounding context to be unique unless replace_all=true.' },
    new_string: { type: 'string', description: 'Replacement text (use empty string to delete the matched region).' },
    replace_all: { type: 'boolean', description: 'Replace every occurrence (default false). Required when old_string is not unique.' },
    start_line: { type: 'integer', description: 'Optional: line number where to start searching (1-indexed).' },
    end_line: { type: 'integer', description: 'Optional: line number where to stop searching (1-indexed).' },
  },
  required: ['path', 'old_string', 'new_string'],
});

const TOOL_BASH = makeTool({
  name: 'bash',
  description: 'Run a shell command in the project sandbox. For: gemix-project management, running workspace scripts, shell utilities (zip, ls, cp...), yt-dlp downloads, LibreOffice/pandoc conversions... Can run WITHOUT a project for stateless tasks, but creating/modifying files REQUIRES an active project. Project mounted at /workspace. Read-only: /readonly/{history,searched_images,skills}. Combine with write_file/edit_file in the same round to write a script and run it. NOTE: bash runs in the GemiX project sandbox (full filesystem access to /workspace + /readonly); for ad-hoc Python without filesystem access use code_interpreter instead.',
  properties: {
    command: { type: 'string', description: 'Single standalone shell command. Do NOT use shell concatenation or piping (&&, ||, ;, |, redirection, subshells) to combine steps. Emit multiple bash tool calls, using execution_phase when ordering is needed.' },
    timeout_ms: { type: 'integer', description: 'Timeout in ms (default 30000, max 120000).' },
    background: { type: 'boolean', description: 'Run in background: returns immediately with an output file path. Use read_file on that path later to get results. Default false.' },
    execution_phase: {
      type: 'string',
      enum: ['before_all', 'after_all'],
      description: "Execution order in multi-tool rounds. Default: 'after_all'."
    },
  },
  required: ['command'],
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

function buildGenerateImageTool(_agenticUnlocked = false) {
  return makeTool({
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
}

function buildGenerateVideoTool(_agenticUnlocked = false) {
  return makeTool({
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
}

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
    source: { type: 'string', description: 'Component or context where the issue occurred (e.g. "bash", "yt-dlp", "proxy", "pdf-parser")' },
    details: { type: 'string', description: 'Brief but clear description of the problem' },
  },
  required: ['source', 'details'],
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
    buildImageSearchTool(userCtx.agenticUnlocked),
    buildReadFileTool(isDiscord, userCtx.agenticUnlocked)
  );
  if (isWhatsApp) {
    tools.push(TOOL_MUSIC_CREATOR);
  }

  // 1c. Grok Imagine — image and video generation. Available only on
  // WhatsApp (same gating as music_creator) since both produce binary media
  // that is delivered through the WA attachment pipeline. Both go in the
  // ONCE_PER_ROUND_TOOLS set in tools/index.js.
  if (isWhatsApp) {
    tools.push(
      buildGenerateImageTool(userCtx.agenticUnlocked),
      buildGenerateVideoTool(userCtx.agenticUnlocked),
    );
  }

  // 1b. xAI server-side code interpreter — always available outside Discord,
  // runs in xAI's own isolated sandbox without access to /workspace/ or /readonly/.
  if (!isDiscord) {
    tools.push(buildCodeInterpreterTool(userCtx.agenticUnlocked));
  }

  // 2. Agentic Workspace (Gated)
  if (!isDiscord) {
    if (userCtx.agenticUnlocked) {
      tools.push(
        TOOL_WRITE_FILE,
        TOOL_EDIT_FILE,
        TOOL_BASH,
        TOOL_ATTACH_FILE,
      );
    } else {
      tools.push(TOOL_AGENTIC_UNLOCK);
    }
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
};
