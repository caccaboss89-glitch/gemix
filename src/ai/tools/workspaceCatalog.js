// src/ai/tools/workspaceCatalog.js
//
// Path-centric workspace and process tools, available on every platform.

import constants from '../../config/constants.js';
import { makeTool } from './schema.js';

const WORKSPACE_PATH_HINT =
  'Path in the shared namespace: "workspace/<file>" for your own files, "attachments/<file>" for files '
  + 'from this chat. A path with no prefix is read as workspace/.';

const TOOL_LIST_FILES = makeTool({
  name: 'list_files',
  description: 'List what is in your workspace or in the files attached to this chat. Call it before assuming a file is or is not there.',
  properties: {
    path: { type: 'string', description: `Directory to list, default "workspace/". ${WORKSPACE_PATH_HINT}` },
    recursive: { type: 'boolean', description: 'Descend into sub-directories. Default false: only the entries directly inside it.' }
  }
});

const TOOL_SEARCH_FILES = makeTool({
  name: 'search_files',
  description: 'Find files by name pattern, or lines by exact text, without reading whole files. '
    + 'Use it on a workspace you did not just create, and to locate the part of a long file you need.',
  properties: {
    namePattern: {
      type: 'string',
      description: 'Glob on the name, e.g. "*.py". Include a slash to match the whole relative path, e.g. "src/*.md".'
    },
    contains: { type: 'string', description: 'Exact text to find inside text files. Returns path, line number and the matching line.' },
    path: { type: 'string', description: `Directory to search under, default "workspace/". ${WORKSPACE_PATH_HINT}` }
  }
});

const TOOL_READ_FILE = makeTool({
  name: 'read_file',
  description: 'Bring a supported local file into your context. Text and code come '
    + 'back as content; PDFs, Office documents, email and archives come back as their text, with pages or '
    + 'figures attached as images when the text alone would lose them; audio comes back as a transcript '
    + '(empty for music or ambient sound, which is not the same as silent); video comes back as its '
    + 'transcript plus frames sampled across the clip; images come back attached so you can look at them. '
    + 'Files in this chat that were not loaded this turn appear as "[Attachment: attachments/name.ext]" — '
    + 'pass that exact path here to open one.',
  properties: {
    path: { type: 'string', description: WORKSPACE_PATH_HINT },
    offset: { type: 'integer', description: 'Text files: first line to return, 1-based. Use with limit to page through a long file.' },
    limit: { type: 'integer', description: 'Text files: how many lines to return from offset.' }
  },
  required: ['path']
});

const TOOL_WRITE_FILE = makeTool({
  name: 'write_file',
  description: 'Create a file, or overwrite one completely. Only inside workspace/. '
    + 'To change part of an existing file use edit_file instead — this replaces the whole content. '
    + 'To change a file from attachments/, copy it into workspace/ with shell first.',
  properties: {
    path: { type: 'string', description: 'Destination under workspace/. Parent directories are created for you.' },
    content: { type: 'string', description: 'Full new content of the file.' }
  },
  required: ['path', 'content']
});

const TOOL_EDIT_FILE = makeTool({
  name: 'edit_file',
  description: 'Replace an exact piece of text in an existing workspace file. '
    + 'oldText must appear exactly once: copy it verbatim from read_file, whitespace included, and add '
    + 'surrounding lines until it is unique. Set replaceAll to change every occurrence instead.',
  properties: {
    path: { type: 'string', description: 'File under workspace/.' },
    oldText: { type: 'string', description: 'Exact text to replace, copied verbatim from the file.' },
    newText: { type: 'string', description: 'Replacement text. Empty string deletes the matched text.' },
    replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' }
  },
  required: ['path', 'oldText', 'newText']
});

function buildShellTool() {
  const defaultSec = Math.round(constants.SHELL_TIMEOUT_DEFAULT_MS / 1000);
  const maxSec = Math.round(constants.SHELL_TIMEOUT_MAX_MS / 1000);
  return makeTool({
    name: 'shell',
    description: 'Run a bash command in the workspace container: Python 3 (numpy, pandas, matplotlib, Pillow, rembg, '
      + 'python-docx/pptx/openpyxl, reportlab, pypdf, pdfplumber), Node, ffmpeg, yt-dlp, poppler, LibreOffice, '
      + 'TeX, zip/unzip, curl/wget. Use it to convert, compress, download, inspect and assemble files. '
      + 'Package installs (pip/npm/apt) are disabled — the toolchain is fixed. '
      + `Timeout ${defaultSec}s by default, ${maxSec}s maximum; start anything longer in the background and check on it in a later call. `
      + 'The container keeps running between calls in the same chat. Background jobs outlive the foreground '
      + 'workspace lock, so do not let them edit files that another tool call may change before they finish.',
    properties: {
      command: { type: 'string', description: 'Bash command line. Runs in workspace/ unless workingDir says otherwise.' },
      timeoutSeconds: { type: 'integer', description: `Seconds before the command is killed (default ${defaultSec}, max ${maxSec}).` },
      workingDir: { type: 'string', description: `Directory to run in, default "workspace/". ${WORKSPACE_PATH_HINT}` }
    },
    required: ['command']
  });
}

function workspaceTools() {
  return [
    TOOL_LIST_FILES,
    TOOL_SEARCH_FILES,
    TOOL_READ_FILE,
    TOOL_WRITE_FILE,
    TOOL_EDIT_FILE,
    buildShellTool()
  ];
}

export { workspaceTools };
