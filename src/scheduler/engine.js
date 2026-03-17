const fs = require('fs');
const path = require('path');
const { TASKS_DIR, SCHEDULER_INTERVAL_MS } = require('../config/constants');
const { callGrok } = require('../ai/grok');
const { webSearch } = require('../tools/webSearch');
const { generatePdf } = require('../tools/pdfGenerator');
const { sendWhatsAppDirect } = require('../tools/whatsappSender');
const { sendEmailDirect } = require('../tools/emailSender');
const { getRomeTime, getRomeISO } = require('../utils/time');
const { buildScheduledFooter } = require('../utils/footer');
const { checkAndSendMusicWrap } = require('./musicWrapMonitor');
const { MessageMedia } = require('whatsapp-web.js');

let dedicatedClient = null;
let lastMusicWrapCheckDate = null;

function setSchedulerWaClient(client) {
  dedicatedClient = client;
}

function startScheduler() {
  // Ensure tasks directory exists
  if (!fs.existsSync(TASKS_DIR)) {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
  }

  console.log('[Scheduler] ✅ Avviato. Controlla ogni', SCHEDULER_INTERVAL_MS / 1000, 'secondi.');

  setInterval(async () => {
    try {
      await checkAndExecuteTasks();
    } catch (err) {
      console.error('[Scheduler] Errore nel ciclo:', err);
    }
  }, SCHEDULER_INTERVAL_MS);
}

async function checkAndExecuteTasks() {
  // Check music wrap once per day (at midnight in Italy)
  const now = new Date();
  // Use locale string in Swedish format for safe ISO-like parsing
  const romeTimeStr = now.toLocaleString('sv-SE', { timeZone: 'Europe/Rome' });
  const todayDateString = romeTimeStr.split(' ')[0]; // Gets YYYY-MM-DD

  if (lastMusicWrapCheckDate !== todayDateString) {
    lastMusicWrapCheckDate = todayDateString;
    try {
      await checkAndSendMusicWrap(dedicatedClient);
    } catch (err) {
      console.error('[MusicWrap] Errore nel controllo:', err);
    }
  }

  if (!fs.existsSync(TASKS_DIR)) return;

  const files = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const filePath = path.join(TASKS_DIR, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      continue;
    }

    if (!data.tasks || data.tasks.length === 0) continue;

    const nowTime = now.getTime();
    const dueTasks = data.tasks.filter(t => new Date(t.scheduledAt).getTime() <= nowTime);
    if (dueTasks.length === 0) continue;

    for (const task of dueTasks) {
      try {
        await executeTask(task);
        console.log(`[Scheduler] ✅ Task eseguito: ${task.id} (${task.type})`);
      } catch (err) {
        console.error(`[Scheduler] ❌ Errore task ${task.id}:`, err.message);
      }
    }

    // Remove executed tasks (refresh now time after potential long-running tasks)
    const nowAfter = new Date();
    const nowAfterTime = nowAfter.getTime();
    data.tasks = data.tasks.filter(t => new Date(t.scheduledAt).getTime() > nowAfterTime);

    if (data.tasks.length === 0) {
      fs.unlinkSync(filePath);
    } else {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    }
  }
}

async function executeTask(task) {
  let messageText = '';
  let pdfBuffer = null;
  let pdfName = null;

  if (task.type === 'static') {
    messageText = task.content;
  } else if (task.type === 'dynamic') {
    // Call Grok with the saved prompt
    const result = await executeDynamicTask(task.content);
    messageText = result.text;
    if (result.pdfBuffer) {
      pdfBuffer = result.pdfBuffer;
      pdfName = result.pdfName;
    }
  }

  // Generate PDF if specified in task
  if (task.pdfContent && !pdfBuffer) {
    pdfBuffer = await generatePdf(task.pdfTitle || 'Documento', task.pdfContent);
    pdfName = `${(task.pdfTitle || 'documento').replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
  }

  // Append scheduled footer with creation date
  const scheduledFooter = buildScheduledFooter(task.createdAt || getRomeISO());
  messageText += scheduledFooter;

  const dest = task.destinations || {};

  // Send to WhatsApp private
  if (dest.whatsapp && dedicatedClient) {
    try {
      await dedicatedClient.sendMessage(dest.whatsapp, messageText);
      if (pdfBuffer) {
        const media = new MessageMedia('application/pdf', pdfBuffer.toString('base64'), pdfName || 'documento.pdf');
        await dedicatedClient.sendMessage(dest.whatsapp, media);
      }
    } catch (err) {
      console.error(`[Scheduler] Errore invio WA privato ${dest.whatsapp}:`, err.message);
    }
  }

  // Send to WhatsApp group
  if (dest.whatsappGroup && dedicatedClient) {
    try {
      await dedicatedClient.sendMessage(dest.whatsappGroup, messageText);
      if (pdfBuffer) {
        const media = new MessageMedia('application/pdf', pdfBuffer.toString('base64'), pdfName || 'documento.pdf');
        await dedicatedClient.sendMessage(dest.whatsappGroup, media);
      }
    } catch (err) {
      console.error(`[Scheduler] Errore invio WA gruppo ${dest.whatsappGroup}:`, err.message);
    }
  }

  // Send email
  if (dest.email) {
    try {
      const attachments = [];
      if (pdfBuffer) {
        attachments.push({
          filename: pdfName || 'documento.pdf',
          content: pdfBuffer,
          contentType: 'application/pdf',
        });
      }
      await sendEmailDirect(
        dest.email,
        `GemiX — Attività programmata`,
        `<div style="font-family:sans-serif">${messageText.replace(/\n/g, '<br>')}</div>`,
        attachments
      );
    } catch (err) {
      console.error(`[Scheduler] Errore invio email ${dest.email}:`, err.message);
    }
  }
}

/**
 * Execute a dynamic task using Grok AI.
 * Grok has access to web_search and generate_pdf tools.
 */
async function executeDynamicTask(prompt) {
  const systemMsg = `Sei un assistente AI che esegue task programmati. Ora corrente (Roma): ${getRomeTime()}.\nEsegui il seguente compito e fornisci il risultato come messaggio da inviare all'utente. Rispondi in italiano.`;

  const grokTools = [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Cerca informazioni aggiornate sul web.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Query di ricerca' } },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'generate_pdf',
        description: 'Genera un PDF con titolo e contenuto.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['title', 'content'],
        },
      },
    },
  ];

  const messages = [
    { role: 'system', content: systemMsg },
    { role: 'user', content: prompt },
  ];

  let pdfBuffer = null;
  let pdfName = null;
  let rounds = 0;

  while (rounds < 5) {
    rounds++;
    const response = await callGrok(messages, grokTools);

    if (response.tool_calls && response.tool_calls.length > 0) {
      messages.push(response);

      for (const tc of response.tool_calls) {
        let result;
        const args = JSON.parse(tc.function.arguments || '{}');

        if (tc.function.name === 'web_search') {
          result = await webSearch(args.query);
        } else if (tc.function.name === 'generate_pdf') {
          pdfBuffer = await generatePdf(args.title, args.content);
          pdfName = `${(args.title || 'documento').replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
          result = 'PDF generato con successo.';
        } else {
          result = 'Tool non disponibile.';
        }

        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
      continue;
    }

    return { text: response.content || 'Task completato.', pdfBuffer, pdfName };
  }

  return { text: 'Task completato (limite iterazioni raggiunto).', pdfBuffer, pdfName };
}

module.exports = { startScheduler, setSchedulerWaClient };
