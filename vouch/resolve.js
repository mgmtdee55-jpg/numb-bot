const { isSnowflake } = require("./util");

function tokenId(token, pattern) {
  const match = pattern.exec(String(token || ""));
  return match?.[1] || null;
}

function memberLabels(member) {
  return [member?.user?.username, member?.user?.globalName, member?.displayName, member?.nickname]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
}

function pickMember(matches, query) {
  const name = String(query || "").trim().toLowerCase();
  const byUsername = matches.filter((member) => member.user?.username?.toLowerCase() === name);
  if (byUsername.length === 1) return byUsername[0];
  if (byUsername.length > 1) return null;
  return matches.length === 1 ? matches[0] : null;
}

function membersFrom(result) {
  if (!result) return [];
  if (typeof result.values === "function") return [...result.values()];
  if (Array.isArray(result)) return result;
  return result.id ? [result] : [];
}

async function searchMembers(guild, query) {
  if (typeof guild?.members?.fetch !== "function") return [];
  const found = await guild.members.fetch({ query: String(query).slice(0, 32), limit: 25 }).catch(() => null);
  return membersFrom(found);
}

async function resolveMember(message, argument) {
  const token = String(argument || "").trim();
  if (!token || !message?.guild) return null;
  const mention = /^<@!?([^>]+)>$/.exec(token);
  const snowflake = mention?.[1] || (isSnowflake(token) ? token : null);
  if (snowflake) {
    const cachedMember = message.guild.members.cache.get(snowflake);
    if (cachedMember) return cachedMember;
    if (!isSnowflake(snowflake) || typeof message.guild.members.fetch !== "function") return null;
    return message.guild.members.fetch(snowflake).catch(() => null);
  }
  const query = token.replace(/^@/, "");
  const cached = [...message.guild.members.cache.values()].filter((member) => memberLabels(member).includes(query.toLowerCase()));
  const chosen = pickMember(cached, query);
  if (chosen || cached.length > 1) return chosen;
  const fetched = (await searchMembers(message.guild, query)).filter((member) => memberLabels(member).includes(query.toLowerCase()));
  return pickMember(fetched, query);
}

async function resolveUserId(message, argument) {
  const token = String(argument || "").trim();
  if (!token) return null;
  const mentioned = /^<@!?([^>]+)>$/.exec(token);
  if (mentioned) return mentioned[1];
  if (isSnowflake(token)) return token;
  const member = await resolveMember(message, token);
  return member?.id || null;
}

async function resolveRole(message, argument) {
  const token = String(argument || "").trim();
  if (!token || !message?.guild) return null;
  const mention = /^<@&([^>]+)>$/.exec(token);
  const id = mention?.[1] || (isSnowflake(token) ? token : null);
  if (id) {
    const cachedRole = message.guild.roles.cache.get(id);
    if (cachedRole) return cachedRole;
    if (!isSnowflake(id) || typeof message.guild.roles.fetch !== "function") return null;
    return message.guild.roles.fetch(id).catch(() => null);
  }
  const name = token.replace(/^@/, "").toLowerCase();
  const cached = [...message.guild.roles.cache.values()].find((role) => role.name.toLowerCase() === name && role.id !== message.guild.id);
  if (cached) return cached;
  if (typeof message.guild.roles.fetch !== "function") return null;
  const fetched = await message.guild.roles.fetch().catch(() => null);
  return [...(fetched?.values?.() || message.guild.roles.cache.values())].find((role) => role.name.toLowerCase() === name && role.id !== message.guild.id) || null;
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
