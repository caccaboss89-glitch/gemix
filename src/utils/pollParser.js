const { MessageType } = require('discord.js');

function extractWhatsAppPollOptions(msg) {
  const options = [];

  const pollData = msg.pollOptions || msg.pollCreation || msg.poll_creation || msg._data?.pollOptions || msg._data?.pollCreation || msg._data?.poll_creation;

  if (Array.isArray(pollData)) {
    for (const opt of pollData) {
      if (!opt) continue;
      const text = opt.name || opt.text || opt.option || opt.title || String(opt || '').trim();
      if (text) options.push(text);
    }
  } else if (pollData && typeof pollData === 'object') {
    const rawOptions = pollData.options || pollData.poll_options || pollData.pollOption || pollData.pollOptions;
    if (Array.isArray(rawOptions)) {
      for (const opt of rawOptions) {
        if (!opt) continue;
        const text = opt.name || opt.text || opt.option || opt.title || String(opt || '').trim();
        if (text) options.push(text);
      }
    } else {
      const keys = Object.keys(pollData).filter(k => k.toLowerCase().includes('option'));
      for (const key of keys) {
        const value = pollData[key];
        if (Array.isArray(value)) {
          for (const opt of value) {
            const text = opt?.name || opt?.text || opt?.option || opt?.title || String(opt || '').trim();
            if (text) options.push(text);
          }
        }
      }
    }
  }

  return options;
}

function formatWhatsAppPollText(msg, textBody) {
  if (msg.type !== 'poll_creation') return textBody;

  const pollQuestion = textBody || msg.body || '';
  const options = extractWhatsAppPollOptions(msg);

  if (options.length === 0) {
    return pollQuestion;
  }

  const normalized = options
    .map((option, idx) => `${idx + 1}. ${option}`)
    .join('\n');

  return `${pollQuestion}\nOpzioni:\n${normalized}`.trim();
}

function formatDiscordPollText(msg, textBody) {
  const isPollType = msg.type === MessageType.Poll;

  const base = textBody || msg.content || '';

  const options = [];

  // prova a leggere da componenti (bottoni/select menu) se disponibili
  if (Array.isArray(msg.components) && msg.components.length > 0) {
    for (const row of msg.components) {
      if (!row || !Array.isArray(row.components)) continue;
      for (const comp of row.components) {
        if (!comp) continue;
        if (comp.type === 3 && Array.isArray(comp.options)) {
          // select menu
          comp.options.forEach(opt => {
            if (opt?.label) options.push(opt.label);
          });
        } else if (comp.label) {
          options.push(comp.label);
        }
      }
    }
  }

  // modalità reazioni, comune ai sondaggi di Discord
  if (msg.reactions?.cache?.size > 0) {
    for (const reaction of msg.reactions.cache.values()) {
      const emojiName = reaction.emoji?.name || reaction.emoji?.id || String(reaction.emoji);
      const count = reaction.count || 0;
      options.push(`${emojiName}${count ? ` (${count})` : ''}`);
    }
  }

  if (!isPollType && options.length === 0) {
    return base;
  }

  const pollPrefix = isPollType ? '[Sondaggio Discord]' : '[Reazioni Discord]';

  const optionsText = options.map((option, idx) => `${idx + 1}. ${option}`).join('\n');

  return `${pollPrefix} ${base}`.trim() + (optionsText ? `\nOpzioni:\n${optionsText}` : '');
}

module.exports = {
  formatWhatsAppPollText,
  formatDiscordPollText,
};
