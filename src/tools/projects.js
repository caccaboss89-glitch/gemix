// src/tools/projects.js
// Project-management tools: list / create / switch / delete / cleanup,
// plus copy helpers from history and searched_images into the project space.

const fs = require('fs');
const path = require('path');
const {
  MAX_PROJECTS_PER_USER,
  MAX_USER_TOTAL_MB,
  PLATFORM_DISCORD,
} = require('../config/constants');
const {
  resolveStorageId,
  ensureUserSkeleton,
  ensureProjectSkeleton,
  sanitizeProjectName,
  listProjects,
  readProjectMeta,
  writeProjectMeta,
  projectExists,
  getProjectRoot,
  getProjectSubdir,
  getPermanentDir,
  getSearchedImagesDir,
  getHistoryDir,
  userTotalBytes,
  userQuotaBytes,
  FIXED_PROJECT_SUBDIRS,
  isPathAllowed,
} = require('../utils/userPaths');
const {
  getCurrentProject,
  setCurrentProject,
} = require('../utils/projectState');
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
 * list_projects → returns the list of projects with description + current.
 */
function listProjectsTool(userCtx) {
  const guard = _guardPlatform(userCtx);
  if (guard) return guard;

  ensureUserSkeleton(userCtx);
  const projects = listProjects(userCtx);
  const current = getCurrentProject(userCtx);
  return {
    success: true,
    current_project: current,
    count: projects.length,
    max: MAX_PROJECTS_PER_USER,
    projects: projects.map(p => ({
      name: p.name,
      description: p.description,
      last_used_at: p.last_used_at,
      is_current: p.name === current,
    })),
  };
}

/**
 * create_project args: { name, description, user_request, strategy }
 * - Validates slug, uniqueness, max count.
 * - Creates scaffold + README.md + .project.json.
 * - Sets as current project.
 */
function createProjectTool(args, userCtx) {
  const guard = _guardPlatform(userCtx);
  if (guard) return guard;

  const { name, description, user_request, strategy } = args || {};
  if (!name || !description || !user_request || !strategy) {
    return _err('Missing required fields: name, description, user_request, strategy.');
  }

  const slug = sanitizeProjectName(name);
  if (!slug) return _err('Invalid project name (empty after sanitization). Use letters, numbers, _ or -.');

  ensureUserSkeleton(userCtx);
  const existing = listProjects(userCtx);
  if (existing.length >= MAX_PROJECTS_PER_USER) {
    return {
      success: false,
      error: `Project limit reached (${MAX_PROJECTS_PER_USER}). Ask the user which existing project to delete, then call delete_project before creating a new one.`,
      existing_projects: existing.map(p => ({ name: p.name, description: p.description })),
    };
  }
  if (projectExists(userCtx, slug)) {
    return _err(`A project named "${slug}" already exists. Choose a different name or use switch_project.`);
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

  setCurrentProject(userCtx, slug);
  return {
    success: true,
    project: slug,
    current_project: slug,
    message: `Project "${slug}" created and selected as current. Write code in projects/${slug}/code/, intermediate files in temp/, final deliverables in output/, images in figures/.`,
  };
}

/**
 * switch_project args: { name }
 */
function switchProjectTool(args, userCtx) {
  const guard = _guardPlatform(userCtx);
  if (guard) return guard;

  const name = args && args.name;
  if (!name) return _err('Missing "name".');
  const slug = sanitizeProjectName(name);
  if (!slug || !projectExists(userCtx, slug)) {
    return {
      success: false,
      error: `Project "${name}" not found. Use list_projects to see available projects.`,
    };
  }

  // Refresh last_used_at
  const meta = readProjectMeta(userCtx, slug) || {};
  meta.last_used_at = new Date().toISOString();
  writeProjectMeta(userCtx, slug, meta);

  setCurrentProject(userCtx, slug);
  return { success: true, current_project: slug };
}

/**
 * delete_project args: { name, user_confirmed: true }
 * Refuses without explicit user_confirmed=true flag.
 */
function deleteProjectTool(args, userCtx) {
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

  const current = getCurrentProject(userCtx);
  if (current === slug) setCurrentProject(userCtx, null);

  return {
    success: true,
    deleted: slug,
    current_project: getCurrentProject(userCtx),
  };
}

/**
 * cleanup_project args: { name?, subdirs: ["temp","figures","output","code"] }
 * Deletes the CONTENTS of the specified subdirs (keeps the folders).
 */
function cleanupProjectTool(args, userCtx) {
  const guard = _guardPlatform(userCtx);
  if (guard) return guard;

  const name = (args && args.name) || getCurrentProject(userCtx);
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
  return { success: true, project: slug, cleared };
}

/**
 * copy_to_permanent args: { history_filename }
 * Copies a file from history/ to permanent/ (never moves).
 */
function copyToPermanentTool(args, userCtx) {
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
    source: `history/${name}`,
    destination: `permanent/${result.finalName}`,
  };
}

/**
 * copy_to_project args: { source, subdir?: 'figures'|'temp'|'output'|'code' }
 * Source may be "history/<file>" or "searched_images/<file>". Default subdir = figures.
 * Writes into the currently selected project.
 */
function copyToProjectTool(args, userCtx) {
  const guard = _guardPlatform(userCtx);
  if (guard) return guard;
  const source = args && args.source;
  if (!source) return _err('Missing "source".');
  const subdir = (args && args.subdir) || 'figures';
  if (!FIXED_PROJECT_SUBDIRS.includes(subdir)) {
    return _err(`Invalid subdir "${subdir}". Allowed: ${FIXED_PROJECT_SUBDIRS.join(', ')}.`);
  }

  const current = getCurrentProject(userCtx);
  if (!current) return _err('No project is currently selected. Use create_project or switch_project first.');

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
    return _err(`Your personal cloud is full (${MAX_USER_TOTAL_MB} MB). Free space with cleanup_project / delete_project before copying more files.`);
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
    source,
    destination: `projects/${current}/${subdir}/${finalName}`,
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
};
