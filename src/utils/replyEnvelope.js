// src/utils/replyEnvelope.js
//
// The single shape a turn hands back to a platform sender.
//
// Every exit of the handler — the maintenance gate, a provider refusal, the
// normal reply, the forced wrap-up, the privacy gate — returns the same object,
// so a sender never has to guess which fields are present. The three builders
// below differ only in what the turn produced:
//
//   textReply    the model answered, possibly with attachments
//   systemReply  the program answered on its own (banner, refusal, notice):
//                no model behind it, so never any attachment
//   voiceReply   the answer is spoken; `text` stays null and the transcript
//                travels alongside so history can render it later
//
// `systemMessage` is what tells a sender the text is program-authored rather
// than something GemiX wrote.

/**
 * A reply carrying model-authored text and/or files.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.text]
 * @param {Array} [opts.attachments]
 * @param {string} [opts.discordTitle]
 * @param {string|null} [opts.modelUsed]
 * @param {boolean} [opts.systemMessage]
 * @returns {object}
 */
function textReply({
  text = null,
  attachments = [],
  discordTitle = '',
  modelUsed = null,
  systemMessage = false
} = {}) {
  return {
    text,
    voiceBuffer: null,
    isVoiceOnly: false,
    attachments,
    discordTitle,
    modelUsed,
    systemMessage
  };
}

/**
 * A program-authored reply. No model produced it and no file goes with it, so
 * both are fixed here rather than left to each call site.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.discordTitle]
 * @param {string|null} [opts.modelUsed]
 * @returns {object}
 */
function systemReply(text, { discordTitle = '', modelUsed = null } = {}) {
  return textReply({ text, discordTitle, modelUsed, systemMessage: true });
}

/**
 * A spoken reply. The text is in the audio, so `text` stays null; the
 * transcript is kept so the chat's history can show what was said.
 *
 * @param {object} opts
 * @param {Buffer} opts.voiceBuffer
 * @param {Array} [opts.attachments]
 * @param {string} [opts.discordTitle]
 * @param {string|null} [opts.modelUsed]
 * @param {string} opts.transcriptText
 * @param {string|null} [opts.transcriptChatId]
 * @param {string|null} [opts.researchFooter]
 * @returns {object}
 */
function voiceReply({
  voiceBuffer,
  attachments = [],
  discordTitle = '',
  modelUsed = null,
  transcriptText,
  transcriptChatId = null,
  researchFooter = null
}) {
  return {
    text: null,
    voiceBuffer,
    isVoiceOnly: true,
    attachments,
    discordTitle,
    modelUsed,
    systemMessage: false,
    voiceTranscriptText: transcriptText,
    voiceTranscriptChatId: transcriptChatId,
    researchFooter
  };
}

export { textReply, systemReply, voiceReply };
