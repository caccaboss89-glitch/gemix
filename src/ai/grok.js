const { API_KEY, API_BASE_URL, GROK_MODEL } = require('../config/env');
const { notifyAdmin } = require('../utils/adminNotifier');

/**
 * Call Grok via AIMLAPI (used for dynamic scheduled tasks).
 * @param {Array} messages - OpenAI-format messages array
 * @param {Array|null} tools - Tool definitions
 * @returns {object} The assistant message
 */
async function callGrok(messages, tools = null) {
  const body = {
    model: GROK_MODEL,
    messages,
    max_tokens: 8192,
  };
  if (tools && tools.length > 0) body.tools = tools;

  const res = await fetch(`${API_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    await notifyAdmin('AIMLAPI (Grok)', `Errore HTTP ${res.status}: ${err.substring(0, 200)}`);
    throw new Error(`Grok API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  if (!data.choices || !data.choices[0]) {
    await notifyAdmin('AIMLAPI (Grok)', 'Nessuna risposta ricevuta dalla API');
    throw new Error('Grok API: nessuna risposta ricevuta');
  }

  return data.choices[0].message;
}

module.exports = { callGrok };
