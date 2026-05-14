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
  copyToProjectTool,
  deleteStorageTool,
  quotaTool,
} = require('./projects');

const GEMIX_PREFIX = 'gemix-project';
const FIXED_SUBDIRS = ['temp', 'output', 'code'];

const SUBCMD_HELP =
  'Valid subcommands: list, create, switch, delete, cleanup, quota, copy-to-project, delete-storage.';

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
function hasShellChaining(cmd) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const next = cmd[i + 1];
    if (c === '\\' && (inSingle || inDouble) && i + 1 < cmd.length) {
      i++;
      continue;
    }
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

function _parseArgs(argStr) {
  const args = [];
  let i = 0;
  const len = argStr.length;

  while (i < len) {
    // Skip leading whitespace
    while (i < len && /\s/.test(argStr[i])) i++;
    if (i >= len) break;

    const ch = argStr[i];
    let token = '';

    if (ch === '"' || ch === "'") {
      // Quoted token — supports backslash-escaped quotes inside
      const quote = ch;
      i++; // skip opening quote
      while (i < len) {
        const c = argStr[i];
        if (c === '\\' && i + 1 < len && (argStr[i + 1] === quote || argStr[i + 1] === '\\')) {
          // Escape sequence: \" or \' or \\
          token += argStr[i + 1];
          i += 2;
        } else if (c === quote) {
          i++; // skip closing quote
          break;
        } else {
          token += c;
          i++;
        }
      }
    } else {
      // Unquoted token — ends at whitespace
      while (i < len && !/\s/.test(argStr[i])) {
        token += argStr[i];
        i++;
      }
    }

    if (token.length > 0) args.push(token);
  }

  return args;
}

async function handleGemixProjectCmd(command, userCtx) {
  const raw = command.trim();
  if (!isGemixProjectCmd(raw)) return null;

  if (hasShellChaining(raw)) {
    return {
      success: false,
      error: 'gemix-project commands must run standalone — no chaining (&&, ||, ;, |, redirection, subshells). Run them in separate bash calls.',
    };
  }

  const rest = raw.slice(GEMIX_PREFIX.length).trim();
  if (!rest) return { success: false, error: `Missing subcommand. ${SUBCMD_HELP}` };

  const args = _parseArgs(rest);
  const subcmd = args[0].toLowerCase();
  const subArgs = args.slice(1).map(a => a.replace(/\/+$/, ''));

  switch (subcmd) {
    case 'list':
      return await listProjectsTool(userCtx);

    case 'quota':
      return await quotaTool(userCtx);

    case 'switch': {
      if (subArgs.length === 0) return { success: false, error: 'gemix-project switch <slug>: missing project name.' };
      return await switchProjectTool({ name: subArgs[0] }, userCtx);
    }

    case 'delete': {
      const name = subArgs.find(a => !a.startsWith('--'));
      const confirmed = subArgs.includes('--confirmed');
      if (!name) return { success: false, error: 'gemix-project delete <slug> --confirmed: missing project name.' };
      return await deleteProjectTool({ name, user_confirmed: confirmed }, userCtx);
    }

    case 'delete-storage': {
      const confirmed = subArgs.includes('--confirmed');
      const pathParts = subArgs.filter(a => a !== '--confirmed');
      if (pathParts.length === 0) {
        return { success: false, error: 'gemix-project delete-storage </readonly/searched_images/path> --confirmed: missing path.' };
      }
      return await deleteStorageTool({ path: pathParts.join(' '), user_confirmed: confirmed }, userCtx);
    }

    case 'cleanup': {
      if (subArgs.length === 0) {
        return { success: false, error: `gemix-project cleanup [<slug>] <subdir>...: missing arguments. Allowed subdirs: ${FIXED_SUBDIRS.join(', ')}.` };
      }
      // If first token is a known subdir, no project name was given (uses current project).
      if (FIXED_SUBDIRS.includes(subArgs[0])) {
        return await cleanupProjectTool({ subdirs: subArgs }, userCtx);
      }
      const [name, ...subdirParts] = subArgs;
      if (subdirParts.length === 0) {
        return { success: false, error: `gemix-project cleanup ${name} <subdir>...: specify at least one subdir. Allowed: ${FIXED_SUBDIRS.join(', ')}.` };
      }
      return await cleanupProjectTool({ name, subdirs: subdirParts }, userCtx);
    }

    case 'create': {
      if (subArgs.length === 0) {
        return {
          success: false,
          error: "gemix-project create '{...}': missing JSON. Required fields: name, user_request. (Optional: description, strategy).",
        };
      }
      // For 'create', the JSON might have spaces, so we should probably use the original argStr minus the subcommand
      const jsonStr = _stripShellQuotes(rest.slice(subcmd.length).trim());
      let parsed;
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        return {
          success: false,
          error: 'gemix-project create: argument must be a valid JSON object with fields: name, user_request. (Optional: description, strategy).',
        };
      }
      return await createProjectTool(parsed, userCtx);
    }

    case 'copy-to-project': {
      if (subArgs.length === 0) {
        return { success: false, error: 'gemix-project copy-to-project <source> [subdir]: missing source. Source must be like "foo.jpg" (from chat history) or "searched_images/bar.png".' };
      }
      // If we have 2 args, second is subdir. If 1 arg, source only.
      // But source might have spaces if NOT quoted, though _parseArgs handles quoted ones.
      // If the AI didn't quote a source with spaces, _parseArgs will split it.
      // However, we can be smart: if the LAST arg is a valid subdir, then everything before it is the source.
      let source, subdir;
      if (subArgs.length > 1 && FIXED_SUBDIRS.includes(subArgs[subArgs.length - 1])) {
        subdir = subArgs.pop();
        source = subArgs.join(' '); // Re-join if AI forgot quotes but we parsed it as multiple tokens
      } else {
        source = subArgs.join(' ');
        subdir = 'temp';
      }

      const copyArgs = { source };
      if (subdir) copyArgs.subdir = subdir;
      return await copyToProjectTool(copyArgs, userCtx);
    }

    default:
      return {
        success: false,
        error: `gemix-project: unknown subcommand "${subcmd}". ${SUBCMD_HELP}`,
      };
  }
}

module.exports = { handleGemixProjectCmd, isGemixProjectCmd, hasShellChaining, GEMIX_PREFIX };
