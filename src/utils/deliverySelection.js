// src/utils/deliverySelection.js
//
// Resolve the attachment entries the model selected for delivery (in the
// structured final reply or in a delivery tool's `attachments` parameter)
// into concrete attachment objects.
//
// Only files that exist in the conversation's container ship: namespace paths
// under `workspace/` or `attachments/`, exactly the ones the model reads with
// the file tools. Remote media is not delivered from its URL — it is downloaded
// into `workspace/` first and then sent by path, so every send names a file the
// model has actually seen. A path is resolved as a path and nothing else: there
// is no basename lookup and no delivery buffer to search first.

import path from 'path';
import { uniqueAttachmentName  } from './attachments.js';
import { parseAgentPath  } from '../sandbox/workspacePaths.js';
import { readAgentFileBuffer, statAgentFile } from '../sandbox/hostFileGateway.js';
import { mimeForExtension  } from '../config/mimeExtensions.js';
import { createLogger  } from './logger.js';

const log = createLogger('DeliverySelection');

const MAX_DELIVERY_SELECTION_ITEMS = 10;
const MAX_DELIVERY_SELECTION_BYTES = 200 * 1024 * 1024;

/**
 * Locate a file the model named by its namespace path, under either root.
 *
 * The model only ever names paths it has seen — what a producer tool returned,
 * what `list_files` showed, or an `[Attachment: attachments/x]` tag — so the
 * path is resolved literally. A name that does not resolve is missing, not a
 * cue to go looking for something with the same basename somewhere else.
 *
 * @param {string} entry - `workspace/report.pdf`, `attachments/photo.jpg`, …
 * @param {string} workspaceId
 * @returns {{ root: string, display: string, name: string, size: number }|null}
 */
function resolveLocalFileEntry(entry, workspaceId) {
  if (typeof entry !== 'string' || !entry.trim() || !workspaceId) return null;
  const parsed = parseAgentPath(entry);
  if (!parsed || !parsed.relPath) return null;
  const resolved = statAgentFile(workspaceId, parsed.display);
  if (!resolved) return null;
  return {
    root: resolved.root,
    display: resolved.display,
    name: path.basename(resolved.relPath),
    size: resolved.stat.size
  };
}

/**
 * @param {string[]} entries - Namespace paths.
 * @param {string|null} workspaceId - the conversation whose files may ship.
 * @returns {{ attachments: Array<object>, missing: string[] }}
 */
function resolveDeliverySelection(entries, workspaceId = null) {
  const attachments = [];
  const missing = [];
  if (!Array.isArray(entries) || entries.length === 0) return { attachments, missing };

  const seen = new Set();
  let selectedBytes = 0;
  for (const raw of entries) {
    const entry = String(raw || '').trim();
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    if (seen.size > MAX_DELIVERY_SELECTION_ITEMS) {
      missing.push(entry);
      continue;
    }
    const remainingBytes = Math.max(0, MAX_DELIVERY_SELECTION_BYTES - selectedBytes);

    // A URL is not a file the container holds: it has to be downloaded into
    // workspace/ first and then selected by its path.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(entry)) {
      log.warn(`delivery entry is a URL, not a container path (${entry.slice(0, 100)})`);
      missing.push(entry);
      continue;
    }

    const local = resolveLocalFileEntry(entry, workspaceId);
    if (!local) {
      missing.push(entry);
      continue;
    }
    let opened;
    try { opened = readAgentFileBuffer(workspaceId, local.display, remainingBytes); }
    catch (err) {
      if (err?.code !== 'EFILETOOLARGE') {
        log.warn(`delivery file unreadable (${entry}): ${err.message}`);
      }
      missing.push(entry);
      continue;
    }
    if (!opened) {
      missing.push(entry);
      continue;
    }
    selectedBytes += opened.buffer.length;
    attachments.push({
      name: uniqueAttachmentName(attachments, local.name),
      buffer: opened.buffer,
      mimetype: mimeForExtension(path.extname(local.name))
    });
  }

  return { attachments, missing };
}

export {
  resolveDeliverySelection,
  resolveLocalFileEntry
};
