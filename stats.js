const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");
const { connection } = require("./db");
const { ACCENT } = require("./vouch/constants");
const { reply } = require("./vouch/ui");

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const HOUR_MS = 60 * 60 * 1000;
const PAGE_SIZE = 8;

connection.exec(`
CREATE TABLE IF NOT EXISTS mod_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mod_actions_mod ON mod_actions(guild_id, moderator_id, kind, created_at);

CREATE TABLE IF NOT EXISTS activity_messages (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  total INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, channel_id)
);

CREATE TABLE IF NOT EXISTS activity_message_hours (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  hour INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, channel_id, hour)
);

CREATE TABLE IF NOT EXISTS voice_time (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  total_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, channel_id)
);

CREATE TABLE IF NOT EXISTS voice_time_hours (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  hour INTEGER NOT NULL,
  total_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, channel_id, hour)
);

CREATE TABLE IF NOT EXISTS voice_sessions (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
`);

const statements = {
  insertAction: connection.prepare(`
    INSERT INTO mod_actions(guild_id, moderator_id, target_id, kind, reason, created_at)
    VALUES(?,?,?,?,?,?)
  `),
  countKind: connection.prepare("SELECT COUNT(*) AS total FROM mod_actions WHERE guild_id=? AND moderator_id=? AND kind=?"),
  listKind: connection.prepare(`
    SELECT target_id, kind, reason, created_at FROM mod_actions
    WHERE guild_id=? AND moderator_id=? AND kind=?
    ORDER BY created_at DESC, id DESC
  `),
  listActions: connection.prepare(`
    SELECT target_id, kind, reason, created_at FROM mod_actions
    WHERE guild_id=? AND moderator_id=?
    ORDER BY created_at DESC, id DESC
  `),
  countIssuedBans: connection.prepare(`
    SELECT COUNT(*) AS total FROM ban_history
    WHERE guild_id=? AND moderator_id=? AND action IN ('ban','hardban','foreverban','softban','tempban')
  `),
  listIssuedBans: connection.prepare(`
    SELECT user_id AS target_id, action AS kind, reason, created_at FROM ban_history
    WHERE guild_id=? AND moderator_id=? AND action IN ('ban','hardban','foreverban','softban','tempban')
    ORDER BY created_at DESC, id DESC
  `),
  countPersonal: connection.prepare("SELECT COUNT(*) AS total FROM personal_bans WHERE guild_id=? AND banner_id=?"),
  listPersonal: connection.prepare(`
    SELECT user_id AS target_id, 'personal ban' AS kind, 'Personal ban' AS reason, created_at
    FROM personal_bans WHERE guild_id=? AND banner_id=?
  `),
  addMessages: connection.prepare(`
    INSERT INTO activity_messages(guild_id, user_id, channel_id, total) VALUES(?,?,?,1)
    ON CONFLICT(guild_id, user_id, channel_id) DO UPDATE SET total = total + 1
  `),
  addMessageHour: connection.prepare(`
    INSERT INTO activity_message_hours(guild_id, user_id, channel_id, hour, count) VALUES(?,?,?,?,1)
    ON CONFLICT(guild_id, user_id, channel_id, hour) DO UPDATE SET count = count + 1
  `),
  messageTotal: connection.prepare("SELECT COALESCE(SUM(total), 0) AS total FROM activity_messages WHERE guild_id=? AND user_id=?"),
  messageChannels: connection.prepare("SELECT channel_id, total FROM activity_messages WHERE guild_id=? AND user_id=?"),
  messageWindow: connection.prepare(`
    SELECT COALESCE(SUM(count), 0) AS total FROM activity_message_hours
    WHERE guild_id=? AND user_id=? AND hour>=?
  `),
  messageWindowChannels: connection.prepare(`
    SELECT channel_id, SUM(count) AS total FROM activity_message_hours
    WHERE guild_id=? AND user_id=? AND hour>=?
    GROUP BY channel_id
  `),
  addVoice: connection.prepare(`
    INSERT INTO voice_time(guild_id, user_id, channel_id, total_ms) VALUES(?,?,?,?)
    ON CONFLICT(guild_id, user_id, channel_id) DO UPDATE SET total_ms = total_ms + excluded.total_ms
  `),
  addVoiceHour: connection.prepare(`
    INSERT INTO voice_time_hours(guild_id, user_id, channel_id, hour, total_ms) VALUES(?,?,?,?,?)
    ON CONFLICT(guild_id, user_id, channel_id, hour) DO UPDATE SET total_ms = total_ms + excluded.total_ms
  `),
  voiceChannels: connection.prepare("SELECT channel_id, total_ms AS total FROM voice_time WHERE guild_id=? AND user_id=?"),
  voiceWindowChannels: connection.prepare(`
    SELECT channel_id, SUM(total_ms) AS total FROM voice_time_hours
    WHERE guild_id=? AND user_id=? AND hour>=?
    GROUP BY channel_id
  `),
  openSession: connection.prepare("INSERT OR REPLACE INTO voice_sessions(guild_id, user_id, channel_id, started_at) VALUES(?,?,?,?)"),
  getSession: connection.prepare("SELECT * FROM voice_sessions WHERE guild_id=? AND user_id=?"),
  listSessions: connection.prepare("SELECT * FROM voice_sessions"),
  deleteSession: connection.prepare("DELETE FROM voice_sessions WHERE guild_id=? AND user_id=?"),
  pruneMessages: connection.prepare("DELETE FROM activity_message_hours WHERE hour<?"),
  pruneVoice: connection.prepare("DELETE FROM voice_time_hours WHERE hour<?")
};

