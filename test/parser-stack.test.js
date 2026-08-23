// test/parser-stack.test.js
//
// The ParserRegistry: which parser a file goes to, what comes back, and the
// cache that sits in front of it. The point of the registry is that read_file's
// contract does not move when a parser changes, so these tests are written
// against that contract rather than against Kreuzberg's own shapes.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';
import PDFDocument from 'pdfkit';
import constants from '../src/config/constants.js';
import { getWorkspaceMetaDir, getWorkspacePath } from '../src/utils/workspaceId.js';
import { PARSE_ERROR, familyFor, parse } from '../src/parsers/parserRegistry.js';
import {
  GLOBAL_CAP_BYTES,
  cacheDir,
  cacheKey,
  clearParserCache,
  hashFile,
  readCache,
  sweepParserCache,
  writeCache
} from '../src/parsers/parserCache.js';
import { parseImage } from '../src/parsers/mediaParser.js';
import { handlesExt, ocrAvailable } from '../src/parsers/documentParser.js';
import { readFile } from '../src/tools/workspace/readFile.js';

const WORKSPACE_ID = `user:parsers-${process.pid}@c.us`;
const ROOT = getWorkspacePath(WORKSPACE_ID);

/** A 1x1 PNG, small enough to inline and real enough to be a valid image. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function write(rel, content) {
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/** A real two-page PDF, built with the pdfkit the project already ships. */
function writePdf(rel, pages) {
  const abs = path.join(ROOT, rel);
  return new Promise((resolve) => {
    const doc = new PDFDocument();
    const out = fs.createWriteStream(abs);
    doc.pipe(out);
    pages.forEach((text, i) => {
      if (i > 0) doc.addPage();
      doc.text(text);
    });
    doc.end();
    out.on('finish', () => resolve(abs));
  });
}

before(async () => {
  fs.mkdirSync(ROOT, { recursive: true });
  write('notes.md', '# Title\nalpha beta\ngamma\n');
  write('logo.png', TINY_PNG);
  write('blob.dat', Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
  write('broken.pdf', Buffer.from('%PDF-1.4 not really a pdf'));
  await writePdf('report.pdf', ['Quarterly report body text.', 'Second page.']);
});

after(() => fs.rmSync(getWorkspaceMetaDir(WORKSPACE_ID), { recursive: true, force: true }));

// -- dispatch -----------------------------------------------------------------

test('every extension lands on the parser that owns it', () => {
  assert.equal(familyFor('.pdf'), 'document');
  assert.equal(familyFor('.docx'), 'document');
  assert.equal(familyFor('.zip'), 'document', 'archives go to the same extractor');
  assert.equal(familyFor('.png'), 'image');
  assert.equal(familyFor('.ogg'), 'audio');
  assert.equal(familyFor('.mp4'), 'video');
  assert.equal(familyFor('.exe'), 'refused');
  // Not a list to maintain: anything unknown is decided by its content.
  assert.equal(familyFor('.log'), 'text');
  assert.equal(familyFor(''), 'text');
});

test('the document parser claims documents and archives, and nothing else', () => {
  assert.equal(handlesExt('.xlsx'), true);
  assert.equal(handlesExt('.tar'), true);
  assert.equal(handlesExt('.png'), false);
});

test('an executable is refused as a type, not as a parser failure', async () => {
  write('setup.exe', Buffer.from([0x4d, 0x5a]));
  const res = await parse(path.join(ROOT, 'setup.exe'));
  assert.equal(res.ok, false);
  assert.equal(res.error_code, PARSE_ERROR.UNSUPPORTED_TYPE);
});

// -- text ---------------------------------------------------------------------

test('text comes back with its line count and honours the window', async () => {
  const whole = await parse(path.join(ROOT, 'notes.md'));
  assert.equal(whole.kind, 'text');
  assert.equal(whole.metadata.lines, 4);

  const windowed = await parse(path.join(ROOT, 'notes.md'), { offset: 2, limit: 1 });
  assert.equal(windowed.content, 'alpha beta');
  assert.match(windowed.notes.join(' '), /Lines 2-2 of 4/);
});

test('a binary with no parser is refused rather than dumped as bytes', async () => {
  const res = await parse(path.join(ROOT, 'blob.dat'));
  assert.equal(res.ok, false);
  assert.equal(res.error_code, PARSE_ERROR.UNSUPPORTED_TYPE);
});

// -- documents ----------------------------------------------------------------

test('a PDF comes back as text plus the metadata the file carries', async () => {
  const res = await parse(path.join(ROOT, 'report.pdf'), { workspaceId: WORKSPACE_ID });
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'document');
  assert.match(res.content, /Quarterly report/);
  assert.equal(res.metadata.pageCount, 2);
});

