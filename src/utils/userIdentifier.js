const { findMemberByWa, findMemberByDiscord } = require('../config/members');

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

  if (ctx.platform === 'discord') {
    member = findMemberByDiscord(ctx.discordUsername, ctx.discordDisplayName, ctx.discordNickname);
  } else {
    // WhatsApp - match by JID (strip @c.us if not present, normalize)
    const jid = ctx.userId.includes('@') ? ctx.userId : ctx.userId + '@c.us';
    member = findMemberByWa(jid);
  }

  const isActiveMember = member !== null;

  // Task file ID: active members get unified file, others get platform-specific
  let taskFileId;
  if (member) {
    taskFileId = 'member_' + member.name.toLowerCase().replace(/\s+/g, '_');
  } else if (ctx.platform === 'discord') {
    taskFileId = 'dc_' + ctx.userId;
  } else {
    taskFileId = 'wa_' + ctx.userId.replace('@c.us', '');
  }

  return { member, isActiveMember, taskFileId };
}

/**
 * Get the group task file ID from a group chat ID
 */
function getGroupTaskFileId(groupId) {
  return 'group_' + groupId.replace('@g.us', '');
}

module.exports = { identifyUser, getGroupTaskFileId };
