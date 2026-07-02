// src/ai/responsesWithUrlRefresh.js
//
// Shared callResponsesModel wrapper: on xAI "failed to download file from URL"
// errors, refresh tmpfile.link URLs from disk and retry (no admin notify).

const { clearXaiUploadCache } = require('../utils/xaiUpload');
const { refreshXaiUrlsInMessages } = require('../utils/refreshXaiMessageUrls');
const { callResponsesModel } = require('./apiClient');
const { chatMessagesToResponsesInput } = require('./responsesAdapter');
const { createLogger } = require('../utils/logger');

const log = createLogger('AI');
const MAX_STALE_URL_REFRESHES = 2;

/**
 * @param {object} opts
 * @param {string} opts.modelName
 * @param {Array|null} opts.messages - When set, body.input/instructions are rebuilt each attempt.
 * @param {object} opts.body - Responses API body (mutated when messages provided).
 * @param {object} [opts.logExtra]
 * @param {number} [opts.timeoutMs]
 * @param {string|null} [opts.historyStorageId] - History path fallback for refresh.
 * @param {boolean} [opts.allowStaleUrlRefresh] - Refresh via _xaiSourcePath only (build agent).
 */
async function callResponsesWithStaleUrlRetry(opts) {
  const {
    modelName,
    messages,
    body,
    logExtra = {},
    timeoutMs,
    historyStorageId = null,
    allowStaleUrlRefresh = false,
  } = opts;

  const canRefresh = allowStaleUrlRefresh || Boolean(historyStorageId);
  let staleRefreshCount = 0;

  for (;;) {
    if (Array.isArray(messages)) {
      const { instructions, input } = chatMessagesToResponsesInput(messages);
      body.input = input;
      if (instructions && instructions.length > 0) {
        body.instructions = instructions;
      } else {
        delete body.instructions;
      }
    }

    try {
      return await callResponsesModel(modelName, body, {
        ...logExtra,
        deferStaleFileUrlError: canRefresh && staleRefreshCount < MAX_STALE_URL_REFRESHES,
        timeoutMs,
      });
    } catch (err) {
      if (err.code !== 'XAI_STALE_FILE_URL' || !canRefresh || !Array.isArray(messages)) {
        throw err;
      }
      if (staleRefreshCount >= MAX_STALE_URL_REFRESHES) {
        throw err;
      }
      staleRefreshCount += 1;
      clearXaiUploadCache();
      const refreshed = await refreshXaiUrlsInMessages(messages, historyStorageId);
      if (refreshed > 0) {
        log.info(`Stale xAI file URL(s) refreshed (${refreshed}), retrying ${modelName}...`);
        continue;
      }
      throw err;
    }
  }
}

module.exports = { callResponsesWithStaleUrlRetry, MAX_STALE_URL_REFRESHES };
