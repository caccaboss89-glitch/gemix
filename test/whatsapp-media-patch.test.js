import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { patchWhatsAppMediaMessageId } from '../scripts/patch-whatsapp-web.js';

const vulnerableSource = [
  '        const message = {',
  '            id: newMsgKey,',
  '            ...mediaOptions,',
  '        };',
  '',
  '        // Bot\'s won\'t reply if canonicalUrl is set (linking)',
  '        if (botOptions) {',
  '            delete message.canonicalUrl;',
  '        }'
].join('\n');

test('the WhatsApp media-ID patch removes the colliding internal field once', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemix-wa-media-patch-'));
  const filePath = path.join(tempDir, 'Utils.js');
  try {
    fs.writeFileSync(filePath, vulnerableSource, 'utf8');
    assert.deepEqual(patchWhatsAppMediaMessageId(filePath), { changed: true });
    const patched = fs.readFileSync(filePath, 'utf8');
    assert.match(patched, /\};\n\n        \/\/ MediaData may carry an internal ID that must not replace the message key\.\n        delete message\.__x_id;/);
    assert.deepEqual(patchWhatsAppMediaMessageId(filePath), { changed: false });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