let prunedAt = 0;

function prune(now = Date.now()) {
  if (now - prunedAt < 60_000) return;
  prunedAt = now;
  const oldest = Math.floor((now - (8 * DAY_MS)) / HOUR_MS);
  statements.pruneMessages.run(oldest);
  statements.pruneVoice.run(oldest);
}

function recordAction(guildId, moderatorId, targetId, kind, reason, createdAt = Date.now()) {
  if (!guildId || !moderatorId || !targetId || !kind) return false;
  const text = String(reason || "").replace(/\s+/g, " ").trim().slice(0, 180);
  const when = Number(createdAt) > 0 ? Number(createdAt) : Date.now();
  statements.insertAction.run(guildId, String(moderatorId), String(targetId), kind, text || null, when);
  return true;
}

function noteMessage(message, now = Date.now()) {
  const guildId = message?.guild?.id;
  const userId = message?.author?.id;
  const channelId = message?.channelId || message?.channel?.id;
  if (!guildId || !userId || !channelId || message.author?.bot) return;
  prune(now);
  const hour = Math.floor(now / HOUR_MS);
  statements.addMessages.run(guildId, userId, channelId);
  statements.addMessageHour.run(guildId, userId, channelId, hour);
}

function addVoiceSpan(guildId, userId, channelId, start, end) {
  const ms = end - start;
  if (!guildId || !userId || !channelId || ms <= 0) return;
  statements.addVoice.run(guildId, userId, channelId, ms);
  let cursor = start;
  while (cursor < end) {
    const hour = Math.floor(cursor / HOUR_MS);
    const sliceEnd = Math.min(end, (hour + 1) * HOUR_MS);
    statements.addVoiceHour.run(guildId, userId, channelId, hour, sliceEnd - cursor);
    cursor = sliceEnd;
  }
}

function closeSession(guildId, userId, now) {
  const row = statements.getSession.get(guildId, userId);
  if (!row) return;
  statements.deleteSession.run(guildId, userId);
  addVoiceSpan(guildId, userId, row.channel_id, row.started_at, now);
}

function trackVoice(before, after, now = Date.now()) {
  const guild = after?.guild || before?.guild;
  const userId = after?.id || before?.id;
  if (!guild?.id || !userId) return;
  const bot = after?.member?.user?.bot || before?.member?.user?.bot || after?.member?.bot;
  if (bot) return;
  const previous = before?.channelId || null;
  const next = after?.channelId || null;
  if (previous === next) return;
  if (previous) closeSession(guild.id, userId, now);
  if (next) statements.openSession.run(guild.id, userId, next, now);
}

