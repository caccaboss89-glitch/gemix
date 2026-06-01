// src/tools/webXSearch.js
//
// Single research tool, two gears, one code path:
//
//   - full_team=false (default): a single fast reasoning model
//     (FAST_RESEARCH_MODEL, e.g. grok-4.20-non-reasoning-latest) runs web_search
//     and x_search server-side. Quick lookups, no "consulting the team"
//     banner. This is the everyday gear.
//   - full_team=true: the grok-4.20-multi-agent team (4 agents) orchestrates
//     the same tools for deep, multi-source research with synthesis.
//
// Both gears share the exact same tools and parameters (web_search +
// x_search, image understanding on both, optional image search on web).
// Sub-agent tool calls are encrypted by Hermes for the team, so result
// counts for those are estimated from the orchestrator's visible activity.
//
// Image search: only enabled when the caller passes search_images=true
// (the model must explicitly want images). When on, web_search returns
// Markdown image embeds in the answer; we download those images, hand the
// buffers back to the caller (main brain -> delivery buffer, build agent ->
// workspace), and replace each embed with a positional placeholder so the
// brain never pastes a raw URL or references an image that didn't ship.

const { HERMES_API_KEY, HERMES_BASE_URL, MULTI_AGENT_MODEL, FAST_RESEARCH_MODEL } = require('../config/env');
const { MAX_IMAGE_BYTES, MAX_RESEARCH_IMAGES, RESEARCH_MAX_TURNS } = require('../config/constants');
const { logApiRequest, logApiResponse } = require('../ai/apiClient');
const { notifyAdmin, ADMIN_NOTIFIED_SUFFIX } = require('../utils/adminNotifier');
const { fetchWithTimeout } = require('../utils/fetch');
const { getRomeTime } = require('../utils/time');
const { createLogger } = require('../utils/logger');

const log = createLogger('WebXSearch');

const RESPONSES_URL = `${HERMES_BASE_URL.replace(/\/+$/, '')}/responses`;
// Multi-agent: "medium" maps to the 4-agent setup. The account is capped at
// 4 agents, so "high"/"xhigh" (16 agents) get silently downgraded to medium
// anyway - no point paying the extra prompt tokens by requesting them.
const TEAM_EFFORT = 'medium';
// Fast gear: a single reasoning model. Low effort keeps it quick while still
// triggering the server-side search tools when the prompt asks for them.
const FAST_EFFORT = 'low';
const WEB_NUM_RESULTS = 10;
const X_LIMIT = 5;
const REQUEST_TIMEOUT_MS = 3 * 60 * 1000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000;
const MIN_IMAGE_BYTES = 500;
const MAX_PROMPT_LEN = 4000;

function _extractOutputText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  if (!Array.isArray(data?.output)) return null;

  const texts = [];
  for (const item of data.output) {
    if (typeof item?.text === 'string' && item.text.trim()) {
      texts.push(item.text.trim());
      continue;
    }
    if (Array.isArray(item?.content)) {
      for (const part of item.content) {
        if (typeof part?.text === 'string' && part.text.trim()) {
          texts.push(part.text.trim());
        } else if (typeof part?.text?.value === 'string' && part.text.value.trim()) {
          texts.push(part.text.value.trim());
        }
      }
    }
  }
  return texts.length > 0 ? texts.join('\n\n').trim() : null;
}