test('a PDF whose text layer is thin also comes back as rendered pages', async () => {
  // Two pages of a few words each is well under the per-page threshold, which
  // is exactly the scanned-document case the render path exists for.
  const res = await parse(path.join(ROOT, 'report.pdf'), { workspaceId: WORKSPACE_ID });
  assert.ok(res.images.length > 0, 'pages were rendered');
  assert.equal(res.images[0].page, 1, 'pages are numbered from 1 for the model');
  assert.ok(Buffer.isBuffer(res.images[0].buffer));
  assert.match(res.notes.join(' '), /thin/i);
});

test('a file the parser cannot open is PARSER_UNAVAILABLE, not a crash', async () => {
  const res = await parse(path.join(ROOT, 'broken.pdf'));
  assert.equal(res.ok, false);
  assert.equal(res.error_code, PARSE_ERROR.PARSER_UNAVAILABLE);
});

test('a document over the size limit is refused before any parsing', async () => {
  const abs = write('huge.docx', Buffer.alloc(1024));
  const original = constants.PARSE_MAX_DOCUMENT_BYTES;
  constants.PARSE_MAX_DOCUMENT_BYTES = 512;
  try {
    const res = await parse(abs);
    assert.equal(res.ok, false);
    assert.equal(res.error_code, PARSE_ERROR.TOO_LARGE);
  } finally {
    constants.PARSE_MAX_DOCUMENT_BYTES = original;
  }
});

test('whether OCR runs is a host fact, answered without throwing', () => {
  assert.equal(typeof ocrAvailable(), 'boolean');
});

// -- images -------------------------------------------------------------------

test('an image returns its dimensions, since the model already sees the picture', async () => {
  const res = await parseImage(path.join(ROOT, 'logo.png'));
  assert.equal(res.ok, true);
  assert.equal(res.metadata.format, 'png');
  assert.equal(res.metadata.width, 1);
  assert.equal(res.metadata.height, 1);
});

// -- cache --------------------------------------------------------------------

test('the cache key changes with the bytes, the parser and the parameters', () => {
  const a = cacheKey(Buffer.from('one'), 'document', { ext: '.pdf' });
  assert.notEqual(a, cacheKey(Buffer.from('two'), 'document', { ext: '.pdf' }));
  assert.notEqual(a, cacheKey(Buffer.from('one'), 'video', { ext: '.pdf' }));
  assert.notEqual(a, cacheKey(Buffer.from('one'), 'document', { ext: '.docx' }));
  // Key order must not matter, or the same parse would miss its own entry.
  assert.equal(
    cacheKey(Buffer.from('one'), 'document', { a: 1, b: 2 }),
    cacheKey(Buffer.from('one'), 'document', { b: 2, a: 1 })
  );
});

test('a stored parse comes back, and a corrupted entry is dropped instead', () => {
  const key = cacheKey(Buffer.from('payload'), 'document', {});
  assert.equal(writeCache(WORKSPACE_ID, key, { ok: true, content: 'cached text' }), true);
  assert.equal(readCache(WORKSPACE_ID, key).content, 'cached text');

  fs.writeFileSync(path.join(cacheDir(WORKSPACE_ID), `${key}.json`), '{ truncated');
  assert.equal(readCache(WORKSPACE_ID, key), null);
  assert.equal(fs.existsSync(path.join(cacheDir(WORKSPACE_ID), `${key}.json`)), false);
});