function reconcile(client, now = Date.now()) {
  for (const session of statements.listSessions.all()) {
    const guild = client.guilds?.cache?.get(session.guild_id);
    const member = guild?.members?.cache?.get(session.user_id);
    if (member?.voice?.channelId === session.channel_id) {
      statements.openSession.run(session.guild_id, session.user_id, session.channel_id, now);
    } else {
      statements.deleteSession.run(session.guild_id, session.user_id);
    }
  }
}

function countOf(statement, ...args) {
  return statement.get(...args)?.total || 0;
}

function moderationCounts(guildId, userId) {
  const warns = countOf(statements.countKind, guildId, userId, "warn");
  const kicks = countOf(statements.countKind, guildId, userId, "kick");
  const mutes = countOf(statements.countKind, guildId, userId, "mute");
  const bans = countOf(statements.countIssuedBans, guildId, userId)
    + countOf(statements.countPersonal, guildId, userId)
    + countOf(statements.countKind, guildId, userId, "ban");
  return { warns, kicks, bans, mutes, total: warns + kicks + bans + mutes };
}

function moderationRows(guildId, userId, kind) {
  if (kind === "bans") {
    return [
      ...statements.listIssuedBans.all(guildId, userId),
      ...statements.listPersonal.all(guildId, userId),
      ...statements.listKind.all(guildId, userId, "ban")
    ].sort((left, right) => right.created_at - left.created_at);
  }
  if (kind === "all") {
    return [
      ...statements.listIssuedBans.all(guildId, userId),
      ...statements.listPersonal.all(guildId, userId),
      ...statements.listActions.all(guildId, userId)
    ].sort((left, right) => right.created_at - left.created_at);
  }
  const stored = { warns: "warn", kicks: "kick", mutes: "mute" }[kind];
  return stored ? statements.listKind.all(guildId, userId, stored) : [];
}

function avatarUrl(user) {
  return user?.displayAvatarURL?.({ size: 256 }) || user?.avatarURL?.() || null;
}

function chart(user, description) {
  const embed = new EmbedBuilder().setColor(ACCENT).setTitle("Moderation Stats").setDescription(description.slice(0, 4000));
  const url = avatarUrl(user);
  if (url) embed.setThumbnail(url);
  return embed;
}

function summaryButtons(userId) {
  const labels = [["warns", "Warns"], ["kicks", "Kicks"], ["bans", "Bans"], ["mutes", "Mutes"], ["all", "All"]];
  return new ActionRowBuilder().addComponents(labels.map(([kind, label]) => new ButtonBuilder()
    .setCustomId(`spanter:modstats:${kind}:${userId}:0`)
    .setLabel(label)
    .setStyle(kind === "all" ? ButtonStyle.Primary : ButtonStyle.Secondary)));
}

function summaryText(user, counts) {
  return [
    `<@${user.id}>`,
    "",
    `**Warns issued:** ${counts.warns}`,
    `**Kicks issued:** ${counts.kicks}`,
    `**Bans issued:** ${counts.bans}`,
    `**Mutes issued:** ${counts.mutes}`,
    `**Total actions:** ${counts.total}`
  ].join("\n");
}

function summaryMessage(guildId, user) {
  return {
    embeds: [chart(user, summaryText(user, moderationCounts(guildId, user.id)))],
    components: [summaryButtons(user.id)],
    allowedMentions: { parse: [] }
  };
}

const KIND_TITLE = { warns: "Warns", kicks: "Kicks", bans: "Bans", mutes: "Mutes", all: "All actions" };
const KIND_LABEL = {
  warn: "Warn", kick: "Kick", mute: "Mute", ban: "Ban", hardban: "Hardban",
  foreverban: "Foreverban", softban: "Softban", tempban: "Tempban", "personal ban": "Personal ban"
};

function actionLine(row, showKind) {
  const when = Number(row.created_at) > 0 ? `<t:${Math.floor(row.created_at / 1000)}:R>` : "unknown time";
  const reason = String(row.reason || "No reason").replace(/\s+/g, " ").slice(0, 80);
  const kind = showKind ? `${KIND_LABEL[row.kind] || row.kind} · ` : "";
  return `${kind}<@${row.target_id}> — ${reason} — ${when}`;
}

