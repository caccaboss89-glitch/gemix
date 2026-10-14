// src/ai/tools.js
//
// Main-brain tool registry. Schemas live in domain catalogs; this facade owns
// only platform/profile composition, which tools wait to be loaded, access
// checks and the public exports used by the dispatcher and capability matrix.

import constants from '../config/constants.js';
import { TOOL, getCapabilities } from '../config/platformCapabilities.js';
import { FEATURE, isFeatureAvailable } from '../features/featureBindings.js';
import { RUNTIME, resolveProviderProfile } from './providers/providerProfile.js';
import { isMinecraftConfigured } from '../minecraft/controller.js';
import {
  buildEmailTool,
  buildReadSentMessagesTool,
  buildWhatsAppTool
} from './tools/deliveryCatalog.js';
import { buildGenerateFormalRequestPdfTool } from './tools/documentCatalog.js';
import { buildLoadToolsTool } from './tools/loadingCatalog.js';
import { TOOL_MINECRAFT_COMMAND, buildMinecraftServerTool } from './tools/minecraftCatalog.js';
import {
  TOOL_GENERATE_MUSIC,
  TOOL_GENERATE_VIDEO,
  TOOL_READ_MUSIC_STATS,
  buildGenerateImageTool
} from './tools/mediaCatalog.js';
import { TOOL_TOGGLE_RELEASE_NOTIFY, buildManagePreferencesTool } from './tools/preferenceCatalog.js';
import { normalizeOptionalNullArgs, validateToolArgs } from './tools/schema.js';
import { TOOL_BUG_REPORT } from './tools/systemCatalog.js';
import {
  buildReadMyTasksTool,
  buildRemoveMyTasksTool,
  buildScheduleTasksTool
} from './tools/taskCatalog.js';
import { TOOL_READ_PAGE, TOOL_SEARCH_IMAGE, TOOL_SEARCH_WEB } from './tools/webCatalog.js';
import { workspaceTools } from './tools/workspaceCatalog.js';

/**
 * @typedef {object} ToolContext
 * @property {boolean} [isActiveMember]
 * @property {boolean} [isAdmin]
 * @property {boolean} [isLegal]
 * @property {boolean} [isMinecraftPlayer]
 * @property {string} platform
 * @property {boolean} [isGroup]
 */

/**
 * Tools whose schemas stay out of a request until the model loads them: the
 * ones most turns never call. Web reading, file reading, the reminders, the
 * formal PDF and bug reports are what a typical turn uses, so they are always
 * offered.
 */
const DEFERRED_TOOLS = new Set([
  TOOL.LIST_FILES,
  TOOL.SEARCH_FILES,
  TOOL.WRITE_FILE,
  TOOL.EDIT_FILE,
  TOOL.SHELL,
  TOOL.SEARCH_IMAGE,
  TOOL.GENERATE_IMAGE,
  TOOL.GENERATE_VIDEO,
  TOOL.GENERATE_MUSIC,
  TOOL.READ_MUSIC_STATS,
  TOOL.SEND_EMAIL,
  TOOL.SEND_WHATSAPP,
  TOOL.READ_SENT_MESSAGES,
  TOOL.MANAGE_PREFERENCES,
  TOOL.TOGGLE_RELEASE,
  TOOL.MINECRAFT_SERVER,
  TOOL.MINECRAFT_COMMAND
]);

const SUPPORTED_TOOL_PLATFORMS = new Set([
  constants.PLATFORM_DISCORD,
  constants.PLATFORM_WA_DEDICATED,
  constants.PLATFORM_WA_PERSONAL
]);

/**
 * Build the exact tool permission boundary of a conversation: every tool the
 * caller may use, deferred ones included. The prompt describes this set; what
 * one Responses round actually sends is offeredTools() of it.
 */
