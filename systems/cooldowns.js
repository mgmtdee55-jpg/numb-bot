const COOLDOWNS_MS = {
  nuke: 25000,
  lockall: 10000,
  unlockall: 10000,
  lockdown: 10000,
  unlockdown: 10000,
  dragall: 8000,
  muteall: 8000,
  unmuteall: 8000,
  unbanall: 15000,
  rolestrip: 20000,
  forcenickname: 20000,
  unforcenickname: 20000,
  forcerolestrip: 20000,
  unforcerolestrip: 20000,
  stsu: 3000
};

const hits = new Map();

const COMMAND_GAP_MS = 2000;
const PROFILE_GAP_MS = 10000;
const PROFILE_COMMANDS = new Set(["instagram", "ig", "insta", "tiktok", "roblox"]);

function keyFor(guildId, userId, action) {
  return `${guildId}:${userId}:${action}`;
}

function prune(now) {
  if (hits.size <= 5000) return;
  for (const [entry, expires] of hits) {
    if (expires <= now) hits.delete(entry);
  }
}

function peek(guildId, userId, action, now = Date.now()) {
  const until = hits.get(keyFor(guildId, userId, action)) || 0;
  return now < until ? until - now : 0;
}

function take(guildId, userId, action, durationMs, now = Date.now()) {
  const key = keyFor(guildId, userId, action);
  const until = hits.get(key) || 0;
  if (now < until) return until - now;
  if (durationMs > 0) hits.set(key, now + durationMs);
  prune(now);
  return 0;
}

function commandKey(name) {
  const command = String(name || "").toLowerCase();
  if (command === "ig" || command === "insta") return "instagram";
  return command;
}

function commandPause(guildId, userId, name, now = Date.now()) {
  const command = commandKey(name);
  if (!command || PROFILE_COMMANDS.has(command) || PROFILE_COMMANDS.has(String(name || "").toLowerCase())) return 0;
  if ((COOLDOWNS_MS[command] || 0) >= COMMAND_GAP_MS) return 0;
  return take(guildId, userId, `cmd:${command}`, COMMAND_GAP_MS, now);
}

function lookupPause(guildId, userId, name, cached, now = Date.now()) {
  const command = commandKey(name);
  const commandWait = peek(guildId, userId, `cmd:${command}`, now);
  const profileWait = cached ? 0 : peek(guildId, userId, "profile", now);
  const wait = Math.max(commandWait, profileWait);
  if (wait) return wait;
  take(guildId, userId, `cmd:${command}`, COMMAND_GAP_MS, now);
  if (!cached) take(guildId, userId, "profile", PROFILE_GAP_MS, now);
  return 0;
}

function consume(guildId, userId, action, now = Date.now()) {
  const duration = COOLDOWNS_MS[action];
  if (!duration) return 0;
  return take(guildId, userId, action, duration, now);
}

function waitText(ms) {
  return `Try again in **${Math.max(1, Math.ceil(ms / 1000))}** seconds.`;
}

module.exports = {
  COOLDOWNS_MS,
  COMMAND_GAP_MS,
  PROFILE_GAP_MS,
  consume,
  peek,
  take,
  commandPause,
  lookupPause,
  waitText,
  clear() {
    hits.clear();
  }
};
