const fs = require('fs');
const path = require('path');
const { DATA_DIR, PLATFORM_DISCORD } = require('../config/constants');

// Tool definitions for AI function calling (OpenAI-compatible format).

// ── send_about_me: allowed una sola volta per chat (persistito su file) ──

const sendAboutMeUsedByChat = new Set();
const READ_ABOUT_ME_STATE_FILE = path.join(DATA_DIR, 'readAboutMeUsedByChat.json');

function _loadSendAboutMeState() {
  try {
    if (!fs.existsSync(READ_ABOUT_ME_STATE_FILE)) return;
    const raw = fs.readFileSync(READ_ABOUT_ME_STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      parsed.forEach(chatKey => {
        if (chatKey) sendAboutMeUsedByChat.add(chatKey);
      });
    }
  } catch { }
}

function _saveSendAboutMeState() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(READ_ABOUT_ME_STATE_FILE, JSON.stringify([...sendAboutMeUsedByChat], null, 2), 'utf-8');
  } catch { }
}

function _getChatKey(userCtx) {
  return userCtx?.chatId || userCtx?.groupId || userCtx?.waJid || userCtx?.userId || 'unknown';
}

function _markSendAboutMeUsed(chatKey) {
  if (!chatKey) return;
  sendAboutMeUsedByChat.add(chatKey);
  _saveSendAboutMeState();
}

function _isSendAboutMeUsed(chatKey) {
  return chatKey && sendAboutMeUsedByChat.has(chatKey);
}

_loadSendAboutMeState();

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
  description: 'Cerca sul web.',
  properties: {
    query: { type: 'string', description: 'Query' },
    numResults: { type: 'integer', description: 'Numero risultati (1-50, default 15)' },
  },
  required: ['query'],
});

const TOOL_IMAGE_SEARCH = makeTool({
  name: 'image_search',
  description: 'Cerca immagini sul web, vengono accumulate e allegate insieme alla risposta finale o tramite i tool di consegna.',
  properties: {
    query: { type: 'string', description: 'Query' },
    count: { type: 'integer', description: 'Quantità (1-4, default 1)' },
  },
  required: ['query'],
});

const TOOL_INCLUDE_HISTORY_IMAGES = makeTool({
  name: 'include_history_images',
  description: 'Includi ultime N immagini dalla cronologia (max 5).',
  properties: {
    count: { type: 'integer', description: 'Quantità (1-5)', minimum: 1 },
  },
  required: ['count'],
});

const TOOL_INCLUDE_HISTORY_DOCS = makeTool({
  name: 'include_history_docs',
  description: 'Includi ultimi N documenti dalla cronologia (max 2, ≤5 pagine).',
  properties: {
    count: { type: 'integer', description: 'Quantità (1-2)', minimum: 1 },
  },
  required: ['count'],
});

const TOOL_INCLUDE_HISTORY_VOICES = makeTool({
  name: 'include_history_voices',
  description: 'Includi ultimi N vocali degli utenti dalla cronologia (max 3).',
  properties: {
    count: { type: 'integer', description: 'Quantità (1-3)', minimum: 1 },
  },
  required: ['count'],
});

const TOOL_SEND_ABOUT_ME = makeTool({
  name: 'send_about_me',
  description: 'Invia la storia di GemiX per presentarti.',
  properties: {},
});

const TOOL_READ_SERVER_RULES = makeTool({
  name: 'read_server_rules',
  description: 'Leggi il regolamento del server Discord (aka Statuto Albertino).',
  properties: {},
});

const TOOL_UPDATE_THREAD_TITLE = makeTool({
  name: 'update_thread_title',
  description: 'Cambia il titolo del thread Discord.',
  properties: {
    title: { type: 'string', description: 'Nuovo titolo del thread' },
  },
  required: ['title'],
});

const TOOL_FETCH_WEBPAGE = makeTool({
  name: 'fetch_webpage',
  description: 'Recupera il contenuto testuale di una pagina web dato il suo URL diretto.',
  properties: {
    url: { type: 'string', description: 'URL della pagina web' },
  },
  required: ['url'],
});

const TOOL_GENERATE_PDF = makeTool({
  name: 'generate_pdf',
  description: 'Genera PDF da testo. Verrà accumulato e allegato insieme alla risposta finale o tramite i tool di consegna.',
  properties: {
    title: { type: 'string', description: 'Titolo' },
    content: {
      type: 'string',
      description: 'Testo (supporta #, ## titoli e - elenchi)',
    },
  },
  required: ['title', 'content'],
});

const TOOL_READ_MUSIC_STATS = makeTool({
  name: 'read_music_stats',
  description: 'Leggi statistiche musicali.',
  properties: {},
});

const TOOL_UPDATE_MEMORY = makeTool({
  name: 'update_memory',
  description: 'Aggiorna memoria personalizzata (privata o di gruppo in base alla chat). Se sono già presenti informazioni riscrivile uguali aggiungendo quello che devi aggiungere. Se memoria quasi piena chiedi all\'utente cosa rimuovere.',
  properties: {
    content: {
      type: 'string',
      description: 'Testo completo memoria (max 500 char, vuoto=cancella)',
    },
  },
  required: ['content'],
});

