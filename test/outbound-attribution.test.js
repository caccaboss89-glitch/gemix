import assert from 'node:assert/strict';
import test from 'node:test';

import constants from '../src/config/constants.js';
import { ACTIVE_MEMBERS } from '../src/config/members.js';
import {
  OUTBOUND_ATTRIBUTION_PREFIX,
  isSystemMessage
} from '../src/config/systemMessages.js';
import { buildWhatsAppHistory } from '../src/platforms/whatsapp/historyBuilder.js';
import { sendWhatsAppTool } from '../src/tools/sendWhatsApp.js';
import { setDedicatedClient } from '../src/tools/whatsappSender.js';
import {
  buildOutboundAttributionLine,
  getOutboundAttributionName,
  prependOutboundAttribution
} from '../src/utils/outboundAttribution.js';
import {
  buildOutboundAttributionBlock,
  prependHtmlBlock
} from '../src/utils/emailHtml.js';

function useActiveMembers(t, members) {
  const originalMembers = [...ACTIVE_MEMBERS];
  t.after(() => ACTIVE_MEMBERS.splice(0, ACTIVE_MEMBERS.length, ...originalMembers));
  ACTIVE_MEMBERS.splice(0, ACTIVE_MEMBERS.length, ...members);
}

test('program attribution uses the canonical active-member name and is classified as a system message', () => {
  const userCtx = {
    member: { name: 'Requester & One' },
    userName: 'platform alias'
  };
  const line = buildOutboundAttributionLine(userCtx);
  const message = prependOutboundAttribution('Please call at eight.', userCtx);

  assert.equal(getOutboundAttributionName(userCtx), 'Requester & One');
  assert.equal(line, `${OUTBOUND_ATTRIBUTION_PREFIX} Requester & One`);
  assert.equal(message, `${line}\n\nPlease call at eight.`);
  assert.equal(isSystemMessage(message), true);
});

test('WhatsApp history keeps a program-attributed outbound message as a system notification', async () => {
  const messageBody = prependOutboundAttribution('Please call at eight.', {
    member: { name: 'Requester One' },
    userName: 'platform alias'
  });
  const message = {
    id: { _serialized: 'outbound-attribution-test' },
    fromMe: true,
    body: messageBody,
    timestamp: 1790000000,
    hasMedia: false,
    type: 'chat',
    hasQuotedMsg: false
  };
  const chat = { id: { _serialized: 'attribution-test@c.us' }, isGroup: false };
  const history = await buildWhatsAppHistory(
    chat,
    constants.PLATFORM_WA_DEDICATED,
    'attribution-test',
    null,
    { windowMessages: [message], recentMessageIds: new Set([message.id._serialized]) }
  );

  assert.equal(history.length, 1);
  assert.equal(history[0].role, 'user');
  const text = history[0].content[0].text;
  assert.match(text, /^<system-notification>/);
  assert.match(text, /Please call at eight\./);
  assert.match(text, /Requester One/);
});

test('the WhatsApp delivery tool stamps the caller before sending', async t => {
  const caller = {
    name: 'Caller One',
    nicks: [],
    email: 'caller@example.invalid',
    wa: '390000000001@c.us',
    admin: true
  };
  const recipient = {
    name: 'Recipient Two',
    nicks: [],
    email: 'recipient@example.invalid',
    wa: '390000000002@c.us'
  };
  useActiveMembers(t, [caller, recipient]);
  assert.ok(caller.wa);
  assert.ok(recipient.wa);
  const sent = [];
  const userCtx = {
    isActiveMember: true,
    isAdmin: true,
    member: caller,
    userName: caller.name,
    waJid: caller.wa
  };
  setDedicatedClient({
    async sendMessage(chatId, message) {
      sent.push({ chatId, message });
    }
  });
  try {
    const result = await sendWhatsAppTool(
      { recipient: { name: recipient.name }, message: 'Please call at eight.' },
      userCtx,
      { contactedWA: new Set() }
    );
    assert.equal(result.success, true);
  } finally {
    setDedicatedClient(null);
  }

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, recipient.wa);
  assert.equal(
    sent[0].message,
    prependOutboundAttribution('Please call at eight.', userCtx)
  );
});

test('email attribution is escaped and inserted before the message body', () => {
  const line = buildOutboundAttributionLine({ member: { name: 'Requester <One>' } });
  const body = prependHtmlBlock(
    '<html><body><p>Message body.</p></body></html>',
    buildOutboundAttributionBlock(line)
  );

  assert.match(body, /<body><p[^>]*><strong>[^<]*&lt;One&gt;[^<]*<\/strong><\/p><p>Message body\.<\/p>/);
});
