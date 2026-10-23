const { AuditLogEvent, ChannelType, PermissionFlagsBits, Routes } = require("discord.js");
const store = require("./store");
const { whenLine } = require("../systems/logs");

const STALE_MS = 15000;
const DANGEROUS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageWebhooks
].filter((bit) => typeof bit === "bigint");
const ADMIN = PermissionFlagsBits.Administrator;

const seen = new Set();
const buckets = new Map();
const lanes = new Map();
const emptyVoice = new Map();
const occupiedVoice = new Map();
const destructiveAt = new Map();
const botStrikes = new Map();
const ownWrites = new Map();
const restoreCooldown = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function claim(id) {
  const key = String(id || "");
  if (!key || seen.has(key)) return false;
  seen.add(key);
  if (seen.size > 4000) {
    const drop = [...seen].slice(0, 1000);
    for (const item of drop) seen.delete(item);
  }
  return true;
}

function hit(guildId, executorId, kind, at, seconds) {
  const key = `${guildId}:${executorId}:${kind}`;
  const windowMs = seconds * 1000;
  const list = (buckets.get(key) || []).filter((stamp) => at - stamp < windowMs);
  list.push(at);
  buckets.set(key, list);
  return list.length;
}

function enqueue(guildId, job) {
  const previous = lanes.get(guildId) || Promise.resolve();
  const run = previous.then(job, job);
  lanes.set(guildId, run.then(() => null, () => null));
  return run;
}

function selfId(guild) {
  return String(guild?.client?.user?.id || guild?.members?.me?.id || "");
}

function rememberWrite(guildId, kind, value) {
  const row = ownWrites.get(String(guildId)) || {};
  row[kind] = value == null ? "" : String(value);
  row.until = Date.now() + 20000;
  ownWrites.set(String(guildId), row);
}

function forgetWrite(guildId, kind) {
  const row = ownWrites.get(String(guildId));
  if (row) delete row[kind];
}

function isOwnWrite(guildId, kind, value) {
  const row = ownWrites.get(String(guildId));
  if (!row || row.until < Date.now()) return false;
  return row[kind] === (value == null ? "" : String(value));
}

function cooling(guildId, kind) {
  const key = `${guildId}:${kind}`;
  if ((restoreCooldown.get(key) || 0) > Date.now()) return true;
  restoreCooldown.set(key, Date.now() + 20000);
  return false;
}

function isOwner(guild, userId) {
  return !!userId && String(userId) === String(guild?.ownerId);
}

function isSelf(guild, userId) {
  const id = selfId(guild);
  return !!id && String(userId) === id;
}

function voiceChannel(channel) {
  return channel?.type === ChannelType.GuildVoice || channel?.type === ChannelType.GuildStageVoice;
}

function bitfield(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  if (value?.bitfield != null) return bitfield(value.bitfield);
  return 0n;
}

function executorId(entry) {
  return entry?.executorId || entry?.executor?.id || null;
}

function targetId(entry) {
  return entry?.targetId || entry?.target?.id || null;
}

function changesOf(entry) {
  const changes = entry?.changes;
  if (!changes) return [];
  if (Array.isArray(changes)) return changes;
  if (typeof changes[Symbol.iterator] === "function") return [...changes];
  return [];
}

function voiceType(type) {
  const value = Number(type);
  return value === ChannelType.GuildVoice || value === ChannelType.GuildStageVoice;
}

function auditChannelType(entry) {
  const change = changesOf(entry).find((item) => item.key === "type");
  return change?.old ?? change?.old_value ?? entry?.target?.type ?? null;
}

async function attempt(label, fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    const raw = Number(error?.retryAfter || error?.data?.retry_after || 0);
    const wait = raw > 30 ? raw : raw * 1000;
    if ((error?.status === 429 || error?.code === 429) && wait > 0 && wait <= 3000) {
      await sleep(wait);
      try {
        return { ok: true, value: await fn() };
      } catch (again) {
        console.error(`[antinuke] ${label}`, again?.code || again?.message || again);
        return { ok: false, error: "rate limited" };
      }
    }
    console.error(`[antinuke] ${label}`, error?.code || error?.message || error);
    return { ok: false, error: "failed" };
  }
}

function health(guild) {
  const names = ["ViewAuditLog", "KickMembers", "BanMembers", "ManageChannels", "ManageRoles", "ManageGuild", "ManageWebhooks"];
  const permissions = guild?.members?.me?.permissions;
  const missing = names.filter((name) => PermissionFlagsBits[name] && !permissions?.has?.(PermissionFlagsBits[name]));
  return {
    missing,
    audit: !missing.includes("ViewAuditLog"),
    active: missing.length ? "degraded" : "ready"
  };
}

function trusted(guild, userId) {
  return store.whitelistOne(guild.id, userId);
}

