const fs = require("node:fs");
const path = require("node:path");
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder
} = require("discord.js");
const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");
const { connection } = require("./db");
const stats = require("./stats");
const { replyUsage } = require("./usage");
const { resolveMember } = require("./vouch/resolve");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RANGES = { "7d": 7, "24h": 1 };
const VIEWS = ["overview", "messages", "voice"];

const FONT_REGULAR = "Card";
const FONT_BOLD = "Card Bold";
const FONT_FILES = [
  [path.join(__dirname, "fonts", "inter-latin-400-normal.woff"), FONT_REGULAR],
  [path.join(__dirname, "fonts", "inter-latin-700-normal.woff"), FONT_BOLD],
  ["C:/Windows/Fonts/segoeui.ttf", FONT_REGULAR],
  ["C:/Windows/Fonts/segoeuib.ttf", FONT_BOLD],
  ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", FONT_REGULAR],
  ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", FONT_BOLD]
];
const registeredFonts = new Set();
for (const [file, family] of FONT_FILES) {
  if (registeredFonts.has(family) || !fs.existsSync(file)) continue;
  if (GlobalFonts.registerFromPath(file, family)) registeredFonts.add(family);
}

connection.exec(`
CREATE TABLE IF NOT EXISTS quick_stats (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);
`);

const statements = {
  disabled: connection.prepare("SELECT disabled FROM quick_stats WHERE guild_id=? AND user_id=?"),
  saveDisabled: connection.prepare(`
    INSERT INTO quick_stats(guild_id, user_id, disabled) VALUES(?,?,?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET disabled=excluded.disabled
  `),
  messageHours: connection.prepare(`
    SELECT hour, SUM(count) AS total FROM activity_message_hours
    WHERE guild_id=? AND user_id=? AND hour>=?
    GROUP BY hour
  `),
  messageRanks: connection.prepare(`
    SELECT user_id, SUM(count) AS total FROM activity_message_hours
    WHERE guild_id=? AND hour>=?
    GROUP BY user_id
  `),
  messageChannels: connection.prepare(`
    SELECT channel_id, SUM(count) AS total FROM activity_message_hours
    WHERE guild_id=? AND user_id=? AND hour>=?
    GROUP BY channel_id
    ORDER BY total DESC
    LIMIT 5
  `),
  voiceHours: connection.prepare(`
    SELECT hour, SUM(total_ms) AS total FROM voice_time_hours
    WHERE guild_id=? AND user_id=? AND hour>=?
    GROUP BY hour
  `),
  voiceRanks: connection.prepare(`
    SELECT user_id, SUM(total_ms) AS total FROM voice_time_hours
    WHERE guild_id=? AND hour>=?
    GROUP BY user_id
  `),
  voiceChannels: connection.prepare(`
    SELECT channel_id, SUM(total_ms) AS total FROM voice_time_hours
    WHERE guild_id=? AND user_id=? AND hour>=?
    GROUP BY channel_id
    ORDER BY total DESC
    LIMIT 5
  `),
  sessions: connection.prepare("SELECT * FROM voice_sessions WHERE guild_id=?")
};

function isDisabled(guildId, userId) {
  return !!statements.disabled.get(String(guildId), String(userId))?.disabled;
}

function setDisabled(guildId, userId, disabled) {
  statements.saveDisabled.run(String(guildId), String(userId), disabled ? 1 : 0);
}

function isInvocation(content) {
  return /^s-u(?:\s|$)/i.test(String(content || "").trim());
}

function invocationTarget(content) {
  return String(content || "").trim().replace(/^s-u\s*/i, "").trim();
}

function rangeHours(range, now) {
  const days = RANGES[range] || 7;
  return { days, startHour: Math.floor((now - days * DAY_MS) / HOUR_MS), start: now - days * DAY_MS };
}

function bucketsFor(range, now) {
  if (range === "24h") {
    const size = 3 * HOUR_MS;
    const start = now - DAY_MS;
    const buckets = [];
    for (let cursor = start; cursor < now; cursor += size) {
      buckets.push({ stamp: cursor, end: Math.min(now, cursor + size), messages: 0, voice: 0 });
    }
    return buckets;
  }
  const buckets = [];
  for (let index = 6; index >= 0; index -= 1) {
    const stamp = dayStart(now - index * DAY_MS);
    buckets.push({ stamp, end: stamp + DAY_MS, messages: 0, voice: 0 });
  }
  return buckets;
}

