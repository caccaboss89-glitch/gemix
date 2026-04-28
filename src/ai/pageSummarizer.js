// src/ai/pageSummarizer.js
// LLM-powered page summarizer — uses the shared API client for
// retry/logging/timeout while returning normal free-form markdown output.

const { OPENROUTER_API_KEY, BROWSE_PAGE_MODEL } = require('../config/env');
const { OPENROUTER_BASE_URL } = require('../config/constants');
const { callModel } = require('./apiClient');
const { createLogger } = require('../utils/logger');

const log = createLogger('PageSummarizer');

// ── Constants ──

const MAX_RAW_CHARS = 120_000;       // max chars extracted from page before summarization
const MAX_SUMMARY_TOKENS = 4096;     // max tokens for the summarizer response

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
    'Return normal Markdown text, not JSON and not XML.',
    'Structure the answer clearly with a short title, a concise summary, key points, and relevant excerpts when useful.',
    'Follow the user instructions, and never invent facts.',
    'If the page is empty, paywalled, blocked, login-only, or inaccessible, say so clearly.',
    'If content was truncated, mention it clearly.',
    'When you include excerpts, keep them short and verbatim, not paraphrased.',
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
  };

  log.info(`   🧠 Summarizing with ${BROWSE_PAGE_MODEL}...`);

  const message = await callModel('BrowsePageSummarizer', `${OPENROUTER_BASE_URL}/chat/completions`, body, OPENROUTER_API_KEY);
  const summary = typeof message?.content === 'string' ? message.content.trim() : '';
  if (!summary) throw new Error('Summarizer returned empty response');

  log.info(`   ✅ Summary generated (${summary.length} chars)`);
  return summary;
}

module.exports = { summarizePage, MAX_RAW_CHARS };
