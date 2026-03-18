// Tool definitions for Gemini AI function calling (OpenAI-compatible format).
// Tool descriptions are the single source of truth for GemiX operational instructions.

const VOICE_EFFECTS_DOC = `LIMITE: il testo deve essere massimo 1000 caratteri. Se supera il limite, rispondi con un normale messaggio testuale.

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

const BASE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Cerca informazioni aggiornate sul web.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'La query di ricerca (in inglese per risultati migliori)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'image_search',
      description: 'Cerca immagini sul web. Le immagini verranno accumulate come allegati e inviate: nella risposta della chat attuale oppure insieme ai tool di consegna (send_whatsapp_message, send_voice_message, send_email). Usalo per esempi visivi.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Cosa cercare nelle immagini (in inglese per risultati migliori)' },
          count: { type: 'integer', description: 'Numero immagini da inviare (1-4). Default 2.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_about_me',
      description: 'Leggi e invia la storia personale di GemiX. IMPORTANTE: quando usi questo tool, il testo della storia verrà inviato direttamente ALL\'UTENTE come tua risposta, interrompendosi senza dare ulteriore risposta. Non fornire commenti aggiuntivi. Usalo quando un utente chiede chi sei, di presentarti, oppure della tua storia.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_voice_message',
      description: `Invia un messaggio vocale come risposta nella chat attuale. IMPORTANTE: quando usi questo tool NON fornire anche una risposta testuale.\n\n${VOICE_EFFECTS_DOC}`,
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Il testo da convertire in audio vocale (max 1000 caratteri). Può contenere effetti vocali inline e wrapping tags.' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_tasks',
      description: "Programma una o più attività future. Due tipi: STATICO (scrivi il testo finale da inviare) o DINAMICO (scrivi un prompt dettagliato per Grok AI che verrà elaborato al momento dell'esecuzione, es. ricerche meteo o statistiche). Le date devono essere ISO 8601 con timezone Europe/Rome (es. 2026-03-16T16:00:00+01:00), max 1 anno nel futuro, non nel passato. Destinazioni: WhatsApp privato, gruppo WhatsApp corrente, e/o email (email solo per membri attivi). Ogni utente gestisce SOLO i propri task (privacy assoluta). In un gruppo puoi creare task sia per il gruppo che per l'utente in privato nella stessa chiamata.",
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                taskType: { type: 'string', enum: ['static', 'dynamic'], description: "'static' = messaggio pronto da inviare; 'dynamic' = prompt per Grok AI che lo elaborerà al momento" },
                content: { type: 'string', description: 'Per static: testo finale del messaggio. Per dynamic: prompt dettagliato per Grok AI' },
                scheduledAt: { type: 'string', description: 'Data e ora ISO 8601 con timezone Europe/Rome. Es: 2026-03-16T16:00:00+01:00' },
                sendToGroup: { type: 'boolean', description: 'true = invia al gruppo WhatsApp corrente (solo se la richiesta viene da un gruppo)' },
                sendToPrivateWhatsApp: { type: 'boolean', description: "true = invia in privato su WhatsApp all'utente" },
                sendToEmail: { type: 'boolean', description: "true = invia via email (solo membri attivi, il programma blocca se non lo è)" },
                pdfContent: { type: 'string', description: 'Contenuto testuale per generare e allegare un PDF al task' },
                pdfTitle: { type: 'string', description: 'Titolo del PDF da allegare' },
              },
              required: ['taskType', 'content', 'scheduledAt'],
            },
          },
        },
        required: ['tasks'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_my_tasks',
      description: "Leggi le attività programmate dell'utente corrente. Mostra solo i PROPRI task personali. Se in un gruppo, può includere anche i task del gruppo corrente.",
      parameters: {
        type: 'object',
        properties: {
          includeGroupTasks: { type: 'boolean', description: 'true = includi anche i task del gruppo corrente (solo se in un gruppo)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_my_tasks',
      description: "Rimuovi attività programmate dell'utente corrente. Può rimuovere solo i PROPRI task. Usa prima read_my_tasks per ottenere gli ID dei task da rimuovere.",
      parameters: {
        type: 'object',
        properties: {
          taskIds: { type: 'array', items: { type: 'string' }, description: 'Gli ID dei task da rimuovere' },
          fromGroup: { type: 'boolean', description: 'true = rimuovi dal file del gruppo corrente invece che da quello personale' },
        },
        required: ['taskIds'],
      },
    },
  },
];

const ACTIVE_MEMBER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_server_rules',
      description: 'Leggi il regolamento del server Discord. Usalo quando un membro attivo chiede info sul regolamento o devi verificare una regola.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_pdf',
      description: 'Genera un file PDF. Il PDF verrà accumulato come allegato e inviato: nella risposta della chat attuale oppure insieme ai tool di consegna (send_whatsapp_message, send_email). Usalo quando un membro richiede un documento PDF.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Titolo del PDF (appare in testa al documento)' },
          content: { type: 'string', description: 'Contenuto testuale del PDF. Supporta # e ## per titoli, - per elenchi puntati.' },
        },
        required: ['title', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_email',
      description: "Invia un'email a un ALTRO membro attivo (consegna, non risposta nella chat attuale). Tutti gli allegati accumulati (immagini, PDF) verranno inclusi automaticamente. Specifica il NOME COMPLETO del destinatario. IMPORTANTE: NON usare markdown nella body. REGOLA: puoi inviare solo 1 email per indirizzo.",
      parameters: {
        type: 'object',
        properties: {
          recipientName: { type: 'string', description: 'Nome completo del membro attivo destinatario (es. "Gagliardi Alberto"). DEVE essere diverso da te.' },
          subject: { type: 'string', description: "Oggetto dell'email" },
          body: { type: 'string', description: "Corpo dell'email (può contenere HTML - NON usare markdown)" },
        },
        required: ['recipientName', 'subject', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_whatsapp_message',
      description: "Invia un messaggio WhatsApp a un ALTRO membro attivo tramite l'account dedicato di GemiX (consegna, non risposta nella chat attuale). Tutti gli allegati accumulati (immagini, PDF) verranno inviati insieme. Specifica il NOME COMPLETO del destinatario. REGOLA: puoi inviare solo 1 messaggio per numero WhatsApp (testuale o vocale, non entrambi).",
      parameters: {
        type: 'object',
        properties: {
          recipientName: { type: 'string', description: 'Nome completo del membro attivo destinatario (es. "Passante Lorenzo"). DEVE essere diverso da te.' },
          message: { type: 'string', description: 'Il messaggio da inviare' },
        },
        required: ['recipientName', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_music_stats',
      description: 'Leggi le statistiche aggiornate del Music Bot del server. Mostra: statistiche globali, per ogni utente del Server Discord. Usalo se richiesto',
      parameters: { type: 'object', properties: {} },
    },
  },
];

const ACTIVE_MEMBER_TOOL_NAMES = ACTIVE_MEMBER_TOOLS.map(t => t.function.name);

// Admin-only variant: send_whatsapp_message with extended recipient options
const ADMIN_SEND_WA_TOOL = {
  type: 'function',
  function: {
    name: 'send_whatsapp_message',
    description: "Invia un messaggio WhatsApp tramite l'account dedicato di GemiX (consegna, non risposta). Tutti gli allegati accumulati (immagini, PDF) verranno inviati insieme. Puoi inviare a chiunque: membri attivi (recipientName) o qualsiasi persona (recipientPhone). Se specifichi il TUO nome in recipientName, riceverai un errore: per rispondere nella chat attuale, non usare questo tool. REGOLA: puoi inviare solo 1 messaggio per numero WhatsApp (testuale o vocale, non entrambi).",
    parameters: {
      type: 'object',
      properties: {
        recipientName: { type: 'string', description: 'Nome completo del destinatario (se membro attivo). DEVE essere diverso da te.' },
        recipientPhone: { type: 'string', description: 'Numero di telefono con prefisso internazionale (es. +393XXXXXXXXX). Per destinatari non membri.' },
        message: { type: 'string', description: 'Il messaggio da inviare' },
      },
      required: ['message'],
    },
  },
};

// Member variant: send_voice_message with recipientName for other members
const MEMBER_VOICE_TOOL = {
  type: 'function',
  function: {
    name: 'send_voice_message',
    description: `Invia un messaggio vocale. SENZA recipientName: il vocale diventa la TUA RISPOSTA nella chat attuale (unico modo per rispondere con voce). CON recipientName: invia il vocale a un ALTRO membro attivo via WhatsApp privato insieme a tutti gli allegati accumulati (immagini, PDF). IMPORTANTE: quando rispondi nella chat attuale, NON fornire anche una risposta testuale.\n\n${VOICE_EFFECTS_DOC}\n\nREGOLE: 1 solo vocale nella chat attuale per richiesta. Ogni numero WhatsApp può ricevere solo 1 messaggio (testuale o vocale, non entrambi).`,
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Il testo da convertire in audio vocale (max 1000 caratteri). Può contenere effetti vocali inline e wrapping tags.' },
        recipientName: { type: 'string', description: 'OPZIONALE: Nome del membro attivo a cui inviare il vocale via WhatsApp. Se omesso, invia nella chat attuale.' },
      },
      required: ['text'],
    },
  },
};

// Admin variant: send_voice_message with recipientName + recipientPhone
const ADMIN_VOICE_TOOL = {
  type: 'function',
  function: {
    name: 'send_voice_message',
    description: `Invia un messaggio vocale. SENZA recipientName/recipientPhone: il vocale diventa la TUA RISPOSTA nella chat attuale (unico modo per rispondere con voce). CON recipientName/recipientPhone: invia il vocale via WhatsApp privato a chiunque, insieme a tutti gli allegati accumulati. Puoi inviare a qualsiasi numero o membro.\n\nIMPORTANTE: quando rispondi nella chat attuale, NON fornire anche una risposta testuale.\n\n${VOICE_EFFECTS_DOC}\n\nREGOLE: 1 solo vocale nella chat attuale per richiesta. Ogni numero WhatsApp può ricevere solo 1 messaggio (testuale o vocale, non entrambi).`,
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Il testo da convertire in audio vocale (max 1000 caratteri). Può contenere effetti vocali inline e wrapping tags.' },
        recipientName: { type: 'string', description: 'OPZIONALE: Nome del membro attivo a cui inviare il vocale.' },
        recipientPhone: { type: 'string', description: 'OPZIONALE: Numero di telefono con prefisso internazionale (es. +393XXXXXXXXX).' },
      },
      required: ['text'],
    },
  },
};

// Admin-only variant: send_email with extended recipient options
const ADMIN_SEND_EMAIL_TOOL = {
  type: 'function',
  function: {
    name: 'send_email',
    description: "Invia un'email (consegna, non risposta). Tutti gli allegati accumulati (immagini, PDF) verranno inclusi automaticamente. Puoi inviare a chiunque: membri attivi (recipientName) o qualsiasi email (recipientEmail). Se specifichi la TUA email in recipientName, riceverai un errore: per rispondere nella chat attuale, non usare questo tool. IMPORTANTE: NON usare markdown nella body. REGOLA: puoi inviare solo 1 email per indirizzo.",
    parameters: {
      type: 'object',
      properties: {
        recipientName: { type: 'string', description: 'Nome completo del membro attivo destinatario (la email viene risolta dal nome). DEVE essere diverso da te.' },
        recipientEmail: { type: 'string', description: 'Indirizzo email diretto del destinatario (per qualsiasi persona, incluso se stesso - ma meglio evitare)' },
        subject: { type: 'string', description: "Oggetto dell'email" },
        body: { type: 'string', description: "Corpo dell'email (può contenere HTML - NON usare markdown)" },
      },
      required: ['subject', 'body'],
    },
  },
};

// Build admin variant of schedule_tasks with recipient override fields
function buildAdminScheduleTool() {
  const tool = JSON.parse(JSON.stringify(BASE_TOOLS.find(t => t.function.name === 'schedule_tasks')));
  tool.function.description += ' ADMIN: puoi specificare recipientPhone o recipientName per inviare a qualsiasi persona, non solo a te stesso.';
  const itemProps = tool.function.parameters.properties.tasks.items.properties;
  itemProps.recipientPhone = {
    type: 'string',
    description: 'ADMIN: Numero di telefono del destinatario con prefisso internazionale (es. +393XXXXXXXXX) per inviare a non-membri.',
  };
  itemProps.recipientName = {
    type: 'string',
    description: 'ADMIN: Nome completo di un membro attivo a cui inviare (al posto di a te stesso).',
  };
  return tool;
}

/**
 * Returns only the tools that l'utente corrente può effettivamente usare.
 * Non-membri: solo BASE_TOOLS. Membri attivi: BASE_TOOLS + ACTIVE_MEMBER_TOOLS.
 * Admin: varianti potenziate di send_whatsapp_message, send_email, send_voice_message e schedule_tasks.
 * Usa lo stesso pattern di accumulazione allegati e delivery enforcement dei dynamic task.
 */
function getToolsForUser(isActiveMember, isAdmin) {
  let tools = isActiveMember ? [...BASE_TOOLS, ...ACTIVE_MEMBER_TOOLS] : [...BASE_TOOLS];
  
  if (isAdmin) {
    const adminScheduleTool = buildAdminScheduleTool();
    tools = tools.map(t => {
      if (t.function.name === 'send_voice_message') return ADMIN_VOICE_TOOL;
      if (t.function.name === 'send_whatsapp_message') return ADMIN_SEND_WA_TOOL;
      if (t.function.name === 'send_email') return ADMIN_SEND_EMAIL_TOOL;
      if (t.function.name === 'schedule_tasks') return adminScheduleTool;
      return t;
    });
  } else if (isActiveMember) {
    tools = tools.map(t => {
      if (t.function.name === 'send_voice_message') return MEMBER_VOICE_TOOL;
      return t;
    });
  }
  
  return tools;
}

/**
 * Check if a tool is restricted to active members only.
 * @param {string} toolName - The tool name to check
 * @returns {boolean} True if the tool is member-only, false if available to all users
 */
function isActiveMemberOnlyTool(toolName) {
  return ACTIVE_MEMBER_TOOL_NAMES.includes(toolName);
}

/**
 * Returns the restricted tool set for dynamic task execution by Grok.
 * Only data-gathering + delivery tools. No aboutMe, scheduler, serverRules, taskReader, taskRemover.
 * Delivery rules are enforced programmatically by the scheduler engine, not by tool definitions.
 */
function getDynamicTaskTools(isActiveMember, isAdmin) {
  // Data-gathering tools (always available, no recipient params)
  const tools = [
    BASE_TOOLS.find(t => t.function.name === 'web_search'),
    {
      type: 'function',
      function: {
        name: 'image_search',
        description: 'Cerca immagini sul web. Le immagini trovate verranno accumulate come allegati e inviate insieme al messaggio di consegna (WhatsApp o email).',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Cosa cercare nelle immagini (preferibilmente in inglese per risultati migliori)' },
            count: { type: 'integer', description: 'Numero immagini da cercare (1-4). Default 2.' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'generate_pdf',
        description: 'Genera un file PDF. Il PDF verrà accumulato come allegato e inviato insieme al messaggio di consegna (WhatsApp o email).',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Titolo del PDF' },
            content: { type: 'string', description: 'Contenuto testuale del PDF. Supporta # e ## per titoli, - per elenchi puntati.' },
          },
          required: ['title', 'content'],
        },
      },
    },
  ];

  // Delivery tools — descriptions vary by permission level
  if (isAdmin) {
    // Add music stats for admin
    tools.push(ACTIVE_MEMBER_TOOLS.find(t => t.function.name === 'read_music_stats'));
    
    tools.push({
      type: 'function',
      function: {
        name: 'send_whatsapp_message',
        description: "Invia un messaggio testuale WhatsApp. Tutti gli allegati accumulati (immagini, PDF) verranno inviati insieme. Puoi inviare a qualsiasi numero o membro. REGOLA: puoi inviare solo 1 messaggio per numero WhatsApp (testuale o vocale, non entrambi allo stesso numero).",
        parameters: {
          type: 'object',
          properties: {
            recipientName: { type: 'string', description: 'Nome completo del destinatario (se membro attivo)' },
            recipientPhone: { type: 'string', description: 'Numero di telefono con prefisso internazionale (es. +393XXXXXXXXX). Per qualsiasi destinatario.' },
            message: { type: 'string', description: 'Il messaggio da inviare' },
          },
          required: ['message'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'send_voice_message',
        description: "Invia un messaggio vocale WhatsApp. Tutti gli allegati accumulati (immagini, PDF) verranno inviati insieme. Puoi inviare a qualsiasi numero o membro. REGOLA: puoi inviare solo 1 messaggio per numero WhatsApp (testuale o vocale, non entrambi allo stesso numero). Max 1000 caratteri.",
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Il testo da convertire in audio vocale (max 1000 caratteri).' },
            recipientName: { type: 'string', description: 'Nome completo del destinatario (se membro attivo)' },
            recipientPhone: { type: 'string', description: 'Numero di telefono con prefisso internazionale (es. +393XXXXXXXXX).' },
          },
          required: ['text'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'send_email',
        description: "Invia un'email con tutti gli allegati accumulati (immagini, PDF). Puoi inviare a qualsiasi email o membro. REGOLA: puoi inviare solo 1 email per indirizzo email.",
        parameters: {
          type: 'object',
          properties: {
            recipientName: { type: 'string', description: 'Nome completo del destinatario (se membro attivo, la email viene risolta dal nome)' },
            recipientEmail: { type: 'string', description: 'Indirizzo email diretto del destinatario (per qualsiasi persona)' },
            subject: { type: 'string', description: "Oggetto dell'email" },
            body: { type: 'string', description: "Corpo dell'email in HTML" },
          },
          required: ['subject', 'body'],
        },
      },
    });
  } else if (isActiveMember) {
    // Add music stats for active members
    tools.push(ACTIVE_MEMBER_TOOLS.find(t => t.function.name === 'read_music_stats'));
    
    tools.push({
      type: 'function',
      function: {
        name: 'send_whatsapp_message',
        description: "Invia un messaggio testuale WhatsApp al creatore del task. Tutti gli allegati accumulati (immagini, PDF) verranno inviati insieme. Si invia solo a se stessi. REGOLA: puoi inviare solo 1 messaggio WhatsApp (testuale o vocale, non entrambi).",
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Il messaggio da inviare' },
          },
          required: ['message'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'send_voice_message',
        description: "Invia un messaggio vocale WhatsApp al creatore del task. Tutti gli allegati accumulati (immagini, PDF) verranno inviati insieme. Si invia solo a se stessi. REGOLA: puoi inviare solo 1 messaggio WhatsApp (testuale o vocale, non entrambi). Max 1000 caratteri.",
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Il testo da convertire in audio vocale (max 1000 caratteri).' },
          },
          required: ['text'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'send_email',
        description: "Invia un'email al creatore del task con tutti gli allegati accumulati (immagini, PDF). Si invia solo a se stessi. REGOLA: puoi inviare solo 1 email.",
        parameters: {
          type: 'object',
          properties: {
            subject: { type: 'string', description: "Oggetto dell'email" },
            body: { type: 'string', description: "Corpo dell'email in HTML" },
          },
          required: ['subject', 'body'],
        },
      },
    });
  } else {
    // Non-active member: only WA to self
    tools.push({
      type: 'function',
      function: {
        name: 'send_whatsapp_message',
        description: "Invia un messaggio testuale WhatsApp al creatore del task. Tutti gli allegati accumulati (immagini, PDF) verranno inviati insieme. REGOLA: puoi inviare solo 1 messaggio WhatsApp (testuale o vocale, non entrambi).",
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Il messaggio da inviare' },
          },
          required: ['message'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'send_voice_message',
        description: "Invia un messaggio vocale WhatsApp al creatore del task. Tutti gli allegati accumulati (immagini, PDF) verranno inviati insieme. REGOLA: puoi inviare solo 1 messaggio WhatsApp (testuale o vocale, non entrambi). Max 1000 caratteri.",
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Il testo da convertire in audio vocale (max 1000 caratteri).' },
          },
          required: ['text'],
        },
      },
    });
  }

  return tools;
}

module.exports = { getToolsForUser, getDynamicTaskTools, isActiveMemberOnlyTool, BASE_TOOLS, ACTIVE_MEMBER_TOOLS };
