const { ChannelType } = require("discord.js");
const store = require("./store");
const access = require("./access");
const vouchStore = require("../vouch/store");
const { embed, reply } = require("../vouch/ui");

const CATEGORY_HELP = {
  message: "Message edits and deletions",
  voice: "Voice joins, leaves, moves and state changes",
  channel: "Channel create, delete and update",
  role: "Role create, delete and update",
  server: "Server/guild changes",
  member: "Member joins, leaves, updates, bans and unbans",
  antinuke: "Anti-Nuke and vouch commands"
};

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
  return [
    events,
    "",
    `**antinuke** — ${CATEGORY_HELP.antinuke}`,
    antinukeId ? `<#${antinukeId}>` : "not set",
    "This channel is separate. `-logging set all` does not change it."
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
      "",
      `\`${prefix}logging set antinuke [#channel]\` sets the Anti-Nuke and vouch log. \`all\` does not include it.`,
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
      return reply(message, "Logs Updated", `Event logs will go to <#${channel.id}>. Anti-Nuke and vouch logs were left alone.`);
    }
    if (category === access.ANTINUKE_LOG) {
      bindAntinukeLog(message.guild.id, channel.id);
      return reply(message, "Logs Updated", `Anti-Nuke and vouch logs will go to <#${channel.id}>.`);
    }
    if (!access.LOG_CATEGORIES.includes(category)) {
      return reply(message, "Unknown Category", `Use one of: ${access.LOG_CATEGORIES.join(", ")}, \`antinuke\`, or \`all\`.`);
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
      return reply(message, "Logs Cleared", `Removed **${removed}** event log setting(s). The Anti-Nuke log was kept.`);
    }
    if (category === access.ANTINUKE_LOG) {
      if (!store.getLog(message.guild.id, access.ANTINUKE_LOG) && !vouchStore.getConfig(message.guild.id).log_channel_id) {
        return reply(message, "Not Configured", "Anti-Nuke does not have a log channel.");
      }
      bindAntinukeLog(message.guild.id, null);
      return reply(message, "Logs Updated", "Anti-Nuke and vouch commands will no longer send a log.");
    }
    if (!access.LOG_CATEGORIES.includes(category)) {
      return reply(message, "Unknown Category", `Use one of: ${access.LOG_CATEGORIES.join(", ")}, \`antinuke\`, or \`all\`.`);
    }
    if (!store.removeLog(message.guild.id, category)) return reply(message, "Not Configured", `**${category}** does not have a log channel.`);
    return reply(message, "Logs Updated", `**${category}** will no longer send a log.`);
  }
  if (sub === "test") {
    const category = (args[2] || "").toLowerCase();
    if (category !== access.ANTINUKE_LOG && !access.LOG_CATEGORIES.includes(category)) {
      return reply(message, "Unknown Category", `Use one of: ${access.LOG_CATEGORIES.join(", ")}, or \`antinuke\`.`);
    }
    const sent = await sendLog(message.guild, category, `Test log from <@${message.author.id}>.`);
    if (!sent) return reply(message, "No Log Channel", `Set one with \`${prefix}logging set ${category}\`.`);
    return reply(message, "Test Sent", `A **${category}** test log was sent.`);
  }
  return reply(message, "Event Logging", `Use \`${prefix}logging help\`.`);
}

async function sendLog(guild, category, description) {
  const channelId = store.getLog(guild.id, category);
  if (!channelId) return false;
  const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || typeof channel.send !== "function") return false;
  await channel.send({ embeds: [embed(CATEGORY_HELP[category] || category, description, true)] });
  return true;
}

module.exports = { handleLogging, sendLog, CATEGORY_HELP, bindAntinukeLog };
