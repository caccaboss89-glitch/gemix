const { Client, GatewayIntentBits, Partials, AttachmentBuilder } = require('discord.js');
const { BOT_TOKEN, GUILD_ID } = require('../../config/env');
const { DISCORD_THREAD_NAME, MAX_HISTORY } = require('../../config/constants');
const { handleMessage } = require('../../handler');
const { identifyUser } = require('../../utils/userIdentifier');
const { formatTimestamp } = require('../../utils/time');
const { mediaToContentPart } = require('../../utils/media');
const responseLock = require('../../utils/responseLock');

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
    console.log(`[Discord] ✅ Bot pronto: ${discordClient.user.tag}`);
  });

  discordClient.on('messageCreate', async (msg) => {
    try {
      await onDiscordMessage(msg);
    } catch (err) {
      console.error(`\n❌ [DISCORD] ERRORE critico:`);
      console.error(`   ${err.message}`);
      console.error(`   Stack: ${err.stack?.split('\n').slice(0, 3).join('\n   ')}`);
    }
  });

  discordClient.login(BOT_TOKEN);
  return discordClient;
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
  } catch {}

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

  if (msg.reference) {
    try {
      const quotedMsg = await channel.messages.fetch(msg.reference.messageId);
      if (quotedMsg) {
        if (quotedMsg.attachments.size > 0) {
          const filetags = [...quotedMsg.attachments.values()]
            .map(att => `[${att.name}]`)
            .join(' ');
          textBody = `[In reply to: ${filetags}]\n` + textBody;
        } else if (quotedMsg.content) {
          textBody = `[In reply to: ${quotedMsg.content}]\n` + textBody;
        }
      }
    } catch {}
  }

  for (const att of msg.attachments.values()) {
    const ext = (att.name || '').split('.').pop().toLowerCase();
    const isImage = att.contentType?.startsWith('image/');
    const isAudio = att.contentType?.startsWith('audio/');
    const isDoc = att.contentType?.startsWith('application/') || ['pdf', 'txt', 'doc', 'docx', 'csv', 'json'].includes(ext);
    const isVideo = att.contentType?.startsWith('video/');

    if (isImage || isAudio || isDoc) {
      try {
        const res = await fetch(att.url);
        const buffer = Buffer.from(await res.arrayBuffer());
        contentParts.push(mediaToContentPart(buffer, att.contentType));
        textBody = `[${att.name}] ${textBody}`.trim();
      } catch {
        textBody = `[${att.name}] ${textBody}`.trim();
      }
    } else if (isVideo) {
      textBody = `[${att.name}] (file non visionabile) ${textBody}`.trim();
    } else {
      textBody = `[${att.name}] ${textBody}`.trim();
    }
  }

  if (textBody) {
    contentParts.unshift({ type: 'text', text: textBody });
  }

  if (contentParts.length === 0) return;

  let availableEmojis = '';
  try {
    const emojis = guild.emojis.cache;
    if (emojis.size > 0) {
      availableEmojis = emojis.map(e => `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`).join(' ');
    }
  } catch {}

  let serverEvents = 'Nessun evento in programma.';
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
  } catch {}

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
    console.log(`   ⛔ [DISCORD] Ignoro messaggio in thread ${channel.id}: GemiX sta già rispondendo`);
    return;
  }

  try {
    await channel.sendTyping();

    const response = await handleMessage(ctx);

    let finalText = response.discordMessage || response.text || '';
    let newTitle = response.discordTitle || '';

    if (newTitle && newTitle.length > 0) {
      try {
        await channel.setName(newTitle);
        console.log(`   📝 Thread rinominato: "${newTitle}"`);
      } catch (err) {
        console.error('[Discord] Errore rinomina thread:', err.message);
      }
    }

    if (response.isVoiceOnly && response.voiceBuffer) {
      const attachment = new AttachmentBuilder(response.voiceBuffer, { name: 'voice.ogg' });
      await channel.send({ files: [attachment] });
      console.log(`   🎤 Vocale inviato`);
      return;
    }

    const files = [];
    if (response.attachments) {
      for (const att of response.attachments) {
        files.push(new AttachmentBuilder(att.buffer, { name: att.name }));
      }
    }

    if (finalText) {
      if (finalText.length > 2000) {
        const chunks = finalText.match(/[\s\S]{1,2000}/g);
        console.log(`   💬 Messaggio diviso in ${chunks.length} parti`);
        for (let i = 0; i < chunks.length; i++) {
          if (i === chunks.length - 1 && files.length > 0) {
            await channel.send({ content: chunks[i], files });
          } else {
            await channel.send({ content: chunks[i] });
          }
        }
      } else {
        await channel.send({ content: finalText, files });
      }
      console.log(`   ✅ Messaggio Discord inviato (${finalText.length} char)`);
    } else if (files.length > 0) {
      await channel.send({ files });
      console.log(`   ✅ File inviati`);
    } else {
      console.warn(`   ⚠️ Nessun contenuto o file da inviare`);
    }
  } catch (err) {
    console.error(`\n❌ [DISCORD] Errore invio risposta:`);
    console.error(`   ${err.message}`);
    try {
      await channel.send({ content: '❌ Si è verificato un errore nell\'invio della risposta.' });
    } catch {}
  } finally {
    try { responseLock.unlock(lockKey); } catch {}
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
    const mediaParts = [];

    for (const att of m.attachments.values()) {
      const isImage = att.contentType?.startsWith('image/');
      const isAudio = att.contentType?.startsWith('audio/');
      const isDoc = att.contentType?.startsWith('application/');
      const isVideo = att.contentType?.startsWith('video/');

      if (isImage || isAudio || isDoc) {
        try {
          const res = await fetch(att.url);
          const buffer = Buffer.from(await res.arrayBuffer());
          mediaParts.push(mediaToContentPart(buffer, att.contentType));
        } catch {}
        textContent = `${textContent} [${att.name}]`.trim();
      } else if (isVideo) {
        textContent = `${textContent} [${att.name}] (file non visionabile)`.trim();
      } else {
        textContent = `${textContent} [${att.name}]`.trim();
      }
    }

    if (!textContent && mediaParts.length === 0) continue;

    const senderName = isBot ? 'GemiX' : (m.member?.nickname || m.author.displayName || m.author.username);
    const prefix = `[${ts}] ${senderName}: `;

    if (mediaParts.length > 0) {
      const content = [
        { type: 'text', text: `${prefix}${textContent}` },
        ...mediaParts,
      ];
      history.push({
        role: isBot ? 'assistant' : 'user',
        content,
      });
    } else {
      history.push({
        role: isBot ? 'assistant' : 'user',
        content: `${prefix}${textContent}`,
      });
    }
  }

  return history;
}

module.exports = { initDiscord };
