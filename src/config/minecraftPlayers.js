// src/config/minecraftPlayers.js
//
// Who may control the Minecraft server on the admin's PC.
//
// The list is stored in src/data/minecraft.json (gitignored), in the shape of
// members.json: an array of { name, wa }, where wa is the player's WhatsApp
// JID or bare number. It is independent of active membership, and it is read
// only on WhatsApp, in private chats and groups alike.
//
// A missing file means nobody may; an invalid one is reported and also means
// nobody may.
import fs from 'fs';
import path from 'path';
import constants from './constants.js';
import { createLogger } from '../utils/logger.js';

const PLAYERS_FILE = path.join(constants.DATA_DIR, 'minecraft.json');

const log = createLogger('MinecraftPlayers');

/** The phone part of a JID or number: '39333…@c.us' and '39333…' both give '39333…'. */
function _phone(wa) {
  return String(wa).split('@')[0].split(':')[0].replace(/\D/g, '');
}

function _validatePlayers(value) {
  if (!Array.isArray(value)) return { errors: ['minecraft.json must contain an array.'], players: [] };
  const errors = [];
  value.forEach((player, index) => {
    const valid = player && typeof player === 'object' && !Array.isArray(player)
      && typeof player.name === 'string' && player.name.trim()
      && typeof player.wa === 'string' && _phone(player.wa);
    if (!valid) errors.push(`players[${index}] must be an object with a non-empty name and a WhatsApp number in wa.`);
  });
  return { errors, players: errors.length === 0 ? value : [] };
}

function _loadPlayers() {
  if (!fs.existsSync(PLAYERS_FILE)) {
    log.info(`No Minecraft player list at ${PLAYERS_FILE}; nobody can control the server.`);
    return [];
  }
  try {
    const { errors, players } = _validatePlayers(JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf-8')));
    if (errors.length > 0) {
      log.error(`Minecraft player list at ${PLAYERS_FILE} is invalid:\n${errors.join('\n')}`);
      return [];
    }
    log.info(`Loaded ${players.length} Minecraft player(s) from ${PLAYERS_FILE}`);
    return players;
  } catch (err) {
    log.error(`Failed to read the Minecraft player list at ${PLAYERS_FILE}: ${err.message}`);
    return [];
  }
}

const PLAYER_PHONES = new Set(_loadPlayers().map(player => _phone(player.wa)));

/**
 * Whether a WhatsApp JID belongs to a listed player.
 * @param {string} jid - e.g. '390000000000@c.us'
 * @returns {boolean}
 */
function isMinecraftPlayer(jid) {
  return typeof jid === 'string' && PLAYER_PHONES.has(_phone(jid));
}

export { isMinecraftPlayer };
