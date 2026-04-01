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
// Varianti admin/membro aggiuntive saranno usate per impostare i parametri che possono cambiare.

// Per chat specifica, read_about_me è allowed una sola volta
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
  } catch (err) {
    // Silenzioso: stato di uso read_about_me non persistente in caso di file corrotto
  }
}

function _saveReadAboutMeState() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const arr = [...readAboutMeUsedByChat];
    fs.writeFileSync(READ_ABOUT_ME_STATE_FILE, JSON.stringify(arr, null, 2), 'utf-8');
  } catch (err) {
    // Silenzioso su errori di scrittura per non bloccare il flusso
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

// Carica lo stato persistente all'avvio del modulo
_loadReadAboutMeState();

function getToolInstructions(name) {
  return TOOL_INSTRUCTIONS[name] || null;
}

function makeTool({
  name,
  description,
  properties = {},
  required = [],
}) {
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

function makeVoiceTool({ includeRecipientName = false, includeRecipientPhone = false } = {}) {
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

function makeWhatsAppTool({ includeRecipientName = false, includeRecipientPhone = false, required = ['message'] } = {}) {
  const properties = {
    message: { type: 'string', description: 'Il messaggio da inviare' },
    includeAttachments: {
      type: 'boolean',
      description: 'Se false, non allegare al messaggio gli eventuali file accumulati in buffer.',
    },
  };

  if (includeRecipientName) {
    properties.recipientName = {
      type: 'string',
      description: 'Nome completo del destinatario (se membro attivo).',
    };
  }

  if (includeRecipientPhone) {
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
    required,
  });
}

function makeEmailTool({ includeRecipientName = false, includeRecipientEmail = false, required = ['subject', 'body'] } = {}) {
  const properties = {
    subject: { type: 'string', description: "Oggetto dell'email" },
    body: { type: 'string', description: "Corpo dell'email (può contenere HTML - NON usare markdown)" },
    includeAttachments: {
      type: 'boolean',
      description: 'Se false, non allegare all\'email gli eventuali file accumulati in buffer.',
    },
  };

  if (includeRecipientName) {
    properties.recipientName = {
      type: 'string',
      description: 'Nome completo del membro attivo destinatario (la email viene risolta dal nome).',
    };
  }

  if (includeRecipientEmail) {
    properties.recipientEmail = {
      type: 'string',
      description: 'Indirizzo email diretto del destinatario (per qualsiasi persona).',
    };
  }

  return makeTool({
    name: 'send_email',
    description: 'Invia un\'email.',
    properties,
    required,
  });
}

function makeScheduleTasksTool({ includeRecipientName = false, includeRecipientPhone = false } = {}) {
  const baseTool = makeTool({
    name: 'schedule_tasks',
    description: 'Programma attività future.',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
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
              properties: {
                toGroup: {
                  type: 'boolean',
                  description: 'true = invia al gruppo WhatsApp corrente (solo in gruppo WA).',
                },
                toPrivate: {
                  type: 'boolean',
                  description: "true = invia in privato su WhatsApp (a te stesso o a un recipient).",
                },
                recipientName: {
                  type: 'string',
                  description: 'Nome membro attivo destinatario (solo membri attivi/admin).',
                },
                recipientPhone: {
                  type: 'string',
                  description: 'Numero di telefono per destinatario non membro (solo admin).',
                },
              },
            },
            email: {
              type: 'object',
              description: 'Configurazione destinazione email per il task.',
              properties: {
                recipientName: {
                  type: 'string',
                  description: 'Nome membro attivo destinatario (solo membri attivi/admin).',
                },
                recipientEmail: {
                  type: 'string',
                  description: 'Indirizzo email diretto del destinatario (solo admin).',
                },
              },
            },
            pdf: {
              type: 'object',
              description: 'Oggetto PDF opzionale con titolo e contenuto.',
              properties: {
                title: { type: 'string', description: 'Titolo del PDF (es. "Report")' },
                content: { type: 'string', description: 'Contenuto testuale del PDF.' },
              },
            },
          },
          required: ['content', 'scheduledAt'],
        },
      },
    },
    required: ['tasks'],
  });

  if (!includeRecipientName && !includeRecipientPhone) return baseTool;

  const tool = JSON.parse(JSON.stringify(baseTool));

  const itemProps = tool.function.parameters.properties.tasks.items.properties;
  if (includeRecipientPhone) {
    itemProps.recipientPhone = {
      type: 'string',
      description: 'Numero di telefono con prefisso internazionale (es. +393XXXXXXXXX).',
    };
  }
  if (includeRecipientName) {
    itemProps.recipientName = {
      type: 'string',
      description: 'Nome completo del destinatario. Usa per inviare ad altro membro.',
    };
  }

  return tool;
}

