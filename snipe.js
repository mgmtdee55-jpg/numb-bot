const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");
const { connection } = require("./db");
const { reply } = require("./vouch/ui");

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const CACHE_LIMIT = 8000;
const recent = new Map();

connection.exec(`
CREATE TABLE IF NOT EXISTS snipes (
  message_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT,
  author_avatar TEXT,
  content TEXT,
  attachment TEXT,
  deleted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snipes_lookup ON snipes(guild_id, channel_id, deleted_at);
`);

const statements = {
  save: connection.prepare(`
    INSERT OR IGNORE INTO snipes(
      message_id, guild_id, channel_id, author_id, author_name, author_avatar, content, attachment, deleted_at
    ) VALUES(?,?,?,?,?,?,?,?,?)
  `),
  list: connection.prepare(`
    SELECT * FROM snipes
    WHERE guild_id=? AND channel_id=? AND deleted_at>=?
    ORDER BY deleted_at DESC, message_id DESC
  `),
  clear: connection.prepare("DELETE FROM snipes WHERE guild_id=? AND channel_id=?"),
  prune: connection.prepare("DELETE FROM snipes WHERE deleted_at<?")
};

function prune(now = Date.now()) {
  statements.prune.run(now - TWO_HOURS_MS);
}

function remember(message) {
  if (!message?.id || !message.guild || message.author?.bot) return;
  const attachment = attachmentOf(message);
  recent.set(message.id, {
    guildId: message.guild.id,
    channelId: message.channelId,
    authorId: message.author.id,
    authorName: message.author.username || message.author.tag || "unknown",
    authorAvatar: typeof message.author.displayAvatarURL === "function"
      ? message.author.displayAvatarURL({ size: 128 })
      : null,
    content: String(message.content || ""),
    attachment
  });
  while (recent.size > CACHE_LIMIT) {
    const oldest = recent.keys().next().value;
    recent.delete(oldest);
  }
}

function attachmentOf(message) {
  const files = message.attachments?.values ? [...message.attachments.values()] : [];
  if (!files.length) return null;
  const image = files.find((file) => isImage(file));
  const file = image || files[0];
  return file.url || file.proxyURL || null;
}

function isImage(file) {
  const name = `${file.contentType || ""} ${file.name || ""} ${file.url || ""}`;
  return /image\/|png|jpe?g|gif|webp/i.test(name);
}

function snapshot(message) {
  const cached = recent.get(message.id) || null;
  const author = message.author || null;
  if ((author && author.bot) || (!author && !cached)) return null;
  const content = message.content || cached?.content || "";
  const attachment = attachmentOf(message) || cached?.attachment || null;
  if (!String(content).trim() && !attachment) return null;
  const guildId = message.guild?.id || message.guildId || cached?.guildId;
  const channelId = message.channelId || cached?.channelId;
  const authorId = author?.id || cached?.authorId;
  if (!guildId || !channelId || !authorId) return null;
  return {
    messageId: message.id,
    guildId,
    channelId,
    authorId,
    authorName: author?.username || cached?.authorName || "unknown",
    authorAvatar: (typeof author?.displayAvatarURL === "function" && author.displayAvatarURL({ size: 128 })) || cached?.authorAvatar || null,
    content: String(content).slice(0, 4000),
    attachment,
    deletedAt: Date.now()
  };
}

function record(entry) {
  if (!entry?.messageId || !entry.guildId || !entry.channelId || !entry.authorId) return false;
  prune(entry.deletedAt || Date.now());
  statements.save.run(
    String(entry.messageId),
    String(entry.guildId),
    String(entry.channelId),
    String(entry.authorId),
    entry.authorName || "unknown",
    entry.authorAvatar || null,
    entry.content || "",
    entry.attachment || null,
    entry.deletedAt || Date.now()
  );
  recent.delete(entry.messageId);
  return true;
}

function capture(message) {
  const entry = snapshot(message);
  if (!entry) return false;
  return record(entry);
}

function captureMany(messages) {
  for (const message of messages?.values?.() || []) capture(message);
}

function list(guildId, channelId, now = Date.now()) {
  prune(now);
  return statements.list.all(String(guildId), String(channelId), now - TWO_HOURS_MS);
}

function clear(guildId, channelId) {
  return statements.clear.run(String(guildId), String(channelId)).changes;
}

function page(guildId, channelId, index = 0) {
  const rows = list(guildId, channelId);
  if (!rows.length) {
    return {
      embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle("Snipe").setDescription("No deleted messages in this channel from the last 2 hours.")],
      components: [],
      allowedMentions: { parse: [] }
    };
  }
  const safe = Math.min(Math.max(rows.length - 1, 0), Math.max(0, Number(index) || 0));
  const entry = rows[safe];
  const lines = [`<@${entry.author_id}>`];
  if (entry.content) lines.push("", entry.content);
  else if (!isImage({ url: entry.attachment })) lines.push("", entry.attachment);
  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setAuthor(entry.author_avatar
      ? { name: entry.author_name || "Deleted message", iconURL: entry.author_avatar }
      : { name: entry.author_name || "Deleted message" })
    .setDescription(lines.join("\n").slice(0, 4096))
    .setFooter({ text: `Page ${safe + 1} / ${rows.length}` })
    .setTimestamp(entry.deleted_at);
  if (entry.attachment && isImage({ url: entry.attachment })) embed.setImage(entry.attachment);
  const components = [];
  if (rows.length > 1) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`spanter:snipe:${safe - 1}`).setLabel("Back").setStyle(ButtonStyle.Secondary).setDisabled(safe <= 0),
      new ButtonBuilder().setCustomId(`spanter:snipe:${safe + 1}`).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(safe >= rows.length - 1)
    ));
  }
  return { embeds: [embed], components, allowedMentions: { parse: [] } };
}

async function handleCommand(message, name) {
  if (name === "clearsnipe" || name === "cs") {
    const removed = clear(message.guild.id, message.channel.id);
    return reply(message, "Snipe Cleared", removed ? `Forgot **${removed}** deleted message${removed === 1 ? "" : "s"} in this channel.` : "There was no snipe history in this channel.");
  }
  if (name === "snipe" || name === "s") {
    return message.reply(page(message.guild.id, message.channel.id, 0));
  }
  return false;
}

async function handleButton(interaction) {
  const id = interaction.customId || "";
  if (!id.startsWith("spanter:snipe:")) return false;
  const index = Number(id.slice("spanter:snipe:".length));
  await interaction.update(page(interaction.guild.id, interaction.channelId, index));
  return true;
}

module.exports = {
  TWO_HOURS_MS,
  remember,
  capture,
  captureMany,
  record,
  list,
  clear,
  page,
  handleCommand,
  handleButton
};
