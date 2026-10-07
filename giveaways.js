const { AuditLogEvent, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");
const { connection } = require("./db");
const access = require("./systems/access");
const roles = require("./vouch/roles");
const protection = require("./vouch/protection");
const { ACCENT } = require("./vouch/constants");
const { reply } = require("./vouch/ui");

connection.exec(`
CREATE TABLE IF NOT EXISTS giveaways (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  host_id TEXT NOT NULL,
  prize TEXT NOT NULL,
  winner_count INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  ended INTEGER NOT NULL DEFAULT 0,
  entrants TEXT NOT NULL DEFAULT '[]',
  winners TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gw_roles (
  guild_id TEXT PRIMARY KEY,
  role_id TEXT
);

CREATE TABLE IF NOT EXISTS gw_hosts (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  added_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
`);

const statements = {
  insert: connection.prepare(`
    INSERT INTO giveaways(guild_id, channel_id, message_id, host_id, prize, winner_count, ends_at, ended, entrants, winners, created_at)
    VALUES(?,?,?,?,?,?,?,0,'[]','[]',?)
  `),
  setMessage: connection.prepare("UPDATE giveaways SET message_id=? WHERE id=?"),
  get: connection.prepare("SELECT * FROM giveaways WHERE id=?"),
  byMessage: connection.prepare("SELECT * FROM giveaways WHERE guild_id=? AND channel_id=? AND message_id=?"),
  latest: connection.prepare("SELECT * FROM giveaways WHERE guild_id=? AND channel_id=? ORDER BY id DESC LIMIT 1"),
  saveEntry: connection.prepare("UPDATE giveaways SET entrants=?, winners=?, ended=? WHERE id=?"),
  pending: connection.prepare("SELECT * FROM giveaways WHERE ended=0"),
  setRole: connection.prepare(`
    INSERT INTO gw_roles(guild_id, role_id) VALUES(?,?)
    ON CONFLICT(guild_id) DO UPDATE SET role_id=excluded.role_id
  `),
  getRole: connection.prepare("SELECT role_id FROM gw_roles WHERE guild_id=?"),
  addHost: connection.prepare(`
    INSERT INTO gw_hosts(guild_id, user_id, added_by, created_at) VALUES(?,?,?,?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET added_by=excluded.added_by
  `),
  removeHost: connection.prepare("DELETE FROM gw_hosts WHERE guild_id=? AND user_id=?"),
  isHost: connection.prepare("SELECT 1 FROM gw_hosts WHERE guild_id=? AND user_id=?")
};

const timers = new Map();

function parseJson(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseDuration(text) {
  const match = /^(\d{1,4})(s|m|h|d)$/i.exec(String(text || "").trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const ms = unit === "s" ? amount * 1000 : unit === "m" ? amount * 60000 : unit === "h" ? amount * 3600000 : amount * 86400000;
  if (ms < 15000 || ms > 30 * 86400000) return null;
  return { ms, label: `${amount}${unit}` };
}

function canConfigure(member) {
  return access.isServerOwner(member) || access.isBotOwner(member?.id) || access.isGod(member);
}

function canHost(member) {
  if (!member?.guild) return false;
  if (canConfigure(member)) return true;
  return !!statements.isHost.get(String(member.guild.id), String(member.id));
}

function draw(entrants, count, exclude) {
  const pool = entrants.filter((id) => !exclude.has(String(id)));
  const picked = [];
  while (picked.length < count && pool.length) {
    const index = Math.floor(Math.random() * pool.length);
    picked.push(String(pool.splice(index, 1)[0]));
  }
  return picked;
}

function giveawayEmbed(row, ended = false) {
  const entrants = parseJson(row.entrants);
  const ends = Math.floor(Number(row.ends_at) / 1000);
  return new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(row.prize)
    .setDescription([
      `Host: <@${row.host_id}>`,
      `Winners: **${row.winner_count}**`,
      ended ? "This giveaway has ended." : `Ends: <t:${ends}:R>`,
      `Entries: **${entrants.length}**`
    ].join("\n"));
}

function enterRow(id, count) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`spanter:gw:enter:${id}`)
      .setLabel(`Enter (${count})`)
      .setStyle(ButtonStyle.Primary)
  );
}

