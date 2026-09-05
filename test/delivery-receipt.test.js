import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDeliveryReceipt,
  deliveryFailureError,
  normalizeDeliveryReceipt
} from '../src/utils/deliveryReceipt.js';

test('delivery receipts distinguish complete, degraded and failed outcomes', () => {
  assert.equal(createDeliveryReceipt({ textAccepted: true }).status, 'complete');
  assert.equal(createDeliveryReceipt({ direct: 1, failures: [{ error: 'one file failed' }] }).status, 'degraded');
  const failed = createDeliveryReceipt({ failures: [{ error: 'nothing accepted' }] });
  assert.equal(failed.status, 'failed');
  assert.equal(deliveryFailureError(failed).code, 'EDELIVERY');
});

test('legacy delivery callbacks without a receipt remain complete', () => {
  assert.equal(normalizeDeliveryReceipt(undefined).status, 'complete');
});
