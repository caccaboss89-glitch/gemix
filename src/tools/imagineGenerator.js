// src/tools/imagineGenerator.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are returned as plain objects so the dispatcher
// serializes a fixed JSON `{ success, message?, error?, ... }` envelope.
//
// `generate_image` is the one tool with two backends behind it:
// Grok Imagine where the profile has it, Cloudflare FLUX otherwise and as the
// fallback. The routing and the fallback rules live in media/imageBackends.js;
// this module validates the advertised tool contract, routes the request,
// reserves quota and stages the result. Direct xAI submit/poll/download handling
// is isolated in media/xaiImagineClient.js.

import path from 'path';
import envConfig from '../config/env.js';
import constants from '../config/constants.js';
import { resolveLocalFileEntry  } from '../utils/deliverySelection.js';
import { readAgentFileBuffer } from '../sandbox/hostFileGateway.js';
import { resolveWorkspaceId  } from '../utils/workspaceId.js';
import { stageToolOutput  } from './workspace/toolOutput.js';
import { INLINE_IMAGE_EXTS, inlineImagePartFromBuffer  } from './workspace/inlineImage.js';
import {
  BACKEND,
  FLUX_MAX_REFERENCES,
  FLUX_SIZES,
  canUseImageFallback,
  declaredImageBackend,
  failurePlan,
  fluxSizeForAspectRatio,
  generateWithFlux,
  resolveImageBackends,
  startCooldown
} from '../media/imageBackends.js';
import {
  classifyXaiFailure,
  generateXaiImage,
  generateXaiVideo
} from '../media/xaiImagineClient.js';
import { sanitizeFilename  } from '../utils/text.js';
import { createLogger  } from '../utils/logger.js';
import { mimeForExtension  } from '../config/mimeExtensions.js';
import { reserveGeneration  } from '../utils/mediaUsageLimits.js';

const log = createLogger('ImagineGenerator');

// -- Limits -----------------------------------------------------------------

const ALLOWED_IMAGE_ASPECT_RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4']);
const ALLOWED_VIDEO_ASPECT_RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']);

// Image generation accepts up to 3 references under the native backend's
// documented limit. The 7-reference video cap is deployment policy; both are
// checked before provider I/O and live in constants.js because the schemas
// advertise them too.
const { MAX_REF_IMAGES_FOR_IMAGE, MAX_REF_IMAGES_FOR_VIDEO } = constants;

// -- Helpers -----------------------------------------------------------------

/**
 * Sanitize the prompt: strip control chars, collapse whitespace, trim, cap length.
 */
function _cleanPrompt(prompt) {
  if (typeof prompt !== 'string') return { prompt: '', truncated: false };
  let p = prompt

    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  let truncated = false;
  if (p.length > constants.MEDIA_GENERATION_PROMPT_MAX_CHARS) {
    p = p.substring(0, constants.MEDIA_GENERATION_PROMPT_MAX_CHARS);
    truncated = true;
  }
  return { prompt: p, truncated };
}

/**
 * Read one local reference image off disk, with the type and size checks that
 * make a bad reference cost no round trip.
 *
 * @returns {{ ok: true, buffer: Buffer, name: string, mime: string }|{ ok: false, reason: string }}
 */
function _openReferenceImage(entry, workspaceId) {
  const found = resolveLocalFileEntry(entry, workspaceId);
  if (!found) {
    return { ok: false, reason: `Reference image "${entry}" does not exist. Pass the path exactly as you saw it.` };
  }
  const ext = path.extname(found.name).toLowerCase();
  if (!INLINE_IMAGE_EXTS.has(ext)) {
    return {
      ok: false,
      reason: `Reference "${entry}" is not a supported image type (allowed: ${[...INLINE_IMAGE_EXTS].join(', ')}).`
    };
  }
  let opened;
  try {
    opened = readAgentFileBuffer(workspaceId, found.display, constants.MAX_IMAGE_BYTES);
  } catch (err) {
    if (err?.code === 'EFILETOOLARGE') {
      return { ok: false, reason: `Reference "${entry}" exceeds the ${Math.round(constants.MAX_IMAGE_BYTES / 1024 / 1024)} MB limit.` };
    }
    return { ok: false, reason: `Cannot read reference "${entry}": ${err.message}` };
  }
  if (!opened) return { ok: false, reason: `Cannot safely read reference "${entry}".` };
  if (opened.buffer.length === 0) return { ok: false, reason: `Reference "${entry}" is empty.` };
  return { ok: true, buffer: opened.buffer, name: found.name, mime: mimeForExtension(ext, 'image/png') };
}

