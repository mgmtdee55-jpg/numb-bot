const { PermissionFlagsBits } = require("discord.js");
const { STAFF_PERMISSIONS } = require("./constants");

const roleMarks = new Map();
const nickMarks = new Set();
const MARK_TTL_MS = 15000;

function markKey(guildId, userId, roleId, type) {
  return `${guildId}:${userId}:${roleId}:${type}`;
}

function prune(map, now) {
  if (map.size < 4000) return;
  for (const [key, expires] of map) {
    if (expires <= now) map.delete(key);
  }
}

function rememberRole(guildId, userId, roleId, type) {
  const now = Date.now();
  prune(roleMarks, now);
  roleMarks.set(markKey(guildId, userId, roleId, type), now + MARK_TTL_MS);
}

function consumeRole(guildId, userId, roleId, type) {
  const key = markKey(guildId, userId, roleId, type);
  const expires = roleMarks.get(key);
  if (!expires) return false;
  roleMarks.delete(key);
  return expires > Date.now();
}

function roleIdOf(role) {
  return typeof role === "string" ? role : role?.id;
}

async function addRole(member, role, reason) {
  const roleId = roleIdOf(role);
  rememberRole(member.guild.id, member.id, roleId, "add");
  try {
    await member.roles.add(roleId, reason);
  } catch (error) {
    consumeRole(member.guild.id, member.id, roleId, "add");
    throw error;
  }
}

async function removeRole(member, role, reason) {
  const roleId = roleIdOf(role);
  rememberRole(member.guild.id, member.id, roleId, "remove");
  try {
    await member.roles.remove(roleId, reason);
  } catch (error) {
    consumeRole(member.guild.id, member.id, roleId, "remove");
    throw error;
  }
}

async function removeRoles(member, roles, reason) {
  const ids = roles.map(roleIdOf).filter(Boolean);
  for (const roleId of ids) rememberRole(member.guild.id, member.id, roleId, "remove");
  try {
    if (ids.length) await member.roles.remove(ids, reason);
  } catch (error) {
    for (const roleId of ids) consumeRole(member.guild.id, member.id, roleId, "remove");
    throw error;
  }
}

function rememberNick(guildId, userId, nickname) {
  if (nickMarks.size > 4000) nickMarks.clear();
  nickMarks.add(`${guildId}:${userId}:${nickname ?? ""}`);
}

function consumeNick(guildId, userId, nickname) {
  const key = `${guildId}:${userId}:${nickname ?? ""}`;
  if (!nickMarks.has(key)) return false;
  nickMarks.delete(key);
  return true;
}

async function applyNickname(member, nickname, reason) {
  rememberNick(member.guild.id, member.id, nickname);
  try {
    await member.setNickname(nickname, reason);
  } catch (error) {
    consumeNick(member.guild.id, member.id, nickname);
    throw error;
  }
}

function roleGrantsStaff(role) {
  if (!role?.permissions?.has) return false;
  return STAFF_PERMISSIONS.some((flag) => role.permissions.has(flag));
}

function botCanManageRole(guild, role) {
  if (!role || role.managed) return false;
  if (role.id === guild.id) return false;
  const me = guild.members?.me;
  if (!me) return false;
  const permissions = me.permissions;
  const can = permissions?.has?.(PermissionFlagsBits.ManageRoles) || permissions?.has?.(PermissionFlagsBits.Administrator);
  if (!can) return false;
  const botPosition = me.roles?.highest?.position ?? 0;
  if (Number.isInteger(role.position) && role.position >= botPosition) return false;
  return true;
}

function countMembersWithRole(guild, roleId, subject) {
  const seen = new Set();
  let count = 0;
  const consider = (member) => {
    if (!member || seen.has(member.id)) return;
    seen.add(member.id);
    if (member.roles?.cache?.has?.(roleId)) count += 1;
  };
  for (const member of guild.members?.cache?.values?.() || []) consider(member);
  consider(subject);
  return count;
}

async function withRateLimit(work) {
  try {
    return await work();
  } catch (error) {
    const limited = error?.status === 429 || error?.code === 429;
    if (!limited) throw error;
    const retryMs = Number(error.retryAfter) ||
      (Number(error.rawError?.retry_after) ? Number(error.rawError.retry_after) * 1000 : 1000);
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(retryMs, 250), 5000)));
    return work();
  }
}

function resetMarks() {
  roleMarks.clear();
  nickMarks.clear();
}

module.exports = {
  rememberRole,
  consumeRole,
  addRole,
  removeRole,
  removeRoles,
  rememberNick,
  consumeNick,
  applyNickname,
  roleGrantsStaff,
  botCanManageRole,
  countMembersWithRole,
  withRateLimit,
  resetMarks
};
