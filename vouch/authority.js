const store = require("./store");
const { RANK } = require("./constants");
const staffAccess = require("../systems/access");

function memberHasOsRole(member) {
  if (!member?.roles?.cache || !member.guild) return false;
  return store.osRoleIds(member.guild.id).some((roleId) => member.roles.cache.has(roleId));
}

function isOs(member) {
  if (!member?.guild) return false;
  return store.isOsUser(member.guild.id, member.id) || memberHasOsRole(member);
}

function isOwner(member) {
  return !!member?.guild && member.id === member.guild.ownerId;
}

function rankOf(member) {
  if (!member?.guild) return RANK.user;
  if (isOwner(member)) return RANK.owner;
  if (isVouchRoot(member)) return RANK.os;
  if (store.isActiveAdmin(member.guild.id, member.id)) return RANK.admin;
  if (store.isActiveGiver(member.guild.id, member.id)) return RANK.giver;
  return RANK.user;
}

function rankOfId(guild, userId, member = null) {
  if (member) return rankOf(member);
  if (!guild || !userId) return RANK.user;
  if (userId === guild.ownerId) return RANK.owner;
  if (store.isOsUser(guild.id, userId)) return RANK.os;
  const staff = require("../systems/store").getStaff(guild.id, userId);
  if (staff?.tier === "god" || require("../systems/store").isAntinukeAdmin(guild.id, userId)) return RANK.os;
  const cached = guild.members?.cache?.get(userId);
  if (cached) return rankOf(cached);
  if (store.isActiveAdmin(guild.id, userId)) return RANK.admin;
  if (store.isActiveGiver(guild.id, userId)) return RANK.giver;
  return RANK.user;
}

function outranks(actor, targetId, targetMember = null) {
  if (!actor || !targetId || actor.id === targetId) return false;
  return rankOf(actor) > rankOfId(actor.guild, targetId, targetMember);
}

function isBlacklisted(guildId, userId) {
  return store.isBlacklisted(guildId, userId);
}

function blockedByBlacklist(member) {
  if (!member?.guild || isOwner(member)) return false;
  return store.isBlacklisted(member.guild.id, member.id);
}

function canGive(member) {
  if (!member || member.user?.bot) return false;
  if (blockedByBlacklist(member)) return false;
  return rankOf(member) >= RANK.giver;
}

function canManageGivers(member) {
  if (!member || member.user?.bot || blockedByBlacklist(member)) return false;
  return rankOf(member) >= RANK.admin;
}

function canManageAdmins(member) {
  if (!member || member.user?.bot || blockedByBlacklist(member)) return false;
  return isVouchRoot(member);
}

function hasVouchFounderRole(member) {
  if (!member?.guild || !member.roles?.cache?.has) return false;
  const roleId = store.getConfig(member.guild.id)?.founder_role_id;
  return !!(roleId && member.roles.cache.has(roleId));
}

function isVouchRoot(member) {
  if (!member?.guild) return false;
  if (isOwner(member) || isOs(member)) return true;
  if (staffAccess.isBotOwner(member.id)) return true;
  if (staffAccess.hasStaff(member, "god")) return true;
  if (staffAccess.isAntinukeAdmin(member)) return true;
  return hasVouchFounderRole(member);
}

function isOsOrOwner(member) {
  if (!member || member.user?.bot || blockedByBlacklist(member)) return false;
  return isVouchRoot(member);
}

function isStripstaffExempt(member) {
  if (!member) return true;
  if (member.user?.bot) return true;
  if (member.id && member.guild?.client?.user?.id && member.id === member.guild.client.user.id) return true;
  if (isOwner(member) || isOs(member) || staffAccess.hasStaff(member, "god") || staffAccess.isBotOwner(member.id)) return true;
  return false;
}

function profile(guild, userId, member = null) {
  const resolved = member || guild.members?.cache?.get(userId) || null;
  const received = store.getActiveVouch(guild.id, userId);
  const given = store.listActiveByGiver(guild.id, userId);
  const allowance = store.allowance(guild.id, userId);
  const giver = store.getGiver(guild.id, userId);
  const admin = store.getAdmin(guild.id, userId);
  return {
    userId,
    member: resolved,
    isOwner: userId === guild.ownerId,
    isOs: resolved ? isOs(resolved) : (userId === guild.ownerId || store.isOsUser(guild.id, userId)),
    isAdmin: !!admin?.active,
    isGiver: !!giver?.active,
    giver,
    admin,
    blacklisted: store.isBlacklisted(guild.id, userId),
    blacklist: store.getBlacklist(guild.id, userId),
    received,
    lastRemoved: received ? null : store.latestRemovedVouch(guild.id, userId),
    given,
    allowance,
    rank: resolved ? rankOf(resolved) : rankOfId(guild, userId)
  };
}

module.exports = {
  isOs,
  isOwner,
  rankOf,
  rankOfId,
  outranks,
  isBlacklisted,
  blockedByBlacklist,
  canGive,
  canManageGivers,
  canManageAdmins,
  isOsOrOwner,
  isStripstaffExempt,
  profile
};