/**
 * Resolve reference-image entries into the shape one backend accepts.
 *
 * The caller supplies the cap advertised for its backend. A local file is read
 * off disk either way: as an inline base64 data URL, which keeps a user file
 * off any third-party host on the way to the provider, or as raw bytes for a
 * backend that uploads them itself.
 *
 * A public URL only travels where the backend takes one. Fetching it here to
 * re-upload it would be a different decision from the one the model made.
 *
 * @param {string[]} refList
 * @param {{ max: number, shape: 'data-url'|'bytes', allowUrls: boolean }} opts
 * @param {string} workspaceId
 * @returns {{ ok: true, items: Array }|{ ok: false, reason: string }}
 */
function _resolveReferenceImages(refList, { max, shape, allowUrls }, workspaceId) {
  if (refList.length > max) {
    return { ok: false, reason: `Too many reference images (${refList.length}). Max allowed: ${max}.` };
  }
  const items = [];
  for (const raw of refList) {
    const entry = typeof raw === 'string' ? raw.trim() : '';
    if (!entry) {
      return { ok: false, reason: 'Each reference image must be a workspace/attachments path or a public https URL.' };
    }
    if (/^https?:\/\//i.test(entry)) {
      if (!allowUrls) {
        return { ok: false, reason: 'This backend takes reference images from this chat, not from a URL. '
          + 'Download it into the workspace with shell first, then pass that path.' };
      }
      items.push(entry);
      continue;
    }
    const opened = _openReferenceImage(entry, workspaceId);
    if (!opened.ok) return opened;
    items.push(shape === 'data-url'
      ? `data:${opened.mime};base64,${opened.buffer.toString('base64')}`
      : { buffer: opened.buffer, name: opened.name, mime: opened.mime });
  }
  return { ok: true, items };
}

/** Land the generated bytes in the workspace under a name taken from the prompt. */
async function _stageGeneratedMedia(workspaceId, prompt, buffer, ext, fallbackBase) {
  const baseName = sanitizeFilename(prompt.slice(0, 30), 30) || fallbackBase;
  return stageToolOutput(workspaceId, `${baseName}_${Date.now()}.${ext}`, buffer);
}

// -- generate_image ----------------------------------------------------------

/**
 * @param {object} args
 * @param {string} args.prompt
 * @param {string[]} [args.reference_images] - namespace paths or public https URLs (max 3).
 * @param {string} [args.aspect_ratio] - pure text-to-image only (edits respect the input image).
 * @param {object} userCtx
 * @returns {Promise<object|Array>} the `{ success, message?, path?, error? }` envelope,
 *   or — when the generated image is put in front of the model —
 *   `[input_text(envelope JSON), input_image]`, the multipart tool result the
 *   dispatcher forwards as it is.
 */
async function generateImage(args, userCtx) {
  const { prompt, truncated } = _cleanPrompt(args && args.prompt);
  if (!prompt || prompt.length < 3) {
    return { success: false, error: 'Missing or too short "prompt": describe the image to generate.' };
  }

  const workspaceId = resolveWorkspaceId(userCtx);
  if (!workspaceId) {
    return { success: false, error: 'Could not resolve the workspace for this context.' };
  }

  // Cooldowns may change which backend runs, but never which schema and
  // semantics the model was offered for this turn.
  const contractBackend = declaredImageBackend();
  if (!contractBackend) {
    return { success: false, error: 'No image generation backend is available on this deployment.' };
  }
  if (contractBackend === BACKEND.XAI && !envConfig.IMAGE_GEN_MODEL) {
    return { success: false, error: 'envConfig.IMAGE_GEN_MODEL is not configured.' };
  }

  const { primary, fallback } = resolveImageBackends();
  if (!primary) {
    return { success: false, error: 'No image generation backend is available on this deployment.' };
  }

  const refList = Array.isArray(args && args.reference_images) ? args.reference_images : [];
  const signal = userCtx?.turnBudget?.signal;

  // Validate against the advertised contract, not the currently selected
  // backend: a cooldown must not reinterpret xAI arguments as FLUX arguments.
  const aspect = (args && typeof args.aspect_ratio === 'string' && args.aspect_ratio.trim())
    ? args.aspect_ratio.trim()
    : null;
  const size = args && typeof args.size === 'string' ? args.size.trim() : '';
  if (contractBackend === BACKEND.XAI && refList.length === 0 && aspect !== null
      && !ALLOWED_IMAGE_ASPECT_RATIOS.has(aspect)) {
    return {
      success: false,
      error: `Invalid aspect_ratio "${aspect}". Allowed: ${[...ALLOWED_IMAGE_ASPECT_RATIOS].join(', ')}.`
    };
  }
  if (contractBackend === BACKEND.CLOUDFLARE && size && !FLUX_SIZES[size.toLowerCase()]) {
    return {
      success: false,
      error: `Invalid size "${size}". Allowed: ${Object.keys(FLUX_SIZES).join(', ')}.`
    };
  }

  log.info(`generate_image: backends=${[primary, fallback].filter(Boolean).join(' -> ')}, `
    + `refs=${refList.length}, prompt="${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`);

  // Daily per-user quota (admins exempt). Reserve the slot before the network
  // call so parallel calls in one round cannot exceed the cap; refund on failure.
  const quota = await reserveGeneration('image', userCtx);
  if (!quota.ok) return { success: false, error: quota.error };

  try {
    const attempt = await _runImageChain({
      primary,
      fallback,
      contractBackend,
      prompt,
      refList,
      aspect,
      size,
      workspaceId,
      signal
    });
    if (!attempt.ok) {
      return { success: false, error: `Image generation failed: ${attempt.error}` };
    }

    let staged;
    try {
      staged = await _stageGeneratedMedia(workspaceId, prompt, attempt.buffer, attempt.ext, 'image');
    } catch (err) {
      return { success: false, error: `Cannot save the generated image: ${err.message}` };
    }
    const visionPart = inlineImagePartFromBuffer(attempt.buffer, mimeForExtension(`.${attempt.ext}`, 'image/png'));

    const truncNote = truncated ? ' (prompt was truncated)' : '';
    const refNote = attempt.refCount > 0 ? ` Used ${attempt.refCount} reference image(s).` : '';
    const backendNote = attempt.backend !== contractBackend
      ? ` The usual backend was unavailable, so this came from ${attempt.backend}.`
      : '';
    quota.commit();
    const payload = {
      success: true,
      path: staged.display,
      message: `Image generated successfully and saved as "${staged.display}".${refNote} `
        + `Pass that path to send it, or as a reference image in generate_image or generate_video.${truncNote}`
        + backendNote
        + (visionPart ? ' Attached below so you can see it.' : '')
    };
    return visionPart ? [{ type: 'input_text', text: JSON.stringify(payload) }, visionPart] : payload;
  } finally {
    await quota.release();
  }
}

