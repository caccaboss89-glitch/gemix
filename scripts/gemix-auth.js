/**
 * GemiX credential management.
 *
 * The one-time, operator-driven half of the native auth subsystem: everything
 * the running bot needs afterwards (proactive refresh, rotation, pool health)
 * happens inside the process without any CLI at all.
 *
 * Usage (from the repo root):
 *   npm run auth -- list
 *   npm run auth -- login  <xai|chatgpt>
 *   npm run auth -- import <xai|chatgpt> [file] [--pool-key=<key>]
 *   npm run auth -- remove <xai|chatgpt> <accountId>
 *
 * `import` is a bootstrap shortcut for a host that already authorized through
 * another CLI. After it, that CLI must stop using the same credential: refresh
 * tokens are single-use and whichever side refreshes first kills the other copy.
 *
 * No token, refresh token or authorization code is ever printed.
 */
import { loopbackLogin } from '../src/ai/credentials/oauthClient.js';
import {
  CREDENTIAL_POOL,
  isDescriptorConfigured,
  oauthDescriptorFor
} from '../src/ai/credentials/oauthProviders.js';
import {
  listProviders,
  readPool,
  removeAccount,
  storePath,
  upsertAccount
} from '../src/ai/credentials/credentialStore.js';
import { IMPORT_SOURCES, importExternalCredentials } from '../src/ai/credentials/credentialImport.js';

const POOLS = Object.values(CREDENTIAL_POOL);

function usage() {
  console.log(`GemiX credential management

  npm run auth -- list
  npm run auth -- login  <${POOLS.join('|')}>
  npm run auth -- import <${POOLS.join('|')}> [file] [--pool-key=<key>]
  npm run auth -- remove <${POOLS.join('|')}> <accountId>

Default import files:
${POOLS.map(p => `  ${p}: ${IMPORT_SOURCES[p] || '(none)'}`).join('\n')}`);
}

function requirePool(value) {
  const pool = String(value || '').trim().toLowerCase();
  if (!POOLS.includes(pool)) {
    throw new Error(`Unknown pool "${value}". Known pools: ${POOLS.join(', ')}.`);
  }
  return pool;
}

function describeAccount(account) {
  const expiry = account.expiresAtMs
    ? new Date(account.expiresAtMs).toISOString()
    : 'no recorded expiry';
  const refresh = account.refreshToken ? 'refreshable' : 'NO refresh token';
  const label = account.label ? ` "${account.label}"` : '';
  return `  - ${account.id}${label} — priority ${account.priority}, ${account.lastStatus}, `
    + `expires ${expiry}, ${refresh}`;
}

function cmdList() {
  const providers = listProviders();
  if (providers.length === 0) {
    console.log('No credential store yet. Run `npm run auth -- login <pool>` first.');
    return;
  }
  for (const provider of providers) {
    const accounts = readPool(provider);
    console.log(`${provider} (${storePath(provider)}) — ${accounts.length} account(s)`);
    for (const account of accounts) console.log(describeAccount(account));
  }
}

async function cmdLogin(poolArg) {
  const pool = requirePool(poolArg);
  const descriptor = oauthDescriptorFor(pool);
  const configured = isDescriptorConfigured(descriptor);
  if (!configured.ok) throw new Error(configured.reason);

  console.log(`Starting the ${pool} login. A browser tab has to open the URL below on this machine;`);
  console.log(`the provider redirects back to ${descriptor.redirectUri}, which GemiX is now listening on.\n`);

  const tokens = await loopbackLogin(descriptor, {
    onAuthorizeUrl: (url) => console.log(`${url}\n`)
  });

  const id = `${pool}-${Date.now().toString(36)}`;
  await upsertAccount(pool, {
    id,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAtMs: tokens.expiresAtMs,
    lastStatus: 'ok'
  });
  console.log(`Stored ${pool} account "${id}" in ${storePath(pool)} (0600).`);
  if (!tokens.refreshToken) {
    console.log('Warning: the provider returned no refresh token, so this credential cannot be renewed.');
  }
}

async function cmdImport(poolArg, fileArg, flags) {
  const pool = requirePool(poolArg);
  const result = await importExternalCredentials({ pool, file: fileArg, poolKey: flags['pool-key'] || null });
  console.log(`Imported ${result.imported} ${pool} account(s) from ${result.file}: ${result.ids.join(', ')}`);
  console.log('Stop using that credential from the other CLI: refresh tokens are single-use.');
}

async function cmdRemove(poolArg, accountId) {
  const pool = requirePool(poolArg);
  if (!accountId) throw new Error('remove needs an accountId (see `npm run auth -- list`).');
  const before = readPool(pool).length;
  const after = (await removeAccount(pool, accountId)).length;
  if (before === after) throw new Error(`No account "${accountId}" in the ${pool} pool.`);
  console.log(`Removed ${pool} account "${accountId}".`);
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = {};
  const positional = [];
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) flags[match[1]] = match[2];
    else positional.push(arg);
  }

  const [command, ...rest] = positional;
  switch (command) {
  case 'list': return cmdList();
  case 'login': return cmdLogin(rest[0]);
  case 'import': return cmdImport(rest[0], rest[1], flags);
  case 'remove': return cmdRemove(rest[0], rest[1]);
  default:
    usage();
    if (command) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\n${err.message}\n`);
  process.exitCode = 1;
});
