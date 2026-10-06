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
  rolestrip: 10000,
  stsu: 3000
};

const hits = new Map();

function consume(guildId, userId, action, now = Date.now()) {
  const duration = COOLDOWNS_MS[action];
  if (!duration) return 0;
  const key = `${guildId}:${userId}:${action}`;
  const until = hits.get(key) || 0;
  if (now < until) return until - now;
  hits.set(key, now + duration);
  if (hits.size > 5000) {
    for (const [entry, expires] of hits) {
      if (expires <= now) hits.delete(entry);
    }
  }
  return 0;
}

function waitText(ms) {
  return `Try again in **${Math.max(1, Math.ceil(ms / 1000))}** seconds.`;
}

module.exports = { COOLDOWNS_MS, consume, waitText };
