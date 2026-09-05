import assert from 'node:assert/strict';
import test from 'node:test';

import { _sendDiscordLinkFallback } from '../src/platforms/discord/client.js';
import { _deliverWhatsAppFallback, sendWhatsAppResponse } from '../src/platforms/whatsapp/shared.js';

const attachment = { name: 'report.pdf' };
const fallbackResult = {
  fallbackMessage: 'download here',
  fallbackAttachments: [attachment],
  fallbackFailures: [],
  linkFallback: [attachment]
};

test('WhatsApp fallback failure remains visible in the delivery receipt inputs', async () => {
  const result = await _deliverWhatsAppFallback(fallbackResult, async () => {
    throw new Error('page detached');
  });
  assert.equal(result.linked, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error, /page detached/);
});

test('a WhatsApp response that becomes empty after sanitization is rejected before delivery', async () => {
  let sends = 0;
  await assert.rejects(
    sendWhatsAppResponse({
      isGroup: false,
      async sendMessage() { sends++; }
    }, { text: '[Attachment (expired): attachments/missing.pdf]', attachments: [] }),
    /vuota/
  );
  assert.equal(sends, 0);
});

test('Discord fallback failure remains visible instead of being swallowed', async () => {
  const result = await _sendDiscordLinkFallback(
    { send: async () => { throw new Error('channel unavailable'); } },
    [attachment],
    () => ({
      message: 'download here',
      fallbackAttachments: [attachment],
      failedAttachments: []
    })
  );
  assert.equal(result.linked, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error, /channel unavailable/);
});