function rememberEmpty(channelId) {
  emptyVoice.set(String(channelId), Date.now() + 30000);
}

function wasEmpty(channelId) {
  const until = emptyVoice.get(String(channelId));
  if (!until) return false;
  if (until < Date.now()) {
    emptyVoice.delete(String(channelId));
    return false;
  }
  return true;
}

function rememberOccupied(channel) {
  const overwrites = [...(channel.permissionOverwrites?.cache?.values?.() || [])].map((overwrite) => ({
    id: overwrite.id,
    type: overwrite.type,
    allow: String(bitfield(overwrite.allow)),
    deny: String(bitfield(overwrite.deny))
  }));
  occupiedVoice.set(String(channel.id), {
    at: Date.now() + 30000,
    occupants: channel.members?.size || 0,
    name: channel.name,
    type: channel.type,
    parentId: channel.parentId || null,
    overwrites
  });
}

function occupied(channelId) {
  const row = occupiedVoice.get(String(channelId));
  if (!row) return null;
  if (row.at < Date.now()) {
    occupiedVoice.delete(String(channelId));
    return null;
  }
  return row;
}

async function notify(guild, content) {
  const sent = new Set();
  const people = [];
  const owner = guild.members?.cache?.get?.(guild.ownerId) || await guild.members?.fetch?.(guild.ownerId).catch(() => null);
  if (owner) people.push(owner);
  for (const member of guild.members?.cache?.values?.() || []) {
    if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) people.push(member);
  }
  for (const member of people) {
    if (!member?.id || sent.has(String(member.id)) || member.user?.bot) continue;
    sent.add(String(member.id));
    if (sent.size > 20) break;
    if (sent.size > 1 && process.env.npm_lifecycle_event !== "test" && !process.env.NODE_TEST_CONTEXT) await sleep(1100);
    await member.send?.({ content, allowedMentions: { parse: [] } }).catch((error) => {
      console.error(`[antinuke dm] ${guild.id}:${member.id}`, error?.code || error?.message || error);
    });
  }
}

async function logLine(guild, config, text) {
  if (!config.logChannelId) return { ok: false, error: "no log channel" };
  const channel = guild.channels?.cache?.get?.(config.logChannelId) || await guild.channels?.fetch?.(config.logChannelId).catch(() => null);
  if (!channel?.send) return { ok: false, error: "log channel missing" };
  return attempt("security log", () => channel.send({ content: text.slice(0, 1900), allowedMentions: { parse: [] } }));
}

function capture(guild) {
  const channels = [...(guild.channels?.cache?.values?.() || [])].map((channel) => ({
    id: channel.id,
    name: channel.name,
    type: channel.type,
    parentId: channel.parentId || null,
    position: channel.position || 0,
    overwrites: [...(channel.permissionOverwrites?.cache?.values?.() || [])].map((overwrite) => ({
      id: overwrite.id,
      type: overwrite.type,
      allow: String(bitfield(overwrite.allow)),
      deny: String(bitfield(overwrite.deny))
    }))
  }));
  const roles = [...(guild.roles?.cache?.values?.() || [])].filter((role) => role.id !== guild.id).map((role) => ({
    id: role.id,
    name: role.name,
    color: role.color || 0,
    permissions: String(bitfield(role.permissions)),
    hoist: !!role.hoist,
    mentionable: !!role.mentionable
  }));
  return {
    channels,
    roles,
    name: guild.name || null,
    verificationLevel: guild.verificationLevel ?? null
  };
}

function saveSnapshot(guild, config) {
  const data = capture(guild);
  store.addSnapshot(guild.id, data, config.snapshotKeep || 5);
  return data;
}

async function kick(guild, userId, reason, apply) {
  if (!apply) return { ok: true, value: "simulated" };
  if (!userId || isOwner(guild, userId) || isSelf(guild, userId)) return { ok: false, error: "protected" };
  const member = guild.members?.cache?.get?.(String(userId)) || await guild.members?.fetch?.(userId).catch(() => null);
  await member?.send?.({
    content: `You were kicked from ${guild.name || "the server"}.\n${reason}`,
    allowedMentions: { parse: [] }
  }).catch((error) => {
    console.error(`[antinuke kick dm] ${guild.id}:${userId}`, error?.code || error?.message || error);
  });
  if (typeof guild.members?.kick !== "function") return { ok: false, error: "kick unavailable" };
  return attempt("kick", () => guild.members.kick(userId, reason.slice(0, 500)));
}

