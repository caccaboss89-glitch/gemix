// src/minecraft/rcon.js
//
// Minimal client for the Minecraft RCON protocol, used by the PC agent to run
// console commands on the server it shares a machine with.
//
// A packet is little-endian: int32 length, int32 request id, int32 type, then
// the payload and two NUL bytes. The server splits a long reply into several
// packets with the same id and no end marker, so every command is followed by
// a packet of an unknown type: the server answers it only after the command's
// reply, and that answer closes the reply.

import net from 'node:net';

const TYPE = { RESPONSE: 0, COMMAND: 2, LOGIN: 3 };
const HEADER_BYTES = 12;
const AUTH_FAILED_ID = -1;
const DEFAULT_TIMEOUT_MS = 10_000;

/** One RCON packet as bytes. */
function encodePacket(id, type, payload) {
  const body = Buffer.from(payload, 'utf8');
  const packet = Buffer.alloc(HEADER_BYTES + body.length + 2);
  packet.writeInt32LE(packet.length - 4, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  body.copy(packet, HEADER_BYTES);
  return packet;
}

/**
 * The complete packets at the head of a buffer.
 * @returns {{ packets: Array<{ id: number, type: number, payload: string }>, rest: Buffer }}
 */
function decodePackets(buffer) {
  const packets = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readInt32LE(offset);
    if (buffer.length - offset - 4 < length) break;
    packets.push({
      id: buffer.readInt32LE(offset + 4),
      type: buffer.readInt32LE(offset + 8),
      payload: buffer.toString('utf8', offset + HEADER_BYTES, offset + 4 + length - 2)
    });
    offset += 4 + length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

/** Minecraft's § formatting codes, which a chat client renders and a text reply does not. */
function stripFormatting(text) {
  return text.replace(/§[0-9a-fk-or]/gi, '');
}

/**
 * Log in and run one command.
 *
 * @param {{ host: string, port: number, password: string, command: string, timeoutMs?: number }} opts
 * @returns {Promise<string>} the reply, without formatting codes
 */
function runRconCommand({ host, port, password, command, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let pending = Buffer.alloc(0);
    let reply = '';
    let loggedIn = false;
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`RCON gave no answer within ${timeoutMs / 1000}s`)), timeoutMs);

    socket.on('connect', () => socket.write(encodePacket(1, TYPE.LOGIN, password)));
    socket.on('data', (chunk) => {
      const decoded = decodePackets(Buffer.concat([pending, chunk]));
      pending = decoded.rest;
      for (const packet of decoded.packets) {
        if (packet.type === TYPE.COMMAND && packet.id === 1) {
          loggedIn = true;
          socket.write(encodePacket(2, TYPE.COMMAND, command));
          socket.write(encodePacket(3, TYPE.RESPONSE, ''));
        } else if (packet.id === AUTH_FAILED_ID) {
          finish(new Error('RCON refused the password'));
        } else if (packet.id === 2) {
          reply += packet.payload;
        } else if (packet.id === 3) {
          finish(null, stripFormatting(reply));
        }
      }
    });
    // A command that stops the server can close the connection before the
    // closing packet arrives; what was read by then is the whole reply.
    socket.on('close', () => finish(
      loggedIn ? null : new Error('RCON closed the connection before the login'),
      stripFormatting(reply)
    ));
    socket.on('error', err => finish(err));
  });
}

export { decodePackets, encodePacket, runRconCommand, stripFormatting };
