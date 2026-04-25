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
    save_to_disk: {
      type: 'boolean',
      description: 'WhatsApp only. If true, save the downloaded image(s) to the user\'s searched_images/ folder so they can be reused later (e.g. by code_execution or copy_to_project). Default false.',
    },
  },
  required: ['query'],
});

const TOOL_ATTACH_FILE = makeTool({
  name: 'attach_file',
  description: 'Buffer an existing file from the user\'s personal cloud for delivery in the current response (WhatsApp only, requires prior agentic_unlock). Allowed sources: permanent/<file>, searched_images/<file>, projects/<name>/{figures|temp|output|code}/<file>. NOT allowed: history/ (the user already sees those files in their chat). After buffering, call send_whatsapp_message / send_email with includeAttachments=true to ship the file. Use this to deliver a permanent copy, an image_search result saved to disk earlier, or any artefact a project produced previously (no need to re-run code_execution).',
  properties: {
    path: { type: 'string', description: 'Relative path under the user root, e.g. "permanent/keep.docx", "searched_images/cat_1.jpg", "projects/myproj/output/report.pdf".' },
  },
  required: ['path'],
});

const TOOL_AGENTIC_UNLOCK = makeTool({
  name: 'agentic_unlock',
  description: 'Unlocks GemiX\'s agentic toolkit for THIS message: project management (list/create/switch/delete/cleanup_project, copy_to_permanent, copy_to_project), Python sandbox (code_execution, write_file, edit_file, bash) and the cross-folder file delivery tool (attach_file). Call this BEFORE attempting any task that needs computation, file generation (PDF, PPTX, XLSX, DOCX, images, audio, video), background removal, OCR, large data manipulation, or that needs to deliver a file from a previous session. The tool returns a complete briefing with: cloud structure, project rules, storage quota, network policy, full Python library catalog with practical examples, file-delivery flow and anti-hallucination guardrails. After calling it the next round will expose the unlocked tools and remove this gateway. No-op for chats that are just text / web research / quick voice replies — do NOT call it for those.',
  properties: {},
});

const TOOL_READ_FILE = makeTool({
  name: 'read_file',
  description: 'Read the contents of a file (text, code, images, audio, pdf). Use this to inspect files mentioned in chat history or produced by agentic tools.',
  properties: {
    path: {
      type: 'string',
      description: 'Relative path. On Discord: any file under history/ (prefix optional, e.g. "report.pdf"). On WhatsApp: paths relative to your user root — allowed zones are "history/...", "permanent/...", "searched_images/...", "projects/<name>/{figures|temp|output|code}/...". Special read-only prefix "skills:<filename>.md" reads a skill guide (WhatsApp only).',
    },
  },
  required: ['path'],
});

// ── Project management (WhatsApp only) ──

const TOOL_LIST_PROJECTS = makeTool({
  name: 'list_projects',
  description: 'List the user\'s projects with their descriptions and which one is currently selected. Use this before creating a new project to check what already exists and before switching.',
  properties: {},
});

const TOOL_CREATE_PROJECT = makeTool({
  name: 'create_project',
  description: 'Create a new project and select it as current. Use this at the START of any multi-step agentic task that will produce files (PDF, PPTX, scripts, images, etc.). The project gets its own scaffold: figures/, temp/, output/, code/. A README.md is generated with the provided description, user_request and strategy. Fails if the project limit is reached or the name collides.',
  properties: {
    name: { type: 'string', description: 'Human-readable project name. Will be slugified (lowercase, [a-z0-9_-], max 40 chars).' },
    description: { type: 'string', description: 'Short description of the project (1-2 sentences).' },
    user_request: { type: 'string', description: 'Verbatim or paraphrased user instruction that motivates the project.' },
    strategy: { type: 'string', description: 'Your plan to accomplish the task (tools to use, files to produce, ordered steps).' },
  },
  required: ['name', 'description', 'user_request', 'strategy'],
});

const TOOL_SWITCH_PROJECT = makeTool({
  name: 'switch_project',
  description: 'Select an existing project as the current one. Required before using code_execution, write_file, edit_file or bash if no project is selected.',
  properties: {
    name: { type: 'string', description: 'Exact project slug (as returned by list_projects).' },
  },
  required: ['name'],
});

const TOOL_DELETE_PROJECT = makeTool({
  name: 'delete_project',
  description: 'Permanently delete a project and all its files. You MUST first ask the user to explicitly confirm the deletion, then call this tool with user_confirmed=true. If the deleted project was the current one, current_project is reset.',
  properties: {
    name: { type: 'string', description: 'Project slug to delete.' },
    user_confirmed: { type: 'boolean', description: 'Must be true — set only after the user confirmed in chat.' },
  },
  required: ['name', 'user_confirmed'],
});

const TOOL_CLEANUP_PROJECT = makeTool({
  name: 'cleanup_project',
  description: 'Empty the contents of one or more project subdirectories (figures/, temp/, output/, code/). The folders themselves are kept. Use to free space when close to the size quota.',
  properties: {
    name: { type: 'string', description: 'Project slug (defaults to the current project).' },
    subdirs: {
      type: 'array',
      items: { type: 'string', enum: ['figures', 'temp', 'output', 'code'] },
      description: 'Subdirs to clear.',
    },
  },
  required: ['subdirs'],
});

