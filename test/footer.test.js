import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addFooter,
  addScheduledFooter,
  hasFooter,
  removeFooter,
  removeScheduledFooter
} from '../src/utils/footer.js';

test('GemiX footers use WhatsApp quote formatting and recognize the legacy format', () => {
  assert.equal(addFooter('Risposta', 'GPT-5'), 'Risposta\n\n> GemiX • GPT-5');
  assert.match(
    addScheduledFooter('Promemoria', '2026-09-15T12:00:00.000Z'),
    /^Promemoria\n\n> GemiX • Messaggio Programmato il /
  );
  assert.equal(removeFooter('Risposta\n\n> GemiX • GPT-5'), 'Risposta');
  assert.equal(removeFooter('Risposta\n\n--GemiX • GPT-5'), 'Risposta');
  assert.equal(
    removeScheduledFooter('Promemoria\n\n> GemiX • Messaggio Programmato il 15/09/2026, 14:00'),
    'Promemoria'
  );
  assert.equal(hasFooter('Risposta\n\n> GemiX • GPT-5'), true);
  assert.equal(hasFooter('Risposta\n\n--GemiX • GPT-5'), true);
});
