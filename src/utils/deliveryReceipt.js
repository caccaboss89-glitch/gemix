// Normalized platform response receipt. It describes what the platform
// accepted, including partial attachment fallbacks, without claiming end-user
// delivery or reading.

function createDeliveryReceipt({ textAccepted = false, direct = 0, linked = 0, failures = [] } = {}) {
  const normalizedFailures = (Array.isArray(failures) ? failures : [])
    .filter(Boolean)
    .map(failure => typeof failure === 'string' ? { error: failure } : failure);
  const accepted = Boolean(textAccepted) || direct > 0 || linked > 0;
  const status = !accepted
    ? 'failed'
    : (normalizedFailures.length > 0 ? 'degraded' : 'complete');
  return Object.freeze({
    status,
    textAccepted: Boolean(textAccepted),
    direct: Math.max(0, Number(direct) || 0),
    linked: Math.max(0, Number(linked) || 0),
    failures: normalizedFailures
  });
}

function normalizeDeliveryReceipt(value) {
  if (!value || !['complete', 'degraded', 'failed'].includes(value.status)) {
    return createDeliveryReceipt({ textAccepted: true });
  }
  return createDeliveryReceipt(value);
}

function deliveryFailureError(receipt) {
  const detail = receipt.failures.map(item => item.error).filter(Boolean).join('; ');
  const error = new Error(detail || 'The platform accepted no part of the response.');
  error.code = 'EDELIVERY';
  error.receipt = receipt;
  return error;
}

export { createDeliveryReceipt, normalizeDeliveryReceipt, deliveryFailureError };
