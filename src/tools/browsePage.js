// src/tools/browsePage.js
const { BROWSE_PAGE_MODEL } = require('../config/env');
const { summarizePage, MAX_RAW_CHARS } = require('../ai/pageSummarizer');
const { fetchWithTimeout } = require('../utils/fetch');
const { createLogger } = require('../utils/logger');

const log = createLogger('BrowsePage');

// ── Constants ──

const FETCH_TIMEOUT_MS = 30_000;     // generous timeout for slow pages

// ── HTML → Text extraction ──

/**
 * Extract readable text from HTML, stripping scripts, styles, and tags.
 * @param {string} html - Raw HTML string
 * @returns {string} Clean text content
 */
function _extractText(html) {
  if (!html) return '';

  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, ' [HEADER] ')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, text) => `\n${'#'.repeat(Number(level))} ${text.replace(/<[^>]+>/g, '').trim()}\n`)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n\n')
    .replace(/<tr[^>]*>/gi, '\n')
    .replace(/<td[^>]*>/gi, ' | ')
    .replace(/<th[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .trim();
}

/**
 * Extract the <title> tag content from HTML.
 * @param {string} html
 * @returns {string|null}
 */
function _extractTitle(html) {
  if (!html) return null;
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/<[^>]+>/g, '').trim() : null;
}

// ── Page fetcher ──

/**
 * Fetch a URL and return the raw HTML content.
 * Handles redirects, validates content type, and provides clear error messages.
 * @param {string} url - URL to fetch
 * @returns {Promise<{html: string, finalUrl: string, status: number}>}
 */
async function _fetchPage(url) {
  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,it;q=0.8',
    },
    redirect: 'follow',
  }, FETCH_TIMEOUT_MS);

  const contentType = (res.headers.get('content-type') || '').toLowerCase();

  // Handle non-HTML content types gracefully
  if (!contentType.includes('html') && !contentType.includes('xml') && !contentType.includes('text/plain')) {
    return {
      html: `<p>This URL returned non-HTML content (${contentType}). The content cannot be parsed as a web page.</p>`,
      finalUrl: res.url || url,
      status: res.status,
    };
  }

  const html = await res.text();
  return {
    html,
    finalUrl: res.url || url,
    status: res.status,
  };
}

// ── Main export ──

/**
 * Browse a web page: fetch its content and optionally summarize it via LLM.
 *
 * Modes:
 *   - "summary" (default): Fetches page, extracts text, summarizes via LLM with custom instructions.
 *   - "raw": Fetches page, extracts text, returns raw content without LLM processing.
 *
 * @param {string} url - URL to browse
 * @param {string} [instructions] - Instructions for the LLM summarizer (required in summary mode)
 * @param {string} [mode='summary'] - 'summary' or 'raw'
 * @returns {Promise<string>} Processed page content
 */
