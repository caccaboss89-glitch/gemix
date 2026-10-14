// src/minecraft/wakeOnLan.js
//
// The Wake-on-LAN magic packet: six 0xFF bytes, then the target MAC sixteen
// times, broadcast over UDP. The network card of a powered-off PC listens for
// it and turns the PC on.

import dgram from 'node:dgram';

const WOL_PORT = 9;

/** The magic packet for a MAC written with ':' or '-' separators. */
function magicPacket(mac) {
  const hex = String(mac).replace(/[:-]/g, '');
  if (!/^[0-9a-f]{12}$/i.test(hex)) throw new Error(`"${mac}" is not a MAC address.`);
  const target = Buffer.from(hex, 'hex');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(target)]);
}

/**
 * Broadcast the magic packet once.
 * @param {{ mac: string, broadcast: string }} opts
 * @returns {Promise<void>}
 */
function sendMagicPacket({ mac, broadcast }) {
  const packet = magicPacket(mac);
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', (err) => {
      socket.close();
      reject(err);
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, WOL_PORT, broadcast, (err) => {
        socket.close();
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

export { magicPacket, sendMagicPacket };
