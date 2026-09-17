import assert from 'node:assert/strict';
import test from 'node:test';

import { _sendDiscordLinkFallback } from '../src/platforms/discord/client.js';
import { _deliverWhatsAppFallback, sendWhatsAppResponse } from '../src/platforms/whatsapp/shared.js';
import { sendWhatsAppDirect, setDedicatedClient } from '../src/tools/whatsappSender.js';
import { setReadyDedicatedClient } from '../src/platforms/whatsapp/dedicatedClientRegistry.js';

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

const MEMOIZE_ERROR = 'Data passed to getter must include an id property (it\'s how we memoize) but got undefined';

function groupChatStub(onSend) {
  return {
    isGroup: true,
    id: { _serialized: '12345@g.us' },
    async sendMessage(text, options) {
      await onSend(text, options);
    }
  };
}

test('a WhatsApp reply with an unresolvable mention is retried as plain text instead of going silent', async () => {
  const calls = [];
  const chat = groupChatStub(async (text, options) => {
    calls.push({ text, options });
    if (options?.mentions?.length > 0) throw new Error(MEMOIZE_ERROR);
  });
  const receipt = await sendWhatsAppResponse(chat, { text: 'ciao @393331234567 come va?' }, {});
  assert.equal(receipt.status, 'complete');
  assert.equal(receipt.textAccepted, true);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].options?.mentions?.length > 0);
  assert.ok(!calls[1].options?.mentions);
});

test('a WhatsApp reply that fails even without mentions still reports the text failure', async () => {
  const chat = groupChatStub(async () => { throw new Error(MEMOIZE_ERROR); });
  const receipt = await sendWhatsAppResponse(chat, { text: 'ciao @393331234567 come va?' }, {});
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.textAccepted, false);
  assert.equal(receipt.failures.length, 1);
});

test('a direct group send with an unresolvable mention is retried as plain text', async () => {
  const calls = [];
  setDedicatedClient({
    async sendMessage(chatId, message, options) {
      calls.push({ chatId, message, options });
      if (options?.mentions?.length > 0) throw new Error(MEMOIZE_ERROR);
    }
  });
  try {
    await sendWhatsAppDirect('12345@g.us', 'ciao @393331234567 come va?');
  } finally {
    setReadyDedicatedClient(null);
  }
  assert.equal(calls.length, 2);
  assert.ok(calls[0].options?.mentions?.length > 0);
  assert.ok(!calls[1].options?.mentions);
});
