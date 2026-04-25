// src/platforms/discord/client.js
const { Client, GatewayIntentBits, Partials, AttachmentBuilder } = require('discord.js');
const { BOT_TOKEN, GUILD_ID } = require('../../config/env');
const { DISCORD_THREAD_NAME, MAX_HISTORY, MAX_AUDIO_DURATION_S, MAX_VIDEO_DURATION_S, MAX_DOC_PAGES } = require('../../config/constants');
const { handleMessage } = require('../../handler');
const { identifyUser } = require('../../utils/userIdentifier');
const { formatTimestamp } = require('../../utils/time');
const { mediaToContentPart, extractTextFromPdfBuffer, buildAttachmentTag } = require('../../utils/media');
const { getMediaDurationSec } = require('../../utils/mediaDuration');
const { retrieveVoiceText } = require('../../utils/voiceTextCache');
const responseLock = require('../../utils/responseLock');
const { createLogger } = require('../../utils/logger');
const { syncFileToHistory } = require('../../utils/historySync');
const { toDiscordAttachmentArgs } = require('../../utils/attachments');

const log = createLogger('DISCORD');

let discordClient;

/**
 * Initialize Discord bot client.
 * Sets up event handlers for client ready state and message creation in threads.
 * Bot will only respond in threads within the "gemix" forum category.
 * @returns {object} The discord.js Client instance
 */
function initDiscord() {
  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildScheduledEvents,
    ],
    partials: [Partials.Message, Partials.Channel],
  });

  discordClient.on('clientReady', () => {
    log.info(`✅ Bot ready: ${discordClient.user.tag}`);
  });

  discordClient.on('messageCreate', async (msg) => {
    try {
      await onDiscordMessage(msg);
    } catch (err) {
      log.error(`\n❌ Critical error:`);
      log.error(`   ${err.message}`);
      log.error(`   Stack: ${err.stack?.split('\n').slice(0, 3).join('\n   ')}`);
    }
  });

  discordClient.login(BOT_TOKEN).catch(err => {
    log.error('❌ Discord login failed:', err.message);
    process.exit(1);
  });
  return discordClient;
}

/**
 * Split a long text into Discord-compatible chunks (max 2000 chars).
 * Preserves line boundaries; only splits mid-line when a single line exceeds the limit.
 * @param {string} text - Message text to split
 * @param {number} [maxLen=2000] - Maximum characters per chunk
 * @returns {string[]} Array of chunks, each within maxLen
 */
