// test/attachment-ingress.test.js
//
// Per-file routing: images of the message being answered go
// inline and nothing else does, every file gets a namespace path, and a tag is
// never live unless the file is really there.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';
import constants from '../src/config/constants.js';
import { getAttachmentsPath, getWorkspaceMetaDir } from '../src/utils/workspaceId.js';
import { MAX_INLINE_IMAGES, ingestAttachment } from '../src/attachments/ingress.js';
import { clearProjection } from '../src/attachments/projection.js';

const WORKSPACE_ID = `user:ingress-${process.pid}@c.us`;
const ATTACHMENTS = getAttachmentsPath(WORKSPACE_ID);

/** A 1x1 PNG, small enough to inline and real enough to be a valid image. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

before(() => fs.mkdirSync(ATTACHMENTS, { recursive: true }));
after(() => fs.rmSync(getWorkspaceMetaDir(WORKSPACE_ID), { recursive: true, force: true }));

/** Ingest one file straight from a buffer, with no history copy behind it. */
function ingest(name, buffer, opts = {}) {
  return ingestAttachment({
    workspaceId: WORKSPACE_ID,
    historyStorageId: null,
    syncedPath: null,
    name,
    fetchBuffer: async () => buffer,
    ...opts
  });
}

test('a document becomes a path and nothing more, even on the current turn', async () => {
  const r = await ingest('report.pdf', Buffer.from('%PDF-1.4 x'), { inline: true });
  assert.equal(r.tag, '[Attachment: attachments/report.pdf]');
  assert.deepEqual(r.contentParts, []);
  assert.equal(fs.existsSync(path.join(ATTACHMENTS, 'report.pdf')), true);
});

test('an image of the current message travels inline as base64, never as a URL', async () => {
  const r = await ingest('photo.png', TINY_PNG, { inline: true, contentType: 'image/png' });
  assert.equal(r.contentParts.length, 1);
  assert.equal(r.contentParts[0].type, 'input_image');
  assert.match(r.contentParts[0].image_url, /^data:image\/png;base64,/);
  assert.equal(r.bumpImageCount, true);
});

test('the same image in history is a tag only', async () => {
  const r = await ingest('old.png', TINY_PNG, { inline: false, contentType: 'image/png' });
  assert.deepEqual(r.contentParts, []);
  assert.equal(r.tag, '[Attachment: attachments/old.png]');
});

test('past the per-turn cap an image degrades to its path, with a reason', async () => {
  const r = await ingest('capped.png', TINY_PNG, {
    inline: true,
    contentType: 'image/png',
    imagesInlined: MAX_INLINE_IMAGES
  });
  assert.deepEqual(r.contentParts, []);
  assert.match(r.textFragment, /read_file/);
  assert.equal(MAX_INLINE_IMAGES, constants.MAX_INLINE_IMAGES_PER_TURN);
});

test('a raw binary is projected too, with a tag that says what it is', async () => {
  const r = await ingest('setup.exe', Buffer.from([0x4d, 0x5a]), { inline: true });
  assert.equal(r.tag, '[Attachment: attachments/setup.exe]');
  assert.deepEqual(r.contentParts, [], 'nothing about it is worth vision');
  assert.match(r.textFragment, /binary/i, 'the model is told read_file will not open it');
  // The invariant is tag ⇔ file: a live tag with nothing behind it is
  // the one shape that is not allowed, even for a file no parser can read.
  assert.equal(fs.existsSync(path.join(ATTACHMENTS, 'setup.exe')), true);
});

test('a file that cannot be materialized is marked expired, never left dangling', async () => {
  const r = await ingestAttachment({
    workspaceId: WORKSPACE_ID,
    historyStorageId: null,
    syncedPath: null,
    name: 'gone.pdf',
    fetchBuffer: async () => null,
    inline: true
  });
  assert.equal(r.tag, '[Attachment (expired): attachments/gone.pdf]');
  assert.equal(fs.existsSync(path.join(ATTACHMENTS, 'gone.pdf')), false);
});

test('an over-long clip is flagged but still kept for the shell to work on', async () => {
  const r = await ingest('long.mp3', Buffer.from('id3'), {
    inline: true,
    contentType: 'audio/mpeg',
    metadataDurationSec: constants.MAX_AUDIO_DURATION_S + 60
  });
  assert.equal(r.overDurationLimit, 'audio');
  assert.match(r.textFragment, /too long/i, 'read_file will not transcribe it');
  // Trimming or converting a long recording is exactly what the raw is for,
  // and the tag has to point at a real file either way.
  assert.equal(fs.existsSync(path.join(ATTACHMENTS, 'long.mp3')), true);
  clearProjection(WORKSPACE_ID);
  fs.mkdirSync(ATTACHMENTS, { recursive: true });
});