async function lockdown(guild, config, executorId, reason, apply) {
  if (config.policy?.halted) return { started: false, result: "anti-nuke is off" };
  if (!config.modules.lockdown && !config.lockdown.restrictOps) return { started: false, result: "lockdown module off" };
  if (config.lockdownActive) return { started: false, result: "already locked down" };
  if (!apply) return { started: true, result: "simulated" };
  return enqueue(guild.id, async () => {
    const current = store.get(guild.id);
    if (current.lockdownActive) return { started: false, result: "already locked down" };
    const state = { verification: null, roles: {}, at: Date.now(), reason };
    const results = [];
    if (current.lockdown.restrictOps && typeof guild.setVerificationLevel === "function") {
      state.verification = guild.verificationLevel ?? 0;
      const raised = await attempt("verification", () => guild.setVerificationLevel(Math.min(4, Number(state.verification) + 1)));
      results.push(raised.ok ? "verification raised" : "verification not changed");
      if (!raised.ok) state.verification = null;
    }
    if ((current.lockdown.stripRoles || current.lockdown.restrictStaff) && executorId && !isOwner(guild, executorId) && !isSelf(guild, executorId)) {
      const member = guild.members?.cache?.get?.(String(executorId)) || await guild.members?.fetch?.(executorId).catch(() => null);
      const removable = [...(member?.roles?.cache?.values?.() || [])].filter((role) => {
        if (!role || role.id === guild.id || role.managed) return false;
        const bits = bitfield(role.permissions);
        return DANGEROUS.some((flag) => (bits & flag) === flag);
      }).map((role) => role.id);
      if (removable.length && member?.roles?.remove) {
        const removed = await attempt("strip roles", () => member.roles.remove(removable, "Anti-nuke lockdown"));
        if (removed.ok) state.roles[String(executorId)] = removable;
        results.push(removed.ok ? "dangerous roles removed" : "role removal failed");
      }
    }
    if (current.lockdown.snapshot) saveSnapshot(guild, current);
    current.lockdownActive = 1;
    current.lockState = state;
    store.save(guild.id, current);
    if (current.lockdown.alertOwner) {
      await notify(guild, `Anti-nuke lockdown is on in ${guild.name || "the server"}.\n${reason}\n${whenLine(Date.now())}`);
    }
    return { started: true, result: results.join(", ") || "lockdown on" };
  });
}

async function unlock(guild, apply) {
  const config = store.get(guild.id);
  if (!config.lockdownActive) return { ok: false, result: "Lockdown is not on." };
  if (!apply) return { ok: true, result: "simulated" };
  const state = config.lockState || {};
  const results = [];
  if (state.verification != null && typeof guild.setVerificationLevel === "function") {
    const restored = await attempt("restore verification", () => guild.setVerificationLevel(state.verification));
    results.push(restored.ok ? "verification restored" : "verification was not restored");
  }
  for (const [userId, roleIds] of Object.entries(state.roles || {})) {
    const member = guild.members?.cache?.get?.(userId) || await guild.members?.fetch?.(userId).catch(() => null);
    const existing = (roleIds || []).filter((id) => guild.roles?.cache?.has?.(id));
    if (member?.roles?.add && existing.length) {
      const added = await attempt("restore roles", () => member.roles.add(existing, "Anti-nuke lockdown ended"));
      results.push(added.ok ? `roles restored for ${userId}` : `roles not restored for ${userId}`);
    }
  }
  config.lockdownActive = 0;
  config.lockState = null;
  store.save(guild.id, config);
  return { ok: true, result: results.join(", ") || "lockdown ended" };
}

async function recreateChannel(guild, info, apply) {
  if (!info?.name) return { ok: false, error: "nothing to recreate" };
  const exists = [...(guild.channels?.cache?.values?.() || [])].find((channel) => channel.name === info.name && (channel.parentId || null) === (info.parentId || null) && channel.type === info.type);
  if (exists) return { ok: true, value: "already exists" };
  if (!apply) return { ok: true, value: "simulated" };
  if (typeof guild.channels?.create !== "function") return { ok: false, error: "channel create unavailable" };
  return attempt("recreate channel", () => guild.channels.create({
    name: info.name,
    type: info.type,
    parent: info.parentId || null,
    permissionOverwrites: info.overwrites || [],
    reason: "Anti-nuke recovery"
  }));
}

async function record(guild, config, row, apply) {
  const id = store.incident(guild.id, row);
  if (apply && config.lockdown.logIncident) {
    const text = [
      `Anti-nuke ${row.severity}: ${row.action}`,
      `Executor: ${row.executorId ? `<@${row.executorId}>` : "unknown"}`,
      `Target: ${row.targetId || "none"}`,
      `Count: ${row.count ?? "n/a"} / ${row.threshold ?? "n/a"} in ${row.windowMs ? `${Math.round(row.windowMs / 1000)}s` : "n/a"}`,
      `Whitelisted: ${row.whitelisted ? "yes" : "no"}`,
      `Lockdown: ${row.lockdown ? "yes" : "no"}`,
      `Result: ${row.result || "recorded"}`,
      whenLine(row.at)
    ].join("\n");
    await logLine(guild, config, text);
  }
  return id;
}

