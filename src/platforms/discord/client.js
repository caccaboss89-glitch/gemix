// src/platforms/discord/client.js
const { Client, GatewayIntentBits, Partials, AttachmentBuilder } = require('discord.js');
const { BOT_TOKEN, GUILD_ID } = require('../../config/env');
const { DISCORD_THREAD_NAME, MAX_HISTORY, MAX_AUDIO_DURATION_S, MAX_VIDEO_DURATION_S } = require('../../config/constants');
const { handleMessage } = require('../../handler');
const { identifyUser } = require('../../utils/userIdentifier');
const { formatTimestamp } = require('../../utils/time');
const { mediaToContentPart, buildAttachmentTag } = require('../../utils/media');
const { getMediaDurationSec } = require('../../utils/mediaDuration');
const responseLock = require('../../utils/responseLock');
const { createLogger } = require('../../utils/logger');
const { syncFileToHistory, getStoredHistoryMediaDescription, getStoredHistoryVoiceTranscription, retrieveRecentVoiceText, storeHistoryVoiceTranscription } = require('../../utils/historySync');
const { toDiscordAttachmentArgs } = require('../../utils/attachments');
const { sendAttachmentsWithFallback } = require('../../utils/attachmentFallback');

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

function createAttachmentBufferFetcher(att) {
  let bufferPromise = null;
  return async () => {
    if (!bufferPromise) {
      bufferPromise = (async () => {
        if (att.size > 25 * 1024 * 1024) {
          throw new Error(`Attachment too large (${Math.round(att.size / 1048576)}MB, max 25MB)`);
        }
        return Buffer.from(await (await fetch(att.url)).arrayBuffer());
      })();
    }
    return bufferPromise;
  };
}

const { isSystemMessage } = require('../../config/systemMessages');