function detailMessage(guildId, user, kind, page) {
  const rows = moderationRows(guildId, user.id, kind);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(Math.max(page, 0), pages - 1);
  const slice = rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const title = KIND_TITLE[kind] || "Actions";
  const lines = slice.length
    ? slice.map((row) => actionLine(row, kind === "all"))
    : [`No ${title.toLowerCase()} recorded.`];
  const description = [`<@${user.id}>`, "", `**${title}:** ${rows.length}`, "", ...lines].join("\n");
  const embed = chart(user, description);
  if (rows.length > PAGE_SIZE) embed.setFooter({ text: `Page ${current + 1} / ${pages}` });
  const buttons = [
    new ButtonBuilder().setCustomId(`spanter:modstats:home:${user.id}`).setLabel("Stats").setStyle(ButtonStyle.Secondary)
  ];
  if (pages > 1) {
    buttons.push(
      new ButtonBuilder().setCustomId(`spanter:modstats:${kind}:${user.id}:${current - 1}`).setLabel("Back").setStyle(ButtonStyle.Secondary).setDisabled(current === 0),
      new ButtonBuilder().setCustomId(`spanter:modstats:${kind}:${user.id}:${current + 1}`).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(current >= pages - 1)
    );
  }
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(buttons)],
    allowedMentions: { parse: [] }
  };
}

async function resolveUser(message, argument) {
  if (!argument) return message.author;
  const mentioned = message.mentions?.users?.first?.() || message.mentions?.members?.first?.()?.user;
  if (mentioned) return mentioned;
  const id = String(argument).replace(/[<@!>]/g, "");
  if (/^\d{17,20}$/.test(id)) {
    const member = message.guild.members?.cache?.get(id) || await message.guild.members?.fetch?.(id).catch(() => null);
    if (member?.user) return member.user;
    const user = await message.client?.users?.fetch?.(id).catch(() => null);
    return user || { id };
  }
  const name = String(argument).toLowerCase();
  const member = [...(message.guild.members?.cache?.values?.() || [])].find((item) => (
    item.user?.username?.toLowerCase() === name || item.displayName?.toLowerCase() === name
  ));
  return member?.user || null;
}

async function showModstats(message, argument) {
  const user = await resolveUser(message, argument);
  if (!user?.id) return reply(message, "Missing User", "Mention a user, or run `-modstats` for yourself.");
  return message.reply(summaryMessage(message.guild.id, user));
}

function formatDuration(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours && rest) return `${hours} hour${hours === 1 ? "" : "s"} ${rest} minute${rest === 1 ? "" : "s"}`;
  if (hours) return `${hours} hour${hours === 1 ? "" : "s"}`;
  if (minutes) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return "0 minutes";
}

function topChannel(rows, extraId, extraAmount) {
  const totals = new Map();
  for (const row of rows) totals.set(row.channel_id, (totals.get(row.channel_id) || 0) + row.total);
  if (extraId && extraAmount > 0) totals.set(extraId, (totals.get(extraId) || 0) + extraAmount);
  let best = null;
  for (const [channelId, total] of totals) {
    if (!best || total > best.total) best = { channelId, total };
  }
  return best;
}

function overlap(start, end, windowStart, windowEnd) {
  return Math.max(0, Math.min(end, windowEnd) - Math.max(start, windowStart));
}

