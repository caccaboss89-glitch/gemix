// src/config/minecraftPlayers.js
//
// Who may control the Minecraft server on the admin's PC.
//
// The list is stored in src/data/minecraft.json (gitignored): an array of
// phone numbers with the country code, written as the user likes ("+39 333
// 123 4567", "393331234567"); only the digits count. It is independent of
// active membership, and it is read only on WhatsApp, in private chats and
// groups alike.
//
// A missing file means nobody may; an invalid one is reported and also means
// nobody may.
import fs from 'fs';
import path from 'path';
import constants from './constants.js';
import { createLogger } from '../utils/logger.js';

const PLAYERS_FILE = path.join(constants.DATA_DIR, 'minecraft.json');

const log = createLogger('MinecraftPlayers');

/** The digits of a phone number or JID: '+39 333…', '39333…' and '39333…@c.us' all give '39333…'. */
function _phone(number) {
  return String(number).split('@')[0].split(':')[0].replace(/\D/g, '');
}

function _validatePlayers(value) {
  if (!Array.isArray(value)) return { errors: ['minecraft.json must contain an array.'], phones: [] };
  const errors = [];
  value.forEach((number, index) => {
    if (typeof number !== 'string' || !_phone(number)) errors.push(`players[${index}] must be a phone number.`);
  });
  return { errors, phones: errors.length === 0 ? value.map(_phone) : [] };
}

function _loadPlayers() {
  if (!fs.existsSync(PLAYERS_FILE)) {
    log.info(`No Minecraft player list at ${PLAYERS_FILE}; nobody can control the server.`);
    return [];
  }
  try {
    const { errors, phones } = _validatePlayers(JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf-8')));
    if (errors.length > 0) {
      log.error(`Minecraft player list at ${PLAYERS_FILE} is invalid:\n${errors.join('\n')}`);
      return [];
    }
    log.info(`Loaded ${phones.length} Minecraft player(s) from ${PLAYERS_FILE}`);
    return phones;
  } catch (err) {
    log.error(`Failed to read the Minecraft player list at ${PLAYERS_FILE}: ${err.message}`);
    return [];
  }
}

const PLAYER_PHONES = new Set(_loadPlayers());

/**
 * Whether a WhatsApp JID belongs to a listed player.
 * @param {string} jid - e.g. '390000000000@c.us'
 * @returns {boolean}
 */
function isMinecraftPlayer(jid) {
  return typeof jid === 'string' && PLAYER_PHONES.has(_phone(jid));
}

export { isMinecraftPlayer };
