// src/tools/projects.js
// Project-management functions: list / create / switch / delete / cleanup,
// plus copy helpers from history and searched_images into the project space.
// These are NOT exposed as AI-callable tools anymore — they are invoked by
// gemixProjectCmds.js when the AI runs `gemix-project <subcmd>` via bash.

const fs = require('fs');
const path = require('path');
const { MAX_PROJECTS_PER_USER, MAX_USER_TOTAL_MB, PLATFORM_DISCORD } = require('../config/constants');
const { resolveStorageId, ensureUserSkeleton, ensureProjectSkeleton, sanitizeProjectName, listProjects, readProjectMeta, writeProjectMeta, projectExists, getProjectRoot, getProjectSubdir, getPermanentDir, userTotalBytes, userQuotaBytes, projectSizeBytes, FIXED_PROJECT_SUBDIRS, isPathAllowed } = require('../utils/userPaths');
const { getCurrentProject, setCurrentProject } = require('../utils/projectState');
const { copyFromHistory } = require('../utils/historySync');
const { createLogger } = require('../utils/logger');

const log = createLogger('Projects');

// ── Guards ──

function _err(msg) { return { success: false, error: msg }; }

function _guardPlatform(userCtx) {
  if (userCtx.platform === PLATFORM_DISCORD) {
    return _err('Project tools are not available on Discord. Use WhatsApp for agentic features.');
  }
  if (!resolveStorageId(userCtx)) {
    return _err('Could not resolve storage ID.');
  }
  return null;
}

// ── Tools ──

/**
 * Invoked by `gemix-project list` — returns the list of projects with description + current.
 */
async function listProjectsTool(userCtx) {
  const guard = _guardPlatform(userCtx);
  if (guard) return guard;

  ensureUserSkeleton(userCtx);
  const projects = listProjects(userCtx);
  const current = await getCurrentProject(userCtx);
  const projectLines = projects.map(p => {
    return `  <Project name="${p.name}" last_used="${p.last_used_at}"${p.name === current ? ' current="true"' : ''}>${p.description}</Project>`;
  }).join('\n');

  const output = `<ProjectList count="${projects.length}" max="${MAX_PROJECTS_PER_USER}" current="${current || ''}">
${projectLines || '  <!-- No projects found -->' }
</ProjectList>`;

  return {
    success: true,
    content: output,
  };
}

/**
 * Invoked by `gemix-project create '{...}'`. Args: { name, description, user_request, strategy }.
 * - Validates slug, uniqueness, max count.
 * - Creates scaffold + README.md + .project.json.
 * - Sets as current project.
 */
async function createProjectTool(args, userCtx) {
  const guard = _guardPlatform(userCtx);
  if (guard) return guard;

  const { name, user_request } = args || {};
  if (!name || !user_request) {
    return _err('Missing required fields: name, user_request. (Optional: description, strategy)');
  }
  const description = args.description || 'No description provided.';
  const strategy = args.strategy || 'General agentic strategy.';

  const slug = sanitizeProjectName(name);
  if (!slug) return _err('Invalid project name (empty after sanitization). Use letters, numbers, _ or -.');

  ensureUserSkeleton(userCtx);
  const existing = listProjects(userCtx);
  if (existing.length >= MAX_PROJECTS_PER_USER) {
    return {
      success: false,
      error: `Project limit reached (${MAX_PROJECTS_PER_USER}). Ask the user which existing project to delete, then run \`gemix-project delete <slug> --confirmed\` via bash before creating a new one.`,
      existing_projects: existing.map(p => ({ name: p.name, description: p.description })),
    };
  }
  if (projectExists(userCtx, slug)) {
    return _err(`A project named "${slug}" already exists. Choose a different name or run \`gemix-project switch ${slug}\` via bash.`);
  }

  ensureProjectSkeleton(userCtx, slug);

  const now = new Date().toISOString();
  const meta = {
    name: slug,
    original_name: name,
    description: String(description).slice(0, 500),
    created_at: now,
    last_used_at: now,
  };
  writeProjectMeta(userCtx, slug, meta);

  const readme = [
    `# ${name}`,
    '',
    `**Slug:** \`${slug}\``,
    `**Created:** ${now}`,
    '',
    '## Description',
    String(description).trim(),
    '',
    '## User request',
    String(user_request).trim(),
    '',
    '## Strategy',
    String(strategy).trim(),
    '',
  ].join('\n');

  try {
    fs.writeFileSync(path.join(getProjectRoot(userCtx, slug), 'README.md'), readme, 'utf-8');
  } catch (err) {
    log.error(`Failed to write README for ${slug}: ${err.message}`);
  }

  await setCurrentProject(userCtx, slug);
  return {
    success: true,
    project: slug,
    current_project: slug,
    message: `Project "${slug}" created and selected as current. Write scripts in projects/${slug}/code/, intermediate files in temp/, final deliverables (auto-delivered to user) in output/.`,
  };
}

