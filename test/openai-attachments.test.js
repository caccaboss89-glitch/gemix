// test/openai-attachments.test.js
//
// Phase 4: what GPT-5.6 Sol is allowed to receive.
//
// The matrix is fail-closed, so most of these tests are about refusal: a file
// whose name, MIME and bytes disagree is never projected, and nothing on this
// path may upload, fetch or otherwise reach the xAI stack.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { seedEnv, writeAuthFile, makeTempDir } from './helpers/testEnv.js';
import { installFetchStub } from './helpers/fetchStub.js';

const AUTH_FILE = writeAuthFile();
seedEnv({ XAI_AUTH_FILE: AUTH_FILE, OPENAI_AUTH_FILE: AUTH_FILE });

const { classifyForOpenAi, isAnimatedGif, hasDangerousDoubleExtension, OPENAI_PROJECTION, SKIP_REASON } =
  await import('../src/config/openaiFileMatrix.js');
const { projectFileForOpenAi, projectBufferForOpenAi } = await import('../src/utils/openaiFileProjection.js');
const { getProviderProfile, PROVIDER } = await import('../src/ai/providers/providerProfile.js');
const { deliverSyncedAttachment } = await import('../src/utils/aiFileDelivery.js');

const OPENAI = getProviderProfile(PROVIDER.OPENAI);
const DIR = makeTempDir('gemix-attach-');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(64, 7)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 7)]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 7)]);
const MP4 = Buffer.concat([Buffer.alloc(4, 0), Buffer.from('ftypisom'), Buffer.alloc(64, 7)]);
const STATIC_GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32, 3), Buffer.from([0x21, 0xf9, 0x04]), Buffer.alloc(32, 3)]);
const ANIMATED_GIF = Buffer.concat([
  Buffer.from('GIF89a'), Buffer.alloc(16, 3),
  Buffer.from([0x21, 0xf9, 0x04]), Buffer.alloc(16, 3),
  Buffer.from([0x21, 0xf9, 0x04]), Buffer.alloc(16, 3)
]);
const LOOPING_GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16, 3), Buffer.from('NETSCAPE2.0'), Buffer.alloc(16, 3)]);

/** Write a fixture file and return its absolute path. */
function write(name, buffer) {
  const abs = path.join(DIR, name);
  fs.writeFileSync(abs, buffer);
  return abs;
}

/** Classify a buffer as if it were a file with that name. */
function classify(name, buffer, mimetype = '') {
  return classifyForOpenAi({ name, mimetype, sizeBytes: buffer.length, head: buffer });
}

// -- The matrix --------------------------------------------------------------