function legacyCovers(guild, action) {
  let security;
  try {
    security = require("../security").load(guild.id);
  } catch {
    return false;
  }
  if (!security) return false;
  if (action === "ban" && security.mass_ban) return true;
  if (action === "kick" && security.mass_kick) return true;
  if (action === "vanity" && security.vanity) return true;
  if (action === "adminPerm" && security.dpa) return true;
  if (action === "dangerPerm" && security.dpu) return true;
  return false;
}

async function respond(guild, config, decision, apply) {
  const covered = legacyCovers(guild, decision.action);
  let lockdownResult = null;
  if (decision.lock && !covered) {
    lockdownResult = await lockdown(guild, config, decision.executorId, decision.detail, apply);
  }
  let punishment = "logged";
  if (decision.punish && !covered) {
    if (decision.action === "occupiedVoice") {
      const kicked = await kick(guild, decision.executorId, "Deleted a voice channel that still had people in it. Empty voice channels can be deleted. Occupied ones cannot.", apply);
      punishment = kicked.ok ? "kicked" : kicked.error || "kick failed";
      if (config.lockdown.recover) {
        const restored = await recreateChannel(guild, decision.channel, apply);
        punishment += restored.ok ? "; channel recovered" : "; channel was not recovered";
      }
      if (apply && kicked.ok) {
        await notify(guild, [
          "Occupied voice channel deleted.",
          `Who: <@${decision.executorId}>`,
          `Channel: ${decision.channel?.name || decision.targetId}`,
          "Why: a voice channel with people in it was deleted.",
          `Punishment: ${punishment}`,
          whenLine(decision.at)
        ].join("\n"));
      }
    } else if (decision.action === "adminPerm" || decision.action === "dangerPerm") {
      punishment = decision.reverted ? "permissions reverted" : "logged";
      if (decision.action === "adminPerm") {
        const kicked = await kick(guild, decision.executorId, "Granted Administrator without permission.", apply);
        punishment += kicked.ok ? "; kicked" : "; kick failed";
      }
    } else if (decision.severity === "emergency" || decision.severity === "lockdown") {
      const kicked = await kick(guild, decision.executorId, decision.detail, apply);
      punishment = kicked.ok ? "kicked" : kicked.error || "kick failed";
    }
  } else if (covered) {
    punishment = "left to the existing security module";
  } else if (decision.whitelisted) {
    punishment = "logged, trusted account was not punished";
  }
  await record(guild, config, {
    at: decision.at,
    severity: decision.severity,
    action: decision.action,
    executorId: decision.executorId,
    targetId: decision.targetId,
    count: decision.count,
    windowMs: decision.windowMs,
    threshold: decision.threshold,
    whitelisted: decision.whitelisted,
    lockdown: !!(decision.lock && lockdownResult?.started),
    result: punishment,
    detail: decision.detail
  }, apply);
  return { ...decision, punishment, lockdownResult };
}

function decideCounts(config, guildId, executorId, action, at) {
  const rules = config.thresholds;
  if (action === "ban" || action === "kick") {
    const own = action === "ban" ? ["banWarning", "banLock"] : ["kickWarning", "kickLock"];
    const warning = hit(guildId, executorId, own[0], at, rules[own[0]].seconds);
    const lock = hit(guildId, executorId, own[1], at, rules[own[1]].seconds);
    const combined = hit(guildId, executorId, "combined", at, rules.combinedEmergency.seconds);
    if (combined >= rules.combinedEmergency.count) {
      return { severity: "emergency", count: combined, windowMs: rules.combinedEmergency.seconds * 1000, threshold: rules.combinedEmergency.count };
    }
    if (lock >= rules[own[1]].count) {
      return { severity: "lockdown", count: lock, windowMs: rules[own[1]].seconds * 1000, threshold: rules[own[1]].count };
    }
    if (warning >= rules[own[0]].count) {
      return { severity: "warning", count: warning, windowMs: rules[own[0]].seconds * 1000, threshold: rules[own[0]].count };
    }
    return null;
  }
  const map = {
    channelDelete: ["channelWarning", "channelLock"],
    roleDelete: ["roleWarning", "roleLock"],
    webhook: ["webhookWarning", "webhookLock"]
  };
  const pair = map[action];
  if (!pair) return null;
  const warning = hit(guildId, executorId, pair[0], at, rules[pair[0]].seconds);
  const lock = hit(guildId, executorId, pair[1], at, rules[pair[1]].seconds);
  if (lock >= rules[pair[1]].count) {
    return { severity: "lockdown", count: lock, windowMs: rules[pair[1]].seconds * 1000, threshold: rules[pair[1]].count };
  }
  if (warning >= rules[pair[0]].count) {
    return { severity: "warning", count: warning, windowMs: rules[pair[0]].seconds * 1000, threshold: rules[pair[0]].count };
  }
  return null;
}

