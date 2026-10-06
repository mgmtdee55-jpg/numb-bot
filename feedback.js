const CONFIRM_ID = "1511840843198107839";
const ERROR_ID = "1511840844276039811";

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

function customEmoji(guild, id, name) {
  const cached = guild?.emojis?.cache?.get?.(id);
  if (cached && typeof cached.toString === "function") return cached.toString();
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

module.exports = {
  CONFIRM_ID,
  ERROR_ID,
  confirm,
  errorMark,
  present
};
