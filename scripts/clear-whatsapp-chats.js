/**
 * Empty every chat of the dedicated WhatsApp account, on the bot's side only.
 *
 * Meant for a release whose GemiX should not be steered by the replies an
 * older one left in the chats: the history window reads those chats, so once
 * they are empty every conversation starts fresh. Nothing GemiX stores on the
 * server is touched (reminders, preferences, workspaces, members, privacy
 * notices...): erasing those is what the /clear command is for.
 *
 * It works on the running bot: it attaches to the dedicated account's Chrome
 * through its DevTools port, runs the same clear as /clear
 * (src/platforms/whatsapp/chatClear.js) and detaches without closing anything.
 * Private chats and groups are cleared; status, channels and broadcast lists
 * are left alone. The personal account is never touched: a clear made on a
 * linked device applies to the whole account, so there it would empty the
 * admin's own chats on the phone.
 *
 * Usage (from repo root, on the server, with GemiX running):
 *   node scripts/clear-whatsapp-chats.js         list the chats it would clear
 *   node scripts/clear-whatsapp-chats.js --yes   clear them
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { clearChatInPage } from '../src/platforms/whatsapp/chatClear.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// LocalAuth keeps the session in the bot's working directory, the repo root.
const PORT_FILE = path.join(ROOT, '.wwebjs_auth', 'session-dedicated', 'DevToolsActivePort');
const CLEARED_SERVERS = ['c.us', 'lid', 'g.us'];

/* global window -- _listChatsInPage runs in the browser page */

/**
 * Runs inside the WhatsApp Web page: the private chats and groups that hold
 * something to clear.
 * @param {string[]} servers
 * @returns {{ id: string, title: string, isGroup: boolean }[]}
 */
function _listChatsInPage(servers) {
  return window.require('WAWebChatCollection').ChatCollection.getModelsArray()
    .filter(chat => servers.includes(chat.id.server) && chat.getLastMsgKeyForAction())
    .map(chat => ({
      id: chat.id._serialized,
      title: chat.formattedTitle || '',
      isGroup: chat.id.server === 'g.us'
    }));
}

function _describe(chat) {
  return `${chat.isGroup ? 'group  ' : 'private'} ${chat.title || '(no name)'} — ${chat.id}`;
}

async function main() {
  const execute = process.argv.includes('--yes');
  if (!fs.existsSync(PORT_FILE)) {
    throw new Error(`No DevTools port file at ${PORT_FILE}: is GemiX running here?`);
  }
  const port = fs.readFileSync(PORT_FILE, 'utf8').split('\n')[0].trim();
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
  try {
    const page = (await browser.pages()).find(p => p.url().startsWith('https://web.whatsapp.com'));
    if (!page) throw new Error('The dedicated account has no WhatsApp Web page open');
    const chats = await page.evaluate(_listChatsInPage, CLEARED_SERVERS);
    for (const chat of chats) console.log(`  ${_describe(chat)}`);

    if (!execute) {
      console.log(`\n${chats.length} chat(s) to clear. Rerun with --yes to clear them.`);
      return;
    }

    const failed = [];
    for (const chat of chats) {
      let cleared = false;
      try {
        cleared = await clearChatInPage(page, chat.id, Math.floor(Date.now() / 1000));
      } catch (err) {
        console.error(`  ${chat.id}: ${err.message}`);
      }
      if (!cleared) failed.push(chat);
    }
    console.log(`\nCleared ${chats.length - failed.length}/${chats.length} chat(s).`);
    if (failed.length > 0) {
      console.log('Not cleared (rerun to retry):');
      for (const chat of failed) console.log(`  ${_describe(chat)}`);
      process.exitCode = 1;
    }
  } finally {
    await browser.disconnect();
  }
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
