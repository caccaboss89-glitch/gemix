import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function readSections(file) {
  const sections = {};
  let section = '';
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const heading = /^# --- (.+?) -+$/.exec(line);
    if (heading) section = heading[1];
    const key = /^\s*#?\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    if (key) sections[key[1]] = section;
  }
  return sections;
}

function structure(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map(line => {
    const key = /^\s*#?\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    return key ? `${key[1]}=` : line.trimEnd();
  }).filter(Boolean);
}

test('.env and .env.example mirror keys, sections, order and comments', {
  skip: !fs.existsSync('.env') && 'Local deployment configuration is not present in clean checkouts'
}, () => {
  const actual = readSections('.env');
  const example = readSections('.env.example');
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(example).sort());
  for (const key of Object.keys(actual)) assert.equal(actual[key], example[key], key);
  assert.deepEqual(structure('.env'), structure('.env.example'), 'key order and explanatory comments');
});
