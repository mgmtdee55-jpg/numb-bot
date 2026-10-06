function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSnowflake(value) {
  return /^\d{17,20}$/.test(String(value || ""));
}

function cleanReason(value) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (!text) return null;
  return text.slice(0, 400);
}

function discordTime(ms) {
  const stamp = Number(ms);
  if (!Number.isFinite(stamp)) return "unknown time";
  return `<t:${Math.floor(stamp / 1000)}:f>`;
}

function pageOf(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return 1;
  return number;
}

function parseLimit(value, max) {
  if (!/^\d+$/.test(String(value ?? "").trim())) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number > max) return null;
  return number;
}

function mentionUser(id) {
  return id ? `<@${id}>` : "unknown";
}

function mentionRole(id) {
  return id ? `<@&${id}>` : "not set";
}

module.exports = {
  sleep,
  isSnowflake,
  cleanReason,
  discordTime,
  pageOf,
  parseLimit,
  mentionUser,
  mentionRole
};