const TOOL_TOGGLE_RELEASE_NOTIFY = makeTool({
  name: 'toggle_release_notify',
  description: 'Attiva/disattiva notifiche nuove release GemiX su questa chat.',
  properties: {
    enabled: {
      type: 'boolean',
      description: 'true=attiva, false=disattiva',
    },
  },
  required: ['enabled'],
});

const TOOL_GENERATE_FORMAL_REQUEST_PDF = makeTool({
  name: 'generate_formal_request_pdf',
  description: 'Genera PDF per richiesta formale. NON usare heading markdown (# ## ecc) ma puoi usare **grassetto**, *corsivo*, elenchi. Data e nome file sono generati automaticamente.',
  properties: {
    fullName: { type: 'string', description: 'Nome e Cognome del richiedente' },
    title: { type: 'string', description: 'Titolo della Richiesta' },
    motivation: { type: 'string', description: 'Motivazione dettagliata e argomentata' },
    requesterSignature: { type: 'string', description: 'Firma del richiedente' },
    legalSignature: { type: 'string', description: 'Visto del legale ("Lorenzo Passante" se richiesto da lui in persona o "Nessuno"' },
  },
  required: ['fullName', 'title', 'motivation', 'requesterSignature'],
});

// ── Dynamic tool builders (schema varies by grade/platform) ──

function buildVoiceTool({ includeRecipientName = false, includeRecipientPhone = false } = {}) {
  const properties = {
    text: {
      type: 'string',
      description: 'Testo TTS (max 1000 char), supporta effetti vocali. Tag inline: [pause] [long-pause] [hum-tune] [laugh] [chuckle] [giggle] [cry] [tsk] [tongue-click] [lip-smack] [breath] [inhale] [exhale] [sigh]. Tag avvolgenti: <soft> <whisper> <loud> <build-intensity> <decrease-intensity> <higher-pitch> <lower-pitch> <slow> <fast> <sing-song> <singing> <laugh-speak> <emphasis>.',
    },
  };

  if (includeRecipientName || includeRecipientPhone) {
    properties.includeAttachments = {
      type: 'boolean',
      description: 'Allega file dal buffer (default true)',
    };
    const recipientProps = {};
    if (includeRecipientName) {
      recipientProps.name = {
        type: 'string',
        description: 'Nome membro (ometti=chat attuale)',
      };
    }
    if (includeRecipientPhone) {
      recipientProps.phone = {
        type: 'string',
        description: 'Tel. con prefisso (es. +393XXXXXXXXX)',
      };
    }
    properties.recipient = {
      type: 'object',
      description: 'Destinatario specifico',
      properties: recipientProps,
    };
  }

  return makeTool({
    name: 'send_voice_message',
    description: 'Tool di consegna - Invia messaggio vocale.',
    properties,
    required: ['text'],
  });
}

function buildWhatsAppTool(isAdmin) {
  const recipientProps = {
    name: {
      type: 'string',
      description: 'Nome membro destinatario',
    },
  };

  if (isAdmin) {
    recipientProps.phone = {
      type: 'string',
      description: 'Tel. con prefisso (es. +393XXXXXXXXX)',
    };
  }

  const properties = {
    message: { type: 'string', description: 'Messaggio' },
    includeAttachments: {
      type: 'boolean',
      description: 'Allega file dal buffer (default true)',
    },
    recipient: {
      type: 'object',
      description: 'Destinatario',
      properties: recipientProps,
      required: isAdmin ? [] : ['name'],
    },
  };

  return makeTool({
    name: 'send_whatsapp_message',
    description: 'Tool di consegna - Invia messaggio WhatsApp.',
    properties,
    required: isAdmin ? ['message'] : ['recipient', 'message'],
  });
}

function buildEmailTool(isAdmin) {
  const recipientProps = {
    name: {
      type: 'string',
      description: 'Nome membro (email risolta dal nome)',
    },
  };

  if (isAdmin) {
    recipientProps.email = {
      type: 'string',
      description: 'Email diretta destinatario',
    };
  }

  const properties = {
    subject: { type: 'string', description: 'Oggetto' },
    body: { type: 'string', description: 'Corpo HTML (no markdown)' },
    includeAttachments: {
      type: 'boolean',
      description: 'Allega file dal buffer (default true)',
    },
    recipient: {
      type: 'object',
      description: 'Destinatario',
      properties: recipientProps,
      required: isAdmin ? [] : ['name'],
    },
  };

  return makeTool({
    name: 'send_email',
    description: 'Tool di consegna - Invia email.',
    properties,
    required: isAdmin ? ['subject', 'body'] : ['recipient', 'subject', 'body'],
  });
}