function place(buckets, ms, field, amount) {
  const bucket = buckets.find((item) => ms >= item.stamp && ms < item.end);
  if (bucket) bucket[field] += amount;
}

function voiceCompact(ms) {
  const minutes = Math.max(0, Math.round(Number(ms || 0) / 60000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours && rest) return `${hours}h ${rest}m`;
  if (hours) return `${hours}h`;
  return `${rest}m`;
}

function rankOf(rows, userId, extra = 0) {
  const totals = new Map();
  for (const row of rows) totals.set(String(row.user_id), Number(row.total) || 0);
  const mine = (totals.get(String(userId)) || 0) + extra;
  let ahead = 0;
  for (const [id, total] of totals) {
    if (id !== String(userId) && total > mine) ahead += 1;
  }
  return ahead + 1;
}

function dayStart(ms) {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function addSpan(buckets, start, end) {
  let cursor = Math.max(0, start);
  while (cursor < end) {
    const bucket = buckets.find((item) => cursor >= item.stamp && cursor < item.end);
    if (!bucket) {
      cursor = end;
      break;
    }
    const next = Math.min(end, bucket.end);
    bucket.voice += next - cursor;
    cursor = next;
  }
}

function buildModel(guild, member, user, view, range, now = Date.now()) {
  const window = rangeHours(range, now);
  const days = bucketsFor(range, now);
  for (const row of statements.messageHours.all(guild.id, user.id, window.startHour)) {
    place(days, row.hour * HOUR_MS, "messages", Number(row.total) || 0);
  }
  for (const row of statements.voiceHours.all(guild.id, user.id, window.startHour)) {
    place(days, row.hour * HOUR_MS, "voice", Number(row.total) || 0);
  }
  let liveVoice = 0;
  const voiceTotals = new Map(statements.voiceRanks.all(guild.id, window.startHour).map((row) => [String(row.user_id), Number(row.total) || 0]));
  for (const session of statements.sessions.all(guild.id)) {
    const overlap = Math.max(0, now - Math.max(session.started_at, window.start));
    if (overlap <= 0) continue;
    voiceTotals.set(session.user_id, (voiceTotals.get(session.user_id) || 0) + overlap);
    if (String(session.user_id) === String(user.id)) {
      liveVoice += overlap;
      addSpan(days, Math.max(session.started_at, window.start), now);
    }
  }
  const messages = days.reduce((sum, day) => sum + day.messages, 0);
  const voiceMs = days.reduce((sum, day) => sum + day.voice, 0);
  const messageRankRows = statements.messageRanks.all(guild.id, window.startHour);
  const channelRows = view === "voice"
    ? statements.voiceChannels.all(guild.id, user.id, window.startHour)
    : statements.messageChannels.all(guild.id, user.id, window.startHour);
  const channels = channelRows.map((row) => {
    const channel = guild.channels?.cache?.get?.(row.channel_id);
    const count = view === "voice" ? voiceCompact(row.total) : String(Number(row.total) || 0);
    return { name: channel?.name ? `#${channel.name}` : "#deleted", count };
  });
  if (view === "voice" && liveVoice > 0) {
    const session = statements.sessions.all(guild.id).find((row) => String(row.user_id) === String(user.id));
    const channel = guild.channels?.cache?.get?.(session?.channel_id);
    const name = channel?.name ? `#${channel.name}` : "#deleted";
    const existing = channels.find((item) => item.name === name);
    if (!existing) channels.unshift({ name, count: voiceCompact(liveVoice) });
  }
  const joinedAt = Number(member?.joinedTimestamp || 0);
  const joined = joinedAt
    ? `Joined ${new Date(joinedAt).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })}`
    : "Joined unknown";
  return {
    username: member?.displayName || user.username || user.globalName || user.id,
    serverName: guild.name || "Server",
    avatarUrl: typeof user.displayAvatarURL === "function" ? user.displayAvatarURL({ extension: "png", size: 128 }) : null,
    joined,
    view: VIEWS.includes(view) ? view : "overview",
    range: RANGES[range] ? range : "7d",
    rangeLabel: window.days === 1 ? "Last 24 hours" : "Last 7 days",
    messages,
    voiceLabel: voiceCompact(voiceMs),
    overallRank: rankOf(messageRankRows, user.id),
    voiceRank: rankOf([...voiceTotals.entries()].map(([user_id, total]) => ({ user_id, total })), user.id),
    days,
    channels: channels.slice(0, 5),
    liveVoice
  };
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function font(size, bold) {
  const family = bold && registeredFonts.has(FONT_BOLD) ? FONT_BOLD : FONT_REGULAR;
  return `${size}px "${family}", "Segoe UI", sans-serif`;
}

function smooth(ctx, points) {
  if (!points.length) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  if (points.length === 1) return;
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const midX = (current.x + next.x) / 2;
    const midY = (current.y + next.y) / 2;
    ctx.quadraticCurveTo(current.x, current.y, midX, midY);
  }
  ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
}

async function loadAvatar(url) {
  if (!url || process.env.NODE_TEST_CONTEXT) return null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return null;
    return await loadImage(Buffer.from(await response.arrayBuffer()));
  } catch {
    return null;
  }
}

async function renderCard(model) {
  const width = 1040;
  const height = 620;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  roundRect(ctx, 0, 0, width, height, 28);
  ctx.fillStyle = "#2b2d31";
  ctx.fill();

  const avatarX = 58;
  const avatarY = 58;
  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarX, avatarY, 28, 0, Math.PI * 2);
  ctx.fillStyle = "#5865f2";
  ctx.fill();
  ctx.clip();
  const image = await loadAvatar(model.avatarUrl);
  if (image) ctx.drawImage(image, avatarX - 28, avatarY - 28, 56, 56);
  else {
    ctx.fillStyle = "#ffffff";
    ctx.font = font(24, true);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(model.username || "?").slice(0, 1).toUpperCase(), avatarX, avatarY + 1);
  }
  ctx.restore();

  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  ctx.font = font(28, true);
  ctx.fillText(String(model.username).slice(0, 32), 100, 46);
  ctx.fillStyle = "#b5bac1";
  ctx.font = font(16, false);
  ctx.fillText(String(model.serverName).slice(0, 42), 100, 74);

  const viewLabel = model.view === "messages" ? "MESSAGES" : model.view === "voice" ? "VOICE" : "OVERVIEW";
  ctx.textAlign = "right";
  ctx.fillStyle = "#ffffff";
  ctx.font = font(15, true);
  ctx.fillText(viewLabel, width - 36, 42);
  ctx.fillStyle = "#b5bac1";
  ctx.font = font(16, false);
  ctx.fillText(model.joined, width - 36, 68);

  const cards = [
    ["MESSAGES", String(model.messages)],
    ["VOICE TIME", model.voiceLabel],
    ["SERVER RANKS", null]
  ];
  const cardY = 112;
  const cardW = 312;
  const gap = 16;
  cards.forEach((card, index) => {
    const x = 28 + index * (cardW + gap);
    roundRect(ctx, x, cardY, cardW, 92, 18);
    ctx.fillStyle = "#1e1f22";
    ctx.fill();
    ctx.fillStyle = "#b5bac1";
    ctx.textAlign = "left";
    ctx.font = font(13, true);
    ctx.fillText(card[0], x + 22, cardY + 28);
    ctx.fillStyle = "#ffffff";
    ctx.font = font(32, true);
    if (card[1]) ctx.fillText(card[1], x + 22, cardY + 62);
  });
  const rankX = 28 + 2 * (cardW + gap) + 22;
  ctx.font = font(18, true);
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.fillText("OVERALL", rankX, cardY + 52);
  ctx.fillText("VOICE", rankX, cardY + 76);
  ctx.textAlign = "right";
  ctx.fillStyle = "#5865f2";
  ctx.fillText(`#${model.overallRank}`, rankX + 268, cardY + 52);
  ctx.fillStyle = "#3ba55c";
  ctx.fillText(`#${model.voiceRank}`, rankX + 268, cardY + 76);

  roundRect(ctx, 28, 220, 620, 340, 18);
  ctx.fillStyle = "#1e1f22";
  ctx.fill();
  roundRect(ctx, 664, 220, 348, 340, 18);
  ctx.fill();

  ctx.textAlign = "left";
  ctx.fillStyle = "#ffffff";
  ctx.font = font(18, true);
  ctx.fillText(model.rangeLabel, 48, 248);
  ctx.font = font(14, false);
  ctx.fillStyle = "#4c8dff";
  ctx.beginPath();
  ctx.arc(430, 248, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#dbdee1";
  ctx.fillText("Messages", 442, 248);
  ctx.fillStyle = "#3ba55c";
  ctx.beginPath();
  ctx.arc(530, 248, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#dbdee1";
  ctx.fillText("Voice", 542, 248);

  const plot = { x: 78, y: 276, w: 460, h: 210 };
  const maxMessages = Math.max(4, ...model.days.map((day) => day.messages));
  const maxVoice = Math.max(60 * 1000, ...model.days.map((day) => day.voice));
  ctx.strokeStyle = "#3a3d44";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#8e9297";
  ctx.font = font(12, false);
  ctx.textAlign = "right";
  for (let tick = 0; tick <= 4; tick += 1) {
    const y = plot.y + plot.h - (plot.h * tick) / 4;
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
    ctx.fillText(String(Math.round((maxMessages * tick) / 4)), plot.x - 8, y);
    ctx.textAlign = "left";
    ctx.fillText(voiceCompact((maxVoice * tick) / 4), plot.x + plot.w + 8, y);
    ctx.textAlign = "right";
  }
  const point = (index, value, max) => ({
    x: plot.x + (model.days.length === 1 ? plot.w / 2 : (plot.w * index) / (model.days.length - 1)),
    y: plot.y + plot.h - (plot.h * value) / max
  });
  const messagePoints = model.days.map((day, index) => point(index, day.messages, maxMessages));
  const voicePoints = model.days.map((day, index) => point(index, day.voice, maxVoice));
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#4c8dff";
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  smooth(ctx, messagePoints);
  ctx.stroke();
  ctx.strokeStyle = "#3ba55c";
  smooth(ctx, voicePoints);
  ctx.stroke();
  for (const dot of messagePoints) {
    ctx.beginPath();
    ctx.fillStyle = "#4c8dff";
    ctx.arc(dot.x, dot.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const dot of voicePoints) {
    ctx.beginPath();
    ctx.fillStyle = "#3ba55c";
    ctx.arc(dot.x, dot.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#8e9297";
  ctx.font = font(12, false);
  ctx.textAlign = "center";
  model.days.forEach((day, index) => {
    if (model.range === "24h" ? index % 2 : model.days.length > 8 && index % 2) return;
    const label = model.range === "24h"
      ? new Date(day.stamp).toLocaleString("en-US", { hour: "numeric", timeZone: "UTC" })
      : new Date(day.stamp).toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    ctx.fillText(label, messagePoints[index].x, plot.y + plot.h + 22);
  });

  ctx.textAlign = "left";
  ctx.fillStyle = "#ffffff";
  ctx.font = font(18, true);
  ctx.fillText("Top Channels", 688, 248);
  const colors = ["#5865f2", "#3ba55c", "#fee75c", "#eb459e", "#ed4245"];
  if (!model.channels.length) {
    ctx.fillStyle = "#8e9297";
    ctx.font = font(16, false);
    ctx.fillText("No activity in this lookback.", 688, 300);
  }
  model.channels.forEach((channel, index) => {
    const y = 292 + index * 48;
    ctx.beginPath();
    ctx.fillStyle = colors[index] || "#5865f2";
    ctx.arc(706, y, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = font(14, true);
    ctx.textAlign = "center";
    ctx.fillText(String(index + 1), 706, y + 1);
    ctx.textAlign = "left";
    ctx.font = font(16, false);
    ctx.fillText(String(channel.name).slice(0, 18), 730, y);
    ctx.textAlign = "right";
    ctx.fillText(String(channel.count), 988, y);
  });

  ctx.textAlign = "left";
  ctx.fillStyle = "#8e9297";
  ctx.font = font(13, false);
  ctx.fillText(`Server Lookback: ${model.rangeLabel}  •  Timezone: UTC`, 36, 590);
  return canvas.toBuffer("image/png");
}

function controls(ownerId, targetId, view, range, disabled = false) {
  if (disabled) {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`spanter:quick:on:${ownerId}`).setLabel("Enable Quick Stats").setStyle(ButtonStyle.Success)
    )];
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`spanter:quick:view:${ownerId}:${targetId}:${range}`)
    .setPlaceholder("Change view")
    .addOptions([
      { label: "Overview", value: "overview" },
      { label: "Messages", value: "messages" },
      { label: "Voice", value: "voice" }
    ]);
  const period = range === "24h" ? "24 hours" : "7 days";
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`spanter:quick:range:${ownerId}:${targetId}:${view}:${range}`).setEmoji({ name: "🕒" }).setLabel(period).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`spanter:quick:refresh:${ownerId}:${targetId}:${view}:${range}`).setEmoji({ name: "🔄" }).setLabel("Refresh").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`spanter:quick:off:${ownerId}`).setLabel("Disable Quick Stats").setStyle(ButtonStyle.Danger)
  );
  return [new ActionRowBuilder().addComponents(menu), buttons];
}

