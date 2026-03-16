const googleTTS = require('google-tts-api');
const { spawn } = require('child_process');

function convertMp3ToWhatsAppOpus(mp3Buffer) {
  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-vn',
      '-ar',
      '48000',
      '-ac',
      '1',
      '-c:a',
      'libopus',
      '-b:a',
      '32k',
      '-vbr',
      'on',
      '-compression_level',
      '10',
      '-application',
      'voip',
      '-f',
      'ogg',
      'pipe:1',
    ];

    const ffmpegCmd = process.env.FFMPEG_PATH || 'ffmpeg';
    const ffmpeg = spawn(ffmpegCmd, ffmpegArgs);
    const chunks = [];
    let stderr = '';

    ffmpeg.stdout.on('data', chunk => chunks.push(chunk));
    ffmpeg.stderr.on('data', data => {
      stderr += data.toString();
    });
    ffmpeg.on('error', err => {
      reject(new Error(`FFmpeg non trovato o non avviabile: ${err.message}`));
    });
    ffmpeg.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`Conversione audio FFmpeg fallita (code ${code}): ${stderr || 'errore sconosciuto'}`));
      }
      resolve(Buffer.concat(chunks));
    });

    ffmpeg.stdin.end(mp3Buffer);
  });
}

/**
 * Generate voice audio from text using Google Translate TTS.
 * @param {string} text - Text to speak
 * @param {string} language - Language code (default: 'it')
 * @param {number} speed - Speed (< 0.8 = slow, >= 0.8 = normal)
 * @returns {Buffer} OGG/Opus audio buffer (48kHz mono, iOS-safe for WhatsApp voice speed)
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

  const mp3Buffer = Buffer.concat(buffers);
  return convertMp3ToWhatsAppOpus(mp3Buffer);
}

module.exports = { generateVoice };
