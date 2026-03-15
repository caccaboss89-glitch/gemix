const { API_KEY, API_BASE_URL, GEMINI_MODEL } = require('../config/env');
const { notifyAdmin } = require('../utils/adminNotifier');

const MAX_RETRIES = 3;
const TIMEOUT_MS = 60000;

/**
 * Call Gemini via AIMLAPI (OpenAI-compatible) with retry and timeout.
 * @param {Array} messages - OpenAI-format messages array
 * @param {Array|null} tools - Tool definitions array
 * @param {object|null} responseFormat - Optional response_format for structured output
 * @returns {object} The assistant message from the response
 */
async function callGemini(messages, tools = null, responseFormat = null) {
  const body = {
    model: GEMINI_MODEL,
    messages,
    max_tokens: 8192,
  };
  if (tools && tools.length > 0) body.tools = tools;
  if (responseFormat) body.response_format = responseFormat;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const startTime = Date.now();
      const res = await fetch(`${API_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const duration = Date.now() - startTime;

      if (!res.ok) {
        const errBody = await res.text();
        // Estrai messaggio utile, ignora HTML di Cloudflare
        const shortErr = errBody.startsWith('<!') ? `Cloudflare error` : errBody.substring(0, 500);
        throw new Error(`HTTP ${res.status}: ${shortErr}`);
      }

      const data = await res.json();
      if (!data.choices || !data.choices[0]) {
        throw new Error('Nessuna risposta ricevuta');
      }
      
      console.log(`   Modello: ${GEMINI_MODEL} - ${duration}ms${attempt > 1 ? ` (tentativo ${attempt})` : ''}`);

      return data.choices[0].message;
    } catch (err) {
      const isTimeout = err.name === 'AbortError' || (err.message && err.message.includes('524'));
      const isRetryable = isTimeout || (err.message && /^HTTP (429|500|502|503|504)/.test(err.message));
      const errMsg = err.name === 'AbortError' ? 'Timeout (60s)' : err.message;

      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = attempt * 3000;
        console.warn(`   ⚠️ API tentativo ${attempt}/${MAX_RETRIES} fallito: ${errMsg} — retry in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      
      console.error(`   ❌ API Error: ${errMsg}`);
      await notifyAdmin('AIMLAPI (Gemini)', `Errore dopo ${attempt} tentativi: ${errMsg}`);
      throw new Error(`Gemini API non raggiungibile dopo ${attempt} tentativ${attempt > 1 ? 'i' : 'o'}: ${errMsg}`);
    }
  }
}

/**
 * Discord structured output schema for Gemini.
 * Returns { title: string, message: string }.
 */
const DISCORD_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'discord_response',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Nuovo titolo per il thread Discord se quello attuale non è coerente con la conversazione, altrimenti stringa vuota',
        },
        message: {
          type: 'string',
          description: 'Il messaggio di risposta',
        },
      },
      required: ['title', 'message'],
      additionalProperties: false,
    },
  },
};

module.exports = { callGemini, DISCORD_RESPONSE_FORMAT };