// Heuristics to tell an "image" citation apart from a regular web source.
// xAI tags embedded images with title "img-N" and the URLs
// usually carry an image extension.
const _IMG_TITLE_RE = /^img-?\d+$/i;
const _IMG_URL_RE = /\.(?:png|jpe?g|webp|gif|bmp|svg)(?:[?#].*)?$/i;

function _looksLikeImageCitation(ann) {
  if (!ann) return false;
  if (typeof ann.title === 'string' && _IMG_TITLE_RE.test(ann.title.trim())) return true;
  const url = ann.url || ann.uri;
  return typeof url === 'string' && _IMG_URL_RE.test(url);
}

/**
 * Collect deduplicated citation URLs for the "Sources" block of the report.
 * Image citations (img-N / image-extension URLs) are excluded - they are
 * delivered as attachments, not listed as textual sources.
 */
function _extractCitations(data) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    if (raw && typeof raw === 'object' && _looksLikeImageCitation(raw)) return;
    const url = typeof raw === 'string' ? raw : raw?.url || raw?.uri;
    if (typeof url !== 'string') return;
    if (_IMG_URL_RE.test(url)) return;
    const key = url.trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(key);
  };

  if (Array.isArray(data?.citations)) data.citations.forEach(push);
  if (Array.isArray(data?.output)) {
    for (const item of data.output) {
      if (Array.isArray(item?.citations)) item.citations.forEach(push);
      if (Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (Array.isArray(part?.annotations)) {
            for (const ann of part.annotations) push(ann);
          }
          if (Array.isArray(part?.citations)) part.citations.forEach(push);
        }
      }
    }
  }
  return out;
}

/**
 * Compute the number of web results and X posts a research run gathered.
 *
 * Fast gear (single model): every tool call the model made is visible in
 * `output[]` (no encrypted sub-agents), so this is EXACT - we sum the real
 * `action.sources` of each web_search_call plus the requested `limit` of each
 * X search call.
 *
 * Team gear (multi-agent): sub-agent calls are encrypted by Hermes, so only
 * the orchestrator's calls are visible. We scale the visible per-call average
 * across the encrypted calls (derived from usage details) to approximate the
 * figure xAI's own surface would show. When there are no encrypted calls the
 * formula collapses to the exact visible count, so a single code path serves
 * both gears.
 */
function _computeResultCounts(data) {
  let visibleWebCalls = 0;
  let visibleWebResults = 0;
  let visibleXCalls = 0;
  let visibleXResults = 0;

  const xLimitFromInput = (raw) => {
    if (typeof raw !== 'string') return X_LIMIT;
    try {
      const obj = JSON.parse(raw);
      const n = Number(obj?.limit);
      return Number.isFinite(n) && n > 0 ? n : X_LIMIT;
    } catch { return X_LIMIT; }
  };

  if (Array.isArray(data?.output)) {
    for (const item of data.output) {
      if (!item) continue;

      if (item.type === 'web_search_call' && item.action) {
        visibleWebCalls++;
        if (item.action.type === 'search' && Array.isArray(item.action.sources)) {
          visibleWebResults += item.action.sources.length;
        } else if (item.action.type === 'open_page' && item.action.url) {
          visibleWebResults += 1;
        }
      }

      // X search appears either as a Responses-native `x_search_call` or as a
      // `custom_tool_call` named x_keyword_search / x_semantic_search / etc.
      const isXCustom = item.type === 'custom_tool_call' && /^x_/i.test(item.name || '');
      const isXNative = item.type === 'x_search_call';
      if (isXCustom || isXNative) {
        visibleXCalls++;
        visibleXResults += xLimitFromInput(item.input);
      }
    }
  }

  const details = data?.usage?.server_side_tool_usage_details || {};
  const totalWebCalls = Math.max(Number(details.web_search_calls) || 0, visibleWebCalls);
  const totalXCalls = Math.max(Number(details.x_search_calls) || 0, visibleXCalls);

  const avgWebPerCall = visibleWebCalls > 0 ? visibleWebResults / visibleWebCalls : WEB_NUM_RESULTS;
  const avgXPerCall = visibleXCalls > 0 ? visibleXResults / visibleXCalls : X_LIMIT;

  const encryptedWebCalls = Math.max(0, totalWebCalls - visibleWebCalls);
  const encryptedXCalls = Math.max(0, totalXCalls - visibleXCalls);

  const webSources = visibleWebResults + Math.round(avgWebPerCall * encryptedWebCalls);
  const xPosts = visibleXResults + Math.round(avgXPerCall * encryptedXCalls);

  return { webSources, xPosts };
}

/**
 * Download an image URL into a Buffer with size/type guards. Returns null on
 * any failure (caller skips the image rather than aborting the whole report).
 */
