// test/openai-citations.test.js
//
// Phase 7: the two things that decide what a reply is allowed to say and send.
//
// Citations arrive as separate annotations on this provider instead of being
// written into the text, while images arrive only from structured SearXNG
// results. Both paths have to survive malformed data without corrupting the
// reply or promoting a URL nobody found.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { seedEnv, writeAuthFile } from './helpers/testEnv.js';

const AUTH_FILE = writeAuthFile();
seedEnv({ XAI_AUTH_FILE: AUTH_FILE, OPENAI_AUTH_FILE: AUTH_FILE });

const { applyCitationAnnotations, renderInlineCitations, sanitizeVoiceMessageText } =
  await import('../src/utils/text.js');
const { SseDecoder, ResponseAssembler, collectCitations } =
  await import('../src/ai/openaiResponsesProtocol.js');
const {
  MAX_REGISTERED_IMAGES,
  IMAGE_SOURCE,
  createImageRegistry,
  normalizeImageUrl,
  registerImageResults,
  registerUserUrls,
  lookupImage,
  sniffImageType,
  checkImageDelivery
} = await import('../src/utils/imageRegistry.js');
const { getProviderProfile, PROVIDER } = await import('../src/ai/providers/providerProfile.js');

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'openai');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const HTML = Buffer.from('<!doctype html><html><body>404 not found</body></html>');