async function browsePage(url, instructions, mode = 'summary') {
  // ── Validate URL ──
  if (!url || typeof url !== 'string') {
    return JSON.stringify({ success: false, error: 'URL is missing or invalid.' });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return JSON.stringify({ success: false, error: 'Invalid URL format. Provide a full URL with protocol (e.g. https://example.com).' });
  }

  // Block non-HTTP protocols
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return JSON.stringify({ success: false, error: `Unsupported protocol "${parsedUrl.protocol}". Only http and https are supported.` });
  }

  // ── Validate model ──
  if (!BROWSE_PAGE_MODEL) {
    return JSON.stringify({ success: false, error: 'BROWSE_PAGE_MODEL is not defined in the environment configuration.' });
  }

  // ── Fetch page ──
  log.info(`🌐 Browsing: ${url} (mode=${mode})`);

  let html, finalUrl, status;
  try {
    ({ html, finalUrl, status } = await _fetchPage(url));
  } catch (err) {
    const isTimeout = err.name === 'AbortError' || err.message.includes('Timeout');
    if (isTimeout) {
      return JSON.stringify({ success: false, error: `The page at ${url} took too long to respond (timeout after ${FETCH_TIMEOUT_MS / 1000}s). Try again later.` });
    }
    const isNetwork = /ECONNREFUSED|ECONNRESET|ENOTFOUND|ERR_NETWORK/i.test(err.message);
    if (isNetwork) {
      return JSON.stringify({ success: false, error: `Could not connect to ${parsedUrl.hostname}. The site may be down or unreachable.` });
    }
    return JSON.stringify({ success: false, error: `Error fetching page: ${err.message}` });
  }

  // Handle HTTP errors
  if (status >= 400) {
    const statusMessages = {
      401: 'This page requires authentication (401 Unauthorized).',
      403: 'Access to this page is forbidden (403 Forbidden). It may be behind a paywall or restricted.',
      404: 'Page not found (404). The URL may be incorrect or the page may have been removed.',
      429: 'Too many requests (429). The server is rate-limiting. Try again later.',
      500: 'Server error (500). The website is experiencing issues.',
      502: 'Bad gateway (502). The website is temporarily unavailable.',
      503: 'Service unavailable (503). The website is temporarily down for maintenance.',
    };
    const msg = statusMessages[status] || `HTTP error ${status}.`;

    // Still try to extract useful content from error pages
    const errorPageText = _extractText(html);
    if (errorPageText && errorPageText.length > 100) {
      return `${msg}\n\nHowever, the error page contained the following content:\n\n${errorPageText.substring(0, 3000)}`;
    }
    return JSON.stringify({ success: false, error: msg });
  }

  // ── Extract text ──
  const pageTitle = _extractTitle(html);
  const pageText = _extractText(html);

  if (!pageText || pageText.length < 20) {
    return JSON.stringify({ success: false, error: `No readable text content found on ${finalUrl}. The page may be JavaScript-rendered, empty, or blocked.` });
  }

  log.info(`   📄 Extracted ${pageText.length} chars${pageTitle ? ` — "${pageTitle}"` : ''}`);

  // ── Raw HTML mode: return full HTML ──
  if (mode === 'raw_html') {
    let result = html;
    const maxHtml = MAX_RAW_CHARS * 2;
    const isTruncated = html.length > maxHtml;
    
    if (isTruncated) {
      result = result.substring(0, maxHtml) + '\n\n... (HTML truncated at ' + maxHtml + ' characters)';
    }

    const header = [
      `**URL:** ${finalUrl}`,
      pageTitle ? `**Title:** ${pageTitle}` : null,
      `**Fetched at:** ${new Date().toLocaleString('it-IT')}`,
      `**Content length:** ${html.length} characters (HTML)${isTruncated ? ' [TRUNCATED]' : ''}`,
      '',
    ].filter(Boolean).join('\n');

    return `${header}\n\`\`\`html\n${result}\n\`\`\``;
  }

  // ── Raw mode: return extracted text directly ──
  if (mode === 'raw') {
    let result = pageText;
    const isTruncated = pageText.length > MAX_RAW_CHARS;
    
    if (isTruncated) {
      result = result.substring(0, MAX_RAW_CHARS) + '\n\n... (content truncated at ' + MAX_RAW_CHARS + ' characters)';
    }

    const header = [
      `**URL:** ${finalUrl}`,
      pageTitle ? `**Title:** ${pageTitle}` : null,
      `**Fetched at:** ${new Date().toLocaleString('it-IT')}`,
      `**Content length:** ${pageText.length} characters${isTruncated ? ' [TRUNCATED]' : ''}`,
      '',
    ].filter(Boolean).join('\n');

    return `${header}\n${result}`;
  }

  // ── Summary mode: LLM-powered extraction ──
  if (!instructions || typeof instructions !== 'string' || instructions.trim().length < 3) {
    // No instructions provided: use a sensible default
    instructions = 'Summarize the page structure, main points, important details, and notable data.';
  }

  try {
    const summary = await summarizePage(pageText, instructions.trim(), finalUrl, pageTitle);
    const isTruncated = pageText.length > MAX_RAW_CHARS;

    const header = [
      `**URL:** ${finalUrl}`,
      pageTitle ? `**Title:** ${pageTitle}` : null,
      `**Fetched at:** ${new Date().toLocaleString('it-IT')}`,
      `**Original length:** ${pageText.length} characters${isTruncated ? ' [TRUNCATED for summarization]' : ''}`,
      '',
    ].filter(Boolean).join('\n');

    return `${header}\n${summary}`;
  } catch (err) {
    log.error(`   ❌ Summarizer failed: ${err.message}`);

    return JSON.stringify({ success: false, error: `LLM summarizer failed to process the page: ${err.message}. If you still need the content, you can call this tool again using mode: "raw" to get the extracted text, or mode: "raw_html" for the raw HTML.` });
  }
}

module.exports = { browsePage };
