// src/tools/webSearch.js
const { SEARXNG_URL } = require('../config/env');
const { fetchExternal } = require('../utils/fetch');
const { createLogger } = require('../utils/logger');

const log = createLogger('WebSearch');

// ── Constants ──

const MAX_QUERY_LENGTH = 512;
const MAX_NUM_RESULTS = 30;
const DEFAULT_NUM_RESULTS = 15;
const MAX_DOMAIN_FILTERS = 5;

// ── Helpers ──

/**
 * Sanitize and trim a search query. Removes control characters and excess whitespace.
 * @param {string} raw - Raw query string
 * @returns {string} Cleaned query, truncated to MAX_QUERY_LENGTH
 */
function _sanitizeQuery(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let q = raw
    .replace(/[\x00-\x1F\x7F]/g, '') // strip control chars
    .replace(/\s+/g, ' ')            // collapse whitespace
    .trim();
  if (q.length > MAX_QUERY_LENGTH) {
    // Truncate at last word boundary before limit
    q = q.substring(0, MAX_QUERY_LENGTH);
    const lastSpace = q.lastIndexOf(' ');
    if (lastSpace > MAX_QUERY_LENGTH * 0.8) {
      q = q.substring(0, lastSpace);
    }
  }
  return q;
}

/**
 * Normalize a domain string: strip protocol, www., trailing slash.
 * @param {string} d - Raw domain
 * @returns {string} Normalized domain (e.g. "example.com")
 */
function _normalizeDomain(d) {
  if (!d || typeof d !== 'string') return '';
  return d
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '');
}

/**
 * Build the full SearXNG query by injecting domain filters.
 * Allowed domains use `site:`, excluded domains use `-site:`.
 * @param {string} baseQuery - User's search query
 * @param {string[]} [allowedDomains] - Domains to restrict results to
 * @param {string[]} [excludedDomains] - Domains to exclude from results
 * @returns {string} Final query with domain operators injected
 */
function _buildQueryWithDomains(baseQuery, allowedDomains, excludedDomains) {
  let q = baseQuery;

  if (Array.isArray(allowedDomains) && allowedDomains.length > 0) {
    const domains = allowedDomains
      .map(_normalizeDomain)
      .filter(Boolean)
      .slice(0, MAX_DOMAIN_FILTERS);
    if (domains.length > 0) {
      // Multiple allowed domains: use OR syntax with parentheses
      // SearXNG passes this to underlying engines; works with Google, Bing, etc.
      const siteOps = domains.map(d => `site:${d}`).join(' OR ');
      q = `${q} (${siteOps})`;
    }
  }

  if (Array.isArray(excludedDomains) && excludedDomains.length > 0) {
    const domains = excludedDomains
      .map(_normalizeDomain)
      .filter(Boolean)
      .slice(0, MAX_DOMAIN_FILTERS);
    for (const d of domains) {
      q = `${q} -site:${d}`;
    }
  }

  return q;
}

/**
 * Deduplicate results by URL, keeping the first occurrence.
 * @param {Array} results - SearXNG results array
 * @returns {Array} Deduplicated results
 */
function _deduplicateResults(results) {
  const seen = new Set();
  return results.filter(r => {
    if (!r.url) return false;
    const key = r.url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Post-filter results by excluded domains (fallback for engines that don't honor -site:).
 * @param {Array} results - Result array
 * @param {string[]} excludedDomains - Normalized domain list
 * @returns {Array} Filtered results
 */
function _postFilterExcluded(results, excludedDomains) {
  if (!excludedDomains || excludedDomains.length === 0) return results;
  const normalized = excludedDomains.map(_normalizeDomain).filter(Boolean);
  if (normalized.length === 0) return results;

  return results.filter(r => {
    if (!r.url) return true;
    try {
      const hostname = new URL(r.url).hostname.toLowerCase().replace(/^www\./, '');
      return !normalized.some(d => hostname === d || hostname.endsWith(`.${d}`));
    } catch {
      return true;
    }
  });
}

/**
 * Format a single search result into a structured text block.
 * @param {object} r - SearXNG result object
 * @param {number} i - 0-based index
 * @returns {string} Formatted result
 */
function _formatResult(r, i) {
  const parts = [`${i + 1}. **${r.title || 'Untitled'}**`];
  parts.push(`   URL: ${r.url}`);
  if (r.content) {
    parts.push(`   ${r.content}`);
  }
  if (r.publishedDate) {
    parts.push(`   Published: ${r.publishedDate}`);
  }
  return parts.join('\n');
}

// ── Main functions ──

/**
 * Perform a web search using SearXNG (self-hosted).
 * 
 * Features:
 * - Domain allow/block lists via site: operators + post-filtering
 * - Deduplication by URL
 * - Smart query sanitization and truncation
 * - Structured output with title, URL, snippet, and date
 * - Clear error messages for all edge cases
 *
 * @param {string} query - Search query (supports operators like site:, after:, before:, filetype:, etc.)
 * @param {number} [numResults=15] - Number of results to return (1-30)
 * @param {string[]} [allowedDomains] - Restrict results to these domains (max 5)
 * @param {string[]} [excludedDomains] - Exclude results from these domains (max 5)
 * @returns {Promise<string>} Formatted search results
 */
async function webSearch(query, numResults = DEFAULT_NUM_RESULTS, allowedDomains, excludedDomains) {
  // ── Validate query ──
  const cleanQuery = _sanitizeQuery(query);
  if (!cleanQuery) {
    return { success: false, error: 'Query is required. Please provide a search query.' };
  }
  if (cleanQuery.length < 2) {
    return { success: false, error: 'Query is too short. Please provide a more descriptive search query.' };
  }

  // ── Clamp numResults ──
  const validNumResults = Math.max(1, Math.min(MAX_NUM_RESULTS, parseInt(numResults) || DEFAULT_NUM_RESULTS));

  // ── Build final query with domain operators ──
  const finalQuery = _buildQueryWithDomains(cleanQuery, allowedDomains, excludedDomains);

  const params = new URLSearchParams({
    q: finalQuery,
    format: 'json',
    language: 'it',
    pageno: 1,
    safesearch: 0,
  });

  const url = `${SEARXNG_URL}/search?${params}`;

  log.debug(`   Query: "${finalQuery}" (want ${validNumResults})`);

  const res = await fetchExternal(url, {}, 'SearXNG (Web Search)');
  if (!res.ok) {
    throw new Error(`Search engine returned HTTP ${res.status}. Try again.`);
  }

  const data = await res.json();

  if (!data.results || data.results.length === 0) {
    return { success: false, error: 'No results found. Try rephrasing the query or using different keywords.' };
  }

  // ── Post-process: deduplicate → filter excluded → trim ──
  let processed = _deduplicateResults(data.results);
  processed = _postFilterExcluded(processed, excludedDomains);
  processed = processed.slice(0, validNumResults);

  if (processed.length === 0) {
    return { success: false, error: 'No results found after filtering. Try removing domain restrictions or rephrasing the query.' };
  }

  // ── Format output ──
  const resultsXml = processed.map((r, i) => {
    return `<Result rank="${i + 1}">
  <Title>${r.title || 'Untitled'}</Title>
  <URL>${r.url}</URL>
  <Snippet>${r.content || ''}</Snippet>
  ${r.publishedDate ? `<Date>${r.publishedDate}</Date>` : ''}
</Result>`;
  }).join('\n');

  const output = `<SearchResults query="${cleanQuery}" count="${processed.length}">
${resultsXml}
</SearchResults>`;

  return { success: true, content: output };
}

module.exports = { webSearch };