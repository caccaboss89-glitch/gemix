// src/handler.js
//
// Main message handler.
//
// One round of conversation looks like this:
//   1. Resolve identity / memory / RAG context.
//   2. Touch the per-user/group build workspace activity timestamp.
//   3. Build the messages array: system prompt + chat history + the current
//      user content. PDF/audio/video parts are rewritten on the fly into
//      Responses-shape `input_file` URLs (xAI fetches them server-side).
//   4. Loop: call Grok (`/v1/responses`) → run any tool calls → repeat
//      until the model returns plain text (final response) or we hit the
//      round budget.
//   5. Apply the research-team badge (web/X sources) and ship the reply
//      back to the platform.

const { callAI } = require('./ai/aiProvider');
const { buildSystemPrompt } = require('./ai/systemPrompt');
const { getToolsForUser } = require('./ai/tools');
const { executeTool, resetVoiceCount, getVoiceLimitChatKey } = require('./tools');
const { isAdmin } = require('./config/members');
const {
  MAX_TOOL_ROUNDS,
  PLATFORM_DISCORD,
  MAINTENANCE_MODE,
  MAINTENANCE_ADMIN_ONLY,
  MAINTENANCE_USER_MESSAGE,
  MAINTENANCE_RELEASE_NOTIFY_COMMAND,
} = require('./config/constants');
const { createLogger } = require('./utils/logger');
const { prepareInputFilesInMessages } = require('./utils/inputFileBuilder');
const { resolveWorkspaceId } = require('./utils/workspaceId');
const { touchActivity } = require('./utils/buildState');
const { listWorkspaceFiles } = require('./sandbox/buildWorkspace');
const { readMemory } = require('./utils/memoryStore');
const { cleanAssistantResponse } = require('./utils/text');
const { getGroupTaskFileId } = require('./utils/userIdentifier');
const { loadRegolamento } = require('./utils/regolamento');
const { resolveStorageId } = require('./utils/userPaths');
const { pruneHistory, collectReferencedHistoryFilenames, DISCORD_MAX_AGE_MS } = require('./utils/historySync');
const { enableReleaseNotify } = require('./tools/releaseNotify');
const { sendWhatsAppDirect } = require('./tools/whatsappSender');
const { RELEASE_NOTIFY_ENABLED_PREFIX, RELEASE_NOTIFY_ALREADY_PREFIX, FALLBACK_ERROR_PREFIX } = require('./config/systemMessages');
const { markNotifiedInCall, clearCallNotifications } = require('./utils/notificationDedup');

const log = createLogger('Handler');

// Total wall-clock budget for one main turn. Caps runaway tool loops even
// when the model keeps emitting tool_calls within the round limit.
const SESSION_MAX_DURATION_MS = 10 * 60 * 1000;

// Delivery tools always run last in a round so they ship the reply only
// after every other tool has finished (e.g. write_file before send_*).
const DELIVERY_TOOL_NAMES = new Set(['send_voice_message', 'send_whatsapp_message', 'send_email']);

/**
 * Send an intermediate notification message to the active chat (Discord channel
 * or WhatsApp JID), suppressing duplicates within the same AI call.
 *
 * Each (call, kind) pair is allowed at most ONE notification. This keeps the
 * UX calm even when several rounds of the same call would otherwise fire the
 * same banner repeatedly.
 *
 * @param {object} ctx - Handler context (must include `requestId` and platform info)
 * @param {string} kind - 'video_gen' | 'image_gen' | 'research' | etc.
 * @param {string} message - Text to send
 */
async function sendIntermediateNotification(ctx, kind, message) {
  if (!markNotifiedInCall(ctx, kind)) return;
  try {
    if (ctx.platform === PLATFORM_DISCORD && ctx.discordChannel) {
      await ctx.discordChannel.send({ content: message });
      log.info(`   📤 ${kind} notification → Discord: ${message}`);
    } else if (ctx.platform && ctx.platform.startsWith('whatsapp')) {
      const targetJid = ctx.chatId || ctx.groupId || ctx.waJid;
      if (targetJid) {
        await sendWhatsAppDirect(targetJid, message);
        log.info(`   📤 ${kind} notification → WhatsApp: ${message}`);
      }
    }
  } catch (err) {
    log.warn(`Failed to send ${kind} notification: ${err.message}`);
  }
}

/**
 * Extract and remove <title>...</title> XML tag from text.
 * Used to extract Discord thread title from AI response.
 */