/** Decode a whole SSE fixture into an assembled response. */
function assembleFixture(name) {
  const decoder = new SseDecoder();
  const assembler = new ResponseAssembler();
  for (const event of decoder.push(Buffer.from(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'), 'utf8'))) {
    assembler.apply(event);
  }
  for (const event of decoder.end()) assembler.apply(event);
  return assembler.toResponse();
}

// -- Citation normalizer -----------------------------------------------------

test('no citations leaves the text byte-identical (the xAI branch)', () => {
  const text = 'Grok already writes [[1]](https://x.ai/news) inline.';
  assert.equal(applyCitationAnnotations(text, []), text);
  assert.equal(applyCitationAnnotations(text, null), text);
  assert.equal(applyCitationAnnotations(text, undefined), text);
});

test('an anchored citation lands right after the span it supports', () => {
  const out = applyCitationAnnotations(
    'Il cielo e blu. La neve e bianca.',
    [{ url: 'https://example.invalid/a', quote: 'Il cielo e blu.' }]
  );
  assert.equal(out, 'Il cielo e blu.[[1]](https://example.invalid/a) La neve e bianca.');
});

test('citations keep document order and numbering across several spans', () => {
  const out = applyCitationAnnotations(
    'Prima frase. Seconda frase. Terza frase.',
    [
      { url: 'https://example.invalid/a', quote: 'Prima frase.' },
      { url: 'https://example.invalid/b', quote: 'Seconda frase.' },
      { url: 'https://example.invalid/c', quote: 'Terza frase.' }
    ]
  );
  assert.equal(
    out,
    'Prima frase.[[1]](https://example.invalid/a) Seconda frase.[[2]](https://example.invalid/b)'
    + ' Terza frase.[[3]](https://example.invalid/c)'
  );
});

test('a span repeated in the text takes the next occurrence, not the first again', () => {
  const out = applyCitationAnnotations(
    'stessa frase. stessa frase.',
    [
      { url: 'https://example.invalid/a', quote: 'stessa frase.' },
      { url: 'https://example.invalid/b', quote: 'stessa frase.' }
    ]
  );
  assert.equal(
    out,
    'stessa frase.[[1]](https://example.invalid/a) stessa frase.[[2]](https://example.invalid/b)'
  );
});

test('overlapping spans never duplicate or drop reply text', () => {
  const text = 'alfa beta gamma';
  const out = applyCitationAnnotations(text, [
    { url: 'https://example.invalid/a', quote: 'alfa beta' },
    { url: 'https://example.invalid/b', quote: 'beta gamma' }
  ]);
  // The second span starts inside the first, so it cannot anchor after it and
  // falls back to the end — the words themselves are untouched either way.
  assert.equal(out.replace(/\[\[\d+\]\]\([^)]*\)/g, ''), text);
});

test('a span that is not in the text puts its marker at the end', () => {
  const out = applyCitationAnnotations(
    'Testo finale.',
    [{ url: 'https://example.invalid/a', quote: 'span che non esiste' }]
  );
  assert.equal(out, 'Testo finale.[[1]](https://example.invalid/a)');
});

test('a citation with no usable span at all still reaches the source list', () => {
  const out = applyCitationAnnotations('Testo.', [{ url: 'https://example.invalid/a', quote: null }]);
  const rendered = renderInlineCitations(out);
  assert.match(rendered, /Fonti:/);
  assert.match(rendered, /\[1\] https:\/\/example\.invalid\/a/);
});

test('entries without a URL are skipped instead of shifting the numbering', () => {
  const out = applyCitationAnnotations('Testo.', [
    { url: '   ', quote: 'Testo.' },
    { url: 'https://example.invalid/a', quote: 'Testo.' }
  ]);
  assert.equal(out, 'Testo.[[1]](https://example.invalid/a)');
});

test('the normalized reply feeds the shared WhatsApp source list', () => {
  const out = renderInlineCitations(applyCitationAnnotations(
    'Il cielo e blu. La neve e bianca.',
    [
      { url: 'https://example.invalid/a', quote: 'Il cielo e blu.' },
      { url: 'https://example.invalid/b', quote: 'La neve e bianca.' }
    ]
  ));
  assert.match(out, /^Il cielo e blu\.\[1\] La neve e bianca\.\[2\]/);
  assert.match(out, /Fonti:\n\[1\] https:\/\/example\.invalid\/a\n\[2\] https:\/\/example\.invalid\/b$/);
});

test('a voice reply speaks the words and none of the citation markup', () => {
  const spoken = sanitizeVoiceMessageText(applyCitationAnnotations(
    'Il cielo e blu.',
    [{ url: 'https://example.invalid/a', quote: 'Il cielo e blu.' }]
  ));
  assert.equal(spoken, 'Il cielo e blu.');
});

test('collectCitations carries the cited span and drops out-of-range offsets', () => {
  const citations = collectCitations(assembleFixture('web-search.sse.txt'));
  assert.equal(citations.length, 2);
  assert.equal(citations[0].url, 'https://example.invalid/alpha');
  assert.equal(typeof citations[0].quote, 'string');
  assert.equal(citations[0].quote.length, citations[0].end - citations[0].start);
  // Out of range: no offsets, therefore no span to anchor on.
  assert.equal(citations[1].start, null);
  assert.equal(citations[1].quote, null);
});

test('annotations that index the JSON envelope never corrupt the parsed reply', () => {
  const response = assembleFixture('web-search.sse.txt');
  const citations = collectCitations(response);
  const reply = 'placeholder reply';
  const out = applyCitationAnnotations(reply, citations);
  // Offsets point into the JSON document, so neither span matches the reply and
  // both markers go to the end rather than inside a word.
  assert.equal(out, 'placeholder reply[[1]](https://example.invalid/alpha)[[2]](https://example.invalid/beta)');
});

// -- Image allowlist registry ------------------------------------------------

test('only the OpenAI profile enforces the allowlist', () => {
  assert.equal(getProviderProfile(PROVIDER.OPENAI).capabilities.imageAllowlist, true);
  assert.equal(getProviderProfile(PROVIDER.XAI).capabilities.imageAllowlist, false);
});

test('normalizeImageUrl accepts https and rejects everything else', () => {
  assert.equal(normalizeImageUrl('https://cdn.example.invalid/a.jpg'), 'https://cdn.example.invalid/a.jpg');
  assert.equal(normalizeImageUrl('https://cdn.example.invalid/a.jpg#frag'), 'https://cdn.example.invalid/a.jpg');
  assert.equal(normalizeImageUrl('http://cdn.example.invalid/a.jpg'), null);
  assert.equal(normalizeImageUrl('data:image/png;base64,AAAA'), null);
  assert.equal(normalizeImageUrl('https://user:pass@cdn.example.invalid/a.jpg'), null);
  assert.equal(normalizeImageUrl('not a url'), null);
  assert.equal(normalizeImageUrl(''), null);
});

test('SearXNG image results register with their source page, deduplicated', () => {
  const registry = createImageRegistry();
  const results = [
    { url: 'https://cdn.example.invalid/one.webp', sourcePage: 'https://example.invalid/gallery' },
    { url: 'https://cdn.example.invalid/one.webp', sourcePage: 'https://example.invalid/gallery' },
    { url: 'https://cdn.example.invalid/two.webp', sourcePage: 'https://example.invalid/other' }
  ];
  assert.equal(registerImageResults(registry, results, IMAGE_SOURCE.SEARCH), 2);
  const entry = lookupImage(registry, 'https://cdn.example.invalid/one.webp');
  assert.equal(entry.source, IMAGE_SOURCE.SEARCH);
  assert.equal(entry.sourcePage, 'https://example.invalid/gallery');
  // Re-registering the same hits adds nothing.
  assert.equal(registerImageResults(registry, results, IMAGE_SOURCE.SEARCH), 0);
});

test('the per-turn budget caps the registry', () => {
  const registry = createImageRegistry();
  const many = Array.from({ length: MAX_REGISTERED_IMAGES + 10 }, (_, i) => ({
    url: `https://cdn.example.invalid/${i}.jpg`
  }));
  assert.equal(registerImageResults(registry, many, IMAGE_SOURCE.SEARCH), MAX_REGISTERED_IMAGES);
  assert.equal(registry.overflowed, true);
  assert.equal(lookupImage(registry, `https://cdn.example.invalid/${MAX_REGISTERED_IMAGES + 5}.jpg`), null);
});

test('URLs the user wrote are registered, model prose is not', () => {
  const registry = createImageRegistry();
  registerUserUrls(registry, 'guarda questa https://cdn.example.invalid/mine.jpg e dimmi');
  assert.equal(lookupImage(registry, 'https://cdn.example.invalid/mine.jpg').source, IMAGE_SOURCE.USER);
  assert.equal(lookupImage(registry, 'https://cdn.example.invalid/other.jpg'), null);
});

test('a made-up image URL is refused even when it downloads', () => {
  const registry = createImageRegistry();
  const check = checkImageDelivery(registry, {
    url: 'https://cdn.example.invalid/invented.jpg',
    finalUrl: 'https://cdn.example.invalid/invented.jpg',
    att: { name: 'invented.jpg', mimetype: 'image/png', buffer: PNG }
  });
  assert.equal(check.ok, false);
  assert.match(check.reason, /structured search results/);
});

test('a registered image passes and keeps its registry entry', () => {
  const registry = createImageRegistry();
  registerImageResults(registry, [{
    url: 'https://cdn.example.invalid/one.png',
    source_page: 'https://example.invalid/gallery'
  }], IMAGE_SOURCE.SEARCH);
  const check = checkImageDelivery(registry, {
    url: 'https://cdn.example.invalid/one.png',
    finalUrl: 'https://cdn.example.invalid/one.png',
    att: { name: 'one.png', mimetype: 'image/png', buffer: PNG }
  });
  assert.equal(check.ok, true);
  assert.equal(check.entry.sourcePage, 'https://example.invalid/gallery');
});

test('a registered URL that redirects off https is refused at its destination', () => {
  const registry = createImageRegistry();
  registerImageResults(registry, [{ url: 'https://cdn.example.invalid/one.png' }], IMAGE_SOURCE.SEARCH);
  const check = checkImageDelivery(registry, {
    url: 'https://cdn.example.invalid/one.png',
    finalUrl: 'http://cdn.example.invalid/one.png',
    att: { name: 'one.png', mimetype: 'image/png', buffer: PNG }
  });
  assert.equal(check.ok, false);
  assert.match(check.reason, /redirected off https/);
});

test('a body that is not really an image is refused', () => {
  const registry = createImageRegistry();
  registerImageResults(registry, [{ url: 'https://cdn.example.invalid/one.png' }], IMAGE_SOURCE.SEARCH);
  const check = checkImageDelivery(registry, {
    url: 'https://cdn.example.invalid/one.png',
    att: { name: 'one.png', mimetype: 'image/png', buffer: HTML }
  });
  assert.equal(check.ok, false);
  assert.match(check.reason, /not a recognized image/);
});

test('image bytes served under a lying content-type are still gated', () => {
  const registry = createImageRegistry();
  const check = checkImageDelivery(registry, {
    url: 'https://cdn.example.invalid/one.bin',
    att: { name: 'one.bin', mimetype: 'application/octet-stream', buffer: PNG }
  });
  assert.equal(check.ok, false);
});

test('non-image attachments are not gated by the image allowlist', () => {
  const registry = createImageRegistry();
  const pdf = checkImageDelivery(registry, {
    url: 'https://example.invalid/report.pdf',
    att: { name: 'report.pdf', mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.7 fake') }
  });
  assert.equal(pdf.ok, true);
  assert.equal(pdf.entry, undefined);
});

test('an image too large to hold in memory is not promoted', () => {
  const registry = createImageRegistry();
  registerImageResults(registry, [{ url: 'https://cdn.example.invalid/huge.jpg' }], IMAGE_SOURCE.SEARCH);
  const check = checkImageDelivery(registry, {
    url: 'https://cdn.example.invalid/huge.jpg',
    att: { name: 'huge.jpg', mimetype: 'image/jpeg', externalUrl: 'https://cdn.example.invalid/huge.jpg' }
  });
  assert.equal(check.ok, false);
  assert.match(check.reason, /too large/);
});

test('sniffImageType reads the real format, not the extension', () => {
  assert.equal(sniffImageType(PNG).mime, 'image/png');
  assert.equal(sniffImageType(HTML), null);
  assert.equal(sniffImageType(Buffer.alloc(4)), null);
  assert.equal(sniffImageType('not a buffer'), null);
});
