const { isSnowflake } = require("./util");

function tokenId(token, pattern) {
  const match = pattern.exec(String(token || ""));
  return match?.[1] || null;
}

async function resolveUserId(message, argument) {
  const token = String(argument || "").trim();
  if (!token) return null;
  const mentioned = tokenId(token, /^<@!?(\d+)>$/);
  if (mentioned) return mentioned;
  if (isSnowflake(token)) return token;
  const query = token.toLowerCase();
  const member = [...message.guild.members.cache.values()].find((item) => (
    item.user?.username?.toLowerCase() === query ||
    item.displayName?.toLowerCase() === query ||
    item.nickname?.toLowerCase() === query
  ));
  return member?.id || null;
}

async function resolveMember(message, argument) {
  const userId = await resolveUserId(message, argument);
  if (!userId) return null;
  const cached = message.guild.members.cache.get(userId);
  if (cached) return cached;
  return message.guild.members.fetch(userId).catch((error) => {
    if (error?.code === 10007 || error?.code === 10013) return null;
    return null;
  });
}

async function resolveRole(message, argument) {
  const token = String(argument || "").trim();
  if (!token) return null;
  const mentioned = tokenId(token, /^<@&(\d+)>$/);
  const id = mentioned || (isSnowflake(token) ? token : null);
  if (id) {
    return message.guild.roles.cache.get(id) || await message.guild.roles.fetch(id).catch(() => null);
  }
  const name = token.toLowerCase();
  return [...message.guild.roles.cache.values()].find((role) => role.name.toLowerCase() === name) || null;
}

async function resolveChannel(message, argument) {
  const token = String(argument || "").trim();
  if (!token) return null;
  const mentioned = tokenId(token, /^<#(\d+)>$/);
  const id = mentioned || (isSnowflake(token) ? token : null);
  if (!id) return null;
  return message.guild.channels.cache.get(id) || await message.guild.channels.fetch(id).catch(() => null);
}

async function resolveOsTarget(message, argument) {
  const token = String(argument || "").trim();
  if (!token) return null;
  if (/^<@&\d+>$/.test(token)) {
    const role = await resolveRole(message, token);
    return role ? { type: "role", id: role.id, role } : null;
  }
  if (/^<@!?\d+>$/.test(token)) {
    const member = await resolveMember(message, token);
    return member ? { type: "user", id: member.id, member } : null;
  }
  const role = await resolveRole(message, token);
  const member = /^<@&\d+>$/.test(token) ? null : await resolveMember(message, token);
  if (role && member && role.id !== member.id) {
    return { ambiguous: true };
  }
  if (role && !member) return { type: "role", id: role.id, role };
  if (member && !role) return { type: "user", id: member.id, member };
  if (role) return { type: "role", id: role.id, role };
  return null;
}

module.exports = {
  resolveUserId,
  resolveMember,
  resolveRole,
  resolveChannel,
  resolveOsTarget
};