function extractTitleTag(text) {
  if (typeof text !== 'string') return { text: text || '', title: '' };
  const titleMatch = text.match(/<title>([\s\S]*?)<\/title>/i);
  if (!titleMatch) return { text, title: '' };
  const title = titleMatch[1].trim();
  const cleanText = text.replace(/<title>[\s\S]*?<\/title>/i, '').trim();
  return { text: cleanText, title };
}

/**
 * Stable phase ordering for tool calls within a round:
 *   - phase 1: standard tools (read_file, image_search, web_x_search, build, …)
 *   - phase 2: delivery tools (send_voice_message, send_*) — always last
 *     so any preceding tool's output reaches the recipient via the buffer.
 */
function orderToolCalls(toolCalls) {
  const getPhase = (tc) => DELIVERY_TOOL_NAMES.has(tc.function.name) ? 2 : 1;
  return [...toolCalls].sort((a, b) => getPhase(a) - getPhase(b));
}

function extractPlainTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.find(p => p.type === 'text')?.text || '';
  return '';
}

function getReleaseNotifyTarget(ctx, ui) {
  const waJid = ctx.isGroup
    ? ctx.groupId
    : (ctx.waJid || (ui.member ? ui.member.wa : null));
  const chatId = ctx.chatId || ctx.groupId || waJid;
  return { chatId, waJid };
}

function buildMaintenanceReleaseEnabledMessage() {
  return `${RELEASE_NOTIFY_ENABLED_PREFIX}\n\nTi avviserò non appena sarà disponibile un nuovo aggiornamento.`;
}

function buildMaintenanceReleaseAlreadyEnabledMessage() {
  return `${RELEASE_NOTIFY_ALREADY_PREFIX}\n\nPotrai disabilitarle chiedendolo direttamente a GemiX quando tornerà disponibile.`;
}

/**
 * Main message handler. Takes a normalized context and returns a response object.
 * @param {object} ctx
 * @returns {Promise<object>} Response { text, voiceBuffer, isVoiceOnly, attachments, modelUsed, discordTitle? }
 */
