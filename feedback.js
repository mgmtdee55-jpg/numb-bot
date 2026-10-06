const { EmbedBuilder } = require("discord.js");

const CONFIRM_ID = "1557010270428078200";
const ERROR_ID = "1557010271753736214";
const knownEmojis = new Map();
const OK_COLOR = 0x57f287;
const ERROR_COLOR = 0xed4245;

const PLAIN_TITLES = new Set([
  "user info",
  "server info",
  "avatar",
  "banner",
  "voice chat stats",
  "staff registry",
  "vc rank",
  "vc ranks",
  "godmode",
  "godmode status",
  "management",
  "role limits",
  "vouch limits",
  "anti-nuke admins",
  "antinuke",
  "vouch blacklist",
  "limited roles",
  "active vouches",
  "vouch",
  "force management",
  "mod setup",
  "voicemaster setup",
  "voicemaster",
  "already configured",
  "commands"
]);

function storeEmoji(emoji) {
  if (!emoji?.id || typeof emoji.toString !== "function") return;
  knownEmojis.set(String(emoji.id), emoji.toString());
}

function findEmoji(guild, id) {
  const client = guild?.client;
  return guild?.emojis?.cache?.get?.(id)
    || client?.application?.emojis?.cache?.get?.(id)
    || [...(client?.guilds?.cache?.values?.() || [])]
      .map((entry) => entry.emojis?.cache?.get?.(id))
      .find(Boolean)
    || null;
}

async function loadEmojis(client) {
  try {
    await client.application?.fetch?.();
    const emojis = await client.application?.emojis?.fetch?.();
    emojis?.forEach?.(storeEmoji);
  } catch (error) {
    console.error("[emojis]", error);
  }
  for (const guild of client.guilds?.cache?.values?.() || []) {
    guild.emojis?.cache?.forEach?.(storeEmoji);
  }
}

function customEmoji(guild, id, name) {
  const saved = knownEmojis.get(String(id));
  if (saved) return saved;
  const found = findEmoji(guild, id);
  if (found?.toString) {
    const text = found.toString();
    knownEmojis.set(String(id), text);
    return text;
  }
  return `<:${name}:${id}>`;
}

function confirm(guild) {
  return customEmoji(guild, CONFIRM_ID, "confirm");
}

function errorMark(guild) {
  return customEmoji(guild, ERROR_ID, "error");
}

function isErrorTitle(title) {
  const name = String(title || "").trim().toLowerCase();
  if (!name) return false;
  if (/^(not|no|invalid|missing|unable|unavailable|usage|unknown|owner only|please wait|temporarily|rank required|server owner|access denied|already|cannot|can't|failed|blocked|protected|ambiguous|expired|join a|nothing)\b/.test(name)) {
    return true;
  }
  return /\bnot\b|required|failed|reached|rate limit|needs attention|denied|blacklisted|unavailable|in progress/.test(name);
}

function inferTone(title, description) {
  const name = String(title || "").trim().toLowerCase();
  const body = String(description || "").trim();
  if (/^(use `|`)/i.test(body)) return "error";
  if (PLAIN_TITLES.has(name)) return "plain";
  if (isErrorTitle(name)) return "error";
  return "ok";
}

function present(title, description, options = {}) {
  const text = String(description || "");
  if (text.includes(CONFIRM_ID) || text.includes(ERROR_ID)) return text.slice(0, 4000);
  const tone = options.tone || inferTone(title, text);
  if (tone === "plain") return text.slice(0, 4000);
  const emoji = tone === "error" ? errorMark(options.guild) : confirm(options.guild);
  return `${emoji}${text ? ` ${text}` : ""}`.slice(0, 4000);
}

function card(title, description, options = {}) {
  let tone = options.tone || inferTone(title, description);
  if (tone === "plain") tone = "ok";
  const color = tone === "error" ? ERROR_COLOR : OK_COLOR;
  const mark = options.mark || (tone === "error" ? errorMark(options.guild) : confirm(options.guild));
  const body = String(description || "").trim();
  const marked = body.includes(CONFIRM_ID) || body.includes(ERROR_ID) || (options.mark && body.startsWith(options.mark));
  let text;
  if (options.sentence) {
    text = marked ? body : `${mark} ${body}`;
  } else if (title && body) {
    text = `${mark} **${title}**\n${body}`;
  } else if (title) {
    text = `${mark} **${title}**`;
  } else {
    text = marked ? body : `${mark}${body ? ` ${body}` : ""}`;
  }
  return new EmbedBuilder().setColor(color).setDescription(text.slice(0, 4000));
}

function heading(embed) {
  const data = embed?.data || embed || {};
  if (data.title) return data.title;
  const match = String(data.description || "").match(/\*\*([^*]+)\*\*/);
  return match ? match[1] : "";
}

module.exports = {
  CONFIRM_ID,
  ERROR_ID,
  OK_COLOR,
  ERROR_COLOR,
  confirm,
  errorMark,
  loadEmojis,
  present,
  card,
  heading
};
