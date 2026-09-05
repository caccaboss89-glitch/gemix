const XAI_GUIDANCE_RE = /\bxAI\b|\bGrok\b|\bx_search\b|X posts|X\/Twitter|CDN URL|SuperGrok/i;

function containsXaiOnlyMaterial(text) {
  return XAI_GUIDANCE_RE.test(text);
}

export { containsXaiOnlyMaterial };