async function handleMessage(ctx) {
  const responseCtx = {
    attachments: [],
    voiceBuffer: null,
    isVoiceOnly: false,
    discordTitle: '',
    // Accumulated research stats from web_x_search calls and any agent
    // sub-runs (e.g. build) — used for the badge appended to the reply.
    researchStats: null,
  };

  try {
    const ui = ctx.userIdentity;
    const isActiveMember = ui.isActiveMember;
    const userIsAdmin = ui.member ? isAdmin(ui.member) : false;
    const maintenanceCommand = extractPlainTextContent(ctx.content).trim().toLowerCase();
    const releaseNotifyTarget = getReleaseNotifyTarget(ctx, ui);

    // ── Maintenance gate ──
    // Blocks every non-admin request with a fixed message. Admins always pass.
    if (MAINTENANCE_MODE && MAINTENANCE_ADMIN_ONLY && !userIsAdmin) {
      if (maintenanceCommand === MAINTENANCE_RELEASE_NOTIFY_COMMAND.toLowerCase()) {
        const enableResult = enableReleaseNotify(releaseNotifyTarget.chatId, releaseNotifyTarget.waJid);
        const alreadyEnabled = Boolean(enableResult.alreadyEnabled);
        const text = alreadyEnabled
          ? buildMaintenanceReleaseAlreadyEnabledMessage()
          : buildMaintenanceReleaseEnabledMessage();
        if (ctx.platform === PLATFORM_DISCORD && releaseNotifyTarget.waJid) {
          try {
            await sendWhatsAppDirect(releaseNotifyTarget.waJid, text);
          } catch (err) {
            log.warn(`maintenance release notify mirror to WhatsApp failed: ${err.message}`);
          }
        }
        await resetVoiceCount(ctx, getVoiceLimitChatKey(ctx));
        return {
          text,
          voiceBuffer: null,
          isVoiceOnly: false,
          attachments: [],
          discordTitle: '',
          modelUsed: null,
          systemMessage: true,
        };
      }
      log.info(`   🔒 Maintenance mode: ignoring non-admin request from ${ui.taskFileId}`);
      await resetVoiceCount(ctx, getVoiceLimitChatKey(ctx));
      return {
        text: MAINTENANCE_USER_MESSAGE,
        voiceBuffer: null,
        isVoiceOnly: false,
        attachments: [],
        discordTitle: '',
        modelUsed: null,
        systemMessage: true,
      };
    }

    // Memory: per-user (private/dedicated chats) or per-group (WA groups).
    const memoryFileId = 'memory_' + ui.taskFileId;
    const isWhatsAppGroup = ctx.isGroup && ctx.platform && ctx.platform.startsWith('whatsapp');

    let userMemory = null;
    let groupMemory = null;
    if (isWhatsAppGroup) {
      const groupMemoryFileId = 'memory_' + getGroupTaskFileId(ctx.groupId);
      groupMemory = readMemory(groupMemoryFileId);
    } else {
      userMemory = readMemory(memoryFileId);
    }

    ctx.userMemory = userMemory;
    ctx.groupMemory = groupMemory;

    // RAG: server rules context for Discord (Statuto Albertino).
    if (ctx.platform === PLATFORM_DISCORD) {
      ctx.ragContext = loadRegolamento();
    }

    const userCtx = {
      isActiveMember,
      isAdmin: userIsAdmin,
      member: ui.member,
      taskFileId: ui.taskFileId,
      memoryFileId,
      userId: ctx.userId,
      userName: ctx.userName,
      userPhone: ctx.userPhone || null,
      waJid: ctx.waJid || (ui.member ? ui.member.wa : null),
      email: ui.member ? ui.member.email : null,
      isGroup: ctx.isGroup,
      groupId: ctx.groupId,
      chatId: ctx.chatId || null,
      platform: ctx.platform,
      requestId: `${ctx.platform || 'unknown'}:${ctx.chatId || ctx.userId || 'unknown'}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`,
      presence: ctx.presence || null,
      // Bound helper for tools that want to fire an intermediate notification
      // (e.g. web_x_search → "🔎 Sto consultando il team di ricerca...").
      // Dedup is enforced per (call, kind) inside sendIntermediateNotification.
      sendIntermediateNotification: (kind, message) => sendIntermediateNotification(ctx, kind, message),
    };

    // ctx.requestId is set here so that sendIntermediateNotification (which
    // receives ctx, not userCtx) uses the same call-scoped ID as the dedup
    // keys written by the tools dispatcher (which receives userCtx).
    ctx.requestId = userCtx.requestId;

    const tools = getToolsForUser(isActiveMember, userIsAdmin, userCtx);

    // ── Build workspace activity tracking ────────────────────────────────
    // Touch the workspace's last-activity timestamp on every main turn so
    // the TTL sweeper sees the user is alive across all platforms, not just
    // when they invoke `build`. The same workspaceId is also used to
    // surface a <UserWorkspace> listing in the system prompt whenever the
    // engineering sub-agent has files leftover from previous runs.
    const workspaceId = resolveWorkspaceId(ctx);
    if (workspaceId) {
      try { touchActivity(workspaceId); }
      catch (e) { log.warn(`touchActivity failed: ${e.message}`); }
    }
    const refreshUserWorkspace = () => {
      if (!workspaceId) { ctx.userWorkspace = null; return; }
      try {
        const listing = listWorkspaceFiles(workspaceId, 30);
        ctx.userWorkspace = listing.total > 0
          ? {
              total: listing.total,
              files: listing.files,
              more: !!listing.more,
            }
          : null;
      } catch (e) {
        log.warn(`refreshUserWorkspace failed: ${e.message}`);
        ctx.userWorkspace = null;
      }
    };
    refreshUserWorkspace();

    const messages = [
      { role: 'system', content: buildSystemPrompt(ctx) },
    ];
    if (ctx.history && ctx.history.length > 0) {
      messages.push(...ctx.history);
    }
    messages.push({ role: 'user', content: ctx.content });

    // ── Media pre-processing (input_file URL conversion) ────────────────
    // Walk all messages once and rewrite non-image media parts (PDF, audio,
    // video, plain text) into Responses-ready `input_file` parts backed by
    // the public attachment tunnel. xAI fetches them server-side and runs
    // OCR / STT / frame extraction natively.
    try {
      await prepareInputFilesInMessages(messages);
    } catch (e) {
      log.warn(`prepareInputFilesInMessages failed: ${e.message}`);
    }

    // ── Deterministic history prune ─────────────────────────────────────
    // Every file in chat history that is no longer reachable from the chat
    // buffer the AI is about to see gets removed (100%, no probabilistic
    // GC). On Discord we additionally enforce a 30-day cap even on still-
    // referenced files (replies can keep old attachments alive forever
    // otherwise).
    try {
      const isDiscord = ctx.platform === PLATFORM_DISCORD;
      const historyUserId = resolveStorageId(ctx);
      if (historyUserId) {
        const referenced = collectReferencedHistoryFilenames(ctx.history, ctx.content);
        const opts = isDiscord ? { maxAgeMs: DISCORD_MAX_AGE_MS } : {};
        pruneHistory(historyUserId, referenced, opts);
      }
    } catch (e) {
      log.warn(`pruneHistory pre-call failed: ${e.message}`);
    }

    const deliveryCtx = {
      contactedWA: new Set(),
      contactedEmail: new Set(),
      roundCalledTools: new Set(),
    };

    let rounds = 0;
    let lastModelUsed = null;
    const sessionStartTime = Date.now();

    const runToolCall = async (tc) => {
      try {
        let argsPreview = '';
        try {
          const parsed = JSON.parse(tc.function.arguments || '{}');
          argsPreview = JSON.stringify(parsed).slice(0, 1000);
        } catch {
          argsPreview = String(tc.function.arguments || '').slice(0, 1000);
        }
        log.info(`   Executing: ${tc.function.name} args=${argsPreview}`);
        const { toolCallId, result } = await executeTool(tc, userCtx, responseCtx, deliveryCtx, tools);
        let resultPreview;
        if (Array.isArray(result)) {
          resultPreview = `multimodal[${result.length}] parts=${result.map(p => p.type).join(',')}`;
        } else if (typeof result === 'string') {
          resultPreview = `text(${result.length}) ${result.slice(0, 1000).replace(/\s+/g, ' ')}`;
        } else {
          resultPreview = typeof result;
        }
        log.info(`   Result: ${resultPreview}`);
        return {
          role: 'tool',
          tool_call_id: toolCallId,
          content: result,
        };
      } catch (toolErr) {
        log.error(`   ❌ Tool error "${tc.function.name}": ${toolErr.message}`);
        return {
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ success: false, error: `Execution error: ${toolErr.message}` }),
        };
      }
    };

    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;

      if (Date.now() - sessionStartTime > SESSION_MAX_DURATION_MS) {
        log.warn(`   ⚠️ Overall session duration limit reached (10 minutes), forcing wrap up`);
        break;
      }

      if (responseCtx.isVoiceOnly && responseCtx.voiceBuffer) {
        log.warn(`   ⚠️ Voice already generated, skipping round`);
        break;
      }

      const pLabel = (typeof ctx?.platform === 'string' && ctx.platform) ? ctx.platform.toUpperCase() : 'UNKNOWN';
      log.info(`🤖 [${pLabel}] AI call (round ${rounds}/${MAX_TOOL_ROUNDS})`);

      // Refresh the workspace listing before each AI call so any file the
      // build sub-agent just produced shows up immediately in <UserWorkspace>.
      refreshUserWorkspace();
      messages[0].content = buildSystemPrompt(ctx);

      const { message: assistantMsg, provider, model } = await callAI(messages, tools);
      lastModelUsed = model;
      log.info(`   Provider: ${provider} (${model})`);

      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        log.info(`🔧 [${pLabel}] ${assistantMsg.tool_calls.length} tool call(s)`);
        // OpenAI-compatible reasoning models occasionally return content=null
        // — drop it so the message validates downstream.
        if (assistantMsg.content === null || assistantMsg.content === undefined) {
          delete assistantMsg.content;
        }
        messages.push(assistantMsg);

        // Reset per-round deduplication tracking for idempotent tools.
        deliveryCtx.roundCalledTools = new Set();

        const orderedCalls = orderToolCalls(assistantMsg.tool_calls);
        // Build a Set of tool names the AI is actually allowed to call this
        // round. Any hallucinated tool name outside this set is rejected
        // with a clear error instead of falling through to the executor.
        const allowedToolNames = new Set(tools.map(t => t.function?.name).filter(Boolean));

        for (const tc of orderedCalls) {
          if (responseCtx.isVoiceOnly && responseCtx.voiceBuffer) {
            log.warn(`   ⚠️ Tool loop interrupted: a tool already produced the final response`);
            break;
          }
          if (!allowedToolNames.has(tc.function.name)) {
            log.warn(`   ⛔ Tool "${tc.function.name}" not in current allowed list — rejected`);
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify({
                success: false,
                error: `Tool "${tc.function.name}" is not available in the current context.`,
              }),
            });
            continue;
          }
          messages.push(await runToolCall(tc));
        }

        // Token optimization: strip image previews from tool results the AI
        // has already seen. The AI evaluated them in this round; keeping the
        // base64 payload would only waste context in future rounds.
        for (const msg of messages) {
          if (msg.role === 'tool' && Array.isArray(msg.content)) {
            if (msg._imagePreviewSeen) {
              msg.content = msg.content.filter(p => p.type !== 'image_url');
              if (msg.content.length === 1 && msg.content[0].type === 'text') {
                msg.content = msg.content[0].text;
              }
              delete msg._imagePreviewSeen;
            } else if (msg.content.some(p => p.type === 'image_url')) {
              msg._imagePreviewSeen = true;
            }
          }
        }

        continue;
      }

      let text = cleanAssistantResponse(assistantMsg.content || '');
      log.info(`✅ [${pLabel}] Response generated (${text.length} chars)`);

      // Extract Discord thread title from <title> XML tag if present.
      if (ctx.platform === PLATFORM_DISCORD) {
        const { text: cleanedText, title } = extractTitleTag(text);
        text = cleanedText;
        if (title) {
          responseCtx.discordTitle = title.replace(/[\u0000-\u001F]/g, '').trim().substring(0, 100);
          log.info(`   📝 Thread title extracted: "${responseCtx.discordTitle}"`);
        }
      }

      if (!text.trim() && !responseCtx.isVoiceOnly && (!responseCtx.attachments || responseCtx.attachments.length === 0)) {
        log.warn('   ⚠️ Empty AI response, sending fallback');
        text = FALLBACK_ERROR_PREFIX;
      }

      // ── Research badge ──────────────────────────────────────────────────
      // Append "🌐: N sources. 𝕏: N posts." when web_x_search was used.
      // Only shown on text replies (not voice-only). Omit a section when its
      // count is zero so the badge stays minimal.
      if (text.trim() && !responseCtx.isVoiceOnly && responseCtx.researchStats) {
        const { webSources, xPosts } = responseCtx.researchStats;
        if (webSources > 0 || xPosts > 0) {
          const parts = [];
          if (webSources > 0) parts.push(`🌐: ${webSources} sources`);
          if (xPosts > 0) parts.push(`𝕏: ${xPosts} posts`);
          text = `${text}\n\n${parts.join('. ')}.`;
          log.info(`   🔎 Research badge: ${parts.join(', ')}`);
        }
      }

      if (responseCtx.isVoiceOnly && responseCtx.voiceBuffer) {
        log.info(`   🎤 Voice ready (${responseCtx.voiceBuffer.length} bytes)`);
        await resetVoiceCount(ctx, getVoiceLimitChatKey(ctx));
        return {
          text: null,
          voiceBuffer: responseCtx.voiceBuffer,
          isVoiceOnly: true,
          attachments: responseCtx.attachments,
          discordTitle: responseCtx.discordTitle || '',
          modelUsed: lastModelUsed,
        };
      }

      await resetVoiceCount(ctx, getVoiceLimitChatKey(ctx));
      return {
        text: text || null,
        voiceBuffer: null,
        isVoiceOnly: false,
        attachments: responseCtx.attachments,
        discordTitle: responseCtx.discordTitle || '',
        modelUsed: lastModelUsed,
      };
    }

    if (responseCtx.isVoiceOnly && responseCtx.voiceBuffer) {
      log.info(`   🎤 Voice ready (${responseCtx.voiceBuffer.length} bytes)`);
      await resetVoiceCount(ctx, getVoiceLimitChatKey(ctx));
      return {
        text: null,
        voiceBuffer: responseCtx.voiceBuffer,
        isVoiceOnly: true,
        attachments: responseCtx.attachments,
        discordTitle: responseCtx.discordTitle || '',
        modelUsed: lastModelUsed,
      };
    }

    try { await resetVoiceCount(ctx, getVoiceLimitChatKey(ctx)); } catch (vcErr) { log.warn(`resetVoiceCount failed: ${vcErr.message}`); }
    return {
      text: FALLBACK_ERROR_PREFIX,
      voiceBuffer: null,
      isVoiceOnly: false,
      attachments: [],
      discordTitle: responseCtx.discordTitle || '',
      modelUsed: lastModelUsed,
    };

  } catch (err) {
    const platformLabel = (typeof ctx?.platform === 'string' && ctx.platform)
      ? ctx.platform.toUpperCase().padEnd(10)
      : 'UNKNOWN   ';
    log.error(`\n❌ [${platformLabel}] HANDLER ERROR:`);
    log.error(`   ${err.message}`);
    log.error(`   Stack: ${err.stack?.split('\n')[1]?.trim() || 'N/A'}`);
    try { await resetVoiceCount(ctx, getVoiceLimitChatKey(ctx)); } catch (vcErr) { log.warn(`resetVoiceCount failed in catch: ${vcErr.message}`); }
    return {
      text: FALLBACK_ERROR_PREFIX,
      voiceBuffer: null,
      isVoiceOnly: false,
      attachments: [],
      discordTitle: responseCtx.discordTitle || '',
      modelUsed: null,
    };
  } finally {
    // Drop per-call notification dedup entries so the next AI call can fire
    // intermediate notifications again.
    try { clearCallNotifications(ctx); } catch { /* best effort */ }
  }
}

module.exports = { handleMessage };
