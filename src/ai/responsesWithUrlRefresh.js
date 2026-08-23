// src/ai/responsesWithUrlRefresh.js
//
// PHASE 4 BRIDGE. Retries one model call after re-uploading the tmpfile.link
// URLs a provider refused to fetch.
//
// It sits above the transport, not inside it: rebuilding a public URL for a
// file GemiX still holds on disk is an attachment-layer concern, and the
// transport must stay free of it. Phase 4 removes tmpfile.link from the model
// path entirely (spec §8.6) and this file goes with it.

import { clearXaiUploadCache } from '../utils/xaiUpload.js';
import { isXaiFileDownloadError, refreshXaiUrlsInMessages } from '../utils/refreshXaiMessageUrls.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('AI');
const MAX_STALE_URL_REFRESHES = 2;

/**
 * @param {object} opts
 * @param {Array} opts.messages - rebuilt into a body on every attempt
 * @param {(messages: Array) => object} opts.buildBody
 * @param {(body: object) => Promise<object>} opts.call
 * @param {string|null} [opts.historyStorageId] - history path used to re-upload
 * @returns {Promise<object>} whatever `call` resolved with
 */
async function callWithStaleUrlRetry({ messages, buildBody, call, historyStorageId = null }) {
  const canRefresh = Boolean(historyStorageId) && Array.isArray(messages);
  let refreshCount = 0;

  for (;;) {
    try {
      return await call(buildBody(messages));
    } catch (err) {
      if (!canRefresh || refreshCount >= MAX_STALE_URL_REFRESHES || !isXaiFileDownloadError(err.message)) {
        throw err;
      }
      refreshCount += 1;
      clearXaiUploadCache();
      const refreshed = await refreshXaiUrlsInMessages(messages, historyStorageId);
      if (refreshed === 0) throw err;
      log.info(`Stale file URL(s) refreshed (${refreshed}), retrying the model call...`);
    }
  }
}

export { callWithStaleUrlRetry };