async function _downloadImage(url) {
  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        'Accept': 'image/*,*/*;q=0.8',
      },
    }, IMAGE_DOWNLOAD_TIMEOUT_MS);
    if (!res.ok) return null;
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!mime.startsWith('image/')) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < MIN_IMAGE_BYTES) return null;
    if (buffer.length > MAX_IMAGE_BYTES) return null;
    return { buffer, mime };
  } catch (err) {
    log.debug(`   image download failed (${url.slice(0, 80)}): ${err.message}`);
    return null;
  }
}

function _extFromMime(mime) {
  if (!mime) return 'jpg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('bmp')) return 'bmp';
  return 'jpg';
}

const _MD_IMAGE_RE = /!\[([^\]]*)\]\(\s*(https?:\/\/[^\s)]+)\s*\)/g;

/**
 * Extract Markdown image embeds from the report text, download up to
 * `maxImages`, and rewrite the text so the brain never sees raw image URLs:
 *   - successfully downloaded -> replaced with "[📎 Immagine N: alt]"
 *   - failed download or over the cap -> embed removed entirely (no broken ref)
 *
 * Returns { text, images: [{ name, buffer, mimetype, alt, sourceUrl }] }.
 * The placeholder order matches the attachment order exactly, so the brain
 * can refer to "la prima immagine / l'immagine 2" with confidence.
 */
async function _extractAndStripImages(text, maxImages) {
  if (typeof text !== 'string' || !text.includes('![')) {
    return { text: text || '', images: [] };
  }

  const matches = [];
  let m;
  _MD_IMAGE_RE.lastIndex = 0;
  while ((m = _MD_IMAGE_RE.exec(text)) !== null) {
    matches.push({ full: m[0], alt: (m[1] || '').trim(), url: m[2].trim() });
  }
  if (matches.length === 0) return { text, images: [] };

  // Deduplicate by URL while preserving order.
  const seen = new Set();
  const unique = [];
  for (const item of matches) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    unique.push(item);
  }

  const images = [];
  const urlToPlaceholder = new Map(); // url -> replacement string (or '' to drop)

  for (const item of unique) {
    if (images.length >= maxImages) {
      urlToPlaceholder.set(item.url, '');
      continue;
    }
    const dl = await _downloadImage(item.url);
    if (!dl) {
      urlToPlaceholder.set(item.url, '');
      continue;
    }
    const idx = images.length + 1;
    const ext = _extFromMime(dl.mime);
    const altSlug = (item.alt || 'image')
      .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'image';
    images.push({
      name: `research_${idx}_${altSlug}.${ext}`,
      buffer: dl.buffer,
      mimetype: dl.mime,
      alt: item.alt,
      sourceUrl: item.url,
    });
    const label = item.alt ? `[📎 Immagine ${idx}: ${item.alt}]` : `[📎 Immagine ${idx}]`;
    urlToPlaceholder.set(item.url, label);
  }

  // Replace every embed occurrence (including duplicates) with its mapping.
  let outText = text.replace(_MD_IMAGE_RE, (full, alt, url) => {
    const cleanUrl = url.trim();
    const repl = urlToPlaceholder.get(cleanUrl);
    return repl === undefined ? '' : repl;
  });
  // Collapse blank lines left behind by removed embeds.
  outText = outText.replace(/\n{3,}/g, '\n\n').trim();

  return { text: outText, images };
}

function _buildResearchTools(searchImages) {
  // Image understanding is enabled on BOTH tools for completeness: xAI exposes
  // a single server-side `view_image` tool shared by web and X, so there is no
  // duplication. Video understanding is X-only (web_search does not support it).
  const webSearch = {
    type: 'web_search',
    num_results: WEB_NUM_RESULTS,
    enable_image_understanding: true,
  };
  if (searchImages) {
    // Only surfaced when the caller explicitly wants images. Off by default so
    // internal/factual lookups (e.g. code docs) never drag in stray imagery.
    webSearch.enable_image_search = true;
  }
  const xSearch = {
    type: 'x_search',
    limit: X_LIMIT,
    enable_image_understanding: true,
    enable_video_understanding: true,
  };
  return [webSearch, xSearch];
}

