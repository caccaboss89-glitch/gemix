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
  web_search: `Cerca informazioni aggiornate sul web. Usa questo tool quando devi rispondere a domande che richiedono fatti attuali o dettagli non presenti nella tua memoria. Parametro: query (string).`,
  image_search: `Cerca immagini sul web. Le immagini trovate vengono accumulate come allegati e inviate insieme alla risposta o tramite i tool di consegna (WhatsApp/email). Parametri: query (string), count (1-4).`,
  read_about_me: `Restituisce il contenuto del file "aboutme" di GemiX. Quando usi questo tool, invia quel testo come unica risposta finale (nessun commento aggiuntivo).`,
  send_voice_message: `(Azioni) Rispondi solo con la chiamata al tool. Genera un messaggio vocale (solo WhatsApp). Il parametro "text" è il contenuto da convertire (max 1000 caratteri). Usa i tag vocali per effetti. Includi nel testo tutto quello che devi dire nella chat in cui lo usi. Non inviare altra risposta testuale quando chiami questo tool. ${VOICE_EFFECTS_DOC}`,
  schedule_tasks: `(Azioni) Rispondi solo con la chiamata al tool. Programma attività future. Ogni task include taskType (static/dynamic), content, scheduledAt (ISO 8601 Europe/Rome) e destinazioni (WhatsApp privato, gruppo, email). In modalità dynamic, content è un prompt per Grok.`,
  read_my_tasks: `(Azioni) Rispondi solo con la chiamata al tool. Mostra i task programmati dell'utente corrente (e opzionalmente del gruppo corrente).`,
  remove_my_tasks: `(Azioni) Rispondi solo con la chiamata al tool. Rimuovi task programmati dell'utente corrente usando gli ID forniti.`,
  read_server_rules: `(Azioni) Rispondi solo con la chiamata al tool. Leggi il regolamento del server Discord.`,
  generate_pdf: `(Azioni) Rispondi solo con la chiamata al tool. Genera un PDF da testo. Fornisci titolo e contenuto.`,
  send_email: `(Azioni) Rispondi solo con la chiamata al tool. Invia email a un membro attivo; allegati accumulati (immagini, PDF) verranno inclusi automaticamente. Fornisci recipientName, subject e body. Usa includeAttachments=false per evitare di allegare il buffer.`,
  send_whatsapp_message: `(Azioni) Rispondi solo con la chiamata al tool. Invia messaggio WhatsApp a un membro attivo; allegati accumulati verranno inclusi. Fornisci recipientName e message. Usa includeAttachments=false per evitare di allegare il buffer. Usa clearAttachmentsAfterSend=true per evitare che il buffer venga inviato nella chat corrente.`,
  read_music_stats: `(Azioni) Rispondi solo con la chiamata al tool. Leggi statistiche musicali del bot (MusicWrap).`,
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
    clearAttachmentsAfterSend: {
      type: 'boolean',
      description: 'Se true, cancella il buffer degli allegati dopo l\'invio (non verranno inviati nella chat corrente).',
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
    clearAttachmentsAfterSend: {
      type: 'boolean',
      description: 'Se true, cancella il buffer degli allegati dopo l\'invio (non verranno inviati nella chat corrente).',
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
    clearAttachmentsAfterSend: {
      type: 'boolean',
      description: 'Se true, cancella il buffer degli allegati dopo l\'invio (non verranno inviati nella chat corrente).',
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
    description: 'Programma attività future (statiche o dinamiche).',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            taskType: {
              type: 'string',
              enum: ['static', 'dynamic'],
              description: "'static' = contenuto pronto; 'dynamic' = prompt per Grok AI da eseguire al momento della consegna",
            },
            content: {
              type: 'string',
              description: 'Testo da inviare (static) oppure prompt da elaborare (dynamic)',
            },
            scheduledAt: {
              type: 'string',
              description: 'Data/ora ISO 8601 con timezone Europe/Rome (es. 2026-03-16T16:00:00+01:00)',
            },
            sendToGroup: {
              type: 'boolean',
              description: 'true = invia al gruppo WhatsApp corrente (solo se la richiesta viene da un gruppo)',
            },
            sendToPrivateWhatsApp: {
              type: 'boolean',
              description: "true = invia in privato su WhatsApp all'utente",
            },
            sendToEmail: {
              type: 'boolean',
              description: "true = invia via email (solo membri attivi, il programma blocca se non lo è)",
            },
            pdfContent: {
              type: 'string',
              description: 'Contenuto testuale per generare e allegare un PDF al task',
            },
            pdfTitle: {
              type: 'string',
              description: 'Titolo del PDF da allegare',
            },
          },
          required: ['taskType', 'content', 'scheduledAt'],
        },
      },
    },
    required: ['tasks'],
  });

  if (!includeRecipientName && !includeRecipientPhone) return baseTool;

  const tool = JSON.parse(JSON.stringify(baseTool));
  tool.function.description += ' ADMIN: puoi specificare recipientPhone o recipientName per inviare a qualsiasi persona, non solo a te stesso.';

  const itemProps = tool.function.parameters.properties.tasks.items.properties;
  if (includeRecipientPhone) {
    itemProps.recipientPhone = {
      type: 'string',
      description: 'ADMIN: Numero di telefono del destinatario con prefisso internazionale (es. +393XXXXXXXXX) per inviare a non-membri.',
    };
  }
  if (includeRecipientName) {
    itemProps.recipientName = {
      type: 'string',
      description: 'ADMIN: Nome completo di un membro attivo a cui inviare (al posto di a te stesso).',
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

      if (!isWhatsAppGroup) {
        delete taskProps.sendToGroup;
      }

      if (!isActiveMember && !isAdmin) {
        delete taskProps.sendToEmail;
        delete taskProps.pdfContent;
        delete taskProps.pdfTitle;
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

  return tools;
}

function isActiveMemberOnlyTool(toolName) {
  return ACTIVE_MEMBER_TOOL_NAMES.includes(toolName);
}

function getDynamicTaskTools(isActiveMember, isAdmin, userCtx = {}) {
  const chatKey = _getChatKey(userCtx);
  // Data-gathering tools (always available, no recipient params)
  let tools = [
    BASE_TOOLS.find(t => t.function.name === 'web_search'),
    makeTool({
      name: 'image_search',
      description: 'Cerca immagini sul web. Le immagini trovate verranno accumulate come allegati e inviate insieme al messaggio di consegna (WhatsApp o email).',
      properties: {
        query: { type: 'string', description: 'Cosa cercare nelle immagini (preferibilmente in inglese per risultati migliori)' },
        count: { type: 'integer', description: 'Numero immagini da cercare (1-4). Default 1.' },
      },
      required: ['query'],
    }),
    makeTool({
      name: 'generate_pdf',
      description: 'Genera un file PDF. Il PDF verrà accumulato come allegato e inviato insieme al messaggio di consegna (WhatsApp o email).',
      properties: {
        title: { type: 'string', description: 'Titolo del PDF' },
        content: { type: 'string', description: 'Contenuto testuale del PDF. Supporta # e ## per titoli, - per elenchi puntati.' },
      },
      required: ['title', 'content'],
    }),
  ];

  // Delivery tools — descriptions vary by permission level
  if (isAdmin) {
    // Add music stats for admin
    tools.push(ACTIVE_MEMBER_TOOLS.find(t => t.function.name === 'read_music_stats'));

    tools.push(makeWhatsAppTool({ includeRecipientName: true, includeRecipientPhone: true }));
    if (!isDiscord) {
      tools.push(makeVoiceTool({ includeRecipientName: true, includeRecipientPhone: true }));
    }
    tools.push(makeEmailTool({ includeRecipientName: true, includeRecipientEmail: true }));
  } else if (isActiveMember) {
    // Add music stats for active members
    tools.push(ACTIVE_MEMBER_TOOLS.find(t => t.function.name === 'read_music_stats'));

    tools.push(makeWhatsAppTool());
    if (!isDiscord) {
      tools.push(makeVoiceTool());
    }
    tools.push(makeEmailTool());
  } else {
    // Non-active member: only WA to self
    tools.push(makeWhatsAppTool());
    if (!isDiscord) {
      tools.push(makeVoiceTool());
    }
  }

  return tools;
}

module.exports = {
  getToolsForUser,
  getDynamicTaskTools,
  isActiveMemberOnlyTool,
  getToolInstructions,
  BASE_TOOLS,
  ACTIVE_MEMBER_TOOLS,
  _markReadAboutMeUsed: _markReadAboutMeUsed,
  _isReadAboutMeUsed: _isReadAboutMeUsed,
};
