/**
 * Regenerate the system-prompt + tool-schema dumps and validate formatting.
 *
 * For every case it writes, into scripts/output-regenerate-prompt-dumps/, the EXACT material the model
 * receives that turn:
 *   - the STATIC prefix (input[0], role:system);
 *   - the DYNAMIC Runtime block (per-turn role:user item, not system);
 *   - the full tool schema (function tools + native xAI tools) for that
 *     platform / membership;
 *   - the structured-output (text.format) schema, when one applies.
 * A final workspace-runtime-dump.txt mirrors the container exec contract and
 * the filesystem tool schemas so prompts can be cross-checked in one place.
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
import { renderCase, renderWorkspaceRuntimeDump } from './prompt-dumps/render.js';
import {
  ISSUES,
  validatePrompt,
  validateResponseFormat,
  validateToolDumpLeaks,
  validateWorkspaceRuntimeDump
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
for (const id of ids) {
  const { staticPart, dynamicPart, dump } = renderCase(id);
  const file = path.join(OUT_DIR, `case${String(id).padStart(2, '0')}-dump.txt`);
  fs.writeFileSync(file, dump, 'utf8');
  validatePrompt(staticPart, dynamicPart, id);
  validateResponseFormat(dump, id);
  validateToolDumpLeaks(dump, id);
  console.log(`Wrote ${file}`);
}

const workspaceFile = path.join(OUT_DIR, 'workspace-runtime-dump.txt');
const workspaceDump = renderWorkspaceRuntimeDump();
fs.writeFileSync(workspaceFile, workspaceDump, 'utf8');
validateWorkspaceRuntimeDump(workspaceDump, PLATFORM_WA_DEDICATED);
console.log(`Wrote ${workspaceFile}`);

if (ISSUES.length) {
  console.error('\nValidation issues:');
  for (const i of ISSUES) console.error(`  case ${i.caseId}: ${i.msg}`);
  process.exit(1);
}
console.log(`\nAll ${ids.length} dumps OK.`);