function announceText(winners, prize, hostId) {
  const names = winners.map((id) => `<@${id}>`).join(" ");
  return `${names} won **${prize}**! You have 3 minutes to DM <@${hostId}>.`;
}

async function announce(channel, winners, prize, hostId) {
  if (!winners.length || typeof channel?.send !== "function") return;
  await channel.send({
    content: announceText(winners, prize, hostId),
    allowedMentions: { users: [...winners, hostId] }
  });
}

async function finish(id) {
  const row = statements.get.get(id);
  if (!row || row.ended) return row;
  const entrants = parseJson(row.entrants);
  const winners = draw(entrants, row.winner_count, new Set([String(row.host_id)]));
  statements.saveEntry.run(JSON.stringify(entrants), JSON.stringify(winners), 1, id);
  const channel = row.channel;
  return { ...row, winners, entrants, channel };
}

async function resolveChannel(client, row) {
  if (row.channel) return row.channel;
  const guild = client?.guilds?.cache?.get?.(row.guild_id);
  if (!guild) return null;
  return guild.channels.cache.get(row.channel_id) || await guild.channels.fetch(row.channel_id).catch(() => null);
}

async function closeGiveaway(client, id) {
  const row = statements.get.get(id);
  if (!row || row.ended) return null;
  const result = await finish(id);
  const channel = await resolveChannel(client, row);
  if (channel?.messages?.fetch && row.message_id) {
    const message = await channel.messages.fetch(row.message_id).catch(() => null);
    if (message?.edit) {
      await message.edit({ embeds: [giveawayEmbed({ ...row, entrants: JSON.stringify(result.entrants) }, true)], components: [] }).catch(() => null);
    }
  }
  if (result.winners.length) await announce(channel, result.winners, row.prize, row.host_id);
  else if (typeof channel?.send === "function") await channel.send({ embeds: [new EmbedBuilder().setColor(ACCENT).setTitle(row.prize).setDescription("Nobody entered this giveaway.")] }).catch(() => null);
  return result;
}

function resume(client) {
  for (const row of statements.pending.all()) {
    const wait = Math.max(0, Number(row.ends_at) - Date.now());
    const timer = setTimeout(() => {
      timers.delete(row.id);
      closeGiveaway(client, row.id).catch((error) => console.error(`[giveaway] ${row.id}`, error));
    }, wait);
    timer.unref?.();
    timers.set(row.id, timer);
  }
}

function usage(prefix) {
  return [
    `\`${prefix}giveaways start [#channel] <duration> <winners> <prize>\``,
    `\`${prefix}giveaways reroll [message link] [winners]\``,
    `\`${prefix}gw start\` and \`${prefix}gw reroll\` do the same thing.`,
    "Duration examples: `30s`, `10m`, `2h`, `1d`.",
    "If you leave the channel out, it posts in the channel you used."
  ].join("\n");
}

