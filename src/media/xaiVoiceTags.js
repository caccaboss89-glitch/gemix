// xAI TTS expressive markup. This catalog stays behind the media boundary:
// generic providers and Google TTS never receive it, while schema generation,
// spoken-text sanitization and text fallback stripping share one definition.

const XAI_INLINE_VOICE_TAG_NAMES = Object.freeze([
  'pause', 'long-pause', 'hum-tune', 'laugh', 'chuckle', 'giggle', 'cry', 'tsk',
  'tongue-click', 'lip-smack', 'breath', 'inhale', 'exhale', 'sigh'
]);

const XAI_WRAPPING_VOICE_TAG_NAMES = Object.freeze([
  'soft', 'whisper', 'loud', 'build-intensity', 'decrease-intensity', 'higher-pitch',
  'lower-pitch', 'slow', 'fast', 'sing-song', 'singing', 'laugh-speak', 'emphasis'
]);

export {
  XAI_INLINE_VOICE_TAG_NAMES,
  XAI_WRAPPING_VOICE_TAG_NAMES
};