const TOOL_COPY_TO_PERMANENT = makeTool({
  name: 'copy_to_permanent',
  description: 'Copy a file from history/ to permanent/ so the user keeps it on their personal cloud even after the chat history rotates. The original in history/ is preserved.',
  properties: {
    history_filename: { type: 'string', description: 'Bare filename as it appears inside history/ (no "history/" prefix).' },
  },
  required: ['history_filename'],
});

const TOOL_CODE_EXECUTION = makeTool({
  name: 'code_execution',
  description: 'Run Python in a stateful, isolated sandbox tied to the currently selected project. The kernel persists across calls in the same conversation, so variables defined earlier remain available. The sandbox has NO free internet (use web_search / browse_page tools instead). Allowed network destinations: api.polygon.io and astropy data servers. Pre-installed libraries: numpy, scipy, sympy, mpmath, pandas, matplotlib, seaborn, plotly, Pillow, rembg, cairosvg, pytesseract, pydub, librosa, moviepy, astropy, qutip, polygon-api-client, python-docx, openpyxl, python-pptx, reportlab, requests. Filesystem layout inside the sandbox: /workspace = current project root (writable: figures/ temp/ output/ code/), /readonly/{history,permanent,searched_images} (read-only). Files written under output/ are AUTO-ATTACHED for delivery (the AI can then call send_whatsapp_message with includeAttachments=true). Files in temp/ figures/ code/ are kept on disk but not auto-attached. pip is disabled — only pre-installed libraries are usable.',
  properties: {
    code: { type: 'string', description: 'Python code to execute. Multiline allowed; the same kernel persists across calls.' },
    timeout_ms: { type: 'integer', description: 'Optional execution timeout in milliseconds (default 30000, max 120000).' },
  },
  required: ['code'],
});

const TOOL_WRITE_FILE = makeTool({
  name: 'write_file',
  description: 'Create or overwrite a file inside the currently selected project. The path MUST be relative and live under projects/<current>/{figures|temp|output|code}/. Files written under output/ are automatically attached for delivery. Routed through the project sandbox so the kernel sees the new file immediately for any subsequent code_execution call. Max 5 MB per call.',
  properties: {
    path: { type: 'string', description: 'Relative path under the current project, e.g. "projects/<current>/code/main.py".' },
    content: { type: 'string', description: 'File content. UTF-8 text by default; for binary data set encoding="base64".' },
    encoding: { type: 'string', enum: ['utf-8', 'base64'], description: 'Content encoding (default "utf-8").' },
    mode: { type: 'string', enum: ['overwrite', 'append'], description: 'Write mode (default "overwrite").' },
  },
  required: ['path', 'content'],
});

const TOOL_EDIT_FILE = makeTool({
  name: 'edit_file',
  description: 'Edit an existing UTF-8 text file in the current project by replacing old_string with new_string. old_string MUST be unique in the file unless replace_all=true. Use write_file to create new files. Path constraints are the same as write_file. Routed through the sandbox.',
  properties: {
    path: { type: 'string', description: 'Relative path under projects/<current>/{figures|temp|output|code}/.' },
    old_string: { type: 'string', description: 'Exact text to replace. Must appear at least once. Provide enough surrounding context to be unique unless replace_all=true.' },
    new_string: { type: 'string', description: 'Replacement text (use empty string to delete the matched region).' },
    replace_all: { type: 'boolean', description: 'Replace every occurrence (default false). Required when old_string is not unique.' },
  },
  required: ['path', 'old_string', 'new_string'],
});

const TOOL_BASH = makeTool({
  name: 'bash',
  description: 'Run a single shell command in the project sandbox container. Same isolation as code_execution: cwd persists across calls (cd survives), no free internet, pip/apt disabled, project subfolders mounted at /workspace. Use for quick file inspections (ls, head, grep), conversions (ffmpeg, pdftotext), zipping, and similar one-shot operations. For complex multi-step logic prefer code_execution. Default timeout 30 s, max 120 s.',
  properties: {
    command: { type: 'string', description: 'Shell command (bash -c). Single line or `&&`-chained statements.' },
    timeout_ms: { type: 'integer', description: 'Optional timeout in milliseconds (default 30000, max 120000).' },
  },
  required: ['command'],
});

const TOOL_COPY_TO_PROJECT = makeTool({
  name: 'copy_to_project',
  description: 'Copy a file from history/ or searched_images/ into the currently selected project (into figures/ by default). Use this to bring user-provided or web-searched images into a project before processing them with code_execution.',
  properties: {
    source: { type: 'string', description: 'Relative path like "history/photo.jpg" or "searched_images/slug_1.png".' },
    subdir: { type: 'string', enum: ['figures', 'temp', 'output', 'code'], description: 'Destination subdir inside the current project (default "figures").' },
  },
  required: ['source'],
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
  // attach_file is WhatsApp-only AND gated behind agentic_unlock (it deals
  // with files only relevant to the agentic flow — permanent/, projects/,
  // searched_images/). Discord never gets it.
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

    // ── Agentic toolkit (gated) ─────────────────────────────────────────
    // By default we expose a tiny gateway tool. The full project /
    // sandbox / file-delivery stack only appears AFTER the AI calls it,
    // saving ~7-8 K input tokens on every non-agentic conversation.
    if (userCtx.agenticUnlocked) {
      tools.push(
        TOOL_LIST_PROJECTS,
        TOOL_CREATE_PROJECT,
        TOOL_SWITCH_PROJECT,
        TOOL_DELETE_PROJECT,
        TOOL_CLEANUP_PROJECT,
        TOOL_COPY_TO_PERMANENT,
        TOOL_COPY_TO_PROJECT,
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
