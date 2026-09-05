// src/ai/tools/workspaceCatalog.js
//
// Path-centric workspace and process tools, available on every platform.

import constants from '../../config/constants.js';
import { makeTool } from './schema.js';

/**
 * How the model is told to name a path. The skill library is a platform
 * capability, so the two variants exist rather than one hint that mentions a
 * root the caller may not have.
 */
function workspacePathHint(skills) {
  return 'Path in the shared namespace: "workspace/<file>" for your own files, "attachments/<file>" for files '
    + `from this chat${skills ? ', "skills/<name>/<file>" for the skill library' : ''}. `
    + 'A path with no prefix is read as workspace/.';
}

const buildListFilesTool = (skills) => makeTool({
  name: 'list_files',
  description: `List what is in your workspace${skills ? ', in the skill library,' : ''} or in the files attached `
    + 'to this chat. Call it before assuming a file is or is not there.',
  properties: {
    path: { type: 'string', description: `Directory to list, default "workspace/". ${workspacePathHint(skills)}` },
    recursive: { type: 'boolean', description: 'Descend into sub-directories. Default false: only the entries directly inside it.' }
  }
});

const buildSearchFilesTool = (skills) => makeTool({
  name: 'search_files',
  description: 'Find files by name pattern, lines by exact text, or both, without reading whole files. '
    + 'Each filter works on its own; when both are set, only files satisfying both are returned. '
    + 'Use it on a workspace you did not just create, and to locate the part of a long file you need. '
    + 'The result reports returned match counts, skipped files and truncation reasons.',
  properties: {
    namePattern: {
      type: 'string',
      description: 'Glob on the name, e.g. "*.py". Include a slash to match the whole relative path, e.g. "src/*.md".'
    },
    contains: { type: 'string', description: 'Exact text to find inside text files. Returns path, line number and the matching line.' },
    path: { type: 'string', description: `Directory to search under, default "workspace/". ${workspacePathHint(skills)}` }
  }
});

const buildReadFileTool = (skills) => makeTool({
  name: 'read_file',
  description: 'Bring a supported local file into your context. Text and code come '
    + 'back as content; PDFs, Office documents, email and archives come back as their text, with pages or '
    + 'figures attached as images when the text alone would lose them; audio comes back as a transcript '
    + '(empty for music or ambient sound, which is not the same as silent); video comes back as its '
    + 'transcript plus frames sampled across the clip; images come back attached so you can look at them. '
    + 'Files in this chat that were not loaded this turn appear as "[Attachment: attachments/name.ext]" — '
    + 'pass that exact path here to open one. Text metadata reports the returned line window, has_more and next_offset; '
    + `up to ${(constants.PARSE_MAX_TEXT_CHARS / 1000).toFixed(0)}K characters come back in one call before you must page with offset/limit, `
    + 'and a single line over the output cap returns an explicit error directing you to byte-slice it with shell. '
    + `Documents up to ${Math.round(constants.PARSE_MAX_DOCUMENT_BYTES / (1024 * 1024))} MB are accepted; larger ones need shell to extract the relevant part first.`,
  properties: {
    path: { type: 'string', minLength: 1, description: workspacePathHint(skills) },
    offset: { type: 'integer', minimum: 1, description: 'Text files only: first line to return, 1-based; ignored for images, audio, video and other non-text formats. Use with limit to page through a long file.' },
    limit: { type: 'integer', minimum: 1, description: 'Text files only: how many lines to return from offset; ignored for images, audio, video and other non-text formats.' }
  },
  required: ['path']
});

const buildWriteFileTool = (skills) => makeTool({
  name: 'write_file',
  description: 'Create a file, or overwrite one completely, under workspace/, the one root you can write in. '
    + 'To change part of an existing file use edit_file instead — this replaces the whole content. '
    + `To change a file from attachments/${skills ? ' or skills/' : ''}, copy it into workspace/ with shell first.`,
  properties: {
    path: { type: 'string', minLength: 1, description: 'Destination under workspace/. Parent directories are created for you.' },
    content: { type: 'string', description: 'Full new content of the file.' }
  },
  required: ['path', 'content']
});