async function consider(guild, event, apply) {
  const config = store.get(guild.id);
  if (!config.active || config.policy.halted) return { ignored: true, reason: "inactive" };
  const at = Number(event.at) || Date.now();
  if (Date.now() - at > STALE_MS) {
    await record(guild, config, {
      at,
      severity: "info",
      action: event.action,
      executorId: event.executorId,
      targetId: event.targetId,
      result: "ignored late audit",
      detail: "The audit event was too old to punish."
    }, apply);
    return { ignored: true, reason: "late" };
  }
  if (event.id && !claim(event.id)) return { ignored: true, reason: "duplicate" };
  if (event.action === "channelDelete" && wasEmpty(event.targetId)) return { ignored: true, reason: "empty voice" };
  const occupiedHit = event.action === "occupiedVoice" || (event.action === "channelDelete" && occupied(event.targetId));
  const action = occupiedHit ? "occupiedVoice" : event.action;
  const moduleOn = action === "occupiedVoice" ? config.modules.channelDelete : config.modules[event.module || action];
  if (moduleOn === false) return { ignored: true, reason: "module off" };
  if (!event.executorId) {
    await record(guild, config, {
      at,
      severity: "info",
      action,
      targetId: event.targetId,
      result: "executor unknown",
      detail: "No punishment because the executor was not confident."
    }, apply);
    return { ignored: true, reason: "unknown executor" };
  }
  if (isSelf(guild, event.executorId)) return { ignored: true, reason: "self" };
  const entry = trusted(guild, event.executorId);
  const whitelisted = !!entry;
  const owner = isOwner(guild, event.executorId);
  const counts = action === "occupiedVoice" ? { severity: "emergency", count: event.occupants || 1, windowMs: 0, threshold: 1 } : decideCounts(config, guild.id, event.executorId, action, at);
  if (action === "ban" || action === "kick" || action === "channelDelete" || action === "roleDelete") {
    destructiveAt.set(String(guild.id), at);
  }
  if (!counts && action !== "occupiedVoice" && action !== "adminPerm" && action !== "dangerPerm" && action !== "raid" && action !== "vanity" && action !== "serverSettings" && action !== "compromisedBot") {
    return { ignored: true, reason: "under threshold" };
  }
  let severity = counts?.severity || "warning";
  if (action === "adminPerm") severity = "emergency";
  if (action === "dangerPerm") severity = config.lockdown.restrictOps ? "lockdown" : "warning";
  if (action === "vanity" || action === "serverSettings") severity = "lockdown";
  if (action === "raid") severity = event.suspicious ? "emergency" : "warning";
  if (action === "compromisedBot") severity = event.repeat ? "lockdown" : "warning";
  const bypassPunish = whitelisted && (config.policy.bypassPunishment || (entry?.kind === "bot" && config.policy.botsDestructive));
  const bypassLock = owner || (whitelisted && config.policy.bypassLockdown);
  const punish = action === "occupiedVoice"
    ? !owner
    : !owner && !bypassPunish && (severity === "lockdown" || severity === "emergency");
  const lock = !owner && !bypassLock && config.modules.lockdown && (severity === "lockdown" || severity === "emergency") && action !== "raid";
  return respond(guild, config, {
    at,
    action,
    severity,
    executorId: String(event.executorId),
    targetId: event.targetId ? String(event.targetId) : null,
    count: counts?.count ?? null,
    windowMs: counts?.windowMs ?? null,
    threshold: counts?.threshold ?? null,
    whitelisted,
    lock,
    punish,
    detail: event.detail || action,
    channel: event.channel || occupied(event.targetId),
    reverted: event.reverted || false
  }, apply);
}

async function handleChannelDelete(channel, apply = true) {
  if (!channel?.guild || !channel.id) return { ignored: true };
  if (!voiceChannel(channel)) return { ignored: true, reason: "not voice" };
  if ((channel.members?.size || 0) === 0) {
    rememberEmpty(channel.id);
    return { ignored: true, reason: "empty voice" };
  }
  rememberOccupied(channel);
  const info = occupied(channel.id);
  let executor = null;
  if (typeof channel.guild.fetchAuditLogs === "function") {
    const logs = await channel.guild.fetchAuditLogs({ type: AuditLogEvent.ChannelDelete, limit: 5 }).catch(() => null);
    const entries = logs?.entries?.values ? [...logs.entries.values()] : [];
    const match = entries.find((entry) => String(targetId(entry)) === String(channel.id) && Date.now() - Number(entry.createdTimestamp || Date.now()) < STALE_MS);
    executor = match ? executorId(match) : null;
    if (match?.id) {
      return consider(channel.guild, {
        id: match.id,
        action: "occupiedVoice",
        module: "channelDelete",
        executorId: executor,
        targetId: channel.id,
        at: Number(match.createdTimestamp) || Date.now(),
        occupants: info?.occupants,
        channel: info,
        detail: `Deleted occupied voice channel ${channel.name}`
      }, apply);
    }
  }
  return consider(channel.guild, {
    id: `voice:${channel.id}:${Date.now()}`,
    action: "occupiedVoice",
    module: "channelDelete",
    executorId: executor,
    targetId: channel.id,
    at: Date.now(),
    occupants: info?.occupants,
    channel: info,
    detail: `Deleted occupied voice channel ${channel.name}`
  }, apply);
}

