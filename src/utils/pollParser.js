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

module.exports = {
  formatWhatsAppPollText,
};