function isDiscordSystemMessage(body) {
  return isSystemMessage(body);
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

  const { history, recentMessageIds } = await buildDiscordHistory(channel, starterMessage?.id, msg.author.id);

  let textBody = msg.content || '';
  let quotedMediaParts = [];
  if (msg.reference) {
    try {
      const quotedMsg = await channel.messages.fetch(msg.reference.messageId);
      if (quotedMsg) {
        const isQuotedInRecentHistory = recentMessageIds instanceof Set && recentMessageIds.has(quotedMsg.id);
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
            const fetchBuffer = createAttachmentBufferFetcher(att);
            let syncedPath = null;
            try {
              syncedPath = await syncFileToHistory(msg.author.id, att.id, fetchBuffer, att.name);
            } catch (err) {
              log.warn(`Failed to sync quoted file ${att.name}: ${err.message}`);
            }
            const attachmentTag = buildAttachmentTag(syncedPath, att.name);

            if (isImage) {
              try {
                const buffer = await fetchBuffer();

                quotedMediaParts.push(mediaToContentPart(buffer, att.contentType, {
                  historyPath: syncedPath,
                  historyUserId: msg.author.id,
                }));
              } catch { }
            } else if (isAudio) {
              const storedVoiceText = getStoredHistoryVoiceTranscription(msg.author.id, syncedPath);
              const cachedText = storedVoiceText || retrieveRecentVoiceText(channel.id, quotedMsg.createdAt?.getTime?.());
              if (!storedVoiceText && cachedText) storeHistoryVoiceTranscription(msg.author.id, syncedPath, cachedText);
              const cachedDescription = getStoredHistoryMediaDescription(msg.author.id, syncedPath, 'audio');
              const audioDuration = Number(att.duration || 0);
              if (cachedText) {
                replyPrefix = `[In reply to: ${attachmentTag} <Transcription>${cachedText}</Transcription>]\n`;
              } else if (cachedDescription) {
                replyPrefix = `[In reply to: ${attachmentTag} <Description kind="audio">${cachedDescription}</Description>]\n`;
              } else if (audioDuration > MAX_AUDIO_DURATION_S) {
                replyPrefix = `[In reply to: ${attachmentTag} (audio too long: ${audioDuration}s, max ${MAX_AUDIO_DURATION_S}s)]\n`;
              } else {
                try {
                  const buffer = await fetchBuffer();
                  quotedMediaParts.push(mediaToContentPart(buffer, att.contentType, {
                    historyPath: syncedPath,
                    historyUserId: msg.author.id,
                  }));
                } catch { }
              }
            } else if (isVideo) {
              const cachedDescription = getStoredHistoryMediaDescription(msg.author.id, syncedPath, 'video');
              if (cachedDescription) {
                replyPrefix = `[In reply to: ${attachmentTag} <Description kind="video">${cachedDescription}</Description>]\n`;
              } else {
                try {
                  const buffer = await fetchBuffer();
                  const dur = await getMediaDurationSec(buffer, ext);
                  if (dur != null && dur > MAX_VIDEO_DURATION_S) {
                    replyPrefix = `[In reply to: ${attachmentTag} (video too long: ${Math.round(dur)}s, max ${MAX_VIDEO_DURATION_S}s)]\n`;
                  } else {
                    quotedMediaParts.push(mediaToContentPart(buffer, att.contentType, {
                      historyPath: syncedPath,
                      historyUserId: msg.author.id,
                    }));
                  }
                } catch { }
              }
            } else if (isPdf) {
              if (isQuotedInRecentHistory) {
                try {
                  const buffer = await fetchBuffer();
                  quotedMediaParts.push(mediaToContentPart(buffer, att.contentType || 'application/pdf', {
                    historyPath: syncedPath,
                    historyUserId: msg.author.id,
                  }));
                } catch { }
              }
            }
          }
          textBody = replyPrefix + textBody;
        } else if (quotedMsg.content) {
          textBody = `[In reply to: ${quotedMsg.content}]\n` + textBody;
        }
      }
    } catch { }
  }

  const contentParts = [];
  for (const att of msg.attachments.values()) {
    const ext = (att.name || '').split('.').pop().toLowerCase();
    const isImage = att.contentType?.startsWith('image/');
    const isAudio = att.contentType?.startsWith('audio/');
    const isDoc = att.contentType?.startsWith('application/') || ['pdf', 'txt', 'doc', 'docx', 'csv', 'json'].includes(ext);
    const isVideo = att.contentType?.startsWith('video/');

    const fetchBuffer = createAttachmentBufferFetcher(att);
    let syncedPath = null;
    try {
      syncedPath = await syncFileToHistory(msg.author.id, att.id, fetchBuffer, att.name);
    } catch (err) {
      log.warn(`Failed to sync file ${att.name}: ${err.message}`);
    }
    const attachmentTag = buildAttachmentTag(syncedPath, att.name);

    if (isVideo) {
      try {
        const buffer = await fetchBuffer();
        const dur = await getMediaDurationSec(buffer, ext);
        if (dur != null && dur > MAX_VIDEO_DURATION_S) {
          textBody = `${attachmentTag} (video too long: ${Math.round(dur)}s, max ${MAX_VIDEO_DURATION_S}s) ${textBody}`.trim();
        } else {
          contentParts.push(mediaToContentPart(buffer, att.contentType, {
            historyPath: syncedPath,
            historyUserId: msg.author.id,
          }));
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
          contentParts.push(mediaToContentPart(buffer, att.contentType, {
            historyPath: syncedPath,
            historyUserId: msg.author.id,
          }));
          textBody = `${attachmentTag} ${textBody}`.trim();
        } catch {
          textBody = `${attachmentTag} ${textBody}`.trim();
        }
      }
    } else if (isDoc && (att.contentType === 'application/pdf' || ext === 'pdf')) {
      try {
        const buffer = await fetchBuffer();
        contentParts.push(mediaToContentPart(buffer, att.contentType || 'application/pdf', {
          historyPath: syncedPath,
          historyUserId: msg.author.id,
        }));
        textBody = `${attachmentTag} ${textBody}`.trim();
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
  const stopLockRenew = responseLock.startAutoRenew(lockKey);

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
        const isLastChunk = i === chunks.length - 1;
        if (isLastChunk && files.length > 0) {
          try {
            await channel.send({ content: chunks[i], files });
            log.info(`   ✅ Discord message and files sent`);
          } catch (err) {
            log.error(`   ❌ Failed to send files directly: ${err.message}. Using fallback...`);
            await channel.send({ content: chunks[i] });
            const result = await sendAttachmentsWithFallback(response.attachments, async (att) => {
              const a = toDiscordAttachmentArgs(att);
              if (!a) throw new Error('Invalid attachment');
              await channel.send({ files: [new AttachmentBuilder(a.data, { name: a.name })] });
            }, { platform: 'discord' });
            
            if (result.fallbackMessage) {
              await channel.send({ content: result.fallbackMessage });
            }
          }
        } else {
          await channel.send({ content: chunks[i] });
        }
      }
    } else if (files.length > 0) {
      try {
        await channel.send({ files });
        log.info(`   ✅ Discord files sent`);
      } catch (err) {
        log.error(`   ❌ Failed to send files directly: ${err.message}. Using fallback...`);
        const result = await sendAttachmentsWithFallback(response.attachments, async (att) => {
          const a = toDiscordAttachmentArgs(att);
          if (!a) throw new Error('Invalid attachment');
          await channel.send({ files: [new AttachmentBuilder(a.data, { name: a.name })] });
        }, { platform: 'discord' });
        
        if (result.fallbackMessage) {
          await channel.send({ content: result.fallbackMessage });
        }
      }
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
      const { notifyAdmin } = require('../../utils/adminNotifier');
      await notifyAdmin('Discord Chat Delivery', `Failed to send response in channel ${channel.id}: ${err.message}`);
    } catch (adminErr) {
      log.error(`Failed to notify admin: ${adminErr.message}`);
    }
    try {
      await channel.send({ content: '❌ Si è verificato un errore nell\'invio della risposta.' });
    } catch { }
  } finally {
    try { if (typeof stopLockRenew === 'function') stopLockRenew(); } catch { }
    try { responseLock.unlock(lockKey); } catch { }
  }
}

