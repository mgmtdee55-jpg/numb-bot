const ACTION_COOLDOWNS_MS = {
  lock: 1000,
  unlock: 1000,
  ghost: 1000,
  unghost: 1000,
  kick: 1000,
  ban: 1000,
  unban: 1000,
  permit: 1000,
  claim: 30000,
  transfer: 3000,
  limit: 1000,
  interfaceRefresh: 3000
};

const cooldowns = new Map();

function cooldownKey(userId, channelId, action) {
  return `${userId}:${channelId}:${action}`;
}

function consumeActionCooldown(userId, channelId, action, now = Date.now()) {
  const durationMs = ACTION_COOLDOWNS_MS[action] ?? 1000;
  const key = cooldownKey(userId, channelId, action);
  const availableAt = cooldowns.get(key) || 0;
  if (now < availableAt) return availableAt - now;
  cooldowns.set(key, now + durationMs);
  return 0;
}

function clearActionCooldowns() {
  cooldowns.clear();
}

module.exports = {
  ACTION_COOLDOWNS_MS,
  consumeActionCooldown,
  clearActionCooldowns
};