async function payloadFor(guild, member, user, view, range, ownerId, now) {
  const model = buildModel(guild, member, user, view, range, now);
  const buffer = await renderCard(model);
  return {
    content: "",
    embeds: [],
    files: [new AttachmentBuilder(buffer, { name: "quick-stats.png" })],
    components: controls(ownerId, user.id, model.view, model.range),
    attachments: [],
    allowedMentions: { parse: [] }
  };
}

function disabledPayload(ownerId) {
  return {
    content: "Quick stats are disabled.",
    embeds: [],
    files: [],
    attachments: [],
    components: controls(ownerId, "", "overview", "7d", true),
    allowedMentions: { parse: [] }
  };
}

async function resolveTarget(message, argument) {
  if (!argument) return { member: message.member, user: message.author };
  const member = await resolveMember(message, argument);
  if (member?.user) return { member, user: member.user };
  if (member?.id) return { member, user: member.user || { id: member.id, username: member.displayName } };
  const id = String(argument).replace(/[<@!>]/g, "");
  if (!/^\d{17,20}$/.test(id)) return null;
  const user = await message.client?.users?.fetch?.(id).catch(() => null);
  const cached = message.guild.members?.cache?.get?.(id) || null;
  return { member: cached, user: user || cached?.user || { id } };
}

