import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import constants from '../src/config/constants.js';
import { buildFallbackAttachmentMessage } from '../src/utils/attachmentFallback.js';
import { deliverWhatsAppAttachments } from '../src/tools/sendWhatsApp.js';
import { prepareEmailAttachmentsForDelivery } from '../src/tools/sendEmail.js';
import {
  EMAIL_DIRECT_MAX_BYTES,
  EMAIL_MIME_ATTACHMENT_BUDGET_BYTES,
  estimateEmailMimeAttachmentBytes
} from '../src/utils/attachmentDelivery.js';
import {
  WA_DIRECT_MAX_BYTES,
  shouldWhatsAppUseTempLink,
  toWhatsAppMediaArgs
} from '../src/utils/attachments.js';
import {
  recordSentMessage,
  readSentRecords,
  deleteSentMessages
} from '../src/utils/sentMessagesStore.js';
import {
  buildAttachmentDeliverySummary,
  outboundStatusFor,
  outboundStatusWithAudit,
  recordOutbound
} from '../src/tools/outboundDelivery.js';

test('oversized WhatsApp voice audio uses the same link fallback as every other media type', () => {
  const attachment = {
    name: 'voice.ogg',
    mimetype: 'audio/ogg',
    buffer: Buffer.alloc(WA_DIRECT_MAX_BYTES + 1),
    sendAudioAsVoice: true
  };
  assert.equal(shouldWhatsAppUseTempLink(attachment), true);
  assert.equal(toWhatsAppMediaArgs(attachment), null);
});

test('an accepted send uses the canonical ok status when no attachment failed', () => {
  assert.equal(outboundStatusFor(buildAttachmentDeliverySummary({ selected: 1, direct: 1 })), 'ok');
});

test('an audit failure degrades only an otherwise-complete tool receipt', () => {
  assert.equal(outboundStatusWithAudit('ok', false), 'degraded');
  assert.equal(outboundStatusWithAudit('ok', true), 'ok');
  assert.equal(outboundStatusWithAudit('degraded', false), 'degraded');
});

test('outbound audit reports a reliable save result and preserves receipt statuses', async () => {
  assert.equal(await recordOutbound({}), false);
  assert.equal(await recordSentMessage({
    senderKey: 'invalid_status_test',
    channel: 'email',
    acceptanceStatus: 'delivered',
    toolStatus: 'ok'
  }), false);

  const senderKey = `test_delivery_audit_${process.pid}_${Date.now()}`;
  try {
    const saved = await recordSentMessage({
      senderKey,
      channel: 'email',
      acceptanceStatus: 'accepted',
      toolStatus: 'degraded',
      recipient: { email: 'recipient@example.com', display: 'recipient' },
      subject: 'Test'
    });
    assert.equal(saved, true);
    const records = readSentRecords(senderKey);
    assert.equal(records.length, 1);
    assert.equal(records[0].acceptanceStatus, 'accepted');
    assert.equal(records[0].toolStatus, 'degraded');
  } finally {
    await deleteSentMessages(senderKey);
  }
});

test('outbound audit refuses to overwrite a corrupt existing record', async () => {
  const senderKey = `test_delivery_corrupt_${process.pid}_${Date.now()}`;
  const dir = path.join(constants.DATA_DIR, 'sent_messages', senderKey);
  const auditFile = path.join(dir, 'messages.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(auditFile, '{not-json', 'utf8');

  try {
    assert.equal(await recordSentMessage({
      senderKey,
      channel: 'whatsapp',
      acceptanceStatus: 'accepted',
      toolStatus: 'ok',
      recipient: { phone: '390000000000' }
    }), false);
    assert.equal(fs.readFileSync(auditFile, 'utf8'), '{not-json');
  } finally {
    await deleteSentMessages(senderKey);
  }
});

function removeMaterializedFile(att) {
  if (att?.filePath) fs.rmSync(att.filePath, { force: true });
}

test('link fallback reports partial registration instead of counting every candidate', () => {
  const available = {
    name: 'source.pdf',
    mimetype: 'application/pdf',
    buffer: Buffer.from('source')
  };
  const unavailable = { name: 'missing.pdf', mimetype: 'application/pdf' };

  try {
    const result = buildFallbackAttachmentMessage([available, unavailable]);

    assert.equal(result.fallbackLinks.length, 1);
    assert.deepEqual(result.fallbackAttachments, [available]);
    assert.equal(result.failedAttachments.length, 1);
    assert.equal(result.failedAttachments[0].attachment, unavailable);
  } finally {
    removeMaterializedFile(available);
  }
});

test('WhatsApp does not count or audit a link when its fallback message fails', async () => {
  const attachment = {
    name: 'report.txt',
    mimetype: 'text/plain',
    buffer: Buffer.from('report')
  };

  try {
    const result = await deliverWhatsAppAttachments(
      [attachment],
      async () => { throw new Error('direct rejected'); },
      async () => { throw new Error('fallback rejected'); }
    );

    assert.equal(result.direct.length, 0);
    assert.equal(result.linked.length, 0);
    assert.equal(result.auditAttachments.length, 0);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].stage, 'link_delivery');
    assert.match(result.failures[0].error, /direct rejected/);
    assert.match(result.failures[0].error, /fallback rejected/);

    const summary = buildAttachmentDeliverySummary({
      selected: 1,
      failures: result.failures
    });
    assert.equal(summary.viaLinks, 0);
    assert.equal(summary.failed, 1);
    assert.equal(outboundStatusFor(summary), 'degraded');
  } finally {
    removeMaterializedFile(attachment);
  }
});

