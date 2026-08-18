/**
 * Regenerate the system-prompt + tool-schema dumps and validate formatting.
 *
 * For every case it writes, into scripts/output-regenerate-prompt-dumps/, the EXACT material the model
 * receives that turn:
 *   - the STATIC prefix (input[0], role:system);
 *   - the DYNAMIC Runtime block (per-turn role:user item, not system);
 *   - the full tool schema (function tools + the active provider's hosted
 *     tools) for that platform / membership;
 *   - the structured-output (text.format) schema, when one applies.
 * Every case is rendered once per provider as `<provider>-caseNN-dump.txt`, and
 * each provider also gets a `<provider>-build-agent-dump.txt` mirroring that
 * profile's build sub-agent rules and host exec contract.
 *
 * The corpus lives in scripts/prompt-dumps/cases.js, the text generation in
 * render.js and every assertion in validate.js. This file only wires them
 * together and writes the files.
 *
 * Everything runs offline (no API calls).
 *
 * Usage (from repo root):
 *   node scripts/regenerate-prompt-dumps.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import constants from '../src/config/constants.js';
import { CASES } from './prompt-dumps/cases.js';
import { renderCase, renderBuildAgentDump } from './prompt-dumps/render.js';
import envConfig from '../src/config/env.js';
import {
  ISSUES,
  validatePrompt,
  validateResponseFormat,
  validateToolDumpLeaks,
  validateBuildAgentDump,
  validateProviderIsolation
} from './prompt-dumps/validate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { PLATFORM_WA_DEDICATED } = constants;
const OUT_DIR = path.join(__dirname, 'output-regenerate-prompt-dumps');

if (fs.existsSync(OUT_DIR)) {
  // Clean only prior dump files; leave any subdirectories intact.
  for (const f of fs.readdirSync(OUT_DIR)) {
    const p = path.join(OUT_DIR, f);
    if (fs.statSync(p).isFile()) fs.unlinkSync(p);
  }
} else {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

const ids = Object.keys(CASES).map(Number).sort((a, b) => a - b);
let written = 0;

// The same case corpus is rendered once per provider: the two branches have to
// be comparable side by side, and each is validated against its own profile.
for (const providerId of envConfig.AI_PROVIDERS) {
  for (const id of ids) {
    const { staticPart, dynamicPart, dump } = renderCase(id, providerId);
    const file = path.join(OUT_DIR, `${providerId}-case${String(id).padStart(2, '0')}-dump.txt`);
    fs.writeFileSync(file, dump, 'utf8');
    validatePrompt(staticPart, dynamicPart, id, providerId);
    validateResponseFormat(dump, id, providerId);
    validateToolDumpLeaks(dump, id, providerId);
    validateProviderIsolation(dump, id, providerId);
    written++;
    console.log(`Wrote ${file}`);
  }

  const buildFile = path.join(OUT_DIR, `${providerId}-build-agent-dump.txt`);
  const buildDump = renderBuildAgentDump(providerId);
  fs.writeFileSync(buildFile, buildDump, 'utf8');
  validateBuildAgentDump(buildDump, PLATFORM_WA_DEDICATED, providerId);
  validateProviderIsolation(buildDump, 'build', providerId);
  written++;
  console.log(`Wrote ${buildFile}`);
}

if (ISSUES.length) {
  console.error('\nValidation issues:');
  for (const i of ISSUES) console.error(`  case ${i.caseId}: ${i.msg}`);
  process.exit(1);
}
console.log(`\nAll ${written} dumps OK.`);
