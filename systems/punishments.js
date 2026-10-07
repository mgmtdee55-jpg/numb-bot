const { AuditLogEvent } = require("discord.js");
const db = require("../db");
const access = require("./access");
const { sendLog } = require("./logs");

const AUDIT_WINDOW_MS = 20000;
const BAN_ACTIONS = new Set(["ban", "hardban", "foreverban", "softban", "tempban"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function auditEntry(guild, type, targetId, changeKey) {
  if (typeof guild.fetchAuditLogs !== "function") return null;
  const logs = await guild.fetchAuditLogs({ type, limit: 6 }).catch(() => null);
  const entries = logs?.entries?.values?.() || [];
  const now = Date.now();
  for (const entry of entries) {
    if (String(entry.targetId) !== String(targetId)) continue;
    if (now - (entry.createdTimestamp || 0) > AUDIT_WINDOW_MS) continue;
    if (changeKey && !(entry.changes || []).some((change) => change.key === changeKey)) continue;
    return entry;
  }
  return null;
}

function recentBan(guildId, userId) {
  return db.getBanHistoryForUser(guildId, userId).find((row) =>
    BAN_ACTIONS.has(row.action) && Date.now() - row.created_at < AUDIT_WINDOW_MS
  ) || null;
}

function enforcedBan(guildId, userId) {
  const hardban = db.getHardban(guildId, userId);
  if (hardban) return { ...hardban, action: "hardban" };
  const foreverban = db.getForeverban(guildId, userId);
  if (foreverban) return { ...foreverban, action: "foreverban" };
  return null;
}

function banTitle(action) {
  if (action === "hardban") return "Hardban";
  if (action === "foreverban") return "Foreverban";
  if (action === "softban") return "Softban";
  if (action === "tempban") return "Tempban";
  return "Ban";
}

function punishmentText({ userId, moderatorId, reason, when, extra }) {
  const unix = Math.floor((when || Date.now()) / 1000);
  return [
    `**User:** <@${userId}> (\`${userId}\`)`,
    `**Moderator:** ${moderatorId ? `<@${moderatorId}> (\`${moderatorId}\`)` : "Unknown"}`,
    `**Reason:** ${String(reason || "No reason provided").slice(0, 900)}`,
    extra,
    `**When:** <t:${unix}:F> (<t:${unix}:R>)`
  ].filter(Boolean).join("\n");
}

async function postPunishment(guild, title, userId, details) {
  return sendLog(guild, access.PUNISHMENT_LOG, punishmentText({ userId, ...details }), title);
}

async function logBan(guild, userId, options = {}) {
  if (options.wait !== 0) await sleep(options.wait ?? 1200);
  const recent = recentBan(guild.id, userId);
  const saved = recent || enforcedBan(guild.id, userId);
  const entry = await auditEntry(guild, AuditLogEvent.MemberBanAdd, userId);
  return postPunishment(guild, banTitle(saved?.action), userId, {
    moderatorId: saved?.moderator_id || entry?.executorId || entry?.executor?.id || null,
    reason: saved?.reason || entry?.reason,
    when: recent?.created_at || entry?.createdTimestamp || Date.now()
  });
}

async function logKick(guild, userId, options = {}) {
  if (options.wait !== 0) await sleep(options.wait ?? 1200);
  let entry = await auditEntry(guild, AuditLogEvent.MemberKick, userId);
  if (!entry && options.wait !== 0) {
    await sleep(1500);
    entry = await auditEntry(guild, AuditLogEvent.MemberKick, userId);
  }
  if (!entry) return false;
  return postPunishment(guild, "Kick", userId, {
    moderatorId: entry.executorId || entry.executor?.id || null,
    reason: entry.reason,
    when: entry.createdTimestamp
  });
}

async function logTimeout(guild, userId, untilTimestamp, cleared, options = {}) {
  if (options.wait !== 0) await sleep(options.wait ?? 1200);
  const entry = await auditEntry(guild, AuditLogEvent.MemberUpdate, userId, "communication_disabled_until");
  const until = Number(untilTimestamp) > Date.now()
    ? `**Until:** <t:${Math.floor(untilTimestamp / 1000)}:F> (<t:${Math.floor(untilTimestamp / 1000)}:R>)`
    : null;
  return postPunishment(guild, cleared ? "Timeout cleared" : "Timeout", userId, {
    moderatorId: entry?.executorId || entry?.executor?.id || null,
    reason: entry?.reason,
    when: entry?.createdTimestamp,
    extra: cleared ? null : until
  });
}

async function logUnban(guild, userId, options = {}) {
  if (options.wait !== 0) await sleep(options.wait ?? 1200);
  const entry = await auditEntry(guild, AuditLogEvent.MemberBanRemove, userId);
  return postPunishment(guild, "Unban", userId, {
    moderatorId: entry?.executorId || entry?.executor?.id || null,
    reason: entry?.reason,
    when: entry?.createdTimestamp
  });
}

module.exports = { logBan, logKick, logTimeout, logUnban };
