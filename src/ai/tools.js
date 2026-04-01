const fs = require('fs');
const path = require('path');
const { DATA_DIR, PLATFORM_DISCORD } = require('../config/constants');

// Tool definitions for Gemini AI function calling (OpenAI-compatible format).
// Tool descriptions are kept minimal; detailed instructions are provided when a tool is actually invoked.

const VOICE_EFFECTS_DOC = `
EFFETTI VOCALI DISPONIBILI:

Inline tags (inseriscili nel punto esatto):
[pause] [long-pause] [hum-tune]
[laugh] [chuckle] [giggle] [cry]
[tsk] [tongue-click] [lip-smack]
[breath] [inhale] [exhale] [sigh]

Wrapping tags (avvolgi il testo):
<soft> <whisper> <loud> <build-intensity> <decrease-intensity>
<higher-pitch> <lower-pitch> <slow> <fast>
<sing-song> <singing> <laugh-speak> <emphasis>

Esempio: "Ciao! <soft>Benvenuto nel futuro della voce.</soft> [laugh] Questo è incredibile!"`;

const TOOL_INSTRUCTIONS = {
  web_search: `Rispondi solo con la chiamata al tool.`,
  image_search: `Rispondi solo con la chiamata al tool. Le immagini trovate vengono accumulate nel buffer e allegati insieme alla risposta o tramite i tool di consegna (WhatsApp/email).`,
  include_history_images: `Rispondi solo con la chiamata al tool. Richiedi al sistema di includere nelle prossime chiamate API le ultime N immagini dalla cronologia (se esistono).`,
  include_history_docs: `Rispondi solo con la chiamata al tool. Richiedi al sistema di includere nelle prossime chiamate API i documenti dalla cronologia (se esistono).`,
  send_voice_message: `Rispondi solo con la chiamata al tool. Genera vocale (solo WhatsApp), testo TTS max 1000 caratteri, è possibile allegare eventuali file nel buffer. ${VOICE_EFFECTS_DOC}`,
  schedule_tasks: `Rispondi solo con la chiamata al tool.`,
  read_my_tasks: `Rispondi solo con la chiamata al tool.`,
  remove_my_tasks: `Rispondi solo con la chiamata al tool.`,
  read_server_rules: `Rispondi solo con la chiamata al tool.`,
  generate_pdf: `Rispondi solo con la chiamata al tool. Genera PDF con titolo+contenuto, verrà accumulato nel buffer e allegato insieme alla risposta o tramite i tool di consegna (WhatsApp/email)`,
  send_email: `Rispondi solo con la chiamata al tool. È possibile allegare eventuali file nel buffer.`,
  send_whatsapp_message: `Rispondi solo con la chiamata al tool. È possibile allegare eventuali file nel buffer.`,
  clear_attachments: `Rispondi solo con la chiamata al tool.`,
  read_music_stats: `Rispondi solo con la chiamata al tool.`,
};

// ── read_about_me: allowed una sola volta per chat (persistito su file) ──

const readAboutMeUsedByChat = new Set();
const READ_ABOUT_ME_STATE_FILE = path.join(DATA_DIR, 'readAboutMeUsedByChat.json');

function _loadReadAboutMeState() {
  try {
    if (!fs.existsSync(READ_ABOUT_ME_STATE_FILE)) return;
    const raw = fs.readFileSync(READ_ABOUT_ME_STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      parsed.forEach(chatKey => {
        if (chatKey) readAboutMeUsedByChat.add(chatKey);
      });
    }
  } catch {
    // Silenzioso: stato non persistente in caso di file corrotto
  }
}

function _saveReadAboutMeState() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(READ_ABOUT_ME_STATE_FILE, JSON.stringify([...readAboutMeUsedByChat], null, 2), 'utf-8');
  } catch {
    // Silenzioso su errori di scrittura
  }
}

function _getChatKey(userCtx) {
  return userCtx?.chatId || userCtx?.groupId || userCtx?.waJid || userCtx?.userId || 'unknown';
}

function _markReadAboutMeUsed(chatKey) {
  if (!chatKey) return;
  readAboutMeUsedByChat.add(chatKey);
  _saveReadAboutMeState();
}

function _isReadAboutMeUsed(chatKey) {
  return chatKey && readAboutMeUsedByChat.has(chatKey);
}

_loadReadAboutMeState();

// ── Helpers ──

function getToolInstructions(name) {
  return TOOL_INSTRUCTIONS[name] || null;
}

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
  description: 'Cerca informazioni aggiornate sul web.',
  properties: {
    query: { type: 'string', description: 'La query di ricerca' },
  },
  required: ['query'],
});

const TOOL_IMAGE_SEARCH = makeTool({
  name: 'image_search',
  description: 'Cerca immagini sul web.',
  properties: {
    query: { type: 'string', description: 'Cosa cercare nelle immagini' },
    count: { type: 'integer', description: 'Numero immagini da inviare (1-4). Default 1.' },
  },
  required: ['query'],
});