async function show(message, argument, view = "overview", range = "7d") {
  if (isDisabled(message.guild.id, message.author.id)) return message.reply(disabledPayload(message.author.id));
  const target = await resolveTarget(message, argument);
  if (!target?.user?.id) return replyUsage(message, "u");
  if (target.user.bot) return message.reply({ content: "Pick a person, not a bot.", allowedMentions: { parse: [] } });
  return message.reply(await payloadFor(message.guild, target.member, target.user, view, range, message.author.id));
}

async function handleMessage(message) {
  return show(message, invocationTarget(message.content));
}

async function handleCommand(message, args) {
  return show(message, args[1]);
}

async function replace(interaction, payload) {
  const next = {
    content: payload.content ?? "",
    embeds: [],
    components: payload.components || [],
    files: payload.files || [],
    attachments: [],
    allowedMentions: { parse: [] }
  };
  if (!interaction.deferred && !interaction.replied && typeof interaction.update === "function") {
    return interaction.update(next);
  }
  if (typeof interaction.editReply === "function") {
    await interaction.editReply({ ...next, files: [] });
    if (next.files.length) return interaction.editReply(next);
    return null;
  }
  return interaction.reply(next);
}

async function handleInteraction(interaction) {
  const id = String(interaction.customId || "");
  if (!id.startsWith("spanter:quick:")) return false;
  const parts = id.split(":");
  const action = parts[2];
  const ownerId = parts[3];
  if (ownerId && interaction.user?.id && ownerId !== interaction.user.id) {
    await interaction.reply({ content: "Only the person who opened this can change it.", flags: 64 }).catch(() => null);
    return true;
  }
  if (action === "off") {
    setDisabled(interaction.guild.id, ownerId, true);
    await replace(interaction, disabledPayload(ownerId));
    return true;
  }
  if (action === "on") {
    setDisabled(interaction.guild.id, ownerId, false);
    const member = interaction.member;
    const user = interaction.user;
    await replace(interaction, await payloadFor(interaction.guild, member, user, "overview", "7d", ownerId));
    return true;
  }
  const targetId = parts[4];
  const member = interaction.guild.members?.cache?.get?.(targetId) || await interaction.guild.members?.fetch?.(targetId).catch(() => null);
  const user = member?.user || await interaction.client?.users?.fetch?.(targetId).catch(() => null) || { id: targetId };
  if (action === "view") {
    const selected = VIEWS.includes(interaction.values?.[0]) ? interaction.values[0] : "overview";
    const range = parts[5] || "7d";
    await replace(interaction, await payloadFor(interaction.guild, member, user, selected, range, ownerId));
    return true;
  }
  if (action === "range" || action === "refresh") {
    const view = parts[5] || "overview";
    const range = action === "range" && parts[6] === "7d" ? "24h" : action === "range" ? "7d" : (parts[6] || "7d");
    await replace(interaction, await payloadFor(interaction.guild, member, user, view, range, ownerId));
    return true;
  }
  return false;
}

module.exports = {
  isInvocation,
  handleMessage,
  handleCommand,
  handleInteraction,
  buildModel,
  renderCard,
  voiceCompact
};