const BASE_TOOLS = [
  makeTool({
    name: 'web_search',
    description: 'Cerca informazioni aggiornate sul web.',
    properties: {
      query: { type: 'string', description: 'La query di ricerca' },
    },
    required: ['query'],
  }),
  makeTool({
    name: 'image_search',
    description: 'Cerca immagini sul web.',
    properties: {
      query: { type: 'string', description: 'Cosa cercare nelle immagini' },
      count: { type: 'integer', description: 'Numero immagini da inviare (1-4). Default 1.' },
    },
    required: ['query'],
  }),
  makeTool({
    name: 'include_history_images',
    description: 'Richiedi le ultime N immagini dalla cronologia (se presenti).',
    properties: {
      count: { type: 'integer', description: 'Numero di immagini ultime da includere (intero positivo).', minimum: 1 },
    },
    required: ['count'],
  }),
  makeTool({
    name: 'include_history_docs',
    description: 'Richiedi gli ultimi N documenti dalla cronologia (se presenti).',
    properties: {
      count: { type: 'integer', description: 'Numero documenti ultimi da includere (intero positivo).', minimum: 1 },
    },
    required: ['count'],
  }),
  makeTool({
    name: 'read_about_me',
    description: 'Invia sulla chat corrente il testo della storia di GemiX, utile per presentarti e dire chi sei.',
    properties: {},
  }),
  makeVoiceTool(),
  makeScheduleTasksTool(),
  makeTool({
    name: 'read_my_tasks',
    description: 'Mostra i task programmati dell\'utente corrente.',
    properties: {
      includeGroupTasks: {
        type: 'boolean',
        description: 'true = includi anche i task del gruppo corrente (solo se in un gruppo)',
      },
    },
  }),
  makeTool({
    name: 'remove_my_tasks',
    description: 'Rimuovi i task programmati dell\'utente corrente.',
    properties: {
      taskIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Gli ID dei task da rimuovere',
      },
      fromGroup: {
        type: 'boolean',
        description: 'true = rimuovi dal file del gruppo corrente invece che da quello personale',
      },
    },
    required: ['taskIds'],
  }),
];

const ACTIVE_MEMBER_TOOLS = [
  makeTool({
    name: 'read_server_rules',
    description: 'Leggi il regolamento del server Discord.',
    properties: {},
  }),
  makeTool({
    name: 'clear_attachments',
    description: 'Svuota il buffer degli allegati accumulati.',
    properties: {},
  }),
  makeTool({
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
  }),
  makeEmailTool({ includeRecipientName: true, required: ['recipientName', 'subject', 'body'] }),
  makeWhatsAppTool({ includeRecipientName: true, required: ['recipientName', 'message'] }),
  makeTool({
    name: 'read_music_stats',
    description: 'Leggi le statistiche musicali del bot.',
    properties: {},
  }),
];

const ACTIVE_MEMBER_TOOL_NAMES = ACTIVE_MEMBER_TOOLS.map(t => t.function.name);