function splitDiscordMessage(text, maxLen = 2000) {
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    const separator = current ? '\n' : '';
    if ((current + separator + line).length > maxLen) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      if (line.length > maxLen) {
        // Single line exceeds limit: split on last space within maxLen
        let rest = line;
        while (rest.length > maxLen) {
          const cut = rest.lastIndexOf(' ', maxLen);
          const pos = cut > 0 ? cut : maxLen;
          chunks.push(rest.substring(0, pos).trimEnd());
          rest = rest.substring(pos).trimStart();
        }
        current = rest;
      } else {
        current = line;
      }
    } else {
      current = current + separator + line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function onDiscordMessage(msg) {
  if (msg.author.id === discordClient.user.id) return;
  if (msg.author.bot) return;

  const channel = msg.channel;
  if (!channel.isThread()) return;

  const parent = channel.parent;
  if (!parent) return;

  if (parent.name.toLowerCase() !== DISCORD_THREAD_NAME) return;

  const starterMessage = await channel.fetchStarterMessage().catch(() => null);
  if (starterMessage && msg.id === starterMessage.id) return;

  const guild = discordClient.guilds.cache.get(GUILD_ID);
  let guildMember = null;
  try {
    guildMember = await guild.members.fetch(msg.author.id);
  } catch { }

  const userIdentity = identifyUser({
    platform: 'discord',
    userId: msg.author.id,
    discordUsername: msg.author.username,
    discordDisplayName: msg.author.displayName || msg.author.globalName,
    discordNickname: guildMember?.nickname,
  });

  const history = await buildDiscordHistory(channel, starterMessage?.id);

  const contentParts = [];
  let textBody = msg.content || '';

  let quotedMediaParts = [];
  if (msg.reference) {
    try {
      const quotedMsg = await channel.messages.fetch(msg.reference.messageId);
      if (quotedMsg) {
        if (quotedMsg.attachments.size > 0) {
          const filetags = [...quotedMsg.attachments.values()]
            .map(att => `[${att.name}]`)
            .join(' ');

          let replyPrefix = `[In reply to: ${filetags}]\n`;

          // Process quoted attachments
          for (const att of quotedMsg.attachments.values()) {
            const ext = (att.name || '').split('.').pop().toLowerCase();
            const isImage = att.contentType?.startsWith('image/');
            const isAudio = att.contentType?.startsWith('audio/');
            const isPdf = att.contentType === 'application/pdf' || ext === 'pdf';
            const isVideo = att.contentType?.startsWith('video/');

            if (isImage || isAudio || isVideo) {
              try {
                const res = await fetch(att.url);
                const buffer = Buffer.from(await res.arrayBuffer());
                quotedMediaParts.push(mediaToContentPart(buffer, att.contentType));
              } catch { }
            } else if (isPdf) {
              try {
                const res = await fetch(att.url);
                const buffer = Buffer.from(await res.arrayBuffer());
                const info = await extractTextFromPdfBuffer(buffer);
                if (info.success && info.pages <= MAX_DOC_PAGES) {
                  replyPrefix = `[In reply to: ${filetags}]\n\n<Transcription>\n${info.text}\n</Transcription>\n`;
                }
              } catch { }
            }
          }
          textBody = replyPrefix + textBody;
        } else if (quotedMsg.content) {
          textBody = `[In reply to: ${quotedMsg.content}]\n` + textBody;
        }
      }
    } catch { }
  }

  for (const att of msg.attachments.values()) {
    const ext = (att.name || '').split('.').pop().toLowerCase();
    const isImage = att.contentType?.startsWith('image/');
    const isAudio = att.contentType?.startsWith('audio/');
    const isDoc = att.contentType?.startsWith('application/') || ['pdf', 'txt', 'doc', 'docx', 'csv', 'json'].includes(ext);
    const isVideo = att.contentType?.startsWith('video/');

    const fetchBuffer = async () => Buffer.from(await (await fetch(att.url)).arrayBuffer());
    const syncedPath = await syncFileToHistory(msg.author.id, att.id, fetchBuffer, att.name);
    const attachmentTag = buildAttachmentTag(syncedPath, att.name);

    if (isVideo) {
      try {
        const buffer = await fetchBuffer();
        const dur = await getMediaDurationSec(buffer, ext);
        if (dur != null && dur > MAX_VIDEO_DURATION_S) {
          textBody = `${attachmentTag} (video too long: ${Math.round(dur)}s, max ${MAX_VIDEO_DURATION_S}s) ${textBody}`.trim();
        } else {
          contentParts.push(mediaToContentPart(buffer, att.contentType));
          textBody = `${attachmentTag} ${textBody}`.trim();
        }
      } catch {
        textBody = `${attachmentTag} ${textBody}`.trim();
      }
    } else if (isAudio) {
      const audioDuration = Number(att.duration || 0);
      if (audioDuration > MAX_AUDIO_DURATION_S) {
        textBody = `${attachmentTag} (audio too long: ${audioDuration}s, max ${MAX_AUDIO_DURATION_S}s) ${textBody}`.trim();
      } else {
        try {
          const buffer = await fetchBuffer();
          contentParts.push(mediaToContentPart(buffer, att.contentType));
          textBody = `${attachmentTag} ${textBody}`.trim();
        } catch {
          textBody = `${attachmentTag} ${textBody}`.trim();
        }
      }
    } else if (isDoc && att.contentType === 'application/pdf') {
      try {
        const buffer = await fetchBuffer();
        const info = await extractTextFromPdfBuffer(buffer);
        if (!info.success) {
          textBody = `${attachmentTag} ${textBody}`.trim();
        } else if (info.pages > MAX_DOC_PAGES) {
          textBody = `${attachmentTag} (document too long: ${info.pages} pages) ${textBody}`.trim();
        } else {
          const docText = info.text ? `\n<Transcription>\n${info.text}\n</Transcription>` : '';
          textBody = `${attachmentTag}${docText} ${textBody}`.trim();
        }
      } catch {
        textBody = `${attachmentTag} ${textBody}`.trim();
      }
    } else if (isDoc) {
      // Non-image, non-PDF documents: tag only.
      textBody = `${attachmentTag} ${textBody}`.trim();
    } else if (isImage) {
      try {
        const buffer = await fetchBuffer();
        contentParts.push(mediaToContentPart(buffer, att.contentType));
        textBody = `${attachmentTag} ${textBody}`.trim();
      } catch {
        textBody = `${attachmentTag} ${textBody}`.trim();
      }
    } else {
      textBody = `${attachmentTag} ${textBody}`.trim();
    }
  }

  if (textBody) {
    contentParts.unshift({ type: 'text', text: textBody });
  }

  if (quotedMediaParts.length > 0) {
    contentParts.push(...quotedMediaParts);
  }

  if (contentParts.length === 0) return;

  let availableEmojis = '';
  try {
    const emojis = guild.emojis.cache;
    if (emojis.size > 0) {
      availableEmojis = emojis.map(e => `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`).join(' ');
    }
  } catch { }

  let serverEvents = 'No upcoming events.';
  try {
    const events = await guild.scheduledEvents.fetch();
    if (events.size > 0) {
      const now = new Date();
      const nowTime = now.getTime();
      const upcoming = events.filter(e => new Date(e.scheduledStartAt).getTime() > nowTime);
      if (upcoming.size > 0) {
        serverEvents = upcoming.map(e => `${e.name} - ${formatTimestamp(e.scheduledStartAt)}`).join('; ');
      }
    }
  } catch { }

  const ctx = {
    platform: 'discord',
    isGroup: false,
    groupId: null,
    groupName: null,
    chatId: channel.id,
    userId: msg.author.id,
    userName: guildMember?.nickname || msg.author.displayName || msg.author.username,
    userIdentity,
    content: contentParts.length === 1 && contentParts[0].type === 'text'
      ? contentParts[0].text
      : contentParts,
    history,
    threadName: channel.name,
    availableEmojis,
    serverEvents,
    waJid: userIdentity.member ? userIdentity.member.wa : null,
    discordChannel: channel,
  };
  const lockKey = `discord:${channel.id}`;
  if (!responseLock.tryLock(lockKey)) {
    log.warn(`   ⛔ Ignoring message in thread ${channel.id}: GemiX is already responding`);
    return;
  }

  try {
    await channel.sendTyping();

    const response = await handleMessage(ctx);

    let finalText = response.text || '';
    let newTitle = response.discordTitle || '';

    const files = [];
    if (response.attachments) {
      for (const att of response.attachments) {
        const a = toDiscordAttachmentArgs(att);
        if (!a) continue;
        files.push(new AttachmentBuilder(a.data, { name: a.name }));
      }
    }

    if (finalText) {
      const chunks = finalText.length > 2000 ? splitDiscordMessage(finalText) : [finalText];
      if (chunks.length > 1) log.info(`   💬 Message split into ${chunks.length} parts`);
      for (let i = 0; i < chunks.length; i++) {
        if (i === chunks.length - 1 && files.length > 0) {
          await channel.send({ content: chunks[i], files });
        } else {
          await channel.send({ content: chunks[i] });
        }
      }
      log.info(`   ✅ Discord message sent (${finalText.length} chars)`);
    } else if (files.length > 0) {
      await channel.send({ files });
      log.info(`   ✅ Files sent`);
    } else {
      log.warn(`   ⚠️ No content or files to send`);
    }

    // Rename thread non-blocking (Discord limits to 2 renames per 10 min)
    if (newTitle && newTitle.length > 0) {
      const safeTitle = newTitle.replace(/[\u0000-\u001F]/g, '').trim().substring(0, 100);
      if (safeTitle) {
        channel.setName(safeTitle)
          .then(() => log.info(`   📝 Thread renamed: "${safeTitle}"`))
          .catch(err => log.error('Thread rename error:', err.message));
      }
    }
  } catch (err) {
    log.error(`\n❌ Error sending response:`);
    log.error(`   ${err.message}`);
    try {
      await channel.send({ content: '❌ Si è verificato un errore nell\'invio della risposta.' });
    } catch { }
  } finally {
    try { responseLock.unlock(lockKey); } catch { }
  }
}

async function buildDiscordHistory(channel, starterMessageId) {
  const raw = await channel.messages.fetch({ limit: MAX_HISTORY + 5 });
  const messages = [...raw.values()]
    .filter(m => !starterMessageId || m.id !== starterMessageId)
    .reverse()
    .slice(-MAX_HISTORY);

  const history = [];

  for (const m of messages) {
    const ts = formatTimestamp(m.createdAt);
    const isBot = m.author.id === discordClient.user.id;
    let textContent = m.content || '';

    for (const att of m.attachments.values()) {
      const isImage = att.contentType?.startsWith('image/');
      const isAudio = att.contentType?.startsWith('audio/');
      const isDoc = att.contentType?.startsWith('application/');
      const isVideo = att.contentType?.startsWith('video/');

      const fetchBuffer = async () => Buffer.from(await (await fetch(att.url)).arrayBuffer());
      const syncedPath = await syncFileToHistory(m.author.id, att.id, fetchBuffer, att.name);

      const attachmentTag = buildAttachmentTag(syncedPath, att.name);

      if (isVideo) {
        // Tag-only in history: the AI re-fetches the video via read_file when it needs the description.
        textContent = `${textContent} ${attachmentTag}`.trim();
      } else if (isAudio) {
        const cachedText = retrieveVoiceText(channel.id, m.createdAt.getTime());
        if (cachedText) {
          textContent = `${textContent} ${attachmentTag} <Transcription>${cachedText}</Transcription>`.trim();
        } else if (isBot) {
          textContent = `${textContent} ${attachmentTag} (transcription unavailable)`.trim();
        } else {
          textContent = `${textContent} ${attachmentTag}`.trim();
        }
      } else if (isDoc && att.contentType === 'application/pdf') {
        try {
          const buffer = await fetchBuffer();
          const info = await extractTextFromPdfBuffer(buffer);
          if (!info.success) {
            textContent = `${textContent} ${attachmentTag}`.trim();
          } else if (info.pages > MAX_DOC_PAGES) {
            textContent = `${textContent} ${attachmentTag} (document too long: ${info.pages} pages)`.trim();
          } else {
            const docText = info.text ? `\n<Transcription>\n${info.text}\n</Transcription>` : '';
            textContent = `${textContent} ${attachmentTag}${docText}`.trim();
          }
        } catch {
          textContent = `${textContent} ${attachmentTag}`.trim();
        }
      } else if (isImage || isDoc) {
        textContent = `${textContent} ${attachmentTag}`.trim();
      } else {
        textContent = `${textContent} ${attachmentTag}`.trim();
      }
    }

    if (!textContent) continue;

    const senderName = isBot ? 'GemiX' : (m.member?.nickname || m.author.displayName || m.author.username);
    const prefix = `[${ts}] ${senderName}: `;

    history.push({
      role: isBot ? 'assistant' : 'user',
      content: `${prefix}${textContent}`,
    });
  }

  return history;
}

module.exports = { initDiscord };