/**
 * Invoked by `gemix-project switch <slug>`. Args: { name }.
 */
async function switchProjectTool(args, userCtx) {
  const guard = _guardPlatform(userCtx);
  if (guard) return guard;

  const name = args && args.name;
  if (!name) return _err('Missing "name".');
  const slug = sanitizeProjectName(name);
  if (!slug || !projectExists(userCtx, slug)) {
    return {
      success: false,
      error: `Project "${name}" not found. Run \`gemix-project list\` via bash to see available projects.`,
    };
  }

  // Refresh last_used_at
  const meta = readProjectMeta(userCtx, slug) || {};
  meta.last_used_at = new Date().toISOString();
  writeProjectMeta(userCtx, slug, meta);

  await setCurrentProject(userCtx, slug);
  return { success: true, message: `Switched to project "${slug}".` };
}

/**
 * Invoked by `gemix-project delete <slug> --confirmed`. Args: { name, user_confirmed: true }.
 * Refuses without explicit user_confirmed=true flag.
 */
async function deleteProjectTool(args, userCtx) {
  const guard = _guardPlatform(userCtx);
  if (guard) return guard;

  const name = args && args.name;
  const confirmed = args && args.user_confirmed === true;
  if (!name) return _err('Missing "name".');
  if (!confirmed) {
    return _err('user_confirmed must be true. First ask the user to explicitly confirm deletion of this project, then retry with user_confirmed=true.');
  }

  const slug = sanitizeProjectName(name);
  if (!slug || !projectExists(userCtx, slug)) {
    return _err(`Project "${name}" not found.`);
  }

  const root = getProjectRoot(userCtx, slug);
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (err) {
    return _err(`Failed to delete project: ${err.message}`);
  }

  const current = await getCurrentProject(userCtx);
  return {
    success: true,
    message: `Project "${slug}" deleted.${current ? ` Current project: ${current}` : ' No project currently selected.'}`,
  };
}

/**
 * Invoked by `gemix-project cleanup [<slug>] <subdir>...`. Args: { name?, subdirs: ["temp","output","code"] }.
 * Deletes the CONTENTS of the specified subdirs (keeps the folders).
 */
