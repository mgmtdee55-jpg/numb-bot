const { AuditLogEvent } = require("discord.js");
const store = require("./store");
const systemStore = require("../systems/store");
const authority = require("./authority");
const logging = require("./logging");
const roles = require("./roles");
const { sleep } = require("./util");
const { logThrottledError } = require("../log-throttle");

const locks = new Map();
const incidents = new Map();
const punishAt = new Map();
const INCIDENT_MS = 6000;
const PUNISH_MS = 4000;
const AUDIT_WINDOW_MS = 20000;
let auditDelays = [0, 500, 1200];

function resetRuntime() {
  locks.clear();
  incidents.clear();
  punishAt.clear();
  roles.resetMarks();
  auditDelays = [0, 500, 1200];
}

function setAuditDelays(delays) {
  auditDelays = delays;
}

function pruneTimed(map, now, ttl) {
  if (map.size < 3000) return;
  for (const [key, stamp] of map) {
    if (now - stamp > ttl) map.delete(key);
  }
}

function withLock(key, work) {
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate, () => gate);
  locks.set(key, tail);
  return previous.then(async () => {
    try {
      return await work();
    } finally {
      release();
      if (locks.get(key) === tail) locks.delete(key);
    }
  }, async () => {
    try {
      return await work();
    } finally {
      release();
      if (locks.get(key) === tail) locks.delete(key);
    }
  });
}

function claimIncident(signature) {
  const now = Date.now();
  pruneTimed(incidents, now, INCIDENT_MS);
  const previous = incidents.get(signature) || 0;
  if (now - previous < INCIDENT_MS) return false;
  incidents.set(signature, now);
  return true;
}

function releaseIncident(signature) {
  incidents.delete(signature);
}

function claimPunishment(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  pruneTimed(punishAt, now, PUNISH_MS);
  const previous = punishAt.get(key) || 0;
  if (now - previous < PUNISH_MS) return false;
  punishAt.set(key, now);
  return true;
}

function diffRoleIds(oldMember, newMember) {
  const before = new Set(oldMember.roles.cache.keys());
  const after = new Set(newMember.roles.cache.keys());
  const guildId = newMember.guild.id;
  const added = [...after].filter((id) => id !== guildId && !before.has(id));
  const removed = [...before].filter((id) => id !== guildId && !after.has(id));
  return { added, removed };
}

function changeRoleIds(change) {
  const value = change?.new ?? change?.new_value ?? change?.old ?? [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => (item && typeof item === "object" ? item.id : item)).filter(Boolean);
}

function entryList(logs) {
  if (!logs?.entries) return [];
  if (typeof logs.entries.values === "function") return [...logs.entries.values()];
  if (Array.isArray(logs.entries)) return logs.entries;
  return [];
}

function pickEntry(logs, userId, roleIds) {
  const now = Date.now();
  const matches = entryList(logs).filter((entry) => {
    const targetId = entry.targetId || entry.target?.id;
    if (targetId !== userId) return false;
    if (!entry.createdTimestamp || now - entry.createdTimestamp > AUDIT_WINDOW_MS) return false;
    const ids = new Set((entry.changes || []).flatMap(changeRoleIds));
    return [...roleIds].some((roleId) => ids.has(roleId));
  });
  matches.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
  return matches[0] || null;
}

async function findExecutor(guild, userId, roleIds) {
  if (!roleIds.length || typeof guild.fetchAuditLogs !== "function") return null;
  for (const delay of auditDelays) {
    if (delay) await sleep(delay);
    let logs;
    try {
      logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 6 });
    } catch (error) {
      logThrottledError(`vouch-audit:${guild.id}`, `[vouch audit] ${guild.id}`, error);
      return null;
    }
    const entry = pickEntry(logs, userId, roleIds);
    if (!entry) continue;
    const executor = entry.executor || (entry.executorId ? { id: entry.executorId } : null);
    if (executor?.id) return executor;
  }
  return null;
}

async function resolveActor(guild, executor) {
  if (!executor?.id) return null;
  if (executor.bot || executor.id === guild.client?.user?.id) {
    return { id: executor.id, bot: true, member: null };
  }
  const member = guild.members.cache.get(executor.id) || await guild.members.fetch(executor.id).catch(() => null);
  if (!member) return { id: executor.id, bot: false, unknown: true, member: null };
  if (member.user?.bot) return { id: executor.id, bot: true, member };
  return { id: executor.id, bot: false, member };
}