/** Resolve references and delegate one image attempt to the native media client. */
async function _attemptXaiImage({ prompt, refList, aspect, workspaceId, signal }) {
  const refs = _resolveReferenceImages(
    refList,
    { max: MAX_REF_IMAGES_FOR_IMAGE, shape: 'data-url', allowUrls: true },
    workspaceId
  );
  if (!refs.ok) return { ok: false, error: refs.reason, code: classifyXaiFailure(refs.reason) };

  const result = await generateXaiImage({
    model: envConfig.IMAGE_GEN_MODEL,
    prompt,
    referenceImages: refs.items,
    aspectRatio: aspect,
    signal
  });
  return result.ok ? { ...result, refCount: refs.items.length } : result;
}

/** One attempt on Cloudflare FLUX, with references read off disk as bytes. */
async function _attemptFluxImage({ prompt, refList, size, workspaceId, signal }) {
  const refs = _resolveReferenceImages(
    refList,
    { max: FLUX_MAX_REFERENCES, shape: 'bytes', allowUrls: false },
    workspaceId
  );
  if (!refs.ok) return { ok: false, error: refs.reason, code: 'MALFORMED' };

  const result = await generateWithFlux({ prompt, size, references: refs.items, signal });
  if (!result.ok) return { ok: false, error: result.error, code: result.code };
  return { ok: true, buffer: result.buffer, ext: result.ext, refCount: refs.items.length };
}

/**
 * Try the primary, then the fallback, under the fallback policy. Never more than
 * one retry per backend and never a third backend, so this always terminates.
 */
async function _runImageChain({
  primary,
  fallback,
  contractBackend = primary,
  prompt,
  refList,
  aspect,
  size,
  workspaceId,
  signal,
  attemptBackend
}) {
  const fluxSize = contractBackend === BACKEND.XAI ? fluxSizeForAspectRatio(aspect) : size;
  const run = typeof attemptBackend === 'function'
    ? (backend) => attemptBackend(backend, { prompt, refList, aspect, size: fluxSize, workspaceId, signal })
    : (backend) => (backend === BACKEND.XAI
      ? _attemptXaiImage({ prompt, refList, aspect, workspaceId, signal })
      : _attemptFluxImage({ prompt, refList, size: fluxSize, workspaceId, signal }));

  const incompatibleFallback = 'Cloudflare FLUX was not attempted because it cannot preserve '
    + 'xAI reference-image editing or composition semantics.';
  if (!canUseImageFallback(contractBackend, primary, refList.length)) {
    return {
      ok: false,
      code: 'UNAVAILABLE',
      error: `The xAI backend required for this reference-image request is temporarily unavailable. ${incompatibleFallback}`
    };
  }

  let attempt = await run(primary);
  if (attempt.ok) return { ...attempt, backend: primary };
  if (signal?.aborted) return attempt;

  let plan = failurePlan(attempt.code);
  if (plan.cooldown) startCooldown(primary);

  if (plan.retryPrimary) {
    log.info(`   ${primary} failed (${attempt.code}); one more attempt before falling back`);
    attempt = await run(primary);
    if (attempt.ok) return { ...attempt, backend: primary };
    if (signal?.aborted) return attempt;
    plan = failurePlan(attempt.code);
    if (plan.cooldown) startCooldown(primary);
  }

  if (!plan.fallBack) return attempt;
  if (!fallback) return attempt;
  if (!canUseImageFallback(contractBackend, fallback, refList.length)) {
    return { ...attempt, error: `${attempt.error} ${incompatibleFallback}` };
  }

  log.info(`   ${primary} failed (${attempt.code}); falling back to ${fallback}`);
  const second = await run(fallback);
  if (second.ok) return { ...second, backend: fallback };
  // Both are spent, so the model gets one structured error, not a loop.
  return { ok: false, error: `${attempt.error} Fallback also failed: ${second.error}`, code: second.code };
}