async function start(message, args, prefix) {
  if (!canHost(message.member)) {
    return reply(message, "Access Denied", "Gods, the server owner, and giveaway hosts granted by the bot can start a giveaway.");
  }
  let index = 0;
  let channel = message.channel;
  const first = args[index];
  const channelId = String(first || "").replace(/[<#>]/g, "");
  if (/^\d{17,20}$/.test(channelId)) {
    const found = message.guild.channels.cache.get(channelId) || message.mentions?.channels?.get?.(channelId);
    if (!found) return reply(message, "Missing Channel", "I could not find that channel.");
    channel = found;
    index += 1;
  }
  const duration = parseDuration(args[index]);
  const winners = Number(args[index + 1]);
  const prize = args.slice(index + 2).join(" ").trim();
  if (!duration || !Number.isInteger(winners) || winners < 1 || winners > 20 || !prize) {
    return reply(message, "Usage", usage(prefix));
  }
  const endsAt = Date.now() + duration.ms;
  const created = statements.insert.run(
    message.guild.id,
    channel.id,
    null,
    message.author.id,
    prize.slice(0, 200),
    winners,
    endsAt,
    Date.now()
  );
  const id = Number(created.lastInsertRowid);
  const row = statements.get.get(id);
  const sent = await channel.send({ embeds: [giveawayEmbed(row)], components: [enterRow(id, 0)] });
  statements.setMessage.run(sent.id, id);
  const timer = setTimeout(() => closeGiveaway(message.client || message.guild.client, id).catch(() => null), duration.ms);
  timer.unref?.();
  timers.set(id, timer);
  if (channel.id === message.channel?.id) return reply(message, "Giveaway Started", `**${prize}** ends <t:${Math.floor(endsAt / 1000)}:R>.`);
  return reply(message, "Giveaway Started", `**${prize}** was posted in <#${channel.id}>.`);
}

async function reroll(message, args, prefix) {
  if (!canHost(message.member)) {
    return reply(message, "Access Denied", "Gods, the server owner, and giveaway hosts granted by the bot can reroll a giveaway.");
  }
  const link = args.find((part) => /channels\/\d+\/\d+\/\d+/.test(part));
  const countArg = args.find((part) => /^\d+$/.test(part));
  let row = null;
  let channel = message.channel;
  if (link) {
    const match = link.match(/channels\/(\d+)\/(\d+)\/(\d+)/);
    if (!match || match[1] !== message.guild.id) return reply(message, "Missing Giveaway", "Use a message link from this server.");
    channel = message.guild.channels.cache.get(match[2]) || message.channel;
    row = statements.byMessage.get(message.guild.id, match[2], match[3]);
  } else {
    row = statements.latest.get(message.guild.id, message.channel.id);
  }
  if (!row) return reply(message, "Missing Giveaway", usage(prefix));
  const entrants = parseJson(row.entrants);
  const previous = new Set(parseJson(row.winners));
  previous.add(String(row.host_id));
  const count = countArg ? Number(countArg) : row.winner_count;
  const winners = draw(entrants, count, previous);
  const nextWinners = [...parseJson(row.winners), ...winners];
  statements.saveEntry.run(JSON.stringify(entrants), JSON.stringify(nextWinners), 1, row.id);
  if (!winners.length) return reply(message, "No Entries Left", "There is nobody left to pick.");
  await announce(channel, winners, row.prize, row.host_id);
  return reply(message, "Giveaway Rerolled", announceText(winners, row.prize, row.host_id));
}

async function setHost(message, args, prefix) {
  if (!canConfigure(message.member)) {
    return reply(message, "Access Denied", "Only Gods and the server owner can set the giveaway host role.");
  }
  const action = (args[0] || "").toLowerCase();
  if (action === "add" || action === "remove") {
    const member = await resolveMember(message, args.slice(1).join(" "));
    if (!member) return reply(message, "Missing User", `\`${prefix}set gw host add @user\``);
    const roleId = statements.getRole.get(message.guild.id)?.role_id;
    if (action === "remove") {
      statements.removeHost.run(message.guild.id, member.id);
      if (roleId && member.roles?.cache?.has?.(roleId)) await roles.removeRole(member, roleId, "Giveaway host removed").catch(() => null);
      return reply(message, "Giveaway Host Removed", `<@${member.id}> can no longer host giveaways.`);
    }
    if (!roleId) return reply(message, "Role Not Set", `Set the role first with \`${prefix}set gw host @role\`.`);
    statements.addHost.run(message.guild.id, member.id, message.author.id, Date.now());
    const role = message.guild.roles.cache.get(roleId);
    if (role && !member.roles?.cache?.has?.(roleId)) await roles.addRole(member, role, "Giveaway host granted");
    return reply(message, "Giveaway Host Granted", `<@${member.id}> can host giveaways.`);
  }
  const role = await resolveRole(message, args.join(" "));
  if (!role || role.id === message.guild.id) {
    return reply(message, "Usage", `\`${prefix}set gw host @role\`\n\`${prefix}set gw host add @user\`\n\`${prefix}set gw host remove @user\``);
  }
  statements.setRole.run(message.guild.id, role.id);
  return reply(message, "Giveaway Host Role Set", `<@&${role.id}> is the giveaway host role. Only people granted with the bot keep it.`);
}

async function resolveMember(message, argument) {
  const id = String(argument || "").replace(/[<@!>]/g, "");
  if (!/^\d{17,20}$/.test(id)) return null;
  return message.guild.members.cache.get(id) || await message.guild.members.fetch(id).catch(() => null);
}

async function resolveRole(message, argument) {
  const mentioned = message.mentions?.roles?.first?.();
  if (mentioned) return mentioned;
  const id = String(argument || "").replace(/[<@&>]/g, "");
  if (/^\d{17,20}$/.test(id)) return message.guild.roles.cache.get(id) || null;
  const name = String(argument || "").trim().toLowerCase();
  if (!name) return null;
  return [...message.guild.roles.cache.values()].find((role) => role.name.toLowerCase() === name) || null;
}

async function handleCommand(message, args, prefix) {
  const sub = (args[0] || "").toLowerCase();
  if (sub === "start") return start(message, args.slice(1), prefix);
  if (sub === "reroll") return reroll(message, args.slice(1), prefix);
  return reply(message, "Giveaways", usage(prefix));
}

async function handleButton(interaction) {
  const id = interaction.customId || "";
  if (!id.startsWith("spanter:gw:enter:")) return false;
  const giveawayId = Number(id.slice("spanter:gw:enter:".length));
  const row = statements.get.get(giveawayId);
  if (!row || row.ended) {
    await interaction.reply({ content: "That giveaway has ended.", flags: 64 }).catch(() => null);
    return true;
  }
  if (interaction.user.bot) return true;
  const entrants = parseJson(row.entrants);
  const userId = String(interaction.user.id);
  const index = entrants.indexOf(userId);
  const joined = index === -1;
  if (joined) entrants.push(userId);
  else entrants.splice(index, 1);
  statements.saveEntry.run(JSON.stringify(entrants), row.winners, 0, row.id);
  await interaction.update({
    embeds: [giveawayEmbed({ ...row, entrants: JSON.stringify(entrants) })],
    components: [enterRow(row.id, entrants.length)]
  });
  return true;
}

async function findRoleExecutor(guild, userId) {
  if (typeof guild.fetchAuditLogs !== "function") return null;
  const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 6 }).catch(() => null);
  const entries = logs?.entries ? [...logs.entries.values()] : [];
  return entries.find((entry) => entry.target?.id === userId || entry.targetId === userId)?.executor || null;
}

async function enforceHostRole(oldMember, newMember) {
  if (!newMember?.guild || !oldMember?.roles?.cache || !newMember.roles?.cache) return;
  const roleId = statements.getRole.get(newMember.guild.id)?.role_id;
  if (!roleId) return;
  const added = !oldMember.roles.cache.has(roleId) && newMember.roles.cache.has(roleId);
  if (!added) return;
  if (statements.isHost.get(newMember.guild.id, newMember.id)) return;
  await roles.removeRole(newMember, roleId, "Giveaway host role was not granted by the bot").catch(() => null);
  const executor = await findRoleExecutor(newMember.guild, newMember.id);
  if (!executor || executor.bot || executor.id === newMember.guild.client?.user?.id) return;
  await protection.stripStaff(newMember, {
    reason: "Giveaway host role added without a bot grant",
    automatic: true,
    actorId: executor.id,
    trigger: executor.id
  });
}

module.exports = {
  handleCommand,
  handleButton,
  setHost,
  enforceHostRole,
  resume,
  closeGiveaway,
  parseDuration,
  draw,
  announceText,
  canHost,
  canConfigure,
  giveawayEmbed
};