async function stripStaff(member, context = {}) {
  if (authority.isStripstaffExempt(member)) return { exempt: true, removed: [] };
  const config = store.getConfig(member.guild.id);
  const removable = [];
  for (const role of member.roles.cache.values()) {
    if (!role || role.managed || role.id === member.guild.id) continue;
    const legacy = config.stripstaff_role_id && role.id === config.stripstaff_role_id;
    if (!legacy && !roles.roleGrantsStaff(role)) continue;
    if (!roles.botCanManageRole(member.guild, role)) continue;
    removable.push(role);
  }
  const ids = [...new Set(removable.map((role) => role.id))];
  if (ids.length) await roles.removeRoles(member, ids, "STRIPSTAFF");
  if (config.vouch_role_id && ids.includes(config.vouch_role_id)) {
    store.deactivateVouch(member.guild.id, member.id, member.guild.client?.user?.id || null, "STRIPSTAFF");
  }
  const reason = context.reason || "STRIPSTAFF";
  store.addPunishment({
    guildId: member.guild.id,
    userId: member.id,
    type: "STRIPSTAFF",
    reason,
    actorId: context.actorId || member.guild.client?.user?.id || null,
    removedRoles: JSON.stringify(ids),
    automatic: context.automatic !== false
  });
  await logging.record(member.guild, {
    action: "stripstaff",
    actorId: member.guild.client?.user?.id || context.actorId || null,
    targetId: member.id,
    reason,
    automatic: true,
    details: { removedRoleIds: ids, trigger: context.trigger || null }
  });
  return { exempt: false, removed: ids };
}

async function enforceNickname(oldMember, newMember) {
  if (newMember.user?.bot) return;
  const forced = store.getForcedNick(newMember.guild.id, newMember.id);
  if (!forced) return;
  const current = newMember.nickname ?? null;
  if (current === forced.nickname) {
    roles.consumeNick(newMember.guild.id, newMember.id, forced.nickname);
    return;
  }
  if (roles.consumeNick(newMember.guild.id, newMember.id, current)) return;
  try {
    await roles.applyNickname(newMember, forced.nickname, "Restore forced nickname");
  } catch (error) {
    logThrottledError(`vouch-nick:${newMember.guild.id}:${newMember.id}`, `[forced nickname] ${newMember.id}`, error);
  }
}