async function _callResearch(prompt, { fullTeam, searchImages }) {
  const model = fullTeam ? MULTI_AGENT_MODEL : FAST_RESEARCH_MODEL;
  const effort = fullTeam ? TEAM_EFFORT : FAST_EFFORT;

  // System prompt for the research model, passed via `instructions` - same
  // channel and shape as the main brain (ai/systemPrompt.js) and the build
  // sub-agent (buildAgent). No outer <SystemPrompt> envelope: the instructions
  // field IS the system channel, so the structured sub-tags sit flush.
  //
  // The <OutputRules> tell the model to answer in plain prose, not XML, so the
  // report stays clean for GemiX to rephrase. The image clause is added ONLY
  // when images are wanted - when off we say nothing about images, so the
  // model still freely uses its image-understanding (view_image) while
  // browsing without being told to avoid images it never had a tool for.
  //
  // When images ARE wanted the clause is phrased as an explicit DIRECTIVE
  // (not a passive "you may include images"): the caller turned the flag on,
  // so the model must actively run web image search and surface the relevant
  // results. Otherwise the model tends to treat image embedding as optional
  // and silently skips it, ignoring the flag.
  const outputRules = searchImages
    ? `Reply in clear, natural prose (Markdown allowed). Do NOT wrap your answer in XML tags. IMAGES REQUESTED: the caller explicitly wants images, so you MUST actively use web image search to find images relevant to the topic and embed the most relevant ones inline as Markdown ![alt](url) where they help the reader. Include up to ${MAX_RESEARCH_IMAGES} (never more); only omit images if the topic has genuinely no visual dimension at all.`
    : 'Reply in clear, natural prose (Markdown allowed). Do NOT wrap your answer in XML tags.';

  const teamLabel = fullTeam ? 'the GemiX research team (multi-agent)' : 'GemiX fast research';
  const instructions = [
    '<Identity>',
    `  You are ${teamLabel}, the research arm of GemiX. Run web_search and x_search to gather and synthesize evidence, then report back to GemiX.`,
    `  Current date and time (Europe/Rome): ${getRomeTime()}.`,
    '</Identity>',
    `<OutputRules>${outputRules}</OutputRules>`,
  ].join('\n');

  const content = `<ResearchBrief>${prompt}</ResearchBrief>`;

  const body = {
    model,
    instructions,
    // max_turns bounds the server-side tool-call turns and guarantees a final
    // synthesized answer even if the budget is hit mid-research (xAI forces a
    // tool-less synthesis at the limit - no round counter exposed to the model,
    // same spirit as the main brain / build wrap-up).
    max_turns: RESEARCH_MAX_TURNS,
    input: [{ role: 'user', content }],
    tools: _buildResearchTools(searchImages),
  };

  // reasoning.effort is only supported by multi-agent and grok-4.3 models.
  // The fast reasoning model (grok-4.20-non-reasoning-latest) rejects the param
  // entirely with HTTP 400 - omit it for that gear.
  if (fullTeam) {
    body.reasoning = { effort };
  }

  logApiRequest(model, RESPONSES_URL, body);
  log.info(`   research call -> ${model} (${fullTeam ? 'team' : 'fast'}, images=${searchImages}, input: ${content.length} chars)`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startTime = Date.now();

  try {
    const res = await fetch(RESPONSES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${HERMES_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      const short = errBody.startsWith('<!') ? 'Cloudflare error' : errBody.substring(0, 500);
      throw new Error(`HTTP ${res.status}: ${short}`);
    }

    const data = await res.json();
    try { logApiResponse(model, RESPONSES_URL, data); } catch { /* best effort */ }
    log.info(`   research reply in ${Date.now() - startTime}ms`);
    return data;

  } catch (err) {
    const isTimeout = err.name === 'AbortError';
    const msg = isTimeout ? `Timeout (${REQUEST_TIMEOUT_MS / 1000}s)` : err.message;
    log.error(`   research error: ${msg}`);
    await notifyAdmin(`WebXSearch (${fullTeam ? 'team' : 'fast'})`, `Error: ${msg}`);
    throw new Error(`Research unavailable: ${msg}${ADMIN_NOTIFIED_SUFFIX}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a research brief.
 *
 * @param {string} prompt
 * @param {object} [options]
 * @param {boolean} [options.fullTeam=false] - true -> multi-agent team, false -> fast model.
 * @param {boolean} [options.searchImages=false] - true -> enable web image search + extraction.
 * @param {number}  [options.maxImages] - cap on images extracted (default MAX_RESEARCH_IMAGES).
 * @returns {Promise<{
 *   success: boolean,
 *   message?: string,
 *   error?: string,
 *   _stats?: {webSources: number, xPosts: number},
 *   _images?: Array<{name:string, buffer:Buffer, mimetype:string, alt:string, sourceUrl:string}>,
 * }>}
 */
async function webXSearch(prompt, options = {}) {
  const fullTeam = options.fullTeam === true;
  const searchImages = options.searchImages === true;
  const maxImages = Number.isFinite(options.maxImages) ? options.maxImages : MAX_RESEARCH_IMAGES;

  if (typeof prompt !== 'string' || !prompt.trim()) {
    return {
      success: false,
      error: 'Missing "prompt": describe what to research, including any specific URLs or domains to inspect.',
    };
  }

  let cleanPrompt = prompt
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();

  if (cleanPrompt.length < 5) {
    return { success: false, error: 'Prompt too short: provide a clear and specific research request.' };
  }

  let truncated = false;
  if (cleanPrompt.length > MAX_PROMPT_LEN) {
    cleanPrompt = cleanPrompt.substring(0, MAX_PROMPT_LEN);
    truncated = true;
  }

  if (!HERMES_API_KEY) {
    return { success: false, error: 'HERMES_API_KEY is not configured - research is unavailable.' };
  }
  const requiredModel = fullTeam ? MULTI_AGENT_MODEL : FAST_RESEARCH_MODEL;
  if (!requiredModel) {
    return { success: false, error: `${fullTeam ? 'MULTI_AGENT_MODEL' : 'FAST_RESEARCH_MODEL'} is not configured - research is unavailable.` };
  }

  log.info(`Research (${fullTeam ? 'team' : 'fast'}, ${cleanPrompt.length} chars${truncated ? ', truncated' : ''}${searchImages ? ', images' : ''})`);

  let data;
  try {
    data = await _callResearch(cleanPrompt, { fullTeam, searchImages });
  } catch (err) {
    return { success: false, error: err.message };
  }

  let text = _extractOutputText(data);
  if (!text) {
    return { success: false, error: 'Research returned an empty response. Try again with a more specific prompt.' };
  }

  // Extract + download images (only when requested), stripping raw URLs.
  let images = [];
  if (searchImages) {
    const extracted = await _extractAndStripImages(text, maxImages);
    text = extracted.text;
    images = extracted.images;
    if (images.length > 0) log.info(`   Attached ${images.length} image(s) from research`);
  }

  const citations = _extractCitations(data);
  const { webSources, xPosts } = _computeResultCounts(data);

  // Return a plain JSON object - the same shape every other GemiX tool uses
  // ({ success, message, ...extra }). No XML wrapper: keeps the tool-result
  // format consistent across all our function tools (the dispatcher
  // JSON-stringifies this), so when our tools sit alongside xAI server-side
  // tools (build agent) there is one coherent return convention.
  const out = {
    success: true,
    message: text,
  };
  if (citations.length > 0) out.sources = citations;
  if (truncated) out.truncated_prompt = true;
  if (images.length > 0) {
    out.images_added = images.length;
    out.image_filenames = images.map(im => im.name);
    out.images_note = `${images.length} cited image(s) were added to the delivery buffer, in the order referenced: `
      + `${images.map(im => im.name).join(', ')}. Refer to them naturally; do not paste URLs or Markdown image syntax. `
      + `You may pass any of these filenames as a reference_image to generate_image/generate_video.`;
  }

  return { ...out, _stats: { webSources, xPosts }, _images: images };
}

module.exports = { webXSearch };