function getToolsForUser(isActiveMember, isAdmin, userCtx = {}) {
  const chatKey = _getChatKey(userCtx);
  let tools = isActiveMember ? [...BASE_TOOLS, ...ACTIVE_MEMBER_TOOLS] : [...BASE_TOOLS];

  const isWhatsApp = userCtx.platform && userCtx.platform.startsWith('whatsapp');
  const isWhatsAppGroup = isWhatsApp && userCtx.isGroup;
  const isDiscord = userCtx.platform === PLATFORM_DISCORD;

  // 1) filter capabilities in schema by context to save token usage in tool calls
  tools = tools.map(tool => {
    if (tool.function.name === 'read_my_tasks' && !isWhatsAppGroup) {
      const clone = JSON.parse(JSON.stringify(tool));
      delete clone.function.parameters.properties.includeGroupTasks;
      return clone;
    }

    if (tool.function.name === 'remove_my_tasks' && !isWhatsAppGroup) {
      const clone = JSON.parse(JSON.stringify(tool));
      delete clone.function.parameters.properties.fromGroup;
      return clone;
    }

    if (tool.function.name === 'schedule_tasks') {
      const clone = JSON.parse(JSON.stringify(tool));
      const taskProps = clone.function.parameters.properties.tasks.items.properties;

      if (!isWhatsAppGroup && taskProps.whatsapp && taskProps.whatsapp.properties) {
        delete taskProps.whatsapp.properties.toGroup;
      }

      if (!isActiveMember && !isAdmin) {
        delete taskProps.email;
        if (taskProps.whatsapp && taskProps.whatsapp.properties) {
          delete taskProps.whatsapp.properties.recipientName;
          delete taskProps.whatsapp.properties.recipientPhone;
        }
        delete taskProps.pdf;
      } else if (isActiveMember && !isAdmin) {
        if (taskProps.whatsapp && taskProps.whatsapp.properties) {
          delete taskProps.whatsapp.properties.recipientPhone;
        }
        if (taskProps.email && taskProps.email.properties) {
          delete taskProps.email.properties.recipientEmail;
        }
      }

      return clone;
    }

    return tool;
  });

  if (_isReadAboutMeUsed(chatKey)) {
    tools = tools.filter(t => t.function.name !== 'read_about_me');
  }

  // Disabilita il tool vocale su Discord
  if (isDiscord) {
    tools = tools.filter(t => t.function.name !== 'send_voice_message');
  }

  // Active members + admins have access alla funzione di pulizia allegati
  if ((isActiveMember || isAdmin) && !tools.some(t => t.function.name === 'clear_attachments')) {
    tools.push(makeTool({
      name: 'clear_attachments',
      description: 'Svuota il buffer degli allegati accumulati.',
      properties: {},
    }));
  }

  if (isAdmin) {
    const adminScheduleTool = makeScheduleTasksTool({ includeRecipientName: true, includeRecipientPhone: true });

    tools = tools.map(t => {
      if (t.function.name === 'send_voice_message') return makeVoiceTool({ includeRecipientName: true, includeRecipientPhone: true });
      if (t.function.name === 'send_whatsapp_message') return makeWhatsAppTool({ includeRecipientName: true, includeRecipientPhone: true });
      if (t.function.name === 'send_email') return makeEmailTool({ includeRecipientName: true, includeRecipientEmail: true });
      if (t.function.name === 'schedule_tasks') {
        let filtered = adminScheduleTool;
        if (!isWhatsAppGroup) {
          filtered = JSON.parse(JSON.stringify(filtered));
          delete filtered.function.parameters.properties.tasks.items.properties.sendToGroup;
        }
        return filtered;
      }
      return t;
    });
  } else if (isActiveMember) {
    tools = tools.map(t => {
      if (t.function.name === 'send_voice_message' && isWhatsApp) return makeVoiceTool({ includeRecipientName: true });
      return t;
    });
  }

  if (!userCtx.hasHistoryImages) {
    tools = tools.filter(t => t.function.name !== 'include_history_images');
  }
  if (!userCtx.hasHistoryDocs) {
    tools = tools.filter(t => t.function.name !== 'include_history_docs');
  }

  return tools;
}

function isActiveMemberOnlyTool(toolName) {
  return ACTIVE_MEMBER_TOOL_NAMES.includes(toolName);
}

module.exports = {
  getToolsForUser,
  isActiveMemberOnlyTool,
  getToolInstructions,
  BASE_TOOLS,
  ACTIVE_MEMBER_TOOLS,
  _markReadAboutMeUsed: _markReadAboutMeUsed,
  _isReadAboutMeUsed: _isReadAboutMeUsed,
};
