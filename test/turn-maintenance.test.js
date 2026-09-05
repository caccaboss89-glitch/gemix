import assert from 'node:assert/strict';
import test from 'node:test';

import { extractLeadingCommand, handleMaintenanceAdmission } from '../src/ai/turnMaintenance.js';
import constants from '../src/config/constants.js';

const identity = {
  isAdmin: false,
  taskFileId: 'test-user',
  member: { wa: '393331234567@c.us' }
};

test('extractLeadingCommand returns only the first body token', () => {
  assert.equal(extractLeadingCommand('/updates please'), '/updates');
  assert.equal(
    extractLeadingCommand('[02/09/2026, 12:00] User: /updates please'),
    '/updates'
  );
  assert.equal(extractLeadingCommand([{ type: 'input_text', text: '/UPDATES now' }]), '/updates');
});

test('maintenance subscription is persisted before it is confirmed or mirrored', async () => {
  const order = [];
  const response = await handleMaintenanceAdmission({
    platform: constants.PLATFORM_DISCORD,
    chatId: 'discord-thread',
    content: '/updates please',
    isGroup: false
  }, identity, {
    maintenanceMode: true,
    adminOnly: true,
    async enableReleaseNotify() {
      await Promise.resolve();
      order.push('persisted');
      return { success: true, alreadyEnabled: false };
    },
    async sendWhatsAppDirect() {
      order.push('mirrored');
    }
  });

  order.push('returned');
  assert.deepEqual(order, ['persisted', 'mirrored', 'returned']);
  assert.match(response.text, /aggiornamento/i);
});

test('maintenance subscription failure is reported and never mirrored', async () => {
  let mirrors = 0;
  const response = await handleMaintenanceAdmission({
    platform: constants.PLATFORM_DISCORD,
    chatId: 'discord-thread',
    content: '/updates',
    isGroup: false
  }, identity, {
    maintenanceMode: true,
    adminOnly: true,
    async enableReleaseNotify() {
      return { success: false, error: 'disk unavailable' };
    },
    async sendWhatsAppDirect() {
      mirrors++;
    }
  });

  assert.equal(mirrors, 0);
  assert.match(response.text, /non sono riuscito/i);
});