async function handleMemberAdd(member, apply = true) {
  const guild = member?.guild;
  if (!guild) return { ignored: true };
  const config = store.get(guild.id);
  if (!config.active || config.policy.halted || !config.modules.antiRaid) return { ignored: true };
  const at = Date.now();
  const count = hit(guild.id, "raid", "raid", at, config.thresholds.raidWarning.seconds);
  const emergency = hit(guild.id, "raid", "raidEmergency", at, config.thresholds.raidEmergency.seconds);
  const suspicious = at - (destructiveAt.get(String(guild.id)) || 0) < 15000;
  if (emergency >= config.thresholds.raidEmergency.count && suspicious) {
    if (config.modules.lockdown && config.lockdown.raidMode) await lockdown(guild, config, null, `${emergency} joins during other destructive activity.`, apply);
    await record(guild, config, {
      at,
      severity: "emergency",
      action: "raid",
      count: emergency,
      windowMs: config.thresholds.raidEmergency.seconds * 1000,
      threshold: config.thresholds.raidEmergency.count,
      result: "alerted, nobody was mass-banned",
      detail: `${emergency} members joined during other destructive activity. Joining members were not banned.`
    }, apply);
    return { severity: "emergency", punishment: "none" };
  }
  if (count >= config.thresholds.raidWarning.count) {
    const id = `raid-warn:${guild.id}:${Math.floor(at / (config.thresholds.raidWarning.seconds * 1000))}`;
    if (!claim(id)) return { ignored: true, reason: "duplicate" };
    await record(guild, config, {
      at,
      severity: "warning",
      action: "raid",
      count,
      windowMs: config.thresholds.raidWarning.seconds * 1000,
      threshold: config.thresholds.raidWarning.count,
      result: "alerted, nobody was mass-banned",
      detail: `${count} members joined. No members were banned for joining.`
    }, apply);
    return { severity: "warning", punishment: "none" };
  }
  return { ignored: true, reason: "under threshold" };
}

async function handleAudit(guild, entry, apply = true) {
  if (!guild?.id || !entry) return { ignored: true };
  const action = entry.action;
  const executor = executorId(entry);
  const target = targetId(entry);
  const at = Number(entry.createdTimestamp) || Date.now();
  if (action === AuditLogEvent.ChannelDelete) {
    if (!entry.instant) await sleep(250);
    if (wasEmpty(target)) return { ignored: true, reason: "empty voice" };
    const info = occupied(target);
    if (info) {
      return consider(guild, {
        id: entry.id,
        action: "occupiedVoice",
        module: "channelDelete",
        executorId: executor,
        targetId: target,
        at,
        occupants: info.occupants,
        channel: info,
        detail: `Deleted occupied voice channel ${info.name}`
      }, apply);
    }
    if (voiceType(auditChannelType(entry))) return { ignored: true, reason: "empty voice" };
    return consider(guild, {
      id: entry.id,
      action: "channelDelete",
      module: "channelDelete",
      executorId: executor,
      targetId: target,
      at,
      detail: "Deleted a channel"
    }, apply);
  }
  if (action === AuditLogEvent.RoleDelete) {
    return consider(guild, { id: entry.id, action: "roleDelete", module: "roleDelete", executorId: executor, targetId: target, at, detail: "Deleted a role" }, apply);
  }
  if (action === AuditLogEvent.MemberBanAdd) {
    return consider(guild, { id: entry.id, action: "ban", module: "massBan", executorId: executor, targetId: target, at, detail: "Banned a member" }, apply);
  }
  if (action === AuditLogEvent.MemberKick) {
    return consider(guild, { id: entry.id, action: "kick", module: "massKick", executorId: executor, targetId: target, at, detail: "Kicked a member" }, apply);
  }
  if (action === AuditLogEvent.WebhookCreate) {
    return consider(guild, { id: entry.id, action: "webhook", module: "webhook", executorId: executor, targetId: target, at, detail: "Created a webhook" }, apply);
  }
  if (action === AuditLogEvent.RoleUpdate) {
    return handleRoleUpdate(guild, entry, apply);
  }
  if (action === AuditLogEvent.GuildUpdate) {
    return { ignored: true, reason: "guild updates are read from the gateway" };
  }
  if (action === AuditLogEvent.BotAdd) {
    const config = store.get(guild.id);
    if (!config.active || config.policy.halted || !config.modules.compromisedBot) return { ignored: true };
    return record(guild, config, {
      at,
      severity: "info",
      action: "botAdd",
      executorId: executor,
      targetId: target,
      result: "logged",
      detail: "A bot was added. Destructive actions from non-trusted bots are watched."
    }, apply);
  }
  return { ignored: true };
}

