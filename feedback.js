const { EmbedBuilder } = require("discord.js");

const CONFIRM_ID = "1511840843198107839";
const ERROR_ID = "1511840844276039811";
const knownEmojis = new Map();
let loadingEmojis = Promise.resolve();
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

const APP_EMOJIS = [
  [CONFIRM_ID, "confirm"],
  [ERROR_ID, "error"]
];

async function registerApplicationEmojis(client) {
  if (!client.application?.emojis?.fetch || !client.application?.emojis?.create) return;
  await client.application.fetch?.();
  const emojis = await client.application.emojis.fetch();
  const owned = [...emojis.values()];
  for (const [sourceId, name] of APP_EMOJIS) {
    try {
      let emoji = owned.find((entry) => entry.name === name);
      if (!emoji) {
        const response = await fetch(`https://cdn.discordapp.com/emojis/${sourceId}.png?size=128&quality=lossless`);
        if (!response.ok) throw new Error(`image download returned ${response.status}`);
        const image = `data:image/png;base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
        emoji = await client.application.emojis.create({ attachment: image, name });
        owned.push(emoji);
      }
      knownEmojis.set(sourceId, emoji.toString());
    } catch (error) {
      console.error(`[emojis] could not register ${name}: ${error?.message || error}`);
    }
  }
}

async function loadEmojis(client) {
  loadingEmojis = (async () => {
    for (const guild of client.guilds?.cache?.values?.() || []) {
      const emojis = await guild.emojis?.fetch?.().catch(() => guild.emojis?.cache);
      emojis?.forEach?.((emoji) => {
        if (emoji?.id === CONFIRM_ID || emoji?.id === ERROR_ID) storeEmoji(emoji);
      });
    }
    await registerApplicationEmojis(client);
    console.log(`[emojis] confirm ${confirm()} | error ${errorMark()}`);
  })();
  return loadingEmojis;
}

function emojisLoaded() {
  return loadingEmojis;
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
  emojisLoaded,
  present,
  card,
  heading
};
