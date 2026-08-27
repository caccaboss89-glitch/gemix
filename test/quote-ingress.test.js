import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_QUOTED_TEXT_CHARS,
  processWhatsAppQuotedReply
} from '../src/utils/quoteIngress.js';

function quotedMessage(id, body, parent = null) {
  return {
    id: { _serialized: id },
    body,
    type: 'chat',
    hasMedia: false,
    hasQuotedMsg: Boolean(parent),
    getMentions: async () => [],
    getQuotedMessage: async () => parent
  };
}

test('a quoted WhatsApp chain shares the caller LID roster and cache at every depth', async () => {
  const oldest = quotedMessage('oldest', '@11111111 oldest');
  const immediate = quotedMessage('immediate', '@11111111 and @22222222 immediate', oldest);
  const current = quotedMessage('current', 'reply', immediate);
  const lidCtx = {
    phones: new Set(['22222222']),
    cache: new Map([
      ['11111111', '393331234567'],
      ['22222222', 'should-not-replace-a-roster-phone']
    ])
  };

  const result = await processWhatsAppQuotedReply(
    current,
    'chat@g.us',
    'chat@g.us',
    new Set(['immediate', 'oldest']),
    true,
    undefined,
    { lidCtx }
  );

  assert.equal((result.prefix.match(/@393331234567/g) || []).length, 2);
  assert.match(result.prefix, /@22222222 immediate/);
  assert.doesNotMatch(result.prefix, /should-not-replace/);
});

test('a long quoted message is capped without truncating the new message', async () => {
  const quoted = quotedMessage('quoted', 'x'.repeat(MAX_QUOTED_TEXT_CHARS + 1200));
  const current = quotedMessage('current', 'the new message remains outside the quote', quoted);

  const result = await processWhatsAppQuotedReply(
    current,
    'chat@c.us',
    'chat@c.us',
    new Set(['quoted'])
  );

  const quotedText = result.prefix.slice('[In reply to: '.length, -2);
  assert.equal(Array.from(quotedText).length, MAX_QUOTED_TEXT_CHARS);
  assert.ok(quotedText.endsWith('…'));
  assert.doesNotMatch(result.prefix, /the new message remains/);
});