function activitySnapshot(guildId, userId, now = Date.now()) {
  const session = statements.getSession.get(guildId, userId);
  const live = session ? Math.max(0, now - session.started_at) : 0;
  const dayStart = now - DAY_MS;
  const weekStart = now - WEEK_MS;
  const liveDay = session ? overlap(session.started_at, now, dayStart, now) : 0;
  const liveWeek = session ? overlap(session.started_at, now, weekStart, now) : 0;
  const voiceRows = statements.voiceChannels.all(guildId, userId);
  const voiceTotal = voiceRows.reduce((sum, row) => sum + row.total, 0) + live;
  const dayHour = Math.floor(dayStart / HOUR_MS);
  const weekHour = Math.floor(weekStart / HOUR_MS);
  const voiceDayRows = statements.voiceWindowChannels.all(guildId, userId, dayHour);
  const voiceWeekRows = statements.voiceWindowChannels.all(guildId, userId, weekHour);
  const messages = countOf(statements.messageTotal, guildId, userId);
  return {
    voiceTotal,
    voiceDay: voiceDayRows.reduce((sum, row) => sum + row.total, 0) + liveDay,
    voiceWeek: voiceWeekRows.reduce((sum, row) => sum + row.total, 0) + liveWeek,
    messages,
    messagesDay: countOf(statements.messageWindow, guildId, userId, dayHour),
    messagesWeek: countOf(statements.messageWindow, guildId, userId, weekHour),
    messageChannel: topChannel(statements.messageChannels.all(guildId, userId)),
    messageDayChannel: topChannel(statements.messageWindowChannels.all(guildId, userId, dayHour)),
    messageWeekChannel: topChannel(statements.messageWindowChannels.all(guildId, userId, weekHour)),
    voiceChannel: topChannel(voiceRows, session?.channel_id, live),
    voiceDayChannel: topChannel(voiceDayRows, session?.channel_id, liveDay),
    voiceWeekChannel: topChannel(voiceWeekRows, session?.channel_id, liveWeek)
  };
}

function placeLine(label, channel, amountText) {
  if (!channel?.total) return `${label}: none yet`;
  return `${label}: <#${channel.channelId}> · ${amountText}`;
}

function activityBlock(title, voiceMs, messages, messageChannel, voiceChannel) {
  return [
    `**${title}**`,
    `Voice: ${formatDuration(voiceMs)}`,
    `Messages: ${Number(messages).toLocaleString("en-US")}`,
    placeLine("Most messages", messageChannel, Number(messageChannel?.total || 0).toLocaleString("en-US")),
    placeLine("Most voice", voiceChannel, formatDuration(voiceChannel?.total || 0))
  ].join("\n");
}

function activityMessage(guildId, user, now = Date.now()) {
  const stats = activitySnapshot(guildId, user.id, now);
  const description = [
    `<@${user.id}>`,
    "",
    activityBlock("All time", stats.voiceTotal, stats.messages, stats.messageChannel, stats.voiceChannel),
    "",
    activityBlock("Last 24 hours", stats.voiceDay, stats.messagesDay, stats.messageDayChannel, stats.voiceDayChannel),
    "",
    activityBlock("Last 7 days", stats.voiceWeek, stats.messagesWeek, stats.messageWeekChannel, stats.voiceWeekChannel)
  ].join("\n");
  const embed = new EmbedBuilder().setColor(ACCENT).setTitle("Activity").setDescription(description.slice(0, 4000));
  embed.setFooter({ text: "Counted while the bot is online." });
  const url = avatarUrl(user);
  if (url) embed.setThumbnail(url);
  return { embeds: [embed], allowedMentions: { parse: [] } };
}

async function showViewstats(message, argument) {
  const user = await resolveUser(message, argument);
  if (!user?.id) return reply(message, "Missing User", "Mention a user, or run `-viewstats` for yourself.");
  return message.reply(activityMessage(message.guild.id, user));
}

async function handleCommand(message, name, args) {
  if (name === "modstats") {
    await showModstats(message, args[1]);
    return true;
  }
  if (name === "viewstats") {
    await showViewstats(message, args[1]);
    return true;
  }
  return false;
}

async function handleButton(interaction) {
  const id = interaction.customId || "";
  if (!id.startsWith("spanter:modstats:")) return false;
  const [, , kind, userId, pageText] = id.split(":");
  if (!/^\d{17,20}$/.test(userId || "")) return false;
  const member = interaction.guild?.members?.cache?.get(userId) || await interaction.guild?.members?.fetch?.(userId).catch(() => null);
  const user = member?.user || await interaction.client?.users?.fetch?.(userId).catch(() => null) || { id: userId };
  if (kind === "home") {
    await interaction.update(summaryMessage(interaction.guild.id, user));
    return true;
  }
  if (!KIND_TITLE[kind]) return false;
  await interaction.update(detailMessage(interaction.guild.id, user, kind, Number(pageText) || 0));
  return true;
}

module.exports = {
  recordAction,
  noteMessage,
  trackVoice,
  reconcile,
  handleCommand,
  handleButton,
  moderationCounts,
  activitySnapshot,
  formatDuration
};