// -- generate_video ----------------------------------------------------------

/**
 * @param {object} args
 * @param {string} args.prompt
 * @param {string[]} [args.reference_images] - namespace paths or public https URLs (max 7).
 * @param {string} [args.aspect_ratio]
 * @param {object} userCtx
 * @returns {Promise<{ success: boolean, message?: string, path?: string, error?: string }>}
 */
async function generateVideo(args, userCtx) {
  if (!envConfig.VIDEO_GEN_MODEL) return { success: false, error: 'envConfig.VIDEO_GEN_MODEL is not configured.' };

  const { prompt, truncated } = _cleanPrompt(args && args.prompt);
  if (!prompt || prompt.length < 3) {
    return { success: false, error: 'Missing or too short "prompt": describe the video to generate.' };
  }

  const workspaceId = resolveWorkspaceId(userCtx);
  if (!workspaceId) {
    return { success: false, error: 'Could not resolve the workspace for this context.' };
  }

  const refList = Array.isArray(args && args.reference_images) ? args.reference_images : [];
  const signal = userCtx?.turnBudget?.signal;

  const aspect = (args && typeof args.aspect_ratio === 'string' && args.aspect_ratio.trim())
    ? args.aspect_ratio.trim()
    : '16:9';
  if (refList.length === 0 && !ALLOWED_VIDEO_ASPECT_RATIOS.has(aspect)) {
    return {
      success: false,
      error: `Invalid aspect_ratio "${aspect}". Allowed: ${[...ALLOWED_VIDEO_ASPECT_RATIOS].join(', ')}.`
    };
  }

  log.info(`generate_video: aspect=${refList.length === 0 ? aspect : 'auto'}, refs=${refList.length}, prompt="${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`);

  // Weekly per-user quota (admins exempt). Reserve the slot before the network
  // call so parallel calls in one round cannot exceed the cap; refund on failure.
  const quota = await reserveGeneration('video', userCtx);
  if (!quota.ok) return { success: false, error: quota.error };

  try {
    const refs = _resolveReferenceImages(
      refList,
      { max: MAX_REF_IMAGES_FOR_VIDEO, shape: 'data-url', allowUrls: true },
      workspaceId
    );
    if (!refs.ok) return { success: false, error: `Video generation failed: ${refs.reason}` };

    const generated = await generateXaiVideo({
      model: envConfig.VIDEO_GEN_MODEL,
      prompt,
      referenceImages: refs.items,
      aspectRatio: aspect,
      duration: constants.VIDEO_GEN_DURATION_S,
      resolution: constants.VIDEO_GEN_RESOLUTION,
      signal
    });
    if (!generated.ok) return { success: false, error: generated.error };

    let staged;
    try {
      staged = await _stageGeneratedMedia(
        workspaceId,
        prompt,
        generated.buffer,
        generated.ext,
        'video'
      );
    } catch (err) {
      return { success: false, error: `Cannot save the generated video: ${err.message}` };
    }

    const truncNote = truncated ? ' (prompt was truncated)' : '';
    const refNote = refs.items.length > 0 ? ` Used ${refs.items.length} reference image(s).` : '';
    quota.commit();
    return {
      success: true,
      path: staged.display,
      message: `Video generated successfully (${constants.VIDEO_GEN_DURATION_S}s, ${constants.VIDEO_GEN_RESOLUTION}) `
        + `and saved as "${staged.display}".${refNote}${truncNote} `
        + 'Open it with read_file to watch it, or pass that path to send it.'
    };
  } finally {
    await quota.release();
  }
}

export {
  _runImageChain,
  generateImage,
  generateVideo
};
