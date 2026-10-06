const { connection } = require("./db");
const { card } = require("./feedback");

const WELCOME_DELETE_MS = 30_000;

connection.exec(`
CREATE TABLE IF NOT EXISTS afk_status (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  since INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
`);

const readStatus = connection.prepare("SELECT status, since FROM afk_status WHERE guild_id=? AND user_id=?");
const writeStatus = connection.prepare(`
  INSERT INTO afk_status(guild_id, user_id, status, since) VALUES(?,?,?,?)
  ON CONFLICT(guild_id, user_id) DO UPDATE SET status=excluded.status, since=excluded.since
`);
const clearStatus = connection.prepare("DELETE FROM afk_status WHERE guild_id=? AND user_id=?");

function cleanStatus(text) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  return (cleaned || "AFK").slice(0, 180);
}

function isAfkCommand(content, prefix) {
  const text = String(content || "").trim().toLowerCase();
  const command = `${String(prefix || "-").toLowerCase()}afk`;
  return text === command || text.startsWith(`${command} `);
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(Number(ms) / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

function mentionedIds(message) {
  const ids = new Set();
  const users = message.mentions?.users;
  if (users && typeof users.values === "function") {
    for (const user of users.values()) if (user?.id) ids.add(String(user.id));
  }
  const members = message.mentions?.members;
  if (members && typeof members.forEach === "function") {
    members.forEach((member) => {
      if (member?.id) ids.add(String(member.id));
    });
  }
  const replied = message.mentions?.repliedUser;
  if (replied?.id) ids.add(String(replied.id));
  return ids;
}

function replyCard(message, sentence, options = {}) {
  return message.reply({
    embeds: [card(null, sentence, { guild: message.guild, sentence: true, ...options })],
    allowedMentions: options.allowedMentions
  });
}

async function setAway(message, rawStatus) {
  const status = cleanStatus(rawStatus);
  writeStatus.run(message.guild.id, message.author.id, status, Date.now());
  return replyCard(message, `You've been set as **Away** with the status: **${status}**`, {
    allowedMentions: { parse: [] }
  });
}

async function welcomeBack(message, since) {
  const duration = formatDuration(Date.now() - Number(since));
  const sent = await replyCard(
    message,
    `Welcome back <@${message.author.id}>, you were Away for: **${duration}**`,
    { mark: "👋", allowedMentions: { users: [message.author.id] } }
  );
  if (sent && typeof sent.delete === "function") {
    const timer = setTimeout(() => {
      sent.delete().catch(() => null);
    }, WELCOME_DELETE_MS);
    timer.unref?.();
  }
  return sent;
}

async function observe(message, prefix) {
  if (!message.guild || message.author?.bot) return;
  const guildId = message.guild.id;
  const authorId = String(message.author.id);
  if (!isAfkCommand(message.content, prefix)) {
    const away = readStatus.get(guildId, authorId);
    if (away) {
      clearStatus.run(guildId, authorId);
      await welcomeBack(message, away.since);
    }
  }
  const lines = [];
  for (const id of mentionedIds(message)) {
    if (id === authorId) continue;
    const away = readStatus.get(guildId, id);
    if (!away) continue;
    const duration = formatDuration(Date.now() - Number(away.since));
    lines.push(`<@${id}> is Away with the status: **${away.status}**\nAway for: **${duration}**`);
  }
  if (!lines.length) return;
  await replyCard(message, lines.join("\n\n"), {
    allowedMentions: { parse: [], repliedUser: true }
  });
}

module.exports = {
  WELCOME_DELETE_MS,
  setAway,
  observe,
  isAfkCommand,
  formatDuration
};
