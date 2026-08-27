import assert from 'node:assert/strict';
import test from 'node:test';

import constants from '../src/config/constants.js';
import {
  IMAGE_GENERATION_PROGRESS_PREFIX,
  VIDEO_GENERATION_PROGRESS_PREFIX,
  isSystemMessage
} from '../src/config/systemMessages.js';
import { sendIntermediateNotification } from '../src/utils/intermediateNotification.js';
import { clearCallNotifications } from '../src/utils/notificationDedup.js';

test('media progress banners are program notifications, not assistant replies', () => {
  assert.equal(isSystemMessage(`${IMAGE_GENERATION_PROGRESS_PREFIX}, attendi un attimo...`), true);
  assert.equal(isSystemMessage(`${VIDEO_GENERATION_PROGRESS_PREFIX} (può richiedere qualche minuto)`), true);
});

test('personal WhatsApp progress is stored without a GemiX assistant footer', async () => {
  const sent = [];
  const ctx = {
    platform: constants.PLATFORM_WA_PERSONAL,
    chatId: 'personal-test',
    requestId: 'system-progress-test',
    presence: { chat: { sendMessage: async (text) => sent.push(text) } }
  };

  try {
    const delivered = await sendIntermediateNotification(
      ctx,
      'image_gen',
      '🎨 Sto generando l\'immagine, attendi un attimo...'
    );
    assert.equal(delivered, true);
    assert.deepEqual(sent, ['🎨 Sto generando l\'immagine, attendi un attimo...']);
    assert.equal(isSystemMessage(sent[0]), true);
  } finally {
    clearCallNotifications(ctx);
  }
});