function buildScheduleTasksTool(isActiveMember, isAdmin, isWhatsAppGroup) {
  const waProps = {};
  if (isWhatsAppGroup) {
    waProps.toGroup = {
      type: 'boolean',
      description: 'Invia al gruppo corrente',
    };
  }
  waProps.toPrivate = {
    type: 'boolean',
    description: 'Invia in privato su WhatsApp',
  };

  const recipientWaProps = {};
  if (isActiveMember) {
    recipientWaProps.name = {
      type: 'string',
      description: 'Nome membro destinatario',
    };
  }
  if (isAdmin) {
    recipientWaProps.phone = {
      type: 'string',
      description: 'Tel. destinatario non membro',
    };
  }

  if (Object.keys(recipientWaProps).length > 0) {
    waProps.recipient = {
      type: 'object',
      description: 'Destinatario',
      properties: recipientWaProps,
    };
  }

  const taskItemProps = {
    content: {
      type: 'string',
      description: 'Testo da inviare',
    },
    scheduledAt: {
      type: 'string',
      description: 'ISO 8601 Europe/Rome (es. 2026-03-16T16:00:00+01:00)',
    },
    whatsapp: {
      type: 'object',
      description: 'Destinazione WhatsApp',
      properties: waProps,
    },
  };

  if (isActiveMember) {
    taskItemProps.recurrence = {
      type: 'object',
      description: 'Ricorrenza (scheduledAt=prima esecuzione)',
      properties: {
        freq: { type: 'string', enum: ['hourly', 'daily', 'weekly', 'monthly'], description: 'Frequenza' },
        endAt: { type: 'string', description: 'Ultimo invio consentito (incluso), ISO 8601 Europe/Rome' },
      },
      required: ['freq', 'endAt'],
    };
  }

  return makeTool({
    name: 'schedule_tasks',
    description: isAdmin
      ? 'Programma promemoria/task per te, altri membri attivi (per nome) o contatti (per telefono). Puoi programmare più task contemporaneamente (fallo per ottimizzare): passa un array di oggetti task.'
      : (isActiveMember
        ? 'Programma promemoria/task per te o altri membri attivi (per nome). Puoi programmare più task contemporaneamente (fallo per ottimizzare): passa un array di oggetti task.'
        : 'Programma promemoria e attività future per te. Puoi programmare più task contemporaneamente (fallo per ottimizzare): passa un array di oggetti task.'),
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
      description: 'Includi task del gruppo',
    };
  }
  return makeTool({
    name: 'read_my_tasks',
    description: 'Mostra task programmati.',
    properties,
  });
}

function buildRemoveMyTasksTool(isWhatsAppGroup) {
  const properties = {
    taskIds: {
      type: 'array',
      items: { type: 'string' },
      description: 'ID dei task',
    },
  };
  if (isWhatsAppGroup) {
    properties.fromGroup = {
      type: 'boolean',
      description: 'Rimuovi dal gruppo invece che dal personale',
    };
  }
  return makeTool({
    name: 'remove_my_tasks',
    description: 'Rimuovi task programmati.',
    properties,
    required: ['taskIds'],
  });
}

// ── Active-member-only tool check (runtime permission guard) ──

const ACTIVE_MEMBER_ONLY_TOOLS = new Set([
  'read_server_rules',
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

  // ── Tutti gli utenti, tutte le piattaforme ──
  tools.push(TOOL_WEB_SEARCH, TOOL_IMAGE_SEARCH, TOOL_FETCH_WEBPAGE);
  if (userCtx.hasHistoryImages) tools.push(TOOL_INCLUDE_HISTORY_IMAGES);
  if (userCtx.hasHistoryDocs) tools.push(TOOL_INCLUDE_HISTORY_DOCS);
  if (userCtx.hasHistoryVoices) tools.push(TOOL_INCLUDE_HISTORY_VOICES);

  // ── Solo WhatsApp: vocale, about me, task, release notify ──
  if (!isDiscord) {
    if (!_isSendAboutMeUsed(chatKey)) tools.push(TOOL_SEND_ABOUT_ME);

    tools.push(buildVoiceTool({
      includeRecipientName: isAdmin || (isActiveMember && isWhatsApp),
      includeRecipientPhone: isAdmin,
    }));

    tools.push(buildScheduleTasksTool(isActiveMember, isAdmin, isWhatsAppGroup));
    tools.push(buildReadMyTasksTool(isWhatsAppGroup));
    tools.push(buildRemoveMyTasksTool(isWhatsAppGroup));

    tools.push(TOOL_TOGGLE_RELEASE_NOTIFY);
  }

  // ── Discord: richiesta formale PDF (tutti i membri) + gestione thread ──
  if (isDiscord) {
    tools.push(TOOL_GENERATE_FORMAL_REQUEST_PDF);
    tools.push(TOOL_UPDATE_THREAD_TITLE);
  }

  // ── Memoria personalizzata: WhatsApp tutti, Discord solo attivi ──
  if (!isDiscord || isActiveMember) {
    tools.push(TOOL_UPDATE_MEMORY);
  }

  // ── Solo membri attivi ──
  if (isActiveMember) {
    if (!isDiscord) {
      tools.push(TOOL_READ_SERVER_RULES, TOOL_GENERATE_PDF, TOOL_READ_MUSIC_STATS);
    }
    tools.push(buildEmailTool(isAdmin));
    tools.push(buildWhatsAppTool(isAdmin));
  }

  return tools;
}

module.exports = {
  getToolsForUser,
  isActiveMemberOnlyTool,
  _markSendAboutMeUsed,
};