async function buildDiscordHistory(channel, starterMessageId, storageUserId) {
  const raw = await channel.messages.fetch({ limit: MAX_HISTORY + 5 });
  const messages = [...raw.values()]
    .filter(m => !starterMessageId || m.id !== starterMessageId)
    .reverse()
    .slice(-MAX_HISTORY);
  const recentMessageIds = new Set(messages.map(m => m.id));

  const history = [];

  for (const m of messages) {
    const ts = formatTimestamp(m.createdAt);
    const isBot = m.author.id === discordClient.user.id;
    const isSystem = isBot && isDiscordSystemMessage(m.content || '');
    let textContent = m.content || '';

    for (const att of m.attachments.values()) {
      const isImage = att.contentType?.startsWith('image/');
      const isAudio = att.contentType?.startsWith('audio/');
      const isDoc = att.contentType?.startsWith('application/');
      const isVideo = att.contentType?.startsWith('video/');

      const fetchBuffer = async () => Buffer.from(await (await fetch(att.url)).arrayBuffer());
      const syncedPath = await syncFileToHistory(storageUserId, att.id, fetchBuffer, att.name);

      const attachmentTag = buildAttachmentTag(syncedPath, att.name);

      if (isVideo) {
        const cachedDescription = getStoredHistoryMediaDescription(storageUserId, syncedPath, 'video');
        if (cachedDescription) {
          textContent = `${textContent} ${attachmentTag} <Description kind="video">${cachedDescription}</Description>`.trim();
        } else {
          textContent = `${textContent} ${attachmentTag}`.trim();
        }
      } else if (isAudio) {
        const storedVoiceText = getStoredHistoryVoiceTranscription(storageUserId, syncedPath);
        const cachedText = storedVoiceText || retrieveRecentVoiceText(channel.id, m.createdAt.getTime());
        if (!storedVoiceText && cachedText) storeHistoryVoiceTranscription(storageUserId, syncedPath, cachedText);
        const cachedDescription = getStoredHistoryMediaDescription(storageUserId, syncedPath, 'audio');
        if (cachedText) {
          textContent = `${textContent} ${attachmentTag} <Transcription>${cachedText}</Transcription>`.trim();
        } else if (cachedDescription) {
          textContent = `${textContent} ${attachmentTag} <Description kind="audio">${cachedDescription}</Description>`.trim();
        } else if (isBot) {
          textContent = `${textContent} ${attachmentTag} (transcription unavailable)`.trim();
        } else {
          textContent = `${textContent} ${attachmentTag}`.trim();
        }
      } else if (isImage || isDoc) {
        textContent = `${textContent} ${attachmentTag}`.trim();
      } else {
        textContent = `${textContent} ${attachmentTag}`.trim();
      }
    }

    if (!textContent) continue;

    const senderName = isSystem ? '[System]' : (isBot ? 'GemiX' : (m.member?.nickname || m.author.displayName || m.author.username));
    const prefix = `[${ts}] ${senderName}: `;

    history.push({
      role: isBot ? 'assistant' : 'user',
      content: `${prefix}${textContent}`,
    });
  }

  return { history, recentMessageIds };
}

module.exports = { initDiscord };