// src/media/ttsVoices.js
//
// The two voices GemiX speaks with. The preference is a gender, not a product
// name: it is the same choice on every provider profile and on both TTS
// backends, so switching from Cartesia to the Edge fallback mid-month never
// changes what the user asked for.
//
// Each backend maps the gender to its own voice. Cartesia's Sonic voices are
// multilingual (the language travels in the request), so one pair covers every
// supported reply language; Edge voices are locale-bound, so the fallback needs
// one verified pair per language GemiX can reply in.

/** The only two values the `voice` preference can take. */
const TTS_VOICES = Object.freeze(['male', 'female']);

/** Cartesia public voice ids: Marco (male) and Giulia (female), both it-IT. */
const CARTESIA_VOICE_IDS = Object.freeze({
  male: '79693aee-1207-4771-a01e-20c393c89e6f',
  female: '36d94908-c5b9-4014-b521-e69aee5bead0'
});

/**
 * Edge Neural voices, one pair per code in VALID_LANGUAGES (settingsStore.js).
 * A language absent here falls back to Italian, the deployment default.
 */
const EDGE_VOICES = Object.freeze({
  en: { male: 'en-US-AndrewNeural', female: 'en-US-AvaNeural', lang: 'en-US' },
  'ar-EG': { male: 'ar-EG-ShakirNeural', female: 'ar-EG-SalmaNeural', lang: 'ar-EG' },
  'ar-SA': { male: 'ar-SA-HamedNeural', female: 'ar-SA-ZariyahNeural', lang: 'ar-SA' },
  'ar-AE': { male: 'ar-AE-HamdanNeural', female: 'ar-AE-FatimaNeural', lang: 'ar-AE' },
  bn: { male: 'bn-IN-BashkarNeural', female: 'bn-IN-TanishaaNeural', lang: 'bn-IN' },
  zh: { male: 'zh-CN-YunxiNeural', female: 'zh-CN-XiaoxiaoNeural', lang: 'zh-CN' },
  fr: { male: 'fr-FR-HenriNeural', female: 'fr-FR-DeniseNeural', lang: 'fr-FR' },
  de: { male: 'de-DE-ConradNeural', female: 'de-DE-KatjaNeural', lang: 'de-DE' },
  hi: { male: 'hi-IN-MadhurNeural', female: 'hi-IN-SwaraNeural', lang: 'hi-IN' },
  id: { male: 'id-ID-ArdiNeural', female: 'id-ID-GadisNeural', lang: 'id-ID' },
  it: { male: 'it-IT-DiegoNeural', female: 'it-IT-ElsaNeural', lang: 'it-IT' },
  ja: { male: 'ja-JP-KeitaNeural', female: 'ja-JP-NanamiNeural', lang: 'ja-JP' },
  ko: { male: 'ko-KR-InJoonNeural', female: 'ko-KR-SunHiNeural', lang: 'ko-KR' },
  'pt-BR': { male: 'pt-BR-AntonioNeural', female: 'pt-BR-FranciscaNeural', lang: 'pt-BR' },
  'pt-PT': { male: 'pt-PT-DuarteNeural', female: 'pt-PT-RaquelNeural', lang: 'pt-PT' },
  ru: { male: 'ru-RU-DmitryNeural', female: 'ru-RU-SvetlanaNeural', lang: 'ru-RU' },
  'es-MX': { male: 'es-MX-JorgeNeural', female: 'es-MX-DaliaNeural', lang: 'es-MX' },
  'es-ES': { male: 'es-ES-AlvaroNeural', female: 'es-ES-ElviraNeural', lang: 'es-ES' },
  tr: { male: 'tr-TR-AhmetNeural', female: 'tr-TR-EmelNeural', lang: 'tr-TR' },
  vi: { male: 'vi-VN-NamMinhNeural', female: 'vi-VN-HoaiMyNeural', lang: 'vi-VN' }
});

const FALLBACK_LANGUAGE = 'it';

/** Normalize any stored value to one of TTS_VOICES. */
function normalizeVoice(voice, fallback = TTS_VOICES[0]) {
  const value = String(voice || '').trim().toLowerCase();
  return TTS_VOICES.includes(value) ? value : fallback;
}

/** Cartesia voice id for a gender. */
function cartesiaVoiceId(voice) {
  return CARTESIA_VOICE_IDS[normalizeVoice(voice)];
}

/**
 * Base language code Cartesia's Sonic models take (`it`, `pt`, `es`, ...).
 * The regional variants GemiX offers differ only in the Edge voice.
 */
function cartesiaLanguage(language) {
  return String(language || FALLBACK_LANGUAGE).split('-')[0].toLowerCase();
}

/**
 * Edge Neural voice and locale for a gender and reply language.
 * @returns {{ voice: string, lang: string }}
 */
function edgeVoice(voice, language) {
  const entry = EDGE_VOICES[language] || EDGE_VOICES[FALLBACK_LANGUAGE];
  return { voice: entry[normalizeVoice(voice)], lang: entry.lang };
}

export {
  TTS_VOICES,
  normalizeVoice,
  cartesiaVoiceId,
  cartesiaLanguage,
  edgeVoice
};
