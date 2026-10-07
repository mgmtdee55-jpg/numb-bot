const { AuditLogEvent, ChannelType } = require("discord.js");
const store = require("./store");
const access = require("./access");
const vouchStore = require("../vouch/store");
const { embed, reply } = require("../vouch/ui");

const CATEGORY_NAME = "numb bot";
const LOG_CHANNELS = [
  ["punishments", "punishments"],
  ["antinuke", "antinuke"],
  ["message", "messages"],
  ["role", "roles"],
  ["server", "server"],
  ["member", "members"]
];

const CATEGORY_HELP = {
  message: "Message edits and deletions",
  role: "Role create, delete, permissions, and member role changes",
  server: "Server updates",
  member: "Joins, leaves, and nickname changes",
  antinuke: "Vouches, giver changes, and Anti-Nuke actions",
  punishments: "Bans, kicks, timeouts, and unbans"
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function whenLine(ms) {
  const unix = Math.floor((ms || Date.now()) / 1000);
  return `**When:** <t:${unix}:F> (<t:${unix}:R>)`;
}

function byLine(userId) {
  return `**By:** ${userId ? `<@${userId}>` : "Unknown"}`;
}

function bindAntinukeLog(guildId, channelId) {
  if (channelId) {
    store.setLog(guildId, access.ANTINUKE_LOG, channelId);
    vouchStore.setLogChannel(guildId, channelId);
    return;
  }
  store.removeLog(guildId, access.ANTINUKE_LOG);
  vouchStore.setLogChannel(guildId, null);
}

function deny(message) {
  return reply(message, "Access Denied", "Gods and the server owner can configure logs.");
}

async function resolveChannel(message, arg) {
  const mentioned = message.mentions?.channels?.first?.();
  if (mentioned) return mentioned;
  const id = String(arg || "").replace(/[<#>]/g, "");
  if (/^\d{17,20}$/.test(id)) {
    return message.guild.channels.cache.get(id) || await message.guild.channels.fetch(id).catch(() => null);
  }
  if (!arg) return message.channel;
  const name = String(arg).replace(/^#/, "").toLowerCase();
  return [...message.guild.channels.cache.values()].find((channel) => channel.name?.toLowerCase() === name) || null;
}

function usable(channel) {
  return channel && channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildCategory && typeof channel.send === "function";
}

function viewText(guildId) {
  const configured = new Map(store.listLogs(guildId).map((row) => [row.category, row.channel_id]));
  const events = access.LOG_CATEGORIES.map((category) => {
    const channelId = configured.get(category);
    const where = channelId ? `<#${channelId}>` : "not set";
    return `**${category}** — ${CATEGORY_HELP[category]}\n${where}`;
  }).join("\n\n");
  const antinukeId = configured.get(access.ANTINUKE_LOG);
  const punishmentId = configured.get(access.PUNISHMENT_LOG);
  return [
    events,
    "",
    `**antinuke** — ${CATEGORY_HELP.antinuke}`,
    antinukeId ? `<#${antinukeId}>` : "not set",
    "",
    `**punishments** — ${CATEGORY_HELP.punishments}`,
    punishmentId ? `<#${punishmentId}>` : "not set",
    "Anti-Nuke and punishment channels are separate. `-logging set all` does not change them."
  ].join("\n");
}

async function handleLogging(message, args, prefix) {
  const sub = (args[1] || "").toLowerCase();
  if (!sub) return reply(message, "Event Logging", viewText(message.guild.id));
  if (sub === "help") {
    return reply(message, "Event Logging", [
      `\`${prefix}logging\` — view configured log channels`,
      `\`${prefix}logging set <category> [#channel]\``,
      `\`${prefix}logging set all [#channel]\``,
      `\`${prefix}logging remove <category|all>\``,
      `\`${prefix}logging test <category>\``,
      "",
      access.LOG_CATEGORIES.map((category) => `**${category}** — ${CATEGORY_HELP[category]}`).join("\n"),
      `**antinuke** — ${CATEGORY_HELP.antinuke}`,
      `**punishments** — ${CATEGORY_HELP.punishments}`,
      "",
      `\`${prefix}logging set antinuke [#channel]\` sets the Anti-Nuke and vouch log.`,
      `\`${prefix}logging set punishments [#channel]\` sets the kick, ban, and timeout log.`,
      `\`all\` does not include either channel.`,
      `Alias: \`${prefix}logs\``
    ].join("\n"));
  }
  if (!access.canConfigureLogs(message.member)) return deny(message);
  if (sub === "set") {
    const category = (args[2] || "").toLowerCase();
    const channel = await resolveChannel(message, args[3]);
    if (!usable(channel)) return reply(message, "Missing Channel", "Mention a text channel, or run this in the channel you want to use.");
    if (category === "all") {
      for (const name of access.LOG_CATEGORIES) store.setLog(message.guild.id, name, channel.id);
      return reply(message, "Logs Updated", `Event logs will go to <#${channel.id}>. Anti-Nuke, vouch, and punishment logs were left alone.`);
    }
    if (category === access.ANTINUKE_LOG) {
      bindAntinukeLog(message.guild.id, channel.id);
      return reply(message, "Logs Updated", `Anti-Nuke and vouch logs will go to <#${channel.id}>.`);
    }
    if (category === access.PUNISHMENT_LOG) {
      store.setLog(message.guild.id, access.PUNISHMENT_LOG, channel.id);
      return reply(message, "Logs Updated", `Kick, ban, and timeout logs will go to <#${channel.id}>.`);
    }
    if (!access.LOG_CATEGORIES.includes(category)) {
      return reply(message, "Unknown Category", `Use one of: ${access.LOG_CATEGORIES.join(", ")}, \`antinuke\`, \`punishments\`, or \`all\`.`);
    }
    store.setLog(message.guild.id, category, channel.id);
    return reply(message, "Logs Updated", `**${category}** logs will go to <#${channel.id}>.`);
  }
  if (sub === "remove") {
    const category = (args[2] || "").toLowerCase();
    if (category === "all") {
      let removed = 0;
      for (const name of access.LOG_CATEGORIES) {
        if (store.removeLog(message.guild.id, name)) removed += 1;
      }
      return reply(message, "Logs Cleared", `Removed **${removed}** event log setting(s). The Anti-Nuke and punishment logs were kept.`);
    }
    if (category === access.PUNISHMENT_LOG) {
      if (!store.removeLog(message.guild.id, access.PUNISHMENT_LOG)) {
        return reply(message, "Not Configured", "Kicks, bans, and timeouts do not have a log channel.");
      }
      return reply(message, "Logs Updated", "Kicks, bans, and timeouts will no longer send a log.");
    }
    if (category === access.ANTINUKE_LOG) {
      if (!store.getLog(message.guild.id, access.ANTINUKE_LOG) && !vouchStore.getConfig(message.guild.id).log_channel_id) {
        return reply(message, "Not Configured", "Anti-Nuke does not have a log channel.");
      }
      bindAntinukeLog(message.guild.id, null);
      return reply(message, "Logs Updated", "Anti-Nuke and vouch commands will no longer send a log.");
    }
    if (!access.LOG_CATEGORIES.includes(category)) {
      return reply(message, "Unknown Category", `Use one of: ${access.LOG_CATEGORIES.join(", ")}, \`antinuke\`, \`punishments\`, or \`all\`.`);
    }
    if (!store.removeLog(message.guild.id, category)) return reply(message, "Not Configured", `**${category}** does not have a log channel.`);
    return reply(message, "Logs Updated", `**${category}** will no longer send a log.`);
  }
  if (sub === "test") {
    const category = (args[2] || "").toLowerCase();
    if (category !== access.ANTINUKE_LOG && category !== access.PUNISHMENT_LOG && !access.LOG_CATEGORIES.includes(category)) {
      return reply(message, "Unknown Category", `Use one of: ${access.LOG_CATEGORIES.join(", ")}, \`antinuke\`, or \`punishments\`.`);
    }
    const sent = await sendLog(message.guild, category, `Test log from <@${message.author.id}>.`);
    if (!sent) return reply(message, "No Log Channel", `Set one with \`${prefix}logging set ${category}\`.`);
    return reply(message, "Test Sent", `A **${category}** test log was sent.`);
  }
  return reply(message, "Event Logging", `Use \`${prefix}logging help\`.`);
}

async function sendLog(guild, category, description, title, options = {}) {
  const channelId = store.getLog(guild.id, category);
  if (!channelId) return false;
  const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || typeof channel.send !== "function") return false;
  const pingRoleId = options.ping ? store.getAntinukePing(guild.id) : null;
  const payload = {
    embeds: [embed(title || CATEGORY_HELP[category] || category, description, true)],
    allowedMentions: pingRoleId ? { parse: [], roles: [pingRoleId] } : { parse: [] }
  };
  if (pingRoleId) payload.content = `<@&${pingRoleId}>`;
  await channel.send(payload);
  return true;
}

function remember(guild, channel) {
  if (channel?.id && guild.channels?.cache?.set) guild.channels.cache.set(channel.id, channel);
  return channel;
}

async function ensureNumbLogs(guild) {
  if (typeof guild.channels?.create !== "function") return 0;
  let category = [...guild.channels.cache.values()].find((channel) =>
    channel.type === ChannelType.GuildCategory && String(channel.name || "").toLowerCase() === CATEGORY_NAME
  );
  if (!category) {
    category = remember(guild, await guild.channels.create({
      name: CATEGORY_NAME,
      type: ChannelType.GuildCategory,
      reason: "Mod setup"
    }));
  }
  if (!category?.id) return 0;
  let count = 0;
  for (const [key, name] of LOG_CHANNELS) {
    let channel = [...guild.channels.cache.values()].find((item) =>
      item.parentId === category.id &&
      item.type === ChannelType.GuildText &&
      String(item.name || "").toLowerCase() === name
    );
    if (!channel) {
      channel = remember(guild, await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: category.id,
        reason: "Mod setup"
      }));
    }
    if (!channel?.id) continue;
    if (key === access.ANTINUKE_LOG) bindAntinukeLog(guild.id, channel.id);
    else store.setLog(guild.id, key, channel.id);
    count += 1;
  }
  store.removeLog(guild.id, "voice");
  store.removeLog(guild.id, "channel");
  return count;
}

async function recentAudit(guild, type, targetId) {
  if (typeof guild.fetchAuditLogs !== "function") return null;
  await sleep(800);
  const logs = await guild.fetchAuditLogs({ type, limit: 6 }).catch(() => null);
  const now = Date.now();
  for (const entry of logs?.entries?.values?.() || []) {
    if (String(entry.targetId) !== String(targetId)) continue;
    if (now - (entry.createdTimestamp || 0) > 20000) continue;
    return entry;
  }
  return null;
}

function actorId(entry) {
  return entry?.executorId || entry?.executor?.id || null;
}

async function logRoleCreate(role) {
  const entry = await recentAudit(role.guild, AuditLogEvent.RoleCreate, role.id);
  return sendLog(role.guild, "role", [
    `**Role:** <@&${role.id}>`,
    byLine(actorId(entry)),
    whenLine(entry?.createdTimestamp)
  ].join("\n"), "Role created");
}

async function logRoleDelete(role) {
  const entry = await recentAudit(role.guild, AuditLogEvent.RoleDelete, role.id);
  return sendLog(role.guild, "role", [
    `**Role:** **${role.name || role.id}**`,
    byLine(actorId(entry)),
    whenLine(entry?.createdTimestamp)
  ].join("\n"), "Role deleted");
}

async function logRoleUpdate(before, after) {
  const nameChanged = before.name !== after.name;
  const beforeBits = before.permissions?.bitfield;
  const afterBits = after.permissions?.bitfield;
  const permissionsChanged = beforeBits != null && afterBits != null && String(beforeBits) !== String(afterBits);
  if (!nameChanged && !permissionsChanged) return false;
  const entry = await recentAudit(after.guild, AuditLogEvent.RoleUpdate, after.id);
  return sendLog(after.guild, "role", [
    `**Role:** <@&${after.id}>`,
    byLine(actorId(entry)),
    nameChanged ? `**Name:** **${before.name}** → **${after.name}**` : null,
    permissionsChanged ? "**Permissions:** changed" : null,
    entry?.reason ? `**Reason:** ${String(entry.reason).slice(0, 300)}` : null,
    whenLine(entry?.createdTimestamp)
  ].filter(Boolean).join("\n"), "Role updated");
}

function roleIdList(member) {
  return new Set([...(member.roles?.cache?.keys?.() || [])].filter((id) => id && id !== member.guild?.id));
}

async function logMemberRoles(before, after) {
  if (!after?.guild) return false;
  const previous = roleIdList(before);
  const current = roleIdList(after);
  const added = [...current].filter((id) => !previous.has(id));
  const removed = [...previous].filter((id) => !current.has(id));
  if (!added.length && !removed.length) return false;
  const entry = await recentAudit(after.guild, AuditLogEvent.MemberRoleUpdate, after.id);
  return sendLog(after.guild, "role", [
    `**Member:** <@${after.id}>`,
    byLine(actorId(entry)),
    added.length ? `**Added:** ${added.map((id) => `<@&${id}>`).join(", ")}` : null,
    removed.length ? `**Removed:** ${removed.map((id) => `<@&${id}>`).join(", ")}` : null,
    entry?.reason ? `**Reason:** ${String(entry.reason).slice(0, 300)}` : null,
    whenLine(entry?.createdTimestamp)
  ].filter(Boolean).join("\n"), "Roles updated");
}

module.exports = {
  handleLogging,
  sendLog,
  CATEGORY_HELP,
  CATEGORY_NAME,
  LOG_CHANNELS,
  bindAntinukeLog,
  ensureNumbLogs,
  logRoleCreate,
  logRoleDelete,
  logRoleUpdate,
  logMemberRoles,
  whenLine
};
