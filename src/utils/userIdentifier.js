const { findMemberByWa, findMemberByDiscord } = require('../config/members');
const { PLATFORM_DISCORD, TASK_PREFIX_MEMBER, TASK_PREFIX_DISCORD, TASK_PREFIX_WA, TASK_PREFIX_GROUP } = require('../config/constants');

/**
 * Identifies a user across platforms and returns unified identity info.
 * @param {object} ctx - Message context
 * @param {string} ctx.platform - 'whatsapp_dedicated' | 'whatsapp_personal' | 'discord'
 * @param {string} ctx.userId - Platform-specific user ID (WA JID or Discord user ID)
 * @param {string} [ctx.discordUsername] - Discord username
 * @param {string} [ctx.discordDisplayName] - Discord display name
 * @param {string} [ctx.discordNickname] - Discord server nickname
 * @returns {{ member: object|null, isActiveMember: boolean, taskFileId: string }}
 */
function identifyUser(ctx) {
  let member = null;

  if (ctx.platform === PLATFORM_DISCORD) {
    console.log('[DEBUG identifyUser] Discord user:', ctx.userId);
    member = findMemberByDiscord(ctx.discordUsername, ctx.discordDisplayName, ctx.discordNickname);
  } else {
    const jid = ctx.userId.includes('@') ? ctx.userId : ctx.userId + '@c.us';
    console.log('[DEBUG identifyUser] WhatsApp JID:', jid);
    member = findMemberByWa(jid);
  }

  const isActiveMember = member !== null;
  
  console.log('[DEBUG identifyUser] Platform:', ctx.platform, '| Member found:', member?.name || 'NONE', '| isActiveMember:', isActiveMember);

  let taskFileId;
  if (member) {
    taskFileId = TASK_PREFIX_MEMBER + member.name.toLowerCase().replace(/\s+/g, '_');
  } else if (ctx.platform === PLATFORM_DISCORD) {
    taskFileId = TASK_PREFIX_DISCORD + ctx.userId;
  } else {
    taskFileId = TASK_PREFIX_WA + ctx.userId.replace('@c.us', '');
  }

  return { member, isActiveMember, taskFileId };
}

/**
 * Get the task file ID for a group WhatsApp chat.
 * @param {string} groupId - WhatsApp group JID (e.g., '123456789-1234567890@g.us')
 * @returns {string} Normalized group task file ID (e.g., 'group_123456789-1234567890')
 */
function getGroupTaskFileId(groupId) {
  return TASK_PREFIX_GROUP + groupId.replace('@g.us', '');
}

module.exports = { identifyUser, getGroupTaskFileId };
