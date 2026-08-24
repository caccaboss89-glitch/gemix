import assert from 'node:assert/strict';
import test from 'node:test';

import { ingressDiscordAttachment, ingressWaMessageMedia } from '../src/utils/incomingMediaIngress.js';
import { DISCORD_ATTACHMENT_MAX_BYTES } from '../src/utils/discordAttachmentFetch.js';

test('unsupported WhatsApp media has an expired tag, never a live missing path', async () => {
  const result = await ingressWaMessageMedia({ type: 'location', id: { id: 'm1' }, _data: {} }, 'history-id');
  assert.match(result.tag, /^\[Attachment \(expired\):/);
  assert.equal(result.syncedPath, null);
});

test('WhatsApp media without a platform id has an expired tag', async () => {
  const result = await ingressWaMessageMedia({
    type: 'image',
    id: {},
    _data: { filename: 'photo.jpg', mimetype: 'image/jpeg' }
  }, 'history-id');
  assert.equal(result.tag, '[Attachment (expired): attachments/photo.jpg]');
});

test('oversize Discord media has an expired tag and a size note', async () => {
  const result = await ingressDiscordAttachment({
    id: 'a1',
    name: 'large.bin',
    size: DISCORD_ATTACHMENT_MAX_BYTES + 1,
    url: 'https://cdn.example/large.bin'
  }, 'history-id');
  assert.equal(result.tag, '[Attachment (expired): attachments/large.bin]');
  assert.match(result.textFragment, /over 25MB/);
});
