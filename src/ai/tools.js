// src/ai/tools.js
//
// Main-brain tool registry. Schemas live in domain catalogs; this facade owns
// only platform/profile composition, access checks and the public exports used
// by the dispatcher and capability matrix.

import constants from '../config/constants.js';
import { FEATURE, isFeatureAvailable } from '../features/featureBindings.js';
import { XAI_X_SEARCH_TOOL } from './extensions/xaiResponsesExtensions.js';
import { resolveProviderProfile } from './providers/providerProfile.js';
import {
  buildEmailTool,
  buildReadMyTasksTool,
  buildReadSentMessagesTool,
  buildRemoveMyTasksTool,
  buildScheduleTasksTool,
  buildWhatsAppTool
} from './tools/deliveryCatalog.js';
import { TOOL_GENERATE_VIDEO, buildGenerateImageTool } from './tools/mediaCatalog.js';
import {
  TOOL_BUG_REPORT,
  TOOL_GENERATE_FORMAL_REQUEST_PDF,
  TOOL_GENERATE_MUSIC,
  TOOL_TOGGLE_RELEASE_NOTIFY,
  buildManagePreferencesTool
} from './tools/preferenceCatalog.js';
import { validateToolArgs } from './tools/schema.js';
import {
  TOOL_READ_MUSIC_STATS,
  TOOL_READ_PAGE,
  TOOL_SEARCH_IMAGE,
  TOOL_SEARCH_WEB
} from './tools/webCatalog.js';
import { workspaceTools } from './tools/workspaceCatalog.js';

function getToolsForUser(isActiveMember, isAdmin, userCtx = {}) {
  const isWhatsApp = constants.isWhatsAppPlatform(userCtx.platform);
  const isWhatsAppGroup = isWhatsApp && Boolean(userCtx.isGroup);
  const isDiscord = userCtx.platform === constants.PLATFORM_DISCORD;
  const profile = resolveProviderProfile();
  const tools = [TOOL_SEARCH_WEB, TOOL_READ_PAGE, TOOL_SEARCH_IMAGE];

  // x_search is a provider-native extension; web and image search above are
  // always GemiX-owned function tools.
  if (isFeatureAvailable(profile, FEATURE.X_SEARCH)) tools.push(XAI_X_SEARCH_TOOL);

  // Generation is currently a WhatsApp surface. The image schema is selected
  // from the bound backend and video is present only where a backend exists.
  if (isWhatsApp) {
    const imageTool = buildGenerateImageTool();
    if (imageTool) tools.push(imageTool);
    if (isFeatureAvailable(profile, FEATURE.GENERATE_VIDEO)) tools.push(TOOL_GENERATE_VIDEO);
    tools.push(TOOL_GENERATE_MUSIC);
  }

  // The agentic workspace is foundational on every platform, including
  // Discord; read_file is the universal local-file gateway.
  tools.push(...workspaceTools());

  if (isDiscord) tools.push(TOOL_GENERATE_FORMAL_REQUEST_PDF);
  if (isActiveMember) {
    tools.push(buildEmailTool(isAdmin));
    tools.push(buildWhatsAppTool(isAdmin));
  }

  if (!isDiscord) {
    tools.push(buildScheduleTasksTool(isActiveMember, isAdmin, isWhatsAppGroup));
    tools.push(buildReadMyTasksTool(isWhatsAppGroup));
    tools.push(buildRemoveMyTasksTool(isWhatsAppGroup));
    const isPersonalChat = userCtx.platform === constants.PLATFORM_WA_PERSONAL;
    tools.push(buildManagePreferencesTool(isWhatsAppGroup, isPersonalChat));
    tools.push(TOOL_TOGGLE_RELEASE_NOTIFY);
  }

  if (isActiveMember && isWhatsApp) {
    tools.push(TOOL_READ_MUSIC_STATS);
    tools.push(buildReadSentMessagesTool(isAdmin));
  }

  tools.push(TOOL_BUG_REPORT);
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

/** Derive each static platform capability set from the registry itself. */
function syncProfileToolSets(caps, profileEnum) {
  for (const profile of Object.values(profileEnum)) {
    const cap = caps[profile];
    if (!cap) continue;
    cap.tools = toolNamesToSet(getToolsForUser(true, false, {
      platform: cap.platform,
      isGroup: Boolean(cap.isGroup)
    }));
  }
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
  syncProfileToolSets,
  toolNamesToSet,
  validateToolArgs
};
