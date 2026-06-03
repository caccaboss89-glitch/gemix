// src/platforms/discord/client.js
//
// Discord platform adapter: initializes the discord.js client, handles
// messageCreate events in forum threads, builds multimodal history,
// and sends responses (text + attachments) back to Discord.
// Only activates inside the configured DISCORD_THREAD_NAME category.

const { Client, GatewayIntentBits, Partials, AttachmentBuilder } = require('discord.js');
const { BOT_TOKEN, GUILD_ID } = require('../../config/env');
const { DISCORD_THREAD_NAME, MAX_HISTORY } = require('../../config/constants');

const { identifyUser } = require('../../utils/userIdentifier');
const { formatTimestamp } = require('../../utils/time');
const { hasInlineFileContent } = require('../../utils/aiFileDelivery');
const { ingressDiscordAttachment } = require('../../utils/incomingMediaIngress');

const { enqueueBatchedTurn } = require('../../utils/batchIngress');
const { analyzeBatchSpeakers } = require('../../utils/batchContext');
const {
  attachmentFilenameHints,
  stripRedundantAttachmentCaption,
  stripRedundantFilenameBesideAttachmentTag,
} = require('../../utils/attachmentCaption');
const { createLogger } = require('../../utils/logger');
const { resolveGemixVoiceTranscription } = require('../../utils/historySync');
const { toDiscordAttachmentArgs } = require('../../utils/attachments');
const { sendAttachmentsWithFallback } = require('../../utils/attachmentFallback');
const { cleanIncomingText, formatLabeledUserContent } = require('../../utils/text');
const { fetchHistoryWithTimeout } = require('../../utils/historyFetch');
const { runTurnPipeline, mergeBatchContentParts } = require('../../utils/turnPipeline');
const { processDiscordQuotedReply } = require('../../utils/quoteIngress');

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
    log.info(`Bot ready: ${discordClient.user.tag}`);
  });

  discordClient.on('messageCreate', async (msg) => {
    try {
      await onDiscordMessage(msg);
    } catch (err) {
      log.error(`\nCritical error:`);
      log.error(`   ${err.message}`);
      log.error(`   Stack: ${err.stack?.split('\n').slice(0, 3).join('\n   ')}`);
    }
  });

  discordClient.login(BOT_TOKEN).catch(err => {
    log.error('Discord login failed:', err.message);
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

function discordMessageHasUsableContent(msg) {
  if (!msg) return false;
  if (msg.content && String(msg.content).trim()) return true;
  if (msg.attachments && msg.attachments.size > 0) return true;
  if (msg.reference?.messageId) return true;
  return false;
}

/**
 * One channel.messages.fetch per turn. Used for history build and batch ingress.
 * @returns {{ raw: import('discord.js').Collection, recentMessageIds: Set<string> }}
 */
async function fetchDiscordMessageWindow(channel, starterMessageId) {
  const raw = await channel.messages.fetch({ limit: MAX_HISTORY + 5 });
  const recentMessageIds = new Set(
    [...raw.values()]
      .filter(m => !starterMessageId || m.id !== starterMessageId)
      .reverse()
      .slice(-MAX_HISTORY)
      .map(m => m.id),
  );
  return { raw, recentMessageIds };
}

async function rebuildDiscordBatchParts(entries, channel, starterMessageId, historyStorageId, recentMessageIds) {
  const ids = recentMessageIds || (await fetchDiscordMessageWindow(channel, starterMessageId)).recentMessageIds;
  for (const ent of entries) {
    if (!ent.msg) continue;
    ent.contentParts = await buildDiscordIncomingContentParts(
      ent.msg, channel, historyStorageId, ids, ent.userName,
    );
  }
}

/**
 * Build content parts for the current Discord message (quoted media, inline
 * text files, attachment tags). History is supplied separately at batch fire.
 */
async function buildDiscordIncomingContentParts(msg, channel, historyStorageId, recentMessageIds, senderName) {
  let textBody = msg.content || '';
  const botUserId = discordClient?.user?.id;
  const { prefix, mediaParts: quotedMediaParts } = await processDiscordQuotedReply(
    msg, channel, historyStorageId, recentMessageIds, botUserId,
  );
  textBody = prefix + textBody;

  const contentParts = [...quotedMediaParts];
  const attachmentTags = [];

  for (const att of msg.attachments.values()) {
    const ingress = await ingressDiscordAttachment(att, historyStorageId, {
      metadataDurationSec: Number(att.duration || 0),
    });
    if (ingress.oversize) {
      attachmentTags.push({ tag: ingress.tag, name: att.name, syncedPath: null });
      textBody = `${ingress.textFragment.trim()} ${textBody}`.trim();
      continue;
    }
    contentParts.push(...ingress.contentParts);
    attachmentTags.push({ tag: ingress.tag, name: ingress.name, syncedPath: ingress.syncedPath });
    const fragment = ingress.textFragment.trim();
    if (hasInlineFileContent(fragment)) {
      textBody = `${fragment}${textBody ? ` ${textBody}` : ''}`.trim();
    } else {
      textBody = `${fragment} ${textBody}`.trim();
    }
  }

  if (attachmentTags.length > 0 && textBody && !hasInlineFileContent(textBody)) {
    for (const { tag, name, syncedPath } of attachmentTags) {
      const hints = attachmentFilenameHints(name, name, syncedPath);
      textBody = stripRedundantAttachmentCaption(textBody, hints);
      textBody = stripRedundantFilenameBesideAttachmentTag(textBody, tag, hints);
    }
  }

  if (textBody) {
    const tsMs = msg.createdAt?.getTime?.() || Date.now();
    contentParts.unshift({ type: 'text', text: formatLabeledUserContent(tsMs, senderName, textBody) });
  }

  return contentParts;
}

async function onDiscordMessage(msg) {
  if (!discordClient?.isReady?.()) {
    log.info('   Skipping Discord message until client is ready (not queued)');
    return;
  }
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
  if (!guild) {
    log.warn(`Guild ${GUILD_ID} not in cache — member nicknames/events/emojis omitted for this message`);
  }
  let guildMember = null;
  if (guild) {
    try {
      guildMember = await guild.members.fetch(msg.author.id);
    } catch { /* member may have left */ }
  }

  const userIdentity = identifyUser({
    platform: 'discord',
    userId: msg.author.id,
    discordUsername: msg.author.username,
    discordDisplayName: msg.author.displayName || msg.author.globalName,
    discordNickname: guildMember?.nickname,
  });

  if (!discordMessageHasUsableContent(msg)) return;

  const senderName = guildMember?.nickname || msg.author.displayName || msg.author.username;
  const historyStorageId = channel.id;

  const batchKey = `discord:${channel.id}`;
  const batchEntry = {
    msg,
    messageId: msg.id,
    authorUserId: msg.author.id,
    historyStorageId,
    channel,
    starterMessageId: starterMessage?.id || null,
    guild,
    guildMember,
    userIdentity,
    userName: senderName,
    stopLockRenew: null,
  };

  const status = enqueueBatchedTurn({
    batchKey,
    entry: batchEntry,
    handler: _handleDiscordBatch,
    log,
    discardLogLabel: `thread ${channel.id}`,
  });
  if (status === 'batched') {
    log.info(`   Batching additional message for ${batchKey}`);
  }
}

async function _discordGuildExtras(guild) {
  let availableEmojis = '';
  try {
    const emojis = guild.emojis.cache;
    if (emojis.size > 0) {
      availableEmojis = emojis.map(e => `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`).join(' ');
    }
  } catch { /* ignore */ }

  let serverEvents = '';
  try {
    const events = await guild.scheduledEvents.fetch();
    if (events.size > 0) {
      const nowTime = Date.now();
      const upcoming = events.filter(e => new Date(e.scheduledStartAt).getTime() > nowTime);
      if (upcoming.size > 0) {
        serverEvents = upcoming.map(e => `${e.name} - ${formatTimestamp(e.scheduledStartAt)}`).join('; ');
      }
    }
  } catch { /* ignore */ }
  return { availableEmojis, serverEvents };
}

async function deliverDiscordResponse(channel, response) {
  let finalText = response.text || '';
  const newTitle = response.discordTitle || '';

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
    if (chunks.length > 1) log.info(`   Message split into ${chunks.length} parts`);

    for (let i = 0; i < chunks.length; i++) {
      const isLastChunk = i === chunks.length - 1;
      if (isLastChunk && files.length > 0) {
        try {
          await channel.send({ content: chunks[i], files });
          log.info('   Discord message and files sent');
        } catch (err) {
          log.error(`   Failed to send files directly: ${err.message}. Using fallback...`);
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
      log.info('   Discord files sent');
    } catch (err) {
      log.error(`   Failed to send files directly: ${err.message}. Using fallback...`);
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
    log.warn('   No content or files to send');
  }

  if (newTitle && newTitle.length > 0) {
    const safeTitle = newTitle.replace(/[\u0000-\u001F]/g, '').trim().substring(0, 100);
    if (safeTitle) {
      channel.setName(safeTitle)
        .then(() => log.info(`   Thread renamed: "${safeTitle}"`))
        .catch(err => log.error('Thread rename error:', err.message));
    }
  }
}

async function _handleDiscordBatch(entries) {
  const first = entries[0];
  const { channel, starterMessageId, historyStorageId, guild, stopLockRenew } = first;

  await runTurnPipeline({
    log,
    lockKey: `discord:${channel.id}`,
    stopLockRenew,
    entries,
    discardLogLabel: `thread ${channel.id}`,
    loadHistory: async ({ entries: ents, first }) => {
      const excludeMessageIds = new Set(ents.map(e => e.messageId).filter(Boolean));
      return fetchHistoryWithTimeout(
        async () => {
          const window = await fetchDiscordMessageWindow(channel, starterMessageId);
          if (first) first._discordWindow = window;
          const built = await buildDiscordHistory(
            channel, starterMessageId, historyStorageId, excludeMessageIds, window,
          );
          return built.history;
        },
        log,
        'DISCORD',
      );
    },
    prepareSession: async () => {
      try { await channel.sendTyping(); } catch { /* ignore */ }
      return {};
    },
    buildHandlerCtx: async ({ entries: ents, history, historyLoadIncomplete, latest, first }) => {
      const recentMessageIds = first?._discordWindow?.recentMessageIds;
      await rebuildDiscordBatchParts(ents, channel, starterMessageId, historyStorageId, recentMessageIds);
      const lat = latest || ents[0];
      const { multiSpeaker } = analyzeBatchSpeakers(ents, 'discord');
      const extras = await _discordGuildExtras(guild);
      return {
        platform: 'discord',
        isGroup: false,
        groupId: null,
        groupName: null,
        chatId: channel.id,
        userId: lat.authorUserId,
        userName: lat.userName,
        userIdentity: lat.userIdentity,
        content: mergeBatchContentParts(ents),
        history,
        historyLoadIncomplete,
        batchMultiSpeaker: multiSpeaker,
        threadName: channel.name,
        availableEmojis: extras.availableEmojis,
        serverEvents: extras.serverEvents,
        waJid: lat.userIdentity.member ? lat.userIdentity.member.wa : null,
        discordChannel: channel,
      };
    },
    deliver: async (_ctx, response) => {
      await deliverDiscordResponse(channel, response);
    },
    onDeliverError: async (_ctx, err) => {
      try {
        const { notifyAdmin } = require('../../utils/adminNotifier');
        await notifyAdmin('Discord Chat Delivery', `Failed to send response in channel ${channel.id}: ${err.message}`);
      } catch { /* ignore */ }
      try {
        await channel.send({ content: '❌ Si è verificato un errore nell\'invio della risposta.' });
      } catch { /* ignore */ }
    },
  });
}

/**
 * @param {Set<string>|string|null} [excludeMessageIds] - Discord message IDs to omit
 *   (current batch); the merged user turn is passed separately as ctx.content.
 */
async function buildDiscordHistory(channel, starterMessageId, historyStorageId, excludeMessageIds = null, prefetched = null) {
  const raw = prefetched?.raw || (await fetchDiscordMessageWindow(channel, starterMessageId)).raw;
  const exclude = excludeMessageIds instanceof Set
    ? excludeMessageIds
    : (excludeMessageIds ? new Set([excludeMessageIds]) : null);

  const messages = [...raw.values()]
    .filter(m => (!starterMessageId || m.id !== starterMessageId) && (!exclude || !exclude.has(m.id)))
    .reverse()
    .slice(-MAX_HISTORY);
  const recentMessageIds = new Set(messages.map(m => m.id));

  const history = [];

  for (const m of messages) {
    const ts = formatTimestamp(m.createdAt);
    const isBot = m.author.id === discordClient.user.id;
    let textContent = cleanIncomingText(m.content || '');

    for (const att of m.attachments.values()) {
      const ingress = await ingressDiscordAttachment(att, historyStorageId, {
        metadataDurationSec: Number(att.duration || 0),
        getVoiceTranscription: isBot
          ? async (syncedPath) => resolveGemixVoiceTranscription(
            historyStorageId,
            syncedPath,
            channel.id,
            m.createdAt?.getTime?.(),
          )
          : null,
      });
      if (ingress.oversize) {
        textContent = `${textContent} ${ingress.textFragment.trim()}`.trim();
        continue;
      }
      const captionHints = attachmentFilenameHints(att.name, ingress.name, ingress.syncedPath);
      textContent = stripRedundantAttachmentCaption(textContent, captionHints);
      textContent = stripRedundantFilenameBesideAttachmentTag(
        textContent,
        ingress.tag,
        captionHints,
      );
      textContent = `${textContent} ${ingress.textFragment.trim()}`.trim();
    }

    if (!textContent) continue;

    const senderName = isBot ? 'GemiX' : (m.member?.nickname || m.author.displayName || m.author.username);
    const prefix = `[${ts}] ${senderName}: `;

    history.push({
      role: isBot ? 'assistant' : 'user',
      content: isBot ? textContent : `${prefix}${textContent}`,
    });
  }

  return { history, recentMessageIds };
}

module.exports = { initDiscord };