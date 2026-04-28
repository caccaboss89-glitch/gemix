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
  description: 'Search the web. Call multiple times for deeper research. Supports operators like site:, -site:, after:/before:, filetype:, intitle:, inurl:, exact phrases, OR/AND.',
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
  description: 'Search for images and inspect the returned previews. Results are buffered for delivery; use discard to remove unwanted ones. Call multiple times to refine.',
  properties: {
    query: {
      type: 'string',
      description: 'Specific image search query.',
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
      description: 'Filter by type (default "any").',
    },
    discard: {
      type: 'array',
      items: { type: 'integer' },
      description: 'Image IDs to remove from buffer (from previous search results).',
    },
    save_to_disk: {
      type: 'boolean',
      description: 'If true, save the downloaded image(s) to searched_images/ (use only if you need them with agentic tools, e.g. image editing, include in documents, etc.). Default false.',
    },
  },
  required: ['query'],
});

const TOOL_ATTACH_FILE = makeTool({
  name: 'attach_file',
  description: 'Buffer a file for delivery (NOT output/<file> or history/<file>). Allowed: permanent/<file>, searched_images/<file>, projects/<name>/{temp|code}/<file>. To send buffered files to other recipients, use send_whatsapp_message / send_voice_message / send_email with includeAttachments=true.',
  properties: {
    path: { type: 'string', description: 'Relative path under the user root.' },
  },
  required: ['path'],
});

const TOOL_REPORT_TO_USER = makeTool({
  name: 'report_to_user',
  description: 'Send an intermediate status message to the user while you continue working. Use ONLY during multi-step operations (3+ tool calls).',
  properties: {
    message: { type: 'string', description: 'Short status update in Italian for the user.' },
  },
  required: ['message'],
});

const TOOL_AGENTIC_UNLOCK = makeTool({
  name: 'agentic_unlock',
  description: 'Unlock cloud, project management, the Python sandbox (code_execution/write_file/edit_file/bash with numpy, scipy, sympy, mpmath, pandas, matplotlib, seaborn, plotly, Pillow, rembg, cairosvg, pytesseract, pydub, librosa, moviepy, astropy, qutip, polygon-api-client, python-docx, openpyxl, python-pptx, reportlab, yt-dlp). Call this before tasks that need computation, workspace exploration, file generation/editing/conversion... It returns the full agentic briefing and exposes those tools next round. Do not call it for normal chat, web research, voice replies, scheduling, memory updates, or tasks already covered by visible tools',
  properties: {},
});

function buildReadFileTool(isDiscord) {
  const description = isDiscord
    ? 'Read the contents of a file from chat history (text, code, images, audio, pdf).'
    : 'Read the contents of a file from chat history, cloud or project artefacts (text, code, images, audio, pdf).';
  const pathDesc = isDiscord
    ? 'Filename from chat history (history/ prefix optional, e.g. "report.pdf").'
    : 'Relative path from user root: history/<file>, permanent/<file>, searched_images/<file>, projects/<name>/{temp|output|code}/<file>. Use skills:<name>.md to read a skill guide.';
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
  description: 'Run quick single-cell Python in the sandbox. Best for calculations, data analysis, or lightweight scripts. Can run without a project for stateless tasks, but creating/modifying files REQUIRES an active project. Writable: /workspace/{temp,output,code}/. Read-only: /readonly/{history,permanent,searched_images}. Everything in output/ is auto-delivered to the user.',
  properties: {
    code: { type: 'string', description: 'Python code to execute. Multiline allowed; the same kernel persists across calls.' },
    timeout_ms: { type: 'integer', description: 'Optional execution timeout in milliseconds (default 30000, max 120000).' },
  },
  required: ['code'],
});

const TOOL_WRITE_FILE = makeTool({
  name: 'write_file',
  description: 'Create or overwrite a file in the current project under {temp|output|code}. Use for: scripts → code/, intermediate data → temp/, final deliverables → output/. Everything in output/ is auto-delivered to the user — put there ONLY the files the user wants to receive. Pair with bash to run scripts. Max 5 MB per call.',
  properties: {
    path: { type: 'string', description: 'Relative path under the current project, e.g. "projects/<current>/code/main.py".' },
    content: { type: 'string', description: 'File content.' },
    encoding: { type: 'string', enum: ['utf-8', 'base64'], description: 'Content encoding (default "utf-8").' },
    mode: { type: 'string', enum: ['overwrite', 'append'], description: 'Write mode (default "overwrite").' },
  },
  required: ['path', 'content'],
});

const TOOL_EDIT_FILE = makeTool({
  name: 'edit_file',
  description: 'Edit an existing UTF-8 text file in the current project by replacing old_string with new_string. old_string must be unique unless replace_all=true. Same path limits as write_file.',
  properties: {
    path: { type: 'string', description: 'Relative path under projects/<current>/{temp|output|code}/.' },
    old_string: { type: 'string', description: 'Exact text to replace. Must appear at least once. Provide enough surrounding context to be unique unless replace_all=true.' },
    new_string: { type: 'string', description: 'Replacement text (use empty string to delete the matched region).' },
    replace_all: { type: 'boolean', description: 'Replace every occurrence (default false). Required when old_string is not unique.' },
  },
  required: ['path', 'old_string', 'new_string'],
});

const TOOL_BASH = makeTool({
  name: 'bash',
  description: 'Run a shell command in the sandbox. Use for: `gemix-project <subcmd>` management, running workspace scripts (`python code/script.py`), shell utilities (ffmpeg, zip, ls, cp...), and yt-dlp downloads. Can run without a project for stateless tasks, but creating/modifying files REQUIRES an active project. Same isolation as code_execution, project mounted at /workspace. In the same round, bash always executes AFTER write_file/edit_file. Default timeout 30 s, max 120 s.',
  properties: {
    command: { type: 'string', description: 'Shell command (bash -c). Single line or `&&`-chained statements.' },
    timeout_ms: { type: 'integer', description: 'Optional timeout in milliseconds (default 30000, max 120000).' },
    background: { type: 'boolean', description: 'Run in background: returns immediately with an output file path. Use read_file on that path later to get results (automatically waits if still running). Default false.' },
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
    description: 'Delivery tool — Send a voice message. Without a recipient it replies in the current chat and ends the turn; with a recipient it sends externally. Buffered files are always included in current-chat replies and optional for other recipients.',
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
    description: 'Delivery tool — Send a WhatsApp message to another recipient. Use includeAttachments to send buffered files too.',
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
    description: 'Delivery tool — Send an email. Use includeAttachments to send buffered files too.',
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
  // attach_file is WhatsApp-only AND gated behind agentic_unlock (it deals
  // with files only relevant to the agentic flow — permanent/, projects/,
  // searched_images/). Discord never gets it.
  tools.push(TOOL_WEB_SEARCH, TOOL_IMAGE_SEARCH, TOOL_BROWSE_PAGE, TOOL_REPORT_TO_USER, buildReadFileTool(isDiscord));

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

    // ── Agentic toolkit (gated) ─────────────────────────────────────────
    // By default we expose a tiny gateway tool. The full project /
    // sandbox / file-delivery stack only appears AFTER the AI calls it,
    // saving ~7-8 K input tokens on every non-agentic conversation.
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