async function enforceRoles(oldMember, newMember) {
  const guild = newMember.guild;
  const { added, removed } = diffRoleIds(oldMember, newMember);
  if (!added.length && !removed.length) return;

  const signature = `${guild.id}:${newMember.id}:add:${[...added].sort().join(",")}:rem:${[...removed].sort().join(",")}`;
  if (!claimIncident(signature)) return;

  try {
    const realAdded = added.filter((roleId) => !roles.consumeRole(guild.id, newMember.id, roleId, "add"));
    const realRemoved = removed.filter((roleId) => !roles.consumeRole(guild.id, newMember.id, roleId, "remove"));
    if (!realAdded.length && !realRemoved.length) return;

    const config = store.getConfig(guild.id);
    const vouchRoleId = config.vouch_role_id;
    const voiceRoleIds = new Set(systemStore.voiceRoleIds(guild.id));
    const toRemove = [];
    const toAdd = [];
    const violations = [];

    for (const roleId of realAdded) {
      if (store.isRoleStripped(guild.id, newMember.id, roleId)) {
        toRemove.push(roleId);
        if (vouchRoleId === roleId) {
          store.deactivateVouch(guild.id, newMember.id, guild.client?.user?.id || null, "Forced role strip");
        }
        violations.push({ action: "force_role_strip", roleId, reason: "Blocked role was added" });
        continue;
      }
      const limit = store.getLimitedRole(guild.id, roleId);
      if (limit && roles.countMembersWithRole(guild, roleId, newMember) > limit.max_members) {
        toRemove.push(roleId);
        if (vouchRoleId === roleId) {
          store.deactivateVouch(guild.id, newMember.id, guild.client?.user?.id || null, "Limited role");
        }
        violations.push({
          action: "limited_role_violation",
          roleId,
          reason: `Role exceeded its limit of ${limit.max_members}`
        });
        continue;
      }
      if (voiceRoleIds.has(roleId)) {
        toRemove.push(roleId);
        violations.push({ action: "voice_rank_reversed", roleId, reason: "Voice rank roles can only be assigned with the bot" });
        continue;
      }
      if (vouchRoleId && roleId === vouchRoleId && store.isBlacklisted(guild.id, newMember.id)) {
        toRemove.push(roleId);
        if (store.getActiveVouch(guild.id, newMember.id)) {
          store.deactivateVouch(guild.id, newMember.id, guild.client?.user?.id || null, "Vouch blacklist");
        }
        violations.push({ action: "blacklist_role", roleId, reason: "Blacklisted member cannot hold the vouch role" });
        continue;
      }
      if (vouchRoleId && roleId === vouchRoleId && !store.getActiveVouch(guild.id, newMember.id)) {
        toRemove.push(roleId);
        violations.push({ action: "unauthorized_role_add", roleId, reason: "Vouch role added without an active vouch" });
      }
    }

    for (const roleId of realRemoved) {
      if (voiceRoleIds.has(roleId)) {
        const expected = systemStore.roleIdForRank(guild.id, systemStore.getRank(guild.id, newMember.id)?.rank_key);
        if (expected === roleId) {
          toAdd.push(roleId);
          violations.push({ action: "voice_rank_restored", roleId, reason: "Voice rank role removed outside the bot" });
        }
        continue;
      }
      if (!vouchRoleId || roleId !== vouchRoleId) continue;
      if (!store.getActiveVouch(guild.id, newMember.id)) continue;
      if (store.isRoleStripped(guild.id, newMember.id, roleId)) continue;
      toAdd.push(roleId);
      violations.push({ action: "unauthorized_role_remove", roleId, reason: "Vouch role removed from a vouched user" });
    }

    if (!toRemove.length && !toAdd.length) return;

    const executor = await findExecutor(guild, newMember.id, [...toRemove, ...toAdd]);
    const actor = await resolveActor(guild, executor);
    const human = actor?.member && !actor.bot && !actor.unknown ? actor.member : null;
    const exempt = !human || authority.isStripstaffExempt(human);
    const punish = !!human && !exempt;

    for (const roleId of [...new Set(toRemove)]) {
      try {
        await roles.removeRole(newMember, roleId, "Vouch protection reversed an unauthorized role");
      } catch (error) {
        logThrottledError(`vouch-revert:${guild.id}:${roleId}`, `[vouch revert] ${roleId}`, error);
      }
    }
    for (const roleId of [...new Set(toAdd)]) {
      try {
        await roles.addRole(newMember, roleId, "Vouch protection restored a protected role");
        await logging.record(guild, {
          action: "role_restore",
          actorId: guild.client?.user?.id || null,
          targetId: newMember.id,
          reason: "Restored the vouch role after an unauthorized removal",
          automatic: true,
          details: { roleId, executorId: actor?.id || null }
        });
      } catch (error) {
        logThrottledError(`vouch-restore:${guild.id}:${roleId}`, `[vouch restore] ${roleId}`, error);
      }
    }

    for (const violation of violations) {
      await logging.record(guild, {
        action: violation.action,
        actorId: actor?.id || null,
        targetId: newMember.id,
        reason: violation.reason,
        automatic: true,
        details: { roleId: violation.roleId, executorKnown: !!actor, exempt }
      });
    }

    if (punish && claimPunishment(guild.id, human.id)) {
      const reason = violations.map((item) => item.reason).join("; ");
      await stripStaff(human, {
        reason,
        automatic: true,
        actorId: guild.client?.user?.id || null,
        trigger: actor.id
      });
    }
  } catch (error) {
    releaseIncident(signature);
    throw error;
  }
}

async function handleGuildMemberUpdate(oldMember, newMember) {
  if (!newMember?.guild || !oldMember?.roles?.cache || !newMember?.roles?.cache) return;
  if (oldMember.partial || newMember.partial) return;
  const key = `${newMember.guild.id}:${newMember.id}`;
  return withLock(key, async () => {
    await enforceNickname(oldMember, newMember);
    await enforceRoles(oldMember, newMember);
  });
}

module.exports = {
  handleGuildMemberUpdate,
  stripStaff,
  resetRuntime,
  setAuditDelays,
  claimPunishment
};
