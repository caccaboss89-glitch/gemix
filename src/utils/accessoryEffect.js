/** Run a non-essential side effect without changing the primary operation. */
async function runAccessoryEffect(effect, { label = 'Accessory effect', log = null } = {}) {
  try {
    return { ok: true, value: await effect() };
  } catch (error) {
    log?.warn?.(`${label} failed: ${error?.message || error}`);
    return { ok: false, error };
  }
}

export { runAccessoryEffect };