async function cleanupProjectTool(args, userCtx) {
  const guard = _guardPlatform(userCtx);
  if (guard) return guard;

  const name = (args && args.name) || (await getCurrentProject(userCtx));
  if (!name) return _err('No project specified and no current project selected.');
  const slug = sanitizeProjectName(name);
  if (!slug || !projectExists(userCtx, slug)) return _err(`Project "${name}" not found.`);

  const subdirs = Array.isArray(args && args.subdirs) ? args.subdirs : [];
  if (subdirs.length === 0) return _err(`Missing "subdirs". Allowed: ${FIXED_PROJECT_SUBDIRS.join(', ')}.`);

  const invalid = subdirs.filter(s => !FIXED_PROJECT_SUBDIRS.includes(s));
  if (invalid.length > 0) {
    return _err(`Invalid subdir(s): ${invalid.join(', ')}. Allowed: ${FIXED_PROJECT_SUBDIRS.join(', ')}.`);
  }

  const cleared = {};
  for (const sub of subdirs) {
    const dir = getProjectSubdir(userCtx, slug, sub);
    let removed = 0;
    try {
      if (fs.existsSync(dir)) {
        for (const entry of fs.readdirSync(dir)) {
          try {
            fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
            removed++;
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      log.error(`cleanup_project ${slug}/${sub}: ${err.message}`);
    }
    cleared[sub] = removed;
  }
  return { success: true, message: `Cleanup complete for project "${slug}". Subdirs cleared: ${subdirs.join(', ')}.` };
}

/**
 * Invoked by `gemix-project copy-to-permanent <history_filename>`. Args: { history_filename }.
 * Copies a file from history/ to permanent/ (never moves).
 */
async function copyToPermanentTool(args, userCtx) {
  const guard = _guardPlatform(userCtx);
  if (guard) return guard;
  const name = args && args.history_filename;
  if (!name) return _err('Missing "history_filename".');
  // Reject paths that try to escape history/
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return _err('"history_filename" must be a bare filename present in history/.');
  }
  ensureUserSkeleton(userCtx);
  const dest = getPermanentDir(userCtx);
  const storageId = resolveStorageId(userCtx);
  const result = copyFromHistory(storageId, name, dest);
  if (!result.success) return _err(result.error);
  return {
    success: true,
    message: `File copied: history/${name} -> permanent/${result.finalName}`,
  };
}

/**
 * Invoked by `gemix-project copy-to-project <source> [<subdir>]`.
 * Args: { source, subdir?: 'temp'|'output'|'code' }.
 * Source may be "history/<file>" or "searched_images/<file>". Default subdir = temp.
 * Writes into the currently selected project.
 */
async function copyToProjectTool(args, userCtx) {
  const guard = _guardPlatform(userCtx);
  if (guard) return guard;
  const source = args && args.source;
  if (!source) return _err('Missing "source".');
  const subdir = (args && args.subdir) || 'temp';
  if (!FIXED_PROJECT_SUBDIRS.includes(subdir)) {
    return _err(`Invalid subdir "${subdir}". Allowed: ${FIXED_PROJECT_SUBDIRS.join(', ')}.`);
  }

  const current = await getCurrentProject(userCtx);
  if (!current) return _err('No project is currently selected. Run `gemix-project create` (new) or `gemix-project switch <slug>` (existing) via bash first.');

  // Source must be read-allowed and live in history/ or searched_images/
  const srcCheck = isPathAllowed(userCtx, source, { op: 'read' });
  if (!srcCheck.ok) return _err(`Invalid source: ${srcCheck.reason}`);
  if (srcCheck.zone !== 'history' && srcCheck.zone !== 'searched_images') {
    return _err('Source must be inside history/ or searched_images/.');
  }

  if (!fs.existsSync(srcCheck.absPath)) return _err(`Source file not found: ${source}.`);
  if (fs.statSync(srcCheck.absPath).isDirectory()) return _err('Source must be a file, not a directory.');

  // Per-user quota check (aggregate of projects/ + searched_images/)
  if (userTotalBytes(userCtx) >= userQuotaBytes()) {
    return _err(`Your personal cloud is full (${MAX_USER_TOTAL_MB} MB). Free space with \`gemix-project cleanup\` or \`gemix-project delete --confirmed\` via bash before copying more files.`);
  }

  ensureProjectSkeleton(userCtx, current);
  const destDir = getProjectSubdir(userCtx, current, subdir);
  const origName = path.basename(srcCheck.absPath);
  // Re-use the same unique-name logic as copyFromHistory by piggybacking its helper
  // via a fresh copy: we simply write ourselves to avoid exporting another internal.
  let finalName = origName;
  if (fs.existsSync(path.join(destDir, finalName))) {
    const m = finalName.match(/\.([^.]+)$/);
    const ext = m ? `.${m[1]}` : '';
    const stem = m ? finalName.slice(0, -ext.length) : finalName;
    let i = 1;
    while (fs.existsSync(path.join(destDir, `${stem}(${i})${ext}`))) i++;
    finalName = `${stem}(${i})${ext}`;
  }
  try {
    fs.copyFileSync(srcCheck.absPath, path.join(destDir, finalName));
  } catch (err) {
    return _err(`Copy failed: ${err.message}`);
  }
  return {
    success: true,
    message: `File copied: ${source} -> projects/${current}/${subdir}/${finalName}`,
  };
}

/**
 * Invoked by `gemix-project quota`. Returns total used/free quota and per-project breakdown.
 */
async function quotaTool(userCtx) {
  const guard = _guardPlatform(userCtx);
  if (guard) return guard;
  const usedBytes = userTotalBytes(userCtx);
  const totalBytes = userQuotaBytes();
  const freeBytes = Math.max(0, totalBytes - usedBytes);
  const toMb = b => Math.round(b / 1024 / 1024 * 10) / 10;
  
  const projectsXml = listProjects(userCtx).map(p => {
    const size = toMb(projectSizeBytes(userCtx, p.name));
    return `  <Project name="${p.name}" size_mb="${size}" />`;
  }).join('\n');

  const output = `<StorageQuota used_mb="${toMb(usedBytes)}" total_mb="${toMb(totalBytes)}" free_mb="${toMb(freeBytes)}">
${projectsXml || '  <!-- No projects found -->' }
</StorageQuota>`;

  return {
    success: true,
    content: output,
  };
}


module.exports = {
  listProjectsTool,
  createProjectTool,
  switchProjectTool,
  deleteProjectTool,
  cleanupProjectTool,
  copyToPermanentTool,
  copyToProjectTool,
  quotaTool,
};
