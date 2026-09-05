import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RELEASE_MEDIA_MAX_BYTES,
  _buildReleaseOutbox,
  _drainReleaseOutbox,
  _fetchReleaseMedia,
  _outboxComplete,
  _parseReleaseBody
} from '../src/scheduler/releaseMonitor.js';

test('release outbox retains failed recipients and does not resend completed ones', async () => {
  const outbox = _buildReleaseOutbox(
    { id: 42, name: '2.2.2', body: 'Notes', assets: [] },
    new Map([['chat-a', 'a@c.us'], ['chat-b', 'b@c.us']])
  );
  const sends = [];
  let failA = true;
  const client = {
    async sendMessage(jid, value) {
      sends.push([jid, value]);
      if (jid === 'a@c.us' && failA) {
        failA = false;
        throw new Error('offline');
      }
    }
  };
  const persisted = [];
  const options = {
    persistOutbox: async value => persisted.push(structuredClone(value)),
    completeOutbox: async () => {}
  };

  assert.equal(await _drainReleaseOutbox(client, outbox, {}, options), false);
  assert.equal(outbox.recipients['chat-a'].text.status, 'pending');
  assert.equal(outbox.recipients['chat-b'].text.status, 'delivered');
  assert.equal(await _drainReleaseOutbox(client, outbox, {}, options), true);
  assert.equal(_outboxComplete(outbox), true);
  assert.equal(sends.filter(([jid]) => jid === 'b@c.us').length, 1);
  assert.ok(persisted.length >= 5);
});

test('release media download failure is delivered as its original URL', async () => {
  const url = 'https://example.invalid/release/demo.png';
  const outbox = _buildReleaseOutbox(
    { id: 43, name: '2.2.3', body: `Before ![demo](${url}) after`, assets: [] },
    new Map([['chat', 'chat@c.us']])
  );
  const sends = [];
  const client = { sendMessage: async (_jid, value) => sends.push(value) };

  const complete = await _drainReleaseOutbox(client, outbox, {}, {
    fetchMedia: async () => { throw new Error('download failed'); },
    persistOutbox: async () => {},
    completeOutbox: async () => {}
  });

  assert.equal(complete, true);
  assert.equal(outbox.recipients.chat.media[0].method, 'link');
  assert.equal(sends.some(value => typeof value === 'string' && value.includes(url)), true);
  assert.equal(_parseReleaseBody(`![demo](${url})`).cleanBody, '');
});

test('release media downloads are bounded and image MIME is sniffed', async () => {
  const originalFetch = global.fetch;
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  try {
    global.fetch = async () => new Response(png, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' }
    });
    const media = await _fetchReleaseMedia(
      { kind: 'image', url: 'https://example.invalid/release.png', name: 'release.png' },
      {}
    );
    assert.equal(media.mimetype, 'image/png');

    global.fetch = async () => new Response('x', {
      status: 200,
      headers: { 'content-length': String(RELEASE_MEDIA_MAX_BYTES + 1) }
    });
    await assert.rejects(
      _fetchReleaseMedia(
        { kind: 'image', url: 'https://example.invalid/huge.png', name: 'huge.png' },
        {}
      ),
      /File too large/
    );
  } finally {
    global.fetch = originalFetch;
  }
});