test('the cache never lives where the model can see it', () => {
  const dir = cacheDir(WORKSPACE_ID);
  assert.ok(!dir.includes(path.sep + 'build_workspace'), 'not inside the workspace mount');
  assert.ok(!dir.includes(path.sep + 'attachments'), 'not inside the attachment projection');
});

test('a second read of the same file is served from the cache', async () => {
  clearParserCache(WORKSPACE_ID);
  const first = await parse(path.join(ROOT, 'report.pdf'), { workspaceId: WORKSPACE_ID });
  assert.notEqual(first.cached, true);

  const second = await parse(path.join(ROOT, 'report.pdf'), { workspaceId: WORKSPACE_ID });
  assert.equal(second.cached, true);
  assert.equal(second.content, first.content);
  assert.ok(Buffer.isBuffer(second.images[0].buffer), 'images survive the round trip as buffers');
  assert.equal(second.images[0].buffer.length, first.images[0].buffer.length);
});

test('editing a file misses its own cache entry rather than answering stale', async () => {
  const abs = await writePdf('mutable.pdf', ['First version of the text.']);
  const before = await parse(abs, { workspaceId: WORKSPACE_ID });
  assert.match(before.content, /First version/);

  await writePdf('mutable.pdf', ['Completely different words now.']);
  const after = await parse(abs, { workspaceId: WORKSPACE_ID });
  assert.notEqual(after.cached, true);
  assert.match(after.content, /Completely different/);
});

test('a failed parse is not cached, so a transient error is not remembered', async () => {
  clearParserCache(WORKSPACE_ID);
  const res = await parse(path.join(ROOT, 'broken.pdf'), { workspaceId: WORKSPACE_ID });
  assert.equal(res.ok, false);
  const entries = fs.existsSync(cacheDir(WORKSPACE_ID)) ? fs.readdirSync(cacheDir(WORKSPACE_ID)) : [];
  assert.equal(entries.length, 0);
});

test('the sweep drops expired entries and keeps fresh ones', () => {
  clearParserCache(WORKSPACE_ID);
  const fresh = cacheKey(Buffer.from('fresh'), 'document', {});
  const stale = cacheKey(Buffer.from('stale'), 'document', {});
  writeCache(WORKSPACE_ID, fresh, { ok: true });
  writeCache(WORKSPACE_ID, stale, { ok: true });

  const past = new Date(Date.now() - constants.WORKSPACE_TTL_MS - 60_000);
  fs.utimesSync(path.join(cacheDir(WORKSPACE_ID), `${stale}.json`), past, past);

  sweepParserCache();
  assert.equal(fs.existsSync(path.join(cacheDir(WORKSPACE_ID), `${fresh}.json`)), true);
  assert.equal(fs.existsSync(path.join(cacheDir(WORKSPACE_ID), `${stale}.json`)), false);
});

test('the global cap is a real bound, not a comment', () => {
  assert.equal(GLOBAL_CAP_BYTES, constants.PARSER_CACHE_CAP_MB * 1024 * 1024);
  const { keptBytes } = sweepParserCache();
  assert.ok(keptBytes <= GLOBAL_CAP_BYTES);
});

test('hashing a file that is not there returns nothing rather than throwing', () => {
  assert.equal(hashFile(path.join(ROOT, 'nope.bin')), null);
  assert.equal(hashFile(path.join(ROOT, 'notes.md')).length, 64);
});

// -- through read_file --------------------------------------------------------

test('read_file hands a parsed PDF to the model as text plus page images', async () => {
  const res = await readFile({ path: 'workspace/report.pdf' }, WORKSPACE_ID);
  assert.ok(Array.isArray(res), 'a PDF with rendered pages returns content parts');
  const envelope = JSON.parse(res[0].text);
  assert.equal(envelope.success, true);
  assert.equal(envelope.kind, 'document');
  assert.match(envelope.content, /Quarterly report/);
  assert.equal(envelope.metadata.path, 'workspace/report.pdf');
  assert.match(envelope.message, /page 1/);
  assert.equal(res[1].type, 'input_image');
});