const TOOL_INCLUDE_HISTORY_IMAGES = makeTool({
  name: 'include_history_images',
  description: 'Richiedi le ultime N immagini dalla cronologia (se presenti).',
  properties: {
    count: { type: 'integer', description: 'Numero di immagini ultime da includere (intero positivo).', minimum: 1 },
  },
  required: ['count'],
});

const TOOL_INCLUDE_HISTORY_DOCS = makeTool({
  name: 'include_history_docs',
  description: 'Richiedi gli ultimi N documenti dalla cronologia (se presenti).',
  properties: {
    count: { type: 'integer', description: 'Numero documenti ultimi da includere (intero positivo).', minimum: 1 },
  },
  required: ['count'],
});

const TOOL_READ_ABOUT_ME = makeTool({
  name: 'read_about_me',
  description: 'Invia sulla chat corrente il testo della storia di GemiX, utile per presentarti e dire chi sei.',
  properties: {},
});

const TOOL_READ_SERVER_RULES = makeTool({
  name: 'read_server_rules',
  description: 'Leggi il regolamento del server Discord.',
  properties: {},
});

const TOOL_CLEAR_ATTACHMENTS = makeTool({
  name: 'clear_attachments',
  description: 'Svuota il buffer degli allegati accumulati.',
  properties: {},
});

const TOOL_GENERATE_PDF = makeTool({
  name: 'generate_pdf',
  description: 'Genera un PDF da testo.',
  properties: {
    title: { type: 'string', description: 'Titolo del PDF (appare in testa al documento)' },
    content: {
      type: 'string',
      description: 'Contenuto testuale del PDF. Supporta # e ## per titoli, - per elenchi puntati.',
    },
  },
  required: ['title', 'content'],
});

const TOOL_READ_MUSIC_STATS = makeTool({
  name: 'read_music_stats',
  description: 'Leggi le statistiche musicali del bot.',
  properties: {},
});

// ── Dynamic tool builders (schema varies by grade/platform) ──

function buildVoiceTool({ includeRecipientName = false, includeRecipientPhone = false } = {}) {
  const properties = {
    text: {
      type: 'string',
      description: 'Il testo da convertire in audio vocale (max 1000 caratteri). Può contenere effetti vocali inline e wrapping tags.',
    },
    includeAttachments: {
      type: 'boolean',
      description: 'Se false, non allegare al messaggio gli eventuali file accumulati in buffer.',
    },
  };

  if (includeRecipientName) {
    properties.recipientName = {
      type: 'string',
      description: 'OPZIONALE: Nome del membro attivo a cui inviare il vocale via WhatsApp. Se omesso, invia nella chat attuale.',
    };
  }

  if (includeRecipientPhone) {
    properties.recipientPhone = {
      type: 'string',
      description: 'OPZIONALE: Numero di telefono con prefisso internazionale (es. +393XXXXXXXXX).',
    };
  }

  return makeTool({
    name: 'send_voice_message',
    description: 'Invia un messaggio vocale. ',
    properties,
    required: ['text'],
  });
}

function buildWhatsAppTool(isAdmin) {
  const properties = {
    message: { type: 'string', description: 'Il messaggio da inviare' },
    includeAttachments: {
      type: 'boolean',
      description: 'Se false, non allegare al messaggio gli eventuali file accumulati in buffer.',
    },
    recipientName: {
      type: 'string',
      description: 'Nome completo del destinatario (se membro attivo).',
    },
  };

  if (isAdmin) {
    properties.recipientPhone = {
      type: 'string',
      description: 'Numero di telefono con prefisso internazionale (es. +393XXXXXXXXX).',
    };
  }

  properties.mentions = {
    type: 'array',
    items: { type: 'string' },
    description: 'Elenco di nomi, numeri o JID da menzionare nel messaggio (gruppo).',
  };

  return makeTool({
    name: 'send_whatsapp_message',
    description: 'Invia un messaggio WhatsApp con il tuo account dedicato.',
    properties,
    required: isAdmin ? ['message'] : ['recipientName', 'message'],
  });
}

function buildEmailTool(isAdmin) {
  const properties = {
    subject: { type: 'string', description: "Oggetto dell'email" },
    body: { type: 'string', description: "Corpo dell'email (può contenere HTML - NON usare markdown)" },
    includeAttachments: {
      type: 'boolean',
      description: 'Se false, non allegare all\'email gli eventuali file accumulati in buffer.',
    },
    recipientName: {
      type: 'string',
      description: 'Nome completo del membro attivo destinatario (la email viene risolta dal nome).',
    },
  };

  if (isAdmin) {
    properties.recipientEmail = {
      type: 'string',
      description: 'Indirizzo email diretto del destinatario (per qualsiasi persona).',
    };
  }

  return makeTool({
    name: 'send_email',
    description: 'Invia un\'email.',
    properties,
    required: isAdmin ? ['subject', 'body'] : ['recipientName', 'subject', 'body'],
  });
}

