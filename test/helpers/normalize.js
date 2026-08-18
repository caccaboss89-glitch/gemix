// test/helpers/normalize.js
//
// Golden dumps capture the model-visible surface, which contains a handful of
// values that move on their own (wall clock, per-user quota counters read from
// disk). Those values are replaced with stable placeholders so a golden failure
// always means a real prompt/tool/schema change.

/** Values that move without a code change, replaced before comparing. */
const VOLATILE_PATTERNS = [
  { re: /Time \(Europe\/Rome\): [^\n]*/g, to: 'Time (Europe/Rome): <TIME>' },
  { re: /Video: \d+\/\d+ · Immagini: \d+\/\d+ · Canzoni: \d+\/\d+/g, to: '<QUOTA>' }
];

/**
 * @param {string} text
 * @returns {string} the same dump with volatile values masked
 */
function normalizeDump(text) {
  let out = String(text).replace(/\r\n/g, '\n');
  for (const { re, to } of VOLATILE_PATTERNS) out = out.replace(re, to);
  return out;
}

export { normalizeDump };
