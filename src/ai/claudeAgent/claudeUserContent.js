// src/ai/claudeAgent/claudeUserContent.js
//
// The conversation of one turn as the single user message a Claude Agent query
// starts from.
//
// A Claude Agent query takes user messages only, so the items a Responses
// engine would send one by one are rendered into one message, in their order:
//
//   <conversation-history>          the history window, oldest first; GemiX's
//   [hh:mm] Name: text …            own earlier replies carry HISTORY_REPLY_LABEL
//   GemiX (you): text …             instead of a sender
//   </conversation-history>
//   <user_query>…</user_query>      the request, images in place
//   <Runtime>…</Runtime>            program state, as prepareTurn built it
//
// Every label, tag and transcript inside the items is kept exactly as
// prepareTurn produced it; only the item boundaries become text.

/** The sender label of GemiX's own replies inside the rendered history. */
const HISTORY_REPLY_LABEL = 'GemiX (you):';

/** Image types the Anthropic Messages API accepts as inline base64. */
const INLINE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** The largest base64 payload the Anthropic Messages API accepts for one image. */
const MAX_INLINE_IMAGE_BASE64_CHARS = 5 * 1024 * 1024;

/**
 * One Responses image reference as the Anthropic Messages API can take it.
 * GemiX inlines more types and larger files than that API accepts, and one
 * refused image would fail the whole request, so those become a note instead.
 *
 * @param {string} imageUrl - a data URL or an http(s) URL
 * @param {{ allowUrl?: boolean }} [opts] - false where only inline images can go
 * @returns {{ mediaType: string, data: string }|{ url: string }|{ note: string }}
 */
function readClaudeImage(imageUrl, { allowUrl = true } = {}) {
  const inline = /^data:([^;,]+);base64,(.*)$/s.exec(imageUrl);
  if (inline) {
    const mediaType = inline[1].toLowerCase();
    if (!INLINE_IMAGE_TYPES.has(mediaType)) {
      return { note: `[image not shown: ${mediaType} is not a supported image type; convert a copy to PNG in workspace/ with shell and read that]` };
    }
    if (inline[2].length > MAX_INLINE_IMAGE_BASE64_CHARS) {
      return { note: '[image not shown: larger than the model accepts; shrink a copy in workspace/ with shell and read that]' };
    }
    return { mediaType, data: inline[2] };
  }
  if (allowUrl && /^https?:\/\//i.test(imageUrl)) return { url: imageUrl };
  return { note: '[image not shown: unreadable image reference]' };
}

/** One Responses `input_image` part as an Anthropic content block. */
function _imageBlock(imageUrl) {
  const image = readClaudeImage(imageUrl);
  if (image.data) return { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } };
  if (image.url) return { type: 'image', source: { type: 'url', url: image.url } };
  return { type: 'text', text: image.note };
}

/** Append-only block list that merges consecutive text into one block. */
function _blockList() {
  const blocks = [];
  return {
    blocks,
    text(text) {
      if (!text) return;
      const last = blocks.at(-1);
      if (last?.type === 'text') last.text += text;
      else blocks.push({ type: 'text', text });
    },
    block(block) {
      if (block.type === 'text') this.text(block.text);
      else blocks.push(block);
    }
  };
}

/** Write one Responses item's visible content: text, and images in place. */
function _renderItem(list, item) {
  if (item.type === 'message' && item.role === 'assistant') {
    const text = item.content
      .filter(part => part?.type === 'output_text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('');
    list.text(`${HISTORY_REPLY_LABEL} ${text}`);
    return;
  }
  for (const part of Array.isArray(item.content) ? item.content : []) {
    if (part?.type === 'input_text' && typeof part.text === 'string') list.text(part.text);
    else if (part?.type === 'input_image' && typeof part.image_url === 'string') list.block(_imageBlock(part.image_url));
  }
}

/**
 * Render the turn's conversation as Anthropic user-message content blocks.
 *
 * @param {{ history: object[], query: object, runtime: object }} conversation -
 *   prepareTurn's conversation parts, as Responses items
 * @returns {object[]} text and image blocks
 */
function renderClaudeUserContent({ history, query, runtime }) {
  const list = _blockList();
  if (history.length > 0) {
    list.text('<conversation-history>\n');
    for (const item of history) {
      _renderItem(list, item);
      list.text('\n');
    }
    list.text('</conversation-history>\n\n');
  }
  _renderItem(list, query);
  list.text('\n\n');
  _renderItem(list, runtime);
  return list.blocks;
}

export { HISTORY_REPLY_LABEL, readClaudeImage, renderClaudeUserContent };