const TOOL_EDIT_FILE = makeTool({
  name: 'edit_file',
  description: 'Replace an exact piece of text in an existing file under workspace/. '
    + 'oldText must appear exactly once: copy it verbatim from read_file, whitespace included, and add '
    + 'surrounding lines until it is unique. Set replaceAll to change every occurrence instead.',
  properties: {
    path: { type: 'string', minLength: 1, description: 'File under workspace/.' },
    oldText: { type: 'string', minLength: 1, description: 'Exact text to replace, copied verbatim from the file.' },
    newText: { type: 'string', description: 'Replacement text. Empty string deletes the matched text.' },
    replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' }
  },
  required: ['path', 'oldText', 'newText']
});

function buildShellTool(skills) {
  const defaultSec = Math.round(constants.SHELL_TIMEOUT_DEFAULT_MS / 1000);
  const maxSec = Math.round(constants.SHELL_TIMEOUT_MAX_MS / 1000);
  const idleMinutes = Math.round(constants.SANDBOX_IDLE_TTL_MS / 60_000);
  return makeTool({
    name: 'shell',
    description: 'Run a bash command in the workspace container: Python 3 (numpy, pandas, matplotlib, Pillow, rembg, '
      + 'python-docx/pptx/openpyxl, reportlab, pypdf, pdfplumber), Node, ffmpeg, yt-dlp, poppler, LibreOffice, '
      + 'TeX, zip/unzip, curl/wget. Use it to convert, compress, download, inspect and assemble files. '
      + 'Package installs (pip/npm/apt) are disabled — the toolchain is fixed. '
      + 'When an exact version matters, query the installed command or library with shell instead of assuming one. '
      + `Timeout ${defaultSec}s by default, ${maxSec}s maximum; for longer work, start it in the background, redirect its output into workspace/, print its PID, and inspect or stop it with a later shell call. `
      + `Each container has ${constants.SANDBOX_MEMORY_MB} MB RAM; at most ${constants.SANDBOX_MAX_CONTAINERS} chat containers run at once. A background job outlives the foreground call, `
      + `but the idle reaper stops the whole container after ${idleMinutes} minutes without a container command; workspace files remain. `
      + 'Do not let background jobs edit files that another tool call may change before they finish. '
      + `Captured stdout and stderr share one ${Math.round(constants.WORKSPACE_OUTPUT_MAX_BYTES / 1024)} KB cap (tail kept); read a larger result from its redirected file with read_file instead. `
      + 'The result reports exit_code, timed_out, output_truncated, output_dropped_bytes, duration_ms, stdout and stderr.',
    properties: {
      command: {
        type: 'string',
        minLength: 1,
        description: 'Bash command line. Without workingDir it runs at `/`, so workspace/<path>'
          + `${skills ? ', attachments/<path> and skills/<path>' : ' and attachments/<path>'} work exactly as shown by the file tools. `
          + 'If workingDir is set, relative operands start there; the absolute `/workspace/<path>`'
          + `${skills ? ', `/attachments/<path>` and `/skills/<path>`' : ' and `/attachments/<path>`'} remain root-stable.`
      },
      timeoutSeconds: {
        type: 'integer',
        minimum: 1,
        maximum: maxSec,
        description: `Seconds before the command is killed (default ${defaultSec}, max ${maxSec}).`
      },
      workingDir: {
        type: 'string',
        description: 'Optional command working directory. Omit it to use displayed namespace paths unchanged. '
          + 'When set, command-relative paths start in this directory; use an absolute '
          + `${skills ? '/workspace/..., /attachments/... or /skills/...' : '/workspace/... or /attachments/...'} `
          + `when you still need a namespace-root path. ${workspacePathHint(skills)}`
      }
    },
    required: ['command']
  });
}

/**
 * The six tools, described for a chat that has the skill library or for one
 * that does not: where it is off, `skills/` is not a root anywhere in the
 * namespace, so no description may name it.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.skills]
 */
function workspaceTools({ skills = true } = {}) {
  return [
    buildListFilesTool(skills),
    buildSearchFilesTool(skills),
    buildReadFileTool(skills),
    buildWriteFileTool(skills),
    TOOL_EDIT_FILE,
    buildShellTool(skills)
  ];
}

export { workspaceTools };