function buildScheduleTasksTool(isActiveMember, isAdmin, isWhatsAppGroup) {
  // WhatsApp destination: proprietà variano per grado e piattaforma
  const waProps = {};
  if (isWhatsAppGroup) {
    waProps.toGroup = {
      type: 'boolean',
      description: 'true = invia al gruppo WhatsApp corrente (solo in gruppo WA).',
    };
  }
  waProps.toPrivate = {
    type: 'boolean',
    description: "true = invia in privato su WhatsApp (a te stesso o a un recipient).",
  };
  if (isActiveMember) {
    waProps.recipientName = {
      type: 'string',
      description: 'Nome membro attivo destinatario (solo membri attivi/admin).',
    };
  }
  if (isAdmin) {
    waProps.recipientPhone = {
      type: 'string',
      description: 'Numero di telefono per destinatario non membro (solo admin).',
    };
  }

  const taskItemProps = {
    content: {
      type: 'string',
      description: 'Testo da inviare al momento della consegna',
    },
    scheduledAt: {
      type: 'string',
      description: 'Data/ora ISO 8601 con timezone Europe/Rome (es. 2026-03-16T16:00:00+01:00)',
    },
    whatsapp: {
      type: 'object',
      description: 'Configurazione destinazione WhatsApp per il task.',
      properties: waProps,
    },
  };

  // Email e PDF: solo per membri attivi / admin
  if (isActiveMember) {
    const emailProps = {
      recipientName: {
        type: 'string',
        description: 'Nome membro attivo destinatario (solo membri attivi/admin).',
      },
    };
    if (isAdmin) {
      emailProps.recipientEmail = {
        type: 'string',
        description: 'Indirizzo email diretto del destinatario (solo admin).',
      };
    }
    taskItemProps.email = {
      type: 'object',
      description: 'Configurazione destinazione email per il task.',
      properties: emailProps,
    };
    taskItemProps.pdf = {
      type: 'object',
      description: 'Oggetto PDF opzionale con titolo e contenuto.',
      properties: {
        title: { type: 'string', description: 'Titolo del PDF (es. "Report")' },
        content: { type: 'string', description: 'Contenuto testuale del PDF.' },
      },
    };
  }

  return makeTool({
    name: 'schedule_tasks',
    description: 'Programma attività future.',
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
      description: 'true = includi anche i task del gruppo corrente (solo se in un gruppo)',
    };
  }
  return makeTool({
    name: 'read_my_tasks',
    description: 'Mostra i task programmati dell\'utente corrente.',
    properties,
  });
}

function buildRemoveMyTasksTool(isWhatsAppGroup) {
  const properties = {
    taskIds: {
      type: 'array',
      items: { type: 'string' },
      description: 'Gli ID dei task da rimuovere',
    },
  };
  if (isWhatsAppGroup) {
    properties.fromGroup = {
      type: 'boolean',
      description: 'true = rimuovi dal file del gruppo corrente invece che da quello personale',
    };
  }
  return makeTool({
    name: 'remove_my_tasks',
    description: 'Rimuovi i task programmati dell\'utente corrente.',
    properties,
    required: ['taskIds'],
  });
}

// ── Active-member-only tool check (runtime permission guard) ──

const ACTIVE_MEMBER_ONLY_TOOLS = new Set([
  'read_server_rules',
  'clear_attachments',
  'generate_pdf',
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
  const chatKey = _getChatKey(userCtx);

  const tools = [];

  // Tutti gli utenti, tutte le piattaforme
  tools.push(TOOL_WEB_SEARCH, TOOL_IMAGE_SEARCH);
  if (userCtx.hasHistoryImages) tools.push(TOOL_INCLUDE_HISTORY_IMAGES);
  if (userCtx.hasHistoryDocs) tools.push(TOOL_INCLUDE_HISTORY_DOCS);
  if (!_isReadAboutMeUsed(chatKey)) tools.push(TOOL_READ_ABOUT_ME);

  // Vocale: solo WhatsApp, schema varia per grado
  if (!isDiscord) {
    tools.push(buildVoiceTool({
      includeRecipientName: isAdmin || (isActiveMember && isWhatsApp),
      includeRecipientPhone: isAdmin,
    }));
  }

  // Task: tutti gli utenti, schema varia per grado e piattaforma
  tools.push(buildScheduleTasksTool(isActiveMember, isAdmin, isWhatsAppGroup));
  tools.push(buildReadMyTasksTool(isWhatsAppGroup));
  tools.push(buildRemoveMyTasksTool(isWhatsAppGroup));

  // Solo membri attivi / admin
  if (isActiveMember) {
    tools.push(TOOL_READ_SERVER_RULES, TOOL_CLEAR_ATTACHMENTS, TOOL_GENERATE_PDF, TOOL_READ_MUSIC_STATS);
    tools.push(buildEmailTool(isAdmin));
    tools.push(buildWhatsAppTool(isAdmin));
  }

  return tools;
}

module.exports = {
  getToolsForUser,
  isActiveMemberOnlyTool,
  getToolInstructions,
  _markReadAboutMeUsed,
};
