// TEMPORARY: apply the WhatsApp Web media-ID compatibility patch after install.
// Remove this script and the postinstall hook once the pinned dependency ships it.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PATCH_LINE = 'delete message.__x_id;';
const MESSAGE_FOLLOWUP = '// Bot\'s won\'t reply if canonicalUrl is set (linking)';

function patchWhatsAppMediaMessageId(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  if (source.includes(PATCH_LINE)) return { changed: false };

  const followupIndex = source.indexOf(MESSAGE_FOLLOWUP);
  const messageStart = source.lastIndexOf('const message = {', followupIndex);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const objectEnd = source.lastIndexOf(`${newline}        };`, followupIndex);
  if (followupIndex < 0 || messageStart < 0 || objectEnd < messageStart) {
    throw new Error(`Unsupported whatsapp-web.js sendMessage layout in ${filePath}`);
  }

  const insertion = `${newline}${newline}        // MediaData may carry an internal ID that must not replace the message key.${newline}        ${PATCH_LINE}`;
  fs.writeFileSync(
    filePath,
    source.slice(0, objectEnd + `${newline}        };`.length)
      + insertion
      + source.slice(objectEnd + `${newline}        };`.length),
    'utf8'
  );
  return { changed: true };
}

function main() {
  const filePath = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js');
  if (!fs.existsSync(filePath)) {
    throw new Error(`Cannot find whatsapp-web.js injected source at ${filePath}`);
  }
  const { changed } = patchWhatsAppMediaMessageId(filePath);
  console.log(`[postinstall] Temporary WhatsApp Web media-ID patch ${changed ? 'applied' : 'already present'}.`);
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) main();

export { patchWhatsAppMediaMessageId };