async function handleRoleUpdate(guild, entry, apply) {
  const config = store.get(guild.id);
  if (!config.active || config.policy.halted || !config.modules.permissions) return { ignored: true };
  const change = changesOf(entry).find((item) => item.key === "permissions");
  if (!change) return { ignored: true };
  const before = bitfield(change.old || change.old_value);
  const after = bitfield(change.new || change.new_value);
  const added = after & ~before;
  const adminAdded = ADMIN && (added & ADMIN) === ADMIN;
  const dangerAdded = DANGEROUS.some((flag) => flag !== ADMIN && (added & flag) === flag);
  if (!adminAdded && !dangerAdded) return { ignored: true };
  const row = trusted(guild, executorId(entry));
  if (row && config.policy.dangerousChanges && row.kind !== "bot") {
    await record(guild, config, {
      at: Number(entry.createdTimestamp) || Date.now(),
      severity: "info",
      action: adminAdded ? "adminPerm" : "dangerPerm",
      executorId: executorId(entry),
      targetId: targetId(entry),
      whitelisted: 1,
      result: "allowed by explicit dangerous-change permission",
      detail: "Logged. The whitelist permission allowed this permission change."
    }, apply);
    return { ignored: true, reason: "explicit permission" };
  }
  let reverted = false;
  if (apply && typeof entry.target?.setPermissions === "function") {
    const result = await attempt("revert permissions", () => entry.target.setPermissions(before, "Anti-nuke reverted a dangerous permission"));
    reverted = !!result.ok;
  } else if (!apply) reverted = true;
  return consider(guild, {
    id: entry.id,
    action: adminAdded ? "adminPerm" : "dangerPerm",
    module: "permissions",
    executorId: executorId(entry),
    targetId: targetId(entry),
    at: Number(entry.createdTimestamp) || Date.now(),
    reverted,
    detail: adminAdded ? "Administrator was added to a role" : "A dangerous permission was added to a role"
  }, apply);
}

async function recentGuildEditor(guild) {
  const logs = await guild.fetchAuditLogs?.({ type: AuditLogEvent.GuildUpdate, limit: 5 }).catch(() => null);
  const entries = logs?.entries?.values ? [...logs.entries.values()] : [];
  const fresh = entries.find((entry) => Date.now() - Number(entry.createdTimestamp || 0) < STALE_MS);
  return fresh ? { id: fresh.id, executorId: executorId(fresh) } : null;
}

async function restoreSetting(guild, kind, before, after, apply) {
  if (isOwnWrite(guild.id, kind, after)) return { ignored: true, reason: "own restore" };
  const editor = await recentGuildEditor(guild);
  const executor = editor?.executorId || null;
  if (!executor || isSelf(guild, executor) || isOwner(guild, executor)) {
    return { ignored: true, reason: executor ? "allowed" : "unknown executor" };
  }
  if (kind === "vanity" && legacyCovers(guild, "vanity")) return { ignored: true, reason: "left to the existing security module" };
  if (cooling(guild.id, kind)) return { ignored: true, reason: "cooldown" };
  let restored = false;
  if (apply && kind === "vanity" && before != null && before !== "" && typeof guild.client?.rest?.patch === "function") {
    rememberWrite(guild.id, "vanity", before);
    const result = await attempt("vanity", () => guild.client.rest.patch(Routes.guildVanityUrl(guild.id), {
      body: { code: before },
      reason: "Anti-nuke restored the server vanity"
    }));
    restored = !!result.ok;
    if (!restored) forgetWrite(guild.id, "vanity");
  }
  if (apply && kind === "name" && before && typeof guild.setName === "function") {
    rememberWrite(guild.id, "name", before);
    const result = await attempt("server name", () => guild.setName(before, "Anti-nuke restored the server name"));
    restored = !!result.ok;
    if (!restored) forgetWrite(guild.id, "name");
  }
  return consider(guild, {
    id: editor?.id || `${kind}:${guild.id}:${before}`,
    action: kind === "vanity" ? "vanity" : "serverSettings",
    module: kind === "vanity" ? "vanity" : "serverSettings",
    executorId: executor,
    targetId: guild.id,
    at: Date.now(),
    detail: restored ? `${kind} restored once.` : `${kind} changed and was not restored again.`
  }, apply);
}

