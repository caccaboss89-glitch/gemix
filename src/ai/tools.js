// src/ai/tools.js
//
// Main-brain tool registry. Schemas live in domain catalogs; this facade owns
// only platform/profile composition, access checks and the public exports used
// by the dispatcher and capability matrix.

import constants from '../config/constants.js';
import { getCapabilities } from '../config/platformCapabilities.js';
import { FEATURE, isFeatureAvailable } from '../features/featureBindings.js';
import { resolveProviderProfile } from './providers/providerProfile.js';
import {
  buildEmailTool,
  buildReadSentMessagesTool,
  buildWhatsAppTool
} from './tools/deliveryCatalog.js';
import { TOOL_GENERATE_FORMAL_REQUEST_PDF } from './tools/documentCatalog.js';
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
 * @property {string} platform
 * @property {boolean} [isGroup]
 */

const SUPPORTED_TOOL_PLATFORMS = new Set([
  constants.PLATFORM_DISCORD,
  constants.PLATFORM_WA_DEDICATED,
  constants.PLATFORM_WA_PERSONAL
]);

/** Build the exact tool permission boundary for one model round. */
function getToolsForUser(toolCtx) {
  if (!toolCtx || !SUPPORTED_TOOL_PLATFORMS.has(toolCtx.platform)) {
    throw new TypeError('getToolsForUser requires an explicit supported platform.');
  }
  const isActiveMember = Boolean(toolCtx.isActiveMember);
  const isAdmin = Boolean(toolCtx.isAdmin);
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

  if (isDiscord) tools.push(TOOL_GENERATE_FORMAL_REQUEST_PDF);
  if (isActiveMember) {
    tools.push(buildEmailTool(isAdmin));
    tools.push(buildWhatsAppTool(isAdmin));
  }

  if (!isDiscord) {
    tools.push(buildScheduleTasksTool(isActiveMember, isAdmin, isWhatsAppGroup));
    tools.push(buildReadMyTasksTool(isWhatsAppGroup));
    tools.push(buildRemoveMyTasksTool(isWhatsAppGroup));
    const isPersonalChat = toolCtx.platform === constants.PLATFORM_WA_PERSONAL;
    tools.push(buildManagePreferencesTool(isWhatsAppGroup, isPersonalChat));
    tools.push(TOOL_TOGGLE_RELEASE_NOTIFY);
  }

  if (isActiveMember && isWhatsApp) {
    tools.push(TOOL_READ_MUSIC_STATS);
    tools.push(buildReadSentMessagesTool(isAdmin));
  }

  // The administrator already sees this conversation and its tool failures;
  // reporting the same problem back to them would be a self-notification.
  if (!isAdmin) tools.push(TOOL_BUG_REPORT);
  return tools;
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
  toolNamesToSet,
  normalizeOptionalNullArgs,
  validateToolArgs
};