test('the observed image and document types are accepted', () => {
  assert.equal(classify('a.png', PNG, 'image/png').as, OPENAI_PROJECTION.IMAGE);
  assert.equal(classify('a.jpg', JPEG, 'image/jpeg').as, OPENAI_PROJECTION.IMAGE);
  assert.equal(classify('a.webp', WEBP, 'image/webp').as, OPENAI_PROJECTION.IMAGE);
  assert.equal(classify('a.gif', STATIC_GIF, 'image/gif').as, OPENAI_PROJECTION.IMAGE);
  assert.equal(classify('a.pdf', PDF, 'application/pdf').as, OPENAI_PROJECTION.FILE);
  assert.equal(classify('a.docx', DOCX, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document').as, OPENAI_PROJECTION.FILE);
  assert.equal(classify('notes.md', Buffer.from('# hello'), 'text/markdown').as, OPENAI_PROJECTION.FILE);
  assert.equal(classify('data.csv', Buffer.from('a,b\n1,2'), 'text/csv').as, OPENAI_PROJECTION.FILE);
  assert.equal(classify('subs.srt', Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhi'), '').as, OPENAI_PROJECTION.FILE);
});

test('audio and video never reach this model', () => {
  // Probed and rejected in every form the backend offers.
  assert.deepEqual(classify('note.ogg', Buffer.from('OggS'), 'audio/ogg'), {
    as: OPENAI_PROJECTION.SKIP, reason: SKIP_REASON.TRANSCRIBED
  });
  assert.equal(classify('note.mp3', Buffer.from('ID3'), 'audio/mpeg').reason, SKIP_REASON.TRANSCRIBED);
  assert.equal(classify('clip.mp4', MP4, 'video/mp4').reason, SKIP_REASON.UNSUPPORTED);
  // An audio MIME on a neutral extension is still audio.
  assert.equal(classify('recording.dat', Buffer.from('OggS'), 'audio/ogg').reason, SKIP_REASON.TRANSCRIBED);
});

test('archives and binaries stay out of the request', () => {
  assert.equal(classify('bundle.zip', DOCX, 'application/zip').reason, SKIP_REASON.UNSUPPORTED);
  assert.equal(classify('tool.exe', Buffer.from('MZ\x90\x00'), '').reason, SKIP_REASON.UNSUPPORTED);
  assert.equal(classify('archive.tar.gz', Buffer.alloc(32, 1), '').reason, SKIP_REASON.UNSUPPORTED);
});

test('a file that contradicts itself is invalid, not merely unsupported', () => {
  // Real PNG bytes wearing a .pdf name.
  assert.equal(classify('report.pdf', PNG, 'application/pdf').reason, SKIP_REASON.INVALID);
  // Correct bytes, lying MIME.
  assert.equal(classify('photo.png', PNG, 'application/pdf').reason, SKIP_REASON.INVALID);
  // A binary hiding behind a text extension.
  assert.equal(classify('readme.txt', Buffer.from([0x41, 0x00, 0x42]), 'text/plain').reason, SKIP_REASON.INVALID);
  // Nothing to send.
  assert.equal(classify('empty.png', Buffer.alloc(0), 'image/png').reason, SKIP_REASON.INVALID);
});

test('an executable hidden behind a second extension is refused', () => {
  assert.equal(hasDangerousDoubleExtension('invoice.exe.pdf'), true);
  assert.equal(hasDangerousDoubleExtension('archive.tar.gz'), false);
  assert.equal(hasDangerousDoubleExtension('report.pdf'), false);
  assert.equal(classify('invoice.exe.pdf', PDF, 'application/pdf').reason, SKIP_REASON.INVALID);
});

test('animated GIFs are tagged, never sent as a still frame', () => {
  assert.equal(isAnimatedGif(ANIMATED_GIF), true);
  assert.equal(isAnimatedGif(LOOPING_GIF), true);
  assert.equal(isAnimatedGif(STATIC_GIF), false);
  // Anything that is not a readable GIF counts as animated: the ambiguous case
  // degrades to a tag, never to a wrong description.
  assert.equal(isAnimatedGif(Buffer.from('not a gif')), true);
  assert.equal(isAnimatedGif(null), true);

  const verdict = classify('meme.gif', ANIMATED_GIF, 'image/gif');
  assert.equal(verdict.reason, SKIP_REASON.UNSUPPORTED);
  assert.equal(verdict.detail, 'animated GIF');
});

test('a GIF sniffed only partially is not cleared as static', () => {
  const verdict = classifyForOpenAi({
    name: 'maybe.gif', mimetype: 'image/gif', sizeBytes: STATIC_GIF.length * 4, head: STATIC_GIF
  });
  assert.equal(verdict.detail, 'animated GIF');
});

test('accepted types still have a size ceiling', () => {
  assert.equal(classifyForOpenAi({ name: 'big.png', mimetype: 'image/png', sizeBytes: 64 * 1024 * 1024, head: PNG }).reason, SKIP_REASON.TOO_LARGE);
  assert.equal(classifyForOpenAi({ name: 'big.pdf', mimetype: 'application/pdf', sizeBytes: 64 * 1024 * 1024, head: PDF }).reason, SKIP_REASON.TOO_LARGE);
});

// -- Projection --------------------------------------------------------------

test('an accepted image is inlined as a data URL and nothing is uploaded', () => {
  const stub = installFetchStub(() => { throw new Error('the OpenAI profile must not make network calls to project a file'); });
  try {
    const built = projectFileForOpenAi(write('shot.png', PNG), 'shot.png', { mimetype: 'image/png' });
    assert.equal(built.success, true);
    assert.equal(built.bumpImageCount, true);
    assert.equal(built.parts[0].text, '[Attachment: shot.png]');
    assert.equal(built.parts[1].type, 'input_image');
    assert.match(built.parts[1].image_url, /^data:image\/png;base64,/);
    assert.equal(Buffer.from(built.parts[1].image_url.split(',')[1], 'base64').equals(PNG), true);
    // The pruner and the history collector find the file through this hint.
    assert.equal(path.basename(built.parts[1]._sourcePath), 'shot.png');
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('an accepted document is inlined with its filename', () => {
  const built = projectFileForOpenAi(write('contract.pdf', PDF), 'contract.pdf', { mimetype: 'application/pdf' });
  assert.equal(built.success, true);
  assert.equal(built.bumpImageCount, false);
  assert.equal(built.parts[1].type, 'input_file');
  assert.equal(built.parts[1].filename, 'contract.pdf');
  assert.match(built.parts[1].file_data, /^data:application\/pdf;base64,/);
});

test('a refused file returns a short note for the attachment tag', () => {
  const clip = projectFileForOpenAi(write('clip.mp4', MP4), 'clip.mp4', { mimetype: 'video/mp4' });
  assert.equal(clip.success, false);
  assert.equal(clip.note, 'unsupported_by_openai: video');

  const note = projectFileForOpenAi(write('note.ogg', Buffer.from('OggS0000')), 'note.ogg', { mimetype: 'audio/ogg' });
  assert.match(note.note, /transcript only/);

  const fake = projectFileForOpenAi(write('fake.pdf', PNG), 'fake.pdf', { mimetype: 'application/pdf' });
  assert.match(fake.note, /^invalid: /);
});

test('a missing file is reported, not thrown', () => {
  const built = projectFileForOpenAi(path.join(DIR, 'nope.png'), 'nope.png', { mimetype: 'image/png' });
  assert.equal(built.success, false);
  assert.equal(built.note, 'file unavailable');
});

test('the per-call image budget is enforced', () => {
  const built = projectFileForOpenAi(write('budget.png', PNG), 'budget.png', { mimetype: 'image/png', imagesReadCount: 30 });
  assert.equal(built.success, false);
  assert.equal(built.note, 'image limit reached');
});

test('buffer previews follow the same matrix', () => {
  const pdf = projectBufferForOpenAi(PDF, 'formal.pdf', 'application/pdf');
  assert.equal(pdf.type, 'input_file');
  assert.equal(pdf.filename, 'formal.pdf');

  assert.equal(projectBufferForOpenAi(MP4, 'clip.mp4', 'video/mp4'), null);
  assert.equal(projectBufferForOpenAi(Buffer.alloc(0), 'empty.png', 'image/png'), null);
});

// -- Ingress -----------------------------------------------------------------

test('a video is kept and tagged instead of deferred to read_video', async () => {
  const abs = write('holiday.mp4', MP4);
  const ingress = await deliverSyncedAttachment({
    providerProfile: OPENAI,
    syncedPath: 'holiday.mp4',
    name: 'holiday.mp4',
    contentType: 'video/mp4',
    historyStorageId: null,
    fetchBuffer: async () => fs.readFileSync(abs),
    deferVideo: true
  });

  assert.equal(ingress.contentParts.length, 0);
  assert.match(ingress.textFragment, /unsupported_by_openai: video/);
  // read_video does not exist on this profile, so it must not be advertised.
  assert.equal(/read_video/.test(ingress.textFragment), false);
  assert.equal(ingress.syncedPath, 'holiday.mp4');
});

test('an image in the current message is inlined by the ingress', async () => {
  const abs = write('ingress.png', PNG);
  const ingress = await deliverSyncedAttachment({
    providerProfile: OPENAI,
    syncedPath: null,
    name: 'ingress.png',
    contentType: 'image/png',
    historyStorageId: null,
    fetchBuffer: async () => fs.readFileSync(abs)
  });

  assert.equal(ingress.contentParts.length, 1);
  assert.equal(ingress.contentParts[0].type, 'input_image');
  assert.match(ingress.contentParts[0].image_url, /^data:image\/png;base64,/);
});

test('the xAI branch still defers history videos to read_video', async () => {
  const abs = write('xai-holiday.mp4', MP4);
  const ingress = await deliverSyncedAttachment({
    providerProfile: getProviderProfile(PROVIDER.XAI),
    syncedPath: 'xai-holiday.mp4',
    name: 'xai-holiday.mp4',
    contentType: 'video/mp4',
    historyStorageId: null,
    fetchBuffer: async () => fs.readFileSync(abs),
    deferVideo: true
  });

  assert.equal(ingress.contentParts.length, 0);
  assert.equal(ingress.textFragment, '[Attachment: xai-holiday.mp4] (not loaded — read_video with this filename to watch it) ');
});

test('an unreadable attachment keeps its tag and says why', async () => {
  const abs = write('ingress-clip.gif', ANIMATED_GIF);
  const ingress = await deliverSyncedAttachment({
    providerProfile: OPENAI,
    syncedPath: null,
    name: 'ingress-clip.gif',
    contentType: 'image/gif',
    historyStorageId: null,
    fetchBuffer: async () => fs.readFileSync(abs)
  });

  assert.equal(ingress.contentParts.length, 0);
  assert.match(ingress.textFragment, /animated GIF/);
});