test('WhatsApp audits a fallback attachment only after its link message is accepted', async () => {
  const attachment = {
    name: 'report.txt',
    mimetype: 'text/plain',
    buffer: Buffer.from('report')
  };

  try {
    const result = await deliverWhatsAppAttachments(
      [attachment],
      async () => { throw new Error('direct rejected'); },
      async () => {}
    );

    assert.equal(result.linked.length, 1);
    assert.equal(result.failures.length, 0);
    assert.equal(result.auditAttachments.length, 1);
    assert.equal(result.auditAttachments[0].deliveryMethod, 'link');
  } finally {
    removeMaterializedFile(attachment);
  }
});

test('email preparation excludes an unavailable link fallback from counts and audit', () => {
  const attached = {
    name: 'included.txt',
    mimetype: 'text/plain',
    buffer: Buffer.from('included')
  };
  const unavailable = { name: 'missing.pdf', mimetype: 'application/pdf' };

  const result = prepareEmailAttachmentsForDelivery('<p>Body</p>', [attached, unavailable]);

  assert.equal(result.attached.length, 1);
  assert.equal(result.linked.length, 0);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].name, 'missing.pdf');
  assert.equal(result.auditAttachments.length, 1);
  assert.equal(result.auditAttachments[0].name, 'included.txt');
  assert.equal(result.auditAttachments[0].deliveryMethod, 'attachment');
  assert.match(result.bodyHtml, /non è stato possibile creare link temporanei/);

  const summary = buildAttachmentDeliverySummary({
    selected: 2,
    direct: result.attached.length,
    linked: result.linked.length,
    failures: result.failures
  });
  assert.equal(summary.delivered, 1);
  assert.equal(summary.viaLinks, 0);
  assert.equal(summary.failed, 1);
  assert.equal(outboundStatusFor(summary), 'degraded');
});

test('email audit distinguishes embedded, attached and linked content', () => {
  const image = {
    name: 'photo.png',
    mimetype: 'image/png',
    buffer: Buffer.from('image')
  };
  const attached = {
    name: 'notes.txt',
    mimetype: 'text/plain',
    buffer: Buffer.from('notes')
  };
  // Only an oversized file is routed to a link now that URLs never become attachments.
  const linked = {
    name: 'archive.zip',
    mimetype: 'application/zip',
    buffer: Buffer.alloc(EMAIL_DIRECT_MAX_BYTES + 1)
  };

  try {
    const result = prepareEmailAttachmentsForDelivery(
      '<p>Body</p><img src="cid:photo.png">',
      [image, attached, linked]
    );

    assert.equal(result.inline.length, 1);
    assert.equal(result.attached.length, 1);
    assert.equal(result.linked.length, 1);
    assert.equal(result.failures.length, 0);
    assert.deepEqual(
      result.auditAttachments.map(att => [att.name, att.deliveryMethod]),
      [
        ['photo.png', 'inline'],
        ['notes.txt', 'attachment'],
        ['archive.zip', 'link']
      ]
    );
  } finally {
    removeMaterializedFile(linked);
  }
});

test('email MIME budget is aggregate across inline and direct files', () => {
  const image = {
    name: 'photo.png',
    mimetype: 'image/png',
    buffer: Buffer.from('image')
  };
  const document = {
    name: 'notes.txt',
    mimetype: 'text/plain',
    buffer: Buffer.from('notes')
  };
  const imageEstimate = estimateEmailMimeAttachmentBytes(image);

  try {
    const result = prepareEmailAttachmentsForDelivery(
      '<p>Body</p><img src="cid:photo.png">',
      [image, document],
      { mimeBudgetBytes: imageEstimate }
    );

    assert.equal(result.inline.length, 1);
    assert.equal(result.attached.length, 0);
    assert.equal(result.linked.length, 1);
    assert.equal(result.linked[0], document);
    assert.equal(result.mailAttachments.length, 1);
    assert.equal(result.mimeBudget.limitBytes, imageEstimate);
    assert.equal(result.mimeBudget.estimatedBytes, imageEstimate);
    assert.equal(result.mimeBudget.overflowed, 1);
    assert.ok(estimateEmailMimeAttachmentBytes(document) > document.buffer.length);
    assert.equal(EMAIL_MIME_ATTACHMENT_BUDGET_BYTES, 20 * 1024 * 1024);
    assert.deepEqual(
      result.auditAttachments.map(att => [att.name, att.deliveryMethod]),
      [
        ['photo.png', 'inline'],
        ['notes.txt', 'link']
      ]
    );
  } finally {
    removeMaterializedFile(document);
  }
});

test('an inline image outside the MIME budget becomes a real link without a broken cid', () => {
  const image = {
    name: 'large-photo.png',
    mimetype: 'image/png',
    buffer: Buffer.from('image')
  };

  try {
    const result = prepareEmailAttachmentsForDelivery(
      '<p>Body</p><img alt="photo" src="cid:large-photo.png">',
      [image],
      { mimeBudgetBytes: 0 }
    );

    assert.equal(result.inline.length, 0);
    assert.equal(result.mailAttachments.length, 0);
    assert.equal(result.linked.length, 1);
    assert.equal(result.linked[0], image);
    assert.equal(result.mimeBudget.overflowed, 1);
    assert.doesNotMatch(result.bodyHtml, /cid:/i);
    assert.doesNotMatch(result.bodyHtml, /<img\b/i);
    assert.equal(result.auditAttachments[0].deliveryMethod, 'link');
  } finally {
    removeMaterializedFile(image);
  }
});
