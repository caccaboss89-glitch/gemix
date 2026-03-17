// Tool definitions for Gemini function calling (OpenAI-compatible format)
// Le descrizioni dei tool sono la UNICA fonte di istruzioni operative per GemiX.
// Il system prompt NON ripete queste info.

const BASE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Cerca informazioni aggiornate sul web. Usa quando serve info in tempo reale o dati specifici non in tua conoscenza.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'La query di ricerca (preferibilmente in inglese per risultati migliori)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'image_search',
      description: 'Cerca immagini sul web e le invia come allegati nella chat corrente (WhatsApp o Discord). Usalo quando l\'utente chiede immagini/esempi visivi o quando sono utili alla risposta.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Cosa cercare nelle immagini (preferibilmente in inglese per risultati migliori)' },
          count: { type: 'integer', description: 'Numero immagini da inviare (1-4). Default 2.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_voice_message',
      description: "Invia un messaggio vocale al posto di un messaggio testuale. Usalo quando richiesto dall'utente o a tua discrezione per risposte brevi/ironiche. IMPORTANTE: quando usi questo tool NON fornire anche una risposta testuale, il tuo turno finisce col vocale.\n\nLIMITE: il testo deve essere massimo 1000 caratteri. Se supera il limite, rispondi con un normale messaggio testuale.\n\nEFFETTI VOCALI DISPONIBILI:\n\nInline tags (inseriscili nel punto esatto):\n[pause] [long-pause] [hum-tune]\n[laugh] [chuckle] [giggle] [cry]\n[tsk] [tongue-click] [lip-smack]\n[breath] [inhale] [exhale] [sigh]\n\nWrapping tags (avvolgi il testo):\n<soft> <whisper> <loud> <build-intensity> <decrease-intensity>\n<higher-pitch> <lower-pitch> <slow> <fast>\n<sing-song> <singing> <laugh-speak> <emphasis>\n\nEsempio: \"Ciao! <soft>Benvenuto nel futuro della voce.</soft> [laugh] Questo è incredibile!\"",
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
      description: "Programma una o più attività future. Due tipi: STATICO (scrivi il testo finale da inviare così com'è) o DINAMICO (scrivi un prompt dettagliato per Grok AI che verrà elaborato al momento dell'esecuzione, es. ricerca meteo). Le date devono essere ISO 8601 con timezone Europe/Rome (es. 2026-03-16T16:00:00+01:00), max 1 anno nel futuro, non nel passato. Destinazioni: WhatsApp privato, gruppo WhatsApp corrente, e/o email (email solo per membri attivi). Ogni utente gestisce SOLO i propri task (privacy assoluta). In un gruppo puoi creare task sia per il gruppo che per l'utente in privato nella stessa chiamata.",
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
      description: 'Genera un file PDF e lo invia come allegato nella chat. Usalo quando un membro attivo richiede la creazione di un documento PDF.',
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
      description: "Invia un'email istantaneamente a un membro attivo. Specifica il NOME COMPLETO del destinatario (il programma risolve l'indirizzo email dal nome, non accetta indirizzi forniti dall'utente). Puoi inviare a te stesso o ad altri membri attivi. IMPORTANTE: NON usare markdown nella body dell'email.",
      parameters: {
        type: 'object',
        properties: {
          recipientName: { type: 'string', description: 'Nome completo del membro attivo destinatario (es. "Gagliardi Alberto")' },
          subject: { type: 'string', description: "Oggetto dell'email" },
          body: { type: 'string', description: "Corpo dell'email (può contenere HTML - ma NON usare markdown)" },
          attachPdf: { type: 'boolean', description: 'true = genera e allega un PDF' },
          pdfTitle: { type: 'string', description: 'Titolo del PDF da allegare (richiesto se attachPdf è true)' },
          pdfContent: { type: 'string', description: 'Contenuto del PDF da allegare (richiesto se attachPdf è true)' },
        },
        required: ['recipientName', 'subject', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_whatsapp_message',
      description: "Invia un messaggio WhatsApp in privato a un altro membro attivo tramite l'account dedicato di GemiX. Specifica il NOME COMPLETO del destinatario (il programma risolve il numero dal nome, non accetta numeri forniti dall'utente). Il destinatario deve essere un membro attivo.",
      parameters: {
        type: 'object',
        properties: {
          recipientName: { type: 'string', description: 'Nome completo del membro attivo destinatario (es. "Passante Lorenzo")' },
          message: { type: 'string', description: 'Il messaggio da inviare' },
        },
        required: ['recipientName', 'message'],
      },
    },
  },
];

const ACTIVE_MEMBER_TOOL_NAMES = ACTIVE_MEMBER_TOOLS.map(t => t.function.name);

// Admin-only variant: send_whatsapp_message with recipientPhone support
const ADMIN_SEND_WA_TOOL = {
  type: 'function',
  function: {
    name: 'send_whatsapp_message',
    description: "Invia un messaggio WhatsApp in privato tramite l'account dedicato di GemiX. Puoi inviare a CHIUNQUE: membri attivi (specifica recipientName) o qualsiasi persona (specifica recipientPhone con prefisso internazionale, es. +39...).",
    parameters: {
      type: 'object',
      properties: {
        recipientName: { type: 'string', description: 'Nome completo del destinatario (se membro attivo)' },
        recipientPhone: { type: 'string', description: 'Numero di telefono con prefisso internazionale (es. +393XXXXXXXXX). Per destinatari non membri attivi.' },
        message: { type: 'string', description: 'Il messaggio da inviare' },
      },
      required: ['message'],
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
 * Admin: varianti potenziate di send_whatsapp_message e schedule_tasks.
 */
function getToolsForUser(isActiveMember, isAdmin) {
  let tools = isActiveMember ? [...BASE_TOOLS, ...ACTIVE_MEMBER_TOOLS] : [...BASE_TOOLS];
  
  if (isAdmin) {
    const adminScheduleTool = buildAdminScheduleTool();
    tools = tools.map(t => {
      if (t.function.name === 'send_whatsapp_message') return ADMIN_SEND_WA_TOOL;
      if (t.function.name === 'schedule_tasks') return adminScheduleTool;
      return t;
    });
  }
  
  return tools;
}

function isActiveMemberOnlyTool(toolName) {
  return ACTIVE_MEMBER_TOOL_NAMES.includes(toolName);
}

module.exports = { getToolsForUser, isActiveMemberOnlyTool, BASE_TOOLS, ACTIVE_MEMBER_TOOLS };
