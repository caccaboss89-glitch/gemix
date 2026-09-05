/** Normalize an absolute HTTP(S) base URL, or return null when invalid. */
function normalizeHttpBaseUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export { normalizeHttpBaseUrl };
