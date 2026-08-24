// src/ai/providers/wireCapabilities.js
//
// What a provider must be able to do on the wire before GemiX will talk to it.
//
// These are deliberately NOT user features. "The provider offers hosted web
// search" is not a wire capability — it is something GemiX ignores.
// A wire capability is only ever about the protocol itself: can this endpoint
// carry the conversation, the tools, the schema and the reasoning GemiX needs.
// Feature bindings answer the other question, and they win.
//
// The minimum contract is a POST /responses that streams
// SSE, reliable client-side function calling, strict json_schema structured
// output, stateless reasoning replay, and a main model that can at least see.

/** Every flag a profile may declare. */
const WIRE_CAPABILITY = Object.freeze({
  RESPONSES: 'supportsResponses',
  SSE: 'supportsSse',
  FUNCTION_CALLING: 'supportsFunctionCalling',
  STRICT_STRUCTURED_OUTPUT: 'supportsStrictStructuredOutput',
  REASONING_REPLAY: 'supportsReasoningReplay',
  IMAGE_INPUT: 'supportsImageInput',
  /** Reserved hook; no backend currently declares it. */
  NATIVE_AUDIO_INPUT: 'nativeAudioInput',
  /** Reserved hook; no backend currently declares it. */
  NATIVE_VIDEO_INPUT: 'nativeVideoInput'
});

/** Flags that must all be true for a provider to be usable as the main brain. */
const REQUIRED_WIRE_CAPABILITIES = Object.freeze([
  WIRE_CAPABILITY.RESPONSES,
  WIRE_CAPABILITY.SSE,
  WIRE_CAPABILITY.FUNCTION_CALLING,
  WIRE_CAPABILITY.STRICT_STRUCTURED_OUTPUT,
  WIRE_CAPABILITY.REASONING_REPLAY,
  WIRE_CAPABILITY.IMAGE_INPUT
]);

const DEFAULTS = Object.freeze({
  [WIRE_CAPABILITY.RESPONSES]: false,
  [WIRE_CAPABILITY.SSE]: false,
  [WIRE_CAPABILITY.FUNCTION_CALLING]: false,
  [WIRE_CAPABILITY.STRICT_STRUCTURED_OUTPUT]: false,
  [WIRE_CAPABILITY.REASONING_REPLAY]: false,
  [WIRE_CAPABILITY.IMAGE_INPUT]: false,
  [WIRE_CAPABILITY.NATIVE_AUDIO_INPUT]: false,
  [WIRE_CAPABILITY.NATIVE_VIDEO_INPUT]: false
});

/**
 * A frozen capability set. Every undeclared flag defaults to false, so
 * capabilities always require an explicit declaration.
 *
 * @param {object} declared
 * @returns {Readonly<object>}
 */
function defineWireCapabilities(declared = {}) {
  const out = { ...DEFAULTS };
  for (const [key, value] of Object.entries(declared)) {
    if (!(key in DEFAULTS)) {
      throw new Error(`Unknown wire capability "${key}". Add it to WIRE_CAPABILITY first.`);
    }
    out[key] = value === true;
  }
  return Object.freeze(out);
}

/**
 * Check a declared capability set against the minimum contract.
 *
 * @param {object} capabilities
 * @returns {{ ok: boolean, missing: string[] }}
 */
function validateWireCapabilities(capabilities) {
  const caps = capabilities || {};
  const missing = REQUIRED_WIRE_CAPABILITIES.filter(flag => caps[flag] !== true);
  return { ok: missing.length === 0, missing };
}

export {
  REQUIRED_WIRE_CAPABILITIES,
  defineWireCapabilities,
  validateWireCapabilities
};
