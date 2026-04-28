// src/tools/gemixProjectCmds.js
// Intercepts `gemix-project <subcmd> [args]` commands issued by the AI via
// the bash tool and routes them directly to the JS project-management
// functions. The sandbox is NEVER invoked for these commands — all logic
// runs in Node.js, with the same validation/security as the legacy tools.

const {
  listProjectsTool,
  createProjectTool,
  switchProjectTool,
  deleteProjectTool,
  cleanupProjectTool,
  copyToPermanentTool,
  copyToProjectTool,
  quotaTool,
} = require('./projects');

const GEMIX_PREFIX = 'gemix-project';
const FIXED_SUBDIRS = ['temp', 'output', 'code'];

const SUBCMD_HELP =
  'Valid subcommands: list, create, switch, delete, cleanup, quota, copy-to-permanent, copy-to-project.';

function _stripShellQuotes(s) {
  const t = s.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Detect shell chaining/redirection operators OUTSIDE of single/double-quoted
 * regions. Used to refuse mixed commands like `gemix-project list && ls`.
 */
function _hasChaining(cmd) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const next = cmd[i + 1];
    if (!inDouble && c === "'") { inSingle = !inSingle; continue; }
    if (!inSingle && c === '"') { inDouble = !inDouble; continue; }
    if (inSingle || inDouble) continue;
    if (c === ';') return true;
    if (c === '|') return true;
    if (c === '&' && next === '&') return true;
    if (c === '>' || c === '<') return true;
    if (c === '`') return true;
    if (c === '$' && next === '(') return true;
  }
  return false;
}

/**
 * Returns a result object if `command` starts with `gemix-project`, or null
 * if the command should be forwarded to the sandbox normally.
 *
 * @param {string} command - Raw bash command string from the AI
 * @param {object} userCtx - User context
 * @returns {object|null}
 */
function isGemixProjectCmd(command) {
  const raw = String(command || '').trim();
  if (raw === GEMIX_PREFIX) return true;
  return raw.startsWith(GEMIX_PREFIX + ' ') || raw.startsWith(GEMIX_PREFIX + '\t');
}

async function handleGemixProjectCmd(command, userCtx) {
  const raw = command.trim();
  if (!isGemixProjectCmd(raw)) return null;

  if (_hasChaining(raw)) {
    return {
      success: false,
      error: 'gemix-project commands must run standalone — no chaining (&&, ||, ;, |, redirection, subshells). Run them in separate bash calls.',
    };
  }

  const rest = raw.slice(GEMIX_PREFIX.length).trim();
  const spaceIdx = rest.indexOf(' ');
  const subcmd = (spaceIdx === -1 ? rest : rest.slice(0, spaceIdx)).toLowerCase();
  const argStr = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1).trim();

  switch (subcmd) {
    case 'list':
      return await listProjectsTool(userCtx);

    case 'quota':
      return await quotaTool(userCtx);

    case 'switch': {
      if (!argStr) return { success: false, error: 'gemix-project switch <slug>: missing project name.' };
      return await switchProjectTool({ name: argStr }, userCtx);
    }

    case 'delete': {
      const parts = argStr.split(/\s+/).filter(Boolean);
      const name = parts.find(p => !p.startsWith('--'));
      const confirmed = parts.includes('--confirmed');
      if (!name) return { success: false, error: 'gemix-project delete <slug> --confirmed: missing project name.' };
      return await deleteProjectTool({ name, user_confirmed: confirmed }, userCtx);
    }

    case 'cleanup': {
      const parts = argStr.split(/[\s,]+/).filter(Boolean);
      if (parts.length === 0) {
        return { success: false, error: `gemix-project cleanup [<slug>] <subdir>...: missing arguments. Allowed subdirs: ${FIXED_SUBDIRS.join(', ')}.` };
      }
      // If first token is a known subdir, no project name was given (uses current project).
      if (FIXED_SUBDIRS.includes(parts[0])) {
        return await cleanupProjectTool({ subdirs: parts }, userCtx);
      }
      const [name, ...subdirParts] = parts;
      if (subdirParts.length === 0) {
        return { success: false, error: `gemix-project cleanup ${name} <subdir>...: specify at least one subdir. Allowed: ${FIXED_SUBDIRS.join(', ')}.` };
      }
      return await cleanupProjectTool({ name, subdirs: subdirParts }, userCtx);
    }

    case 'create': {
      if (!argStr) {
        return {
          success: false,
          error: "gemix-project create '{...}': missing JSON. Required fields: name, user_request. (Optional: description, strategy).",
        };
      }
      let parsed;
      try {
        parsed = JSON.parse(_stripShellQuotes(argStr));
      } catch {
        return {
          success: false,
          error: 'gemix-project create: argument must be a valid JSON object with fields: name, user_request. (Optional: description, strategy).',
        };
      }
      return await createProjectTool(parsed, userCtx);
    }

    case 'copy-to-permanent': {
      if (!argStr) {
        return { success: false, error: 'gemix-project copy-to-permanent <history_filename>: missing filename.' };
      }
      return await copyToPermanentTool({ history_filename: argStr }, userCtx);
    }

    case 'copy-to-project': {
      const parts = argStr.split(/\s+/).filter(Boolean);
      const source = parts[0];
      const subdir = parts[1];
      if (!source) {
        return { success: false, error: 'gemix-project copy-to-project <source> [subdir]: missing source. Source must be like "history/foo.jpg" or "searched_images/bar.png".' };
      }
      const args = { source };
      if (subdir) args.subdir = subdir;
      return await copyToProjectTool(args, userCtx);
    }

    default:
      return {
        success: false,
        error: `gemix-project: unknown subcommand "${subcmd}". ${SUBCMD_HELP}`,
      };
  }
}

module.exports = { handleGemixProjectCmd, isGemixProjectCmd, GEMIX_PREFIX };
