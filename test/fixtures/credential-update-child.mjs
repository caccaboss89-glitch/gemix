import { updatePool } from '../../src/ai/credentials/credentialStore.js';

const [pool, id] = process.argv.slice(2);
await updatePool(pool, async (accounts) => {
  await new Promise(resolve => setTimeout(resolve, 100));
  return [...accounts, { id, accessToken: `token-${id}`, refreshToken: null }];
});
