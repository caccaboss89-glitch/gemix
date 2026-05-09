// src/ai/tools.js
const { PLATFORM_DISCORD } = require('../config/constants');

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
  description: 'Search the web. Call multiple times for deeper research. Supports operators: site:, -site:, after:/before:, filetype:, intitle:, inurl:, "exact phrase", OR/AND.',
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
      description: 'If true, ALL images are saved to searched_images/ regardless of your final selection. Default false.',
    };
  }

  return makeTool({
    name: 'image_search',
    description: 'Search for images and inspect the returned previews. Results are buffered with sequential IDs (1, 2, 3...). Use [image:N] tags in your final message to selectively send images to the current user.',
    properties,
    required: ['query'],
  });
}

const TOOL_ATTACH_FILE = makeTool({
  name: 'attach_file',
  description: 'Buffer a file for delivery (from /readonly/ or /workspace/) for automatic delivery to the current user. Use delivery tools with includeAttachments=true to send to others.',
  properties: {
    path: { type: 'string', description: 'Unified path: "/readonly/permanent/file.txt" or "/workspace/code/main.py".' },
  },
  required: ['path'],
});


const TOOL_AGENTIC_UNLOCK = makeTool({
  name: 'agentic_unlock',
  description: 'MUST be called BEFORE any action that needs the agentic workspace. Unlocks: Python sandbox, bash, file creation/editing, cloud storage, project management, advance computations, yt-dlp downloads, OCR, charts, data work... After unlock, the full toolkit is available in the NEXT round. Do NOT call for: normal chat, web search, voice replies, scheduling, memory updates.',
  properties: {},
});

function buildReadFileTool(isDiscord, agenticUnlocked = false) {
  const description = !agenticUnlocked
    ? 'Read the contents of a file from chat history (text, code, images, video, audio, pdf).'
    : 'Read the contents of a file from chat history, cloud, searched images or project artefacts (text, code, images, video, audio, pdf).';

  let pathDesc = !agenticUnlocked
    ? 'Filename from chat history (e.g. "report.pdf").'
    : 'Absolute path: /readonly/{history|permanent|searched_images|skills}/<file> or /workspace/{temp|output|code}/<file>. Bare filenames (no slash) are resolved to chat history automatically.';

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

const TOOL_CODE_EXECUTION = makeTool({
  name: 'code_execution',
  description: 'Run Python in the sandbox for calculations, data analysis, or scripts. Can run without a project. Writable: /workspace/{code,temp,output}/. Read-only: /readonly/{history,permanent,searched_images,skills}. Files in /workspace/output/ are buffered for delivery.',
  properties: {
    code: { type: 'string', description: 'Python code to execute. Multiline allowed; the same kernel persists across calls.' },
    timeout_ms: { type: 'integer', description: 'Timeout in ms (default 30000, max 120000).' },
    execution_phase: {
      type: 'string',
      enum: ['before_all', 'after_all'],
      description: "Execution order in multi-tool rounds. Default: 'after_all'."
    },
  },
  required: ['code'],
});

const TOOL_WRITE_FILE = makeTool({
  name: 'write_file',
  description: 'Create or overwrite a file in the current project ({temp|output|code}). Files in /workspace/output/ are buffered for delivery.',
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
  description: 'Run a shell command in the sandbox. For: gemix-project management, running workspace scripts (python code/script.py), shell utilities (zip, ls, cp...), yt-dlp downloads... Can run WITHOUT a project for stateless tasks, but creating/modifying files REQUIRES an active project. Project mounted at /workspace. Read-only: /readonly/{history,permanent,searched_images,skills}. Can combine with write_file/edit_file or other bash/code_execution in the same round.',
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

const TOOL_BROWSE_PAGE = makeTool({
  name: 'browse_page',
  description: 'Fetch and analyze a web page. In summary mode, an LLM extracts what matters based on your instructions. Use after web_search for promising URLs; use raw/raw_html only when you need unprocessed content.',
  properties: {
    url: {
      type: 'string',
      description: 'Full URL to fetch (must include https://).',
    },
    instructions: {
      type: 'string',
      description: 'What to extract or analyze from the page (e.g. "list all pricing tiers", "summarize the main argument", "extract all API endpoints"). Be specific for better results. If omitted in summary mode, the page is summarized with a generic overview.',
    },
    mode: {
      type: 'string',
      enum: ['summary', 'raw', 'raw_html'],
      description: 'Processing mode (default "summary"). Use "raw" to get unprocessed extracted text without LLM summarization. Use "raw_html" to get the full HTML source (useful for complex scraping).',
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

const TOOL_MUSIC_CREATOR = makeTool({
  name: 'music_creator',
  description: 'Create a 30-second music clip from a prompt. Returns lyrics and buffers the audio for delivery.',
  properties: {
    prompt: {
      type: 'string',
      description: 'Detailed description of style, instruments, and mood.',
    },
  },
  required: ['prompt'],
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
    description: 'Delivery tool — Send a voice message. Use includeAttachments=true to send ALL currently buffered files to this recipient (supports all or none; [image:N] tags not supported here).',
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
    description: 'Delivery tool — Send a WhatsApp message to another recipient. Use includeAttachments=true to send ALL currently buffered files.',
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
    description: 'Delivery tool — Send an email. Use includeAttachments=true to send ALL currently buffered files.',
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
  description: 'Report a system problem to the admin (bug, tool failure, unexpected behavior). Use when a tool fails, something behaves wrongly, or there is a system issue worth reporting. After calling this, you MUST also inform the user in your final reply that you encountered a problem and reported it to the admin (do NOT call this silently).',
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
    TOOL_WEB_SEARCH,
    buildImageSearchTool(userCtx.agenticUnlocked),
    TOOL_BROWSE_PAGE,
    buildReadFileTool(isDiscord, userCtx.agenticUnlocked)
  );
  if (isWhatsApp) {
    tools.push(TOOL_MUSIC_CREATOR);
  }

  // 2. Agentic Workspace (Gated)
  if (!isDiscord) {
    if (userCtx.agenticUnlocked) {
      tools.push(
        TOOL_CODE_EXECUTION,
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
