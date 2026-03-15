const googleTTS = require('google-tts-api');

/**
 * Generate voice audio from text using Google Translate TTS.
 * @param {string} text - Text to speak
 * @param {string} language - Language code (default: 'it')
 * @param {number} speed - Speed (< 0.8 = slow, >= 0.8 = normal)
 * @returns {Buffer} MP3 audio buffer
 */
async function generateVoice(text, language = 'it', speed = 1.0) {
  const urls = googleTTS.getAllAudioUrls(text, {
    lang: language || 'it',
    slow: speed < 0.8,
    host: 'https://translate.google.com',
  });

  // Fetch all chunks in parallel for speed
  const buffers = await Promise.all(
    urls.map(async ({ url }) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`TTS download failed: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    })
  );

  return Buffer.concat(buffers);
}

module.exports = { generateVoice };