function getToolsForUser(toolCtx) {
  if (!toolCtx || !SUPPORTED_TOOL_PLATFORMS.has(toolCtx.platform)) {
    throw new TypeError('getToolsForUser requires an explicit supported platform.');
  }
  const isActiveMember = Boolean(toolCtx.isActiveMember);
  const isAdmin = Boolean(toolCtx.isAdmin);
  const isLegal = Boolean(toolCtx.isLegal);
  const isWhatsApp = constants.isWhatsAppPlatform(toolCtx.platform);
  const isWhatsAppGroup = isWhatsApp && Boolean(toolCtx.isGroup);
  const isDiscord = toolCtx.platform === constants.PLATFORM_DISCORD;
  const profile = resolveProviderProfile();
  const tools = [TOOL_SEARCH_WEB, TOOL_READ_PAGE, TOOL_SEARCH_IMAGE];

  // Provider-native tools cross the generic boundary only through the active
  // profile. Web and image search above are always GemiX-owned function tools.
  tools.push(...(Array.isArray(profile.nativeTools) ? profile.nativeTools : []));

  // Generation is currently a WhatsApp surface. The image schema is selected
  // from the bound backend and video is present only where a backend exists.
  if (isWhatsApp) {
    const imageTool = buildGenerateImageTool();
    if (imageTool) tools.push(imageTool);
    if (isFeatureAvailable(profile, FEATURE.GENERATE_VIDEO)) tools.push(TOOL_GENERATE_VIDEO);
    tools.push(TOOL_GENERATE_MUSIC);
  }

  // The agentic workspace is foundational on every platform, including
  // Discord; read_file is the universal local-file gateway. The skill library
  // is not: where the platform does not offer it, no schema may name it.
  tools.push(...workspaceTools({ skills: Boolean(getCapabilities(toolCtx).skills) }));

  if (isDiscord) tools.push(buildGenerateFormalRequestPdfTool(isLegal));
  if (isActiveMember) {
    tools.push(buildEmailTool(isAdmin, isWhatsApp));
    tools.push(buildWhatsAppTool(isAdmin));
  }

  if (!isDiscord) {
    const isPersonalChat = toolCtx.platform === constants.PLATFORM_WA_PERSONAL;
    tools.push(buildScheduleTasksTool(isActiveMember, isAdmin, isWhatsAppGroup, isPersonalChat));
    tools.push(buildReadMyTasksTool(isWhatsAppGroup, isActiveMember || isAdmin));
    tools.push(buildRemoveMyTasksTool(isWhatsAppGroup));
    tools.push(buildManagePreferencesTool(isWhatsAppGroup, isPersonalChat));
    tools.push(TOOL_TOGGLE_RELEASE_NOTIFY);
  }

  if (isActiveMember && isWhatsApp) {
    tools.push(TOOL_READ_MUSIC_STATS);
    tools.push(buildReadSentMessagesTool(isAdmin));
  }

  // The Minecraft server belongs to its own player list, not to membership.
  if (isWhatsApp && toolCtx.isMinecraftPlayer && isMinecraftConfigured()) {
    tools.push(buildMinecraftServerTool(isAdmin));
    tools.push(TOOL_MINECRAFT_COMMAND);
  }

  // The administrator already sees this conversation and its tool failures;
  // reporting the same problem back to them would be a self-notification.
  if (!isAdmin) tools.push(TOOL_BUG_REPORT);

  // Claude Code defers these behind its own ToolSearch; a Responses turn loads
  // them through load_tools.
  const deferred = tools.map(tool => tool.function?.name).filter(isDeferredTool);
  if (profile.runtime === RUNTIME.RESPONSES && deferred.length > 0) tools.push(buildLoadToolsTool(deferred));
  return tools;
}

/** Whether a tool's schema waits to be loaded instead of reaching every request. */
function isDeferredTool(name) {
  return DEFERRED_TOOLS.has(name);
}

/** The part of a permission boundary one Responses round sends: deferred tools only once loaded. */
function offeredTools(tools, loadedNames) {
  return tools.filter(tool => !isDeferredTool(tool.function?.name) || loadedNames.has(tool.function.name));
}

/** Function names plus native server-side tool types for prompt capabilities. */
function toolNamesToSet(tools) {
  const names = new Set();
  for (const tool of tools) {
    if (tool?.function?.name) names.add(tool.function.name);
    else if (typeof tool?.type === 'string' && tool.type !== 'function') names.add(tool.type);
  }
  return names;
}

/** The offered set is the complete permission boundary for one round. */
function getToolAccessError(toolName, allowedRoundNames, unavailableMessage) {
  if (allowedRoundNames.has(toolName)) return null;
  if (typeof unavailableMessage === 'function') return unavailableMessage(toolName);
  return `Tool "${toolName}" is not available in the current context.`;
}

export {
  getToolAccessError,
  getToolsForUser,
  isDeferredTool,
  offeredTools,
  toolNamesToSet,
  normalizeOptionalNullArgs,
  validateToolArgs
};
