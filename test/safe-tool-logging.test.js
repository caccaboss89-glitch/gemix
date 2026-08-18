import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeToolArguments, summarizeToolResult } from '../src/utils/safeToolLogging.js';

test('tool argument logs expose keys and size but no values', () => {
  const secret = 'private user prompt with https://secret.example/token';
  const summary = summarizeToolArguments(JSON.stringify({ prompt: secret, reference_images: ['data:image/png;base64,ABC'] }));
  assert.match(summary, /argKeys=\[prompt,reference_images\]/);
  assert.doesNotMatch(summary, /private user|secret\.example|base64/);
});

test('tool result logs expose shape and success but no content', () => {
  const secret = 'sensitive generated text';
  const objectSummary = summarizeToolResult({ success: false, error: secret });
  const jsonSummary = summarizeToolResult(JSON.stringify({ success: true, message: secret }));
  const arraySummary = summarizeToolResult([
    { type: 'text', text: secret },
    { type: 'input_image', image_url: 'data:image/png;base64,ABC' }
  ]);
  for (const summary of [objectSummary, jsonSummary, arraySummary]) {
    assert.doesNotMatch(summary, /sensitive generated|base64/);
  }
  assert.match(objectSummary, /success=false/);
  assert.match(jsonSummary, /success=true/);
  assert.match(arraySummary, /partTypes=\[input_image,text\]/);
});
