// test/attachment-projection.test.js
//
// The read-only `attachments/` view and the invariant it exists to hold: a live
// tag always has a file behind it, and retention slides from last use rather
// than from arrival.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';
import constants from '../src/config/constants.js';
import { getAttachmentsPath, getWorkspaceMetaDir } from '../src/utils/workspaceId.js';
import {
  ATTACHMENT_TTL_MS,
  attachmentDisplayPath,
  clearProjection,
  isProjected,
  projectBuffer,
  projectFile,
  projectionRoot,
  sweepExpiredAttachments,
  touchProjected,
  unprojectFile
} from '../src/attachments/projection.js';
import { buildAttachmentTag, isInlineableImage, mediaKindFor } from '../src/attachments/ingress.js';

const WORKSPACE_ID = `user:proj-${process.pid}@c.us`;
const ATTACHMENTS = getAttachmentsPath(WORKSPACE_ID);
const SOURCE_DIR = path.join(constants.DATA_DIR, 'users', `src-proj-${process.pid}`);

function source(name, content) {
  const abs = path.join(SOURCE_DIR, name);
  fs.writeFileSync(abs, content);
  return abs;
}

before(() => {
  fs.mkdirSync(SOURCE_DIR, { recursive: true });
  fs.mkdirSync(ATTACHMENTS, { recursive: true });
});

after(() => {
  fs.rmSync(getWorkspaceMetaDir(WORKSPACE_ID), { recursive: true, force: true });
  fs.rmSync(SOURCE_DIR, { recursive: true, force: true });
});

test('the display path is always namespaced, whatever the caller passes', () => {
  assert.equal(attachmentDisplayPath('photo.jpg'), 'attachments/photo.jpg');
  // A caller handing over a path, not a name, must not produce a nested one.
  assert.equal(attachmentDisplayPath('history/photo.jpg'), 'attachments/photo.jpg');
});

test('a live tag and an expired tag are told apart by their label', () => {
  assert.equal(buildAttachmentTag('report.pdf'), '[Attachment: attachments/report.pdf]');
  assert.equal(buildAttachmentTag('report.pdf', true), '[Attachment (expired): attachments/report.pdf]');
});

test('projecting a file copies it and reports the namespace path', () => {
  const abs = source('doc.txt', 'hello');
  const projected = projectFile(WORKSPACE_ID, abs);
  assert.equal(projected.display, 'attachments/doc.txt');
  assert.equal(projected.name, 'doc.txt');
  assert.equal(fs.readFileSync(projected.abs, 'utf8'), 'hello');
  assert.equal(isProjected(WORKSPACE_ID, 'doc.txt'), true);
});

test('the projection is a copy, so refreshing it leaves the source clock alone', () => {
  const abs = source('clock.txt', 'x');
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  fs.utimesSync(abs, old, old);
  projectFile(WORKSPACE_ID, abs);

  const before = fs.statSync(abs).mtimeMs;
  const dest = path.join(ATTACHMENTS, 'clock.txt');
  fs.utimesSync(dest, old, old);
  assert.equal(touchProjected(WORKSPACE_ID, 'clock.txt'), true);
  assert.ok(fs.statSync(dest).mtimeMs > before, 'the projection moved forward');
  assert.equal(fs.statSync(abs).mtimeMs, before, 'the source did not');
});

test('a missing or empty source projects nothing, which is the expired-tag cue', () => {
  assert.equal(projectFile(WORKSPACE_ID, path.join(SOURCE_DIR, 'nope.txt')), null);
  const empty = source('empty.txt', '');
  assert.equal(projectFile(WORKSPACE_ID, empty), null);
});

test('a buffer can be projected directly when there is no durable copy yet', () => {
  const projected = projectBuffer(WORKSPACE_ID, 'inline.bin', Buffer.from([1, 2, 3]));
  assert.equal(projected.display, 'attachments/inline.bin');
  assert.equal(fs.readFileSync(projected.abs).length, 3);
  assert.equal(projectBuffer(WORKSPACE_ID, 'zero.bin', Buffer.alloc(0)), null);
});

test('a name cannot escape the projection root', () => {
  assert.equal(projectBuffer(WORKSPACE_ID, '../escape.txt', Buffer.from('x')).name, 'escape.txt');
  assert.equal(fs.existsSync(path.join(ATTACHMENTS, 'escape.txt')), true);
  assert.equal(fs.existsSync(path.join(path.dirname(ATTACHMENTS), 'escape.txt')), false);
});

test('the sweep drops what has gone quiet and keeps what has not', () => {
  const fresh = projectBuffer(WORKSPACE_ID, 'fresh.txt', Buffer.from('new'));
  const stale = projectBuffer(WORKSPACE_ID, 'stale.txt', Buffer.from('old'));
  const past = new Date(Date.now() - ATTACHMENT_TTL_MS - 60_000);
  fs.utimesSync(stale.abs, past, past);

  sweepExpiredAttachments();
  assert.equal(fs.existsSync(fresh.abs), true);
  assert.equal(fs.existsSync(stale.abs), false);
});

test('unproject removes one file and clearProjection removes the lot', () => {
  projectBuffer(WORKSPACE_ID, 'one.txt', Buffer.from('1'));
  projectBuffer(WORKSPACE_ID, 'two.txt', Buffer.from('2'));
  unprojectFile(WORKSPACE_ID, 'one.txt');
  assert.equal(isProjected(WORKSPACE_ID, 'one.txt'), false);
  assert.equal(isProjected(WORKSPACE_ID, 'two.txt'), true);

  assert.equal(projectionRoot(WORKSPACE_ID), ATTACHMENTS);
  clearProjection(WORKSPACE_ID);
  assert.equal(fs.existsSync(ATTACHMENTS), false);
  fs.mkdirSync(ATTACHMENTS, { recursive: true });
});

test('media kind and inlineability come from extension or content type', () => {
  assert.equal(mediaKindFor('note.ogg'), 'audio');
  assert.equal(mediaKindFor('clip.mp4'), 'video');
  assert.equal(mediaKindFor('report.pdf'), 'other');
  assert.equal(mediaKindFor('blob', 'audio/mpeg'), 'audio');

  assert.equal(isInlineableImage('photo.JPG'), true);
  assert.equal(isInlineableImage('blob', 'image/webp'), true);
  assert.equal(isInlineableImage('report.pdf'), false);
});
