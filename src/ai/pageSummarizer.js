// src/ai/pageSummarizer.js
// LLM-powered page summarizer — mirrors the mediaDescriber pattern:
// prompt + schema + callModel, so retry/logging/timeout are handled
// by the shared API client instead of a hand-rolled fetch.

const { OPENROUTER_BASE_URL, OPENROUTER_API_KEY, BROWSE_PAGE_MODEL } = require('../config/env');
const { callModel } = require('./apiClient');
const { createLogger } = require('../utils/logger');

const log = createLogger('PageSummarizer');

// ── Constants ──

const MAX_RAW_CHARS = 60_000;        // max chars extracted from page before summarization
const MAX_SUMMARY_TOKENS = 4096;     // max tokens for the summarizer response

// ── Schema ──

const PAGE_SUMMARY_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'page_summary',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Concise page title or main subject (a few words).' },
        summary: { type: 'string', description: 'Comprehensive narrative summary in Italian, following the user instructions. Multi-paragraph if needed.' },
        key_points: {
          type: 'array',
          items: { type: 'string' },
          description: '3-10 short bullet points capturing the most important facts/data.',
        },
        relevant_sections: {
          type: 'array',
          items: { type: 'string' },
          description: 'Direct excerpts/quotes from the page that best support the summary. Empty array if not applicable.',
        },
      },
      required: ['title', 'summary', 'key_points', 'relevant_sections'],
      additionalProperties: false,
    },
  },
};

// ── Markdown renderer ──

function _renderSummaryMarkdown(parsed) {
  const lines = [];
  if (parsed.title) lines.push(`# ${parsed.title}`, '');
  if (parsed.summary) lines.push(parsed.summary, '');
  if (Array.isArray(parsed.key_points) && parsed.key_points.length > 0) {
    lines.push('## Key points');
    for (const k of parsed.key_points) lines.push(`- ${k}`);
    lines.push('');
  }
  if (Array.isArray(parsed.relevant_sections) && parsed.relevant_sections.length > 0) {
    lines.push('## Relevant excerpts');
    for (const s of parsed.relevant_sections) lines.push(`> ${s.replace(/\n+/g, ' ')}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

// ── Main summarizer ──

/**
 * Summarize page content using a lightweight LLM via OpenRouter.
 * @param {string} pageText - Extracted text content from the page
 * @param {string} instructions - User instructions for what to extract/analyze
 * @param {string} url - Original URL (for context)
 * @param {string} [pageTitle] - Page title if available
 * @returns {Promise<string>} Summarized content as Markdown
 */
async function summarizePage(pageText, instructions, url, pageTitle = null) {
  const systemPrompt = [
    'Reply in Italian, follow the user instructions, and never invent facts.',
    'If the page is empty, paywalled, blocked, login-only, or inaccessible, say so in `summary` and return empty arrays.',
    'If content was truncated, mention it in `summary`.',
    '`relevant_sections` must contain short verbatim excerpts, not paraphrases.',
  ].join(' ');

  let content = pageText;
  let truncated = false;
  if (content.length > MAX_RAW_CHARS) {
    content = content.substring(0, MAX_RAW_CHARS);
    truncated = true;
  }

  const userPrompt = [
    `URL: ${url}`,
    pageTitle ? `Title: ${pageTitle}` : null,
    `Content length: ${pageText.length}${truncated ? ` (truncated to ${MAX_RAW_CHARS})` : ''}`,
    `Instructions: ${instructions}`,
    '',
    'PAGE CONTENT:',
    content,
    'END PAGE CONTENT',
  ].filter(Boolean).join('\n');

  const body = {
    model: BROWSE_PAGE_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: MAX_SUMMARY_TOKENS,
    response_format: PAGE_SUMMARY_SCHEMA,
  };

  log.info(`   🧠 Summarizing with ${BROWSE_PAGE_MODEL}...`);

  const message = await callModel('BrowsePageSummarizer', `${OPENROUTER_BASE_URL}/chat/completions`, body, OPENROUTER_API_KEY);
  const raw = typeof message?.content === 'string' ? message.content : '';
  if (!raw) throw new Error('Summarizer returned empty response');

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new Error(`Summarizer returned invalid JSON: ${e.message}`); }

  if (!parsed || typeof parsed.summary !== 'string' || !Array.isArray(parsed.key_points)) {
    throw new Error('Summarizer JSON missing required fields');
  }

  const md = _renderSummaryMarkdown(parsed);
  log.info(`   ✅ Summary generated (${md.length} chars, ${parsed.key_points.length} key_points)`);
  return md;
}

module.exports = { summarizePage, MAX_RAW_CHARS };