async function handleGuildUpdate(before, after, apply = true) {
  if (!after?.id) return { ignored: true };
  const config = store.get(after.id);
  if (!config.active || config.policy.halted) return { ignored: true, reason: "inactive" };
  let result = { ignored: true };
  if (config.modules.vanity && before?.vanityURLCode !== after.vanityURLCode) {
    result = await restoreSetting(after, "vanity", before?.vanityURLCode, after.vanityURLCode, apply);
  }
  if (config.modules.serverSettings && before?.name && after.name && before.name !== after.name) {
    const named = await restoreSetting(after, "name", before.name, after.name, apply);
    if (result.ignored) result = named;
  }
  return result;
}

async function noteBot(guild, executorId, action, apply) {
  const config = store.get(guild.id);
  if (!config.active || config.policy.halted || !config.modules.compromisedBot) return { ignored: true };
  const row = trusted(guild, executorId);
  if (row?.kind === "bot" && config.policy.botsDestructive) {
    return record(guild, config, {
      at: Date.now(),
      severity: "info",
      action: "compromisedBot",
      executorId,
      whitelisted: 1,
      result: "logged",
      detail: `${action} by a trusted bot with destructive permission.`
    }, apply);
  }
  const key = `${guild.id}:${executorId}`;
  const stamps = (botStrikes.get(key) || []).filter((stamp) => Date.now() - stamp < 10000);
  stamps.push(Date.now());
  botStrikes.set(key, stamps);
  return consider(guild, {
    id: `bot:${key}:${stamps.length}:${Date.now()}`,
    action: "compromisedBot",
    module: "compromisedBot",
    executorId,
    at: Date.now(),
    repeat: stamps.length >= 2,
    detail: stamps.length >= 2 ? "A non-trusted bot repeated a destructive action." : "A non-trusted bot took a destructive action."
  }, apply);
}

async function tickSnapshots(guild) {
  const config = store.get(guild.id);
  if (!config.active || config.policy.halted || !config.modules.snapshots) return false;
  const latest = store.snapshots(guild.id, 1)[0];
  if (latest && Date.now() - latest.at < config.snapshotMinutes * 60 * 1000) return false;
  saveSnapshot(guild, config);
  return true;
}

async function recreateRole(guild, info, apply) {
  if (!info?.name || info.name === "@everyone") return { ok: true, value: "already exists" };
  const exists = [...(guild.roles?.cache?.values?.() || [])].find((role) => role.id === info.id || role.name === info.name);
  if (exists) return { ok: true, value: "already exists" };
  if (!apply) return { ok: true, value: "simulated" };
  if (typeof guild.roles?.create !== "function") return { ok: false, error: "role create unavailable" };
  let permissions = 0n;
  try {
    permissions = BigInt(info.permissions || 0);
  } catch {
    permissions = 0n;
  }
  return attempt("recreate role", () => guild.roles.create({
    name: info.name,
    permissions,
    color: info.color || 0,
    hoist: !!info.hoist,
    mentionable: !!info.mentionable,
    reason: "Anti-nuke recovery"
  }));
}

async function recover(guild, snapshotId, apply = true) {
  const config = store.get(guild.id);
  const savedSnapshot = store.snapshot(guild.id, snapshotId) || null;
  const data = savedSnapshot?.data || capture(guild);
  const created = [];
  const skipped = [];
  const allow = apply && config.lockdown.recover;
  for (const channel of data.channels || []) {
    const result = await recreateChannel(guild, channel, allow);
    if (result.ok && result.value !== "already exists") created.push(channel.name);
    else skipped.push(channel.name);
  }
  for (const role of data.roles || []) {
    const result = await recreateRole(guild, role, allow);
    if (result.ok && result.value !== "already exists") created.push(role.name);
    else skipped.push(role.name);
  }
  return {
    created,
    skipped,
    note: "Snapshots cannot restore messages or every setting. Vanity URLs cannot always be restored. Existing channels and roles were left in place."
  };
}

function resetForTests() {
  seen.clear();
  buckets.clear();
  emptyVoice.clear();
  occupiedVoice.clear();
  destructiveAt.clear();
  botStrikes.clear();
  ownWrites.clear();
  restoreCooldown.clear();
}

module.exports = {
  health,
  capture,
  saveSnapshot,
  claim,
  consider,
  handleAudit,
  handleChannelDelete,
  handleMemberAdd,
  handleGuildUpdate,
  handleRoleUpdate,
  lockdown,
  unlock,
  kick,
  recover,
  tickSnapshots,
  noteBot,
  resetForTests
};
