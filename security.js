const {
  AuditLogEvent,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  Routes
} = require("discord.js");
const { connection } = require("./db");
const { logThrottledError } = require("./log-throttle");
const store = require("./systems/store");
const access = require("./systems/access");
const { ACCENT } = require("./vouch/constants");
const { reply } = require("./vouch/ui");
const { replyUsage } = require("./usage");
const { resolveMember, resolveRole } = require("./vouch/resolve");

const WINDOW_MS = 8000;
const ADMIN = PermissionFlagsBits.Administrator;
const DANGEROUS = [
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageWebhooks
].filter((bit) => typeof bit === "bigint");

const COMMANDS = {
  securityconfig: "config",
  dangerouspermissionsadd: "dpa",
  dpa: "dpa",
  dangerouspermissionsupdate: "dpu",
  dpu: "dpu",
  vanityprotection: "vanity",
  vp: "vanity",
  denybotjoins: "bots",
  dbj: "bots",
  massmemberkick: "masskick",
  mmk: "masskick",
  massmemberban: "massban",
  mmb: "massban",
  setwatchrole: "watchrole",
  unwatchrole: "unwatchrole",
  watchuser: "watchuser",
  unwatchuser: "unwatchuser"
};

connection.exec(`
CREATE TABLE IF NOT EXISTS security_config (
  guild_id TEXT PRIMARY KEY,
  dpa INTEGER NOT NULL DEFAULT 0,
  dpu INTEGER NOT NULL DEFAULT 0,
  vanity INTEGER NOT NULL DEFAULT 0,
  vanity_code TEXT,
  deny_bots INTEGER NOT NULL DEFAULT 0,
  mass_kick INTEGER NOT NULL DEFAULT 0,
  mass_kick_threshold INTEGER NOT NULL DEFAULT 3,
  mass_kick_punishment TEXT NOT NULL DEFAULT 'ban',
  mass_ban INTEGER NOT NULL DEFAULT 0,
  mass_ban_threshold INTEGER NOT NULL DEFAULT 3,
  mass_ban_punishment TEXT NOT NULL DEFAULT 'ban',
  events_channel_id TEXT,
  watch_channel_id TEXT
);
CREATE TABLE IF NOT EXISTS security_watch_roles (
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, role_id)
);
CREATE TABLE IF NOT EXISTS security_watch_users (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
`);

const statements = {
  get: connection.prepare("SELECT * FROM security_config WHERE guild_id=?"),
  save: connection.prepare(`
    INSERT INTO security_config(
      guild_id, dpa, dpu, vanity, vanity_code, deny_bots,
      mass_kick, mass_kick_threshold, mass_kick_punishment,
      mass_ban, mass_ban_threshold, mass_ban_punishment,
      events_channel_id, watch_channel_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(guild_id) DO UPDATE SET
      dpa=excluded.dpa, dpu=excluded.dpu, vanity=excluded.vanity, vanity_code=excluded.vanity_code,
      deny_bots=excluded.deny_bots, mass_kick=excluded.mass_kick,
      mass_kick_threshold=excluded.mass_kick_threshold, mass_kick_punishment=excluded.mass_kick_punishment,
      mass_ban=excluded.mass_ban, mass_ban_threshold=excluded.mass_ban_threshold,
      mass_ban_punishment=excluded.mass_ban_punishment,
      events_channel_id=excluded.events_channel_id, watch_channel_id=excluded.watch_channel_id
  `),
  watchRoles: connection.prepare("SELECT role_id FROM security_watch_roles WHERE guild_id=?"),
  addWatchRole: connection.prepare("INSERT OR IGNORE INTO security_watch_roles(guild_id, role_id) VALUES(?,?)"),
  removeWatchRole: connection.prepare("DELETE FROM security_watch_roles WHERE guild_id=? AND role_id=?"),
  watchUsers: connection.prepare("SELECT user_id FROM security_watch_users WHERE guild_id=?"),
  addWatchUser: connection.prepare("INSERT OR IGNORE INTO security_watch_users(guild_id, user_id) VALUES(?,?)"),
  removeWatchUser: connection.prepare("DELETE FROM security_watch_users WHERE guild_id=? AND user_id=?")
};

const cache = new Map();
const roleCache = new Map();
const userCache = new Map();
const recentAudits = [];
const bursts = new Map();
const claimed = new Map();
const logQueues = new Map();

function fresh(guildId) {
  return {
    guild_id: String(guildId),
    dpa: 0,
    dpu: 0,
    vanity: 0,
    vanity_code: null,
    deny_bots: 0,
    mass_kick: 0,
    mass_kick_threshold: 3,
    mass_kick_punishment: "ban",
    mass_ban: 0,
    mass_ban_threshold: 3,
    mass_ban_punishment: "ban",
    events_channel_id: null,
    watch_channel_id: null
  };
}

function normalize(row) {
  return {
    ...fresh(row.guild_id),
    ...row,
    dpa: Number(row.dpa) || 0,
    dpu: Number(row.dpu) || 0,
    vanity: Number(row.vanity) || 0,
    deny_bots: Number(row.deny_bots) || 0,
    mass_kick: Number(row.mass_kick) || 0,
    mass_ban: Number(row.mass_ban) || 0,
    mass_kick_threshold: Number(row.mass_kick_threshold) || 3,
    mass_ban_threshold: Number(row.mass_ban_threshold) || 3,
    mass_kick_punishment: row.mass_kick_punishment || "ban",
    mass_ban_punishment: row.mass_ban_punishment || "ban"
  };
}

function load(guildId) {
  const key = String(guildId);
  if (cache.has(key)) return cache.get(key);
  const row = statements.get.get(key);
  const config = row ? normalize(row) : fresh(key);
  cache.set(key, config);
  return config;
}

function save(config) {
  const row = normalize(config);
  statements.save.run(
    row.guild_id, row.dpa, row.dpu, row.vanity, row.vanity_code, row.deny_bots,
    row.mass_kick, row.mass_kick_threshold, row.mass_kick_punishment,
    row.mass_ban, row.mass_ban_threshold, row.mass_ban_punishment,
    row.events_channel_id, row.watch_channel_id
  );
  cache.set(row.guild_id, row);
  return row;
}

function watchRoles(guildId) {
  const key = String(guildId);
  if (!roleCache.has(key)) roleCache.set(key, new Set(statements.watchRoles.all(key).map((row) => String(row.role_id))));
  return roleCache.get(key);
}

function watchUsers(guildId) {
  const key = String(guildId);
  if (!userCache.has(key)) userCache.set(key, new Set(statements.watchUsers.all(key).map((row) => String(row.user_id))));
  return userCache.get(key);
}

function bitfield(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  if (value && typeof value.bitfield === "bigint") return value.bitfield;
  if (value && typeof value.bitfield === "number") return BigInt(value.bitfield);
  return 0n;
}

function listOf(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value.values === "function") return [...value.values()];
  return [];
}

function changesOf(entry) {
  return listOf(entry?.changes);
}

function changeValue(change, side) {
  if (!change) return undefined;
  if (side === "new" && Object.prototype.hasOwnProperty.call(change, "new")) return change.new;
  if (side === "old" && Object.prototype.hasOwnProperty.call(change, "old")) return change.old;
  return side === "new" ? change.new_value : change.old_value;
}

function executorId(entry) {
  return String(entry?.executorId || entry?.executor?.id || "");
}

function targetId(entry) {
  return String(entry?.targetId || entry?.target?.id || "");
}

function botId(guild) {
  return String(guild?.client?.user?.id || guild?.members?.me?.id || "");
}

function trusted(guild, userId) {
  const id = String(userId || "");
  if (!id) return false;
  if (id === String(guild.ownerId || "")) return true;
  if (id === botId(guild)) return true;
  return store.isAntinukeAdmin(guild.id, id);
}

function canConfigure(message) {
  return trusted(message.guild, message.author.id) || access.isBotOwner(message.author.id);
}

function claim(key) {
  const now = Date.now();
  const previous = claimed.get(key) || 0;
  if (now - previous < 15000) return false;
  claimed.set(key, now);
  if (claimed.size > 400) {
    const oldest = claimed.keys().next().value;
    claimed.delete(oldest);
  }
  return true;
}

function burst(guildId, userId, kind, now = Date.now()) {
  const key = `${guildId}:${userId}:${kind}`;
  const hits = (bursts.get(key) || []).filter((stamp) => now - stamp < WINDOW_MS);
  hits.push(now);
  bursts.set(key, hits);
  return hits.length;
}

function noteAudit(guild, entry) {
  recentAudits.push({
    guildId: String(guild.id),
    action: entry.action,
    targetId: targetId(entry),
    executorId: executorId(entry),
    at: Date.now()
  });
  if (recentAudits.length > 40) recentAudits.shift();
}

function findRecent(guildId, action, target) {
  for (let index = recentAudits.length - 1; index >= 0; index -= 1) {
    const row = recentAudits[index];
    if (row.guildId === String(guildId) && row.action === action && row.targetId === String(target) && Date.now() - row.at < 15000) {
      return row.executorId;
    }
  }
  return "";
}

function stamp(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    month: "numeric",
    day: "numeric",
    year: "2-digit"
  }).formatToParts(new Date(ms));
  const read = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${read("hour")}:${read("minute")}${read("dayPeriod").toLowerCase()} est ${read("month")}/${read("day")}/${read("year")}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryWaitMs(error) {
  const raw = Number(error?.rawError?.retry_after ?? error?.data?.retry_after);
  if (raw > 0) return Math.min(15000, Math.ceil(raw * 1000));
  const given = Number(error?.retryAfter);
  if (given > 0) return Math.min(15000, Math.ceil(given < 100 ? given * 1000 : given));
  if (Number(error?.status) === 429 || Number(error?.code) === 429) return 1000;
  return 0;
}

function rateLimited(error) {
  return Number(error?.status) === 429 || Number(error?.code) === 429;
}

async function once(run) {
  try {
    return await run();
  } catch (error) {
    const wait = retryWaitMs(error);
    if (rateLimited(error) && wait > 0) {
      await sleep(wait);
      return run();
    }
    throw error;
  }
}

function overwrites(guild) {
  const rows = [{ id: guild.id, deny: [PermissionFlagsBits.ViewChannel] }];
  const me = botId(guild);
  if (me) {
    rows.push({
      id: me,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory
      ]
    });
  }
  return rows;
}

const channelCreates = new Map();

async function ensureChannel(guild, kind) {
  const key = `${guild.id}:${kind}`;
  const pending = channelCreates.get(key);
  if (pending) return pending;
  const task = openLogChannel(guild, kind).finally(() => {
    if (channelCreates.get(key) === task) channelCreates.delete(key);
  });
  channelCreates.set(key, task);
  return task;
}

async function openLogChannel(guild, kind) {
  const row = load(guild.id);
  const field = kind === "watch" ? "watch_channel_id" : "events_channel_id";
  const name = kind === "watch" ? "watchlist" : "security-events";
  const cached = row[field] && guild.channels?.cache?.get?.(row[field]);
  if (cached) return cached;
  if (typeof guild.channels?.create !== "function") return null;
  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    permissionOverwrites: overwrites(guild),
    reason: kind === "watch" ? "Watchlist log" : "Security event log"
  });
  save({ ...load(guild.id), [field]: channel.id });
  guild.channels?.cache?.set?.(channel.id, channel);
  return channel;
}

function enqueue(channel, payload) {
  if (!channel || typeof channel.send !== "function") return;
  const queue = logQueues.get(channel.id) || { running: false, items: [] };
  queue.items.push(payload);
  logQueues.set(channel.id, queue);
  if (!queue.running) drain(channel, queue).catch((error) => console.error("[security log]", error));
}

async function drain(channel, queue) {
  queue.running = true;
  while (queue.items.length) {
    const payload = queue.items.shift();
    let sent = false;
    let lastError = null;
    for (let attempt = 1; attempt <= 2 && !sent; attempt += 1) {
      try {
        await channel.send(payload);
        sent = true;
      } catch (error) {
        lastError = error;
        const wait = retryWaitMs(error);
        if (rateLimited(error) && wait > 0 && attempt === 1) {
          await sleep(wait);
          continue;
        }
        break;
      }
    }
    if (!sent) logThrottledError(`security-log:${channel.id}`, "[security log]", lastError);
    if (queue.items.length && process.env.npm_lifecycle_event !== "test") await sleep(250);
  }
  queue.running = false;
}

function logEvent(guild, kind, title, description) {
  const row = load(guild.id);
  const channelId = kind === "watch" ? row.watch_channel_id : row.events_channel_id;
  const channel = channelId && guild.channels?.cache?.get?.(channelId);
  const send = (target) => enqueue(target, {
    embeds: [new EmbedBuilder().setColor(ACCENT).setTitle(title).setDescription(String(description).slice(0, 4000))],
    allowedMentions: { parse: [] }
  });
  if (channel) {
    send(channel);
    return;
  }
  ensureChannel(guild, kind).then((created) => {
    if (created) send(created);
  }).catch((error) => console.error("[security channel]", error));
}

async function punish(guild, userId, kind, reason) {
  const text = String(reason || "Security").slice(0, 500);
  try {
    if (kind === "kick" && typeof guild.members?.kick === "function") {
      await once(() => guild.members.kick(userId, text));
      return "kicked";
    }
    if (kind === "strip") {
      const member = guild.members?.cache?.get?.(userId) || await guild.members?.fetch?.(userId).catch(() => null);
      if (typeof member?.roles?.set !== "function") return "failed";
      await once(() => member.roles.set([], text));
      return "stripped";
    }
    if (typeof guild.members?.ban !== "function") return "failed";
    await once(() => guild.members.ban(userId, { reason: text }));
    return "banned";
  } catch (error) {
    console.error("[security punish]", error?.message || error);
    return "failed";
  }
}

async function restoreRole(guild, roleId, permissions) {
  const role = guild.roles?.cache?.get?.(roleId) || await guild.roles?.fetch?.(roleId).catch(() => null);
  if (!role) return false;
  if (typeof role.setPermissions === "function") {
    await once(() => role.setPermissions(permissions, "Security restored the previous permissions"));
    return true;
  }
  if (typeof role.edit === "function") {
    await once(() => role.edit({ permissions, reason: "Security restored the previous permissions" }));
    return true;
  }
  return false;
}

async function removeRole(guild, roleId) {
  const role = guild.roles?.cache?.get?.(roleId) || await guild.roles?.fetch?.(roleId).catch(() => null);
  if (typeof role?.delete !== "function") return false;
  await once(() => role.delete("Security removed a role created with dangerous permissions"));
  return true;
}

async function restoreVanity(guild, code) {
  const rest = guild.client?.rest;
  if (typeof rest?.patch !== "function") return false;
  await once(() => rest.patch(Routes.guildVanityUrl(guild.id), {
    body: { code: code || null },
    reason: "Security restored the server vanity"
  }));
  guild.vanityURLCode = code || null;
  return true;
}

function dangerousAdded(added) {
  return DANGEROUS.some((bit) => (added & bit) !== 0n);
}

async function handleRole(guild, entry, created) {
  const row = load(guild.id);
  if (!row.dpa && !row.dpu) return;
  const roleId = targetId(entry);
  if (!roleId) return;
  const executor = executorId(entry);
  if (trusted(guild, executor)) return;
  const change = changesOf(entry).find((item) => item.key === "permissions");
  const role = guild.roles?.cache?.get?.(roleId);
  const next = change ? bitfield(changeValue(change, "new")) : bitfield(role?.permissions);
  const previous = change ? bitfield(changeValue(change, "old")) : 0n;
  const added = created ? next : (next & ~previous);
  const adminAdded = (added & ADMIN) !== 0n && !!row.dpa;
  const updateAdded = dangerousAdded(added) && !!row.dpu;
  if (!adminAdded && !updateAdded) return;
  if (!claim(`role:${guild.id}:${roleId}:${executor}:${next.toString()}`)) return;
  const tasks = [];
  if (created) tasks.push(removeRole(guild, roleId));
  else tasks.push(restoreRole(guild, roleId, previous));
  tasks.push(punish(guild, executor, "ban", "Security banned a dangerous permission change"));
  const results = await Promise.all(tasks);
  const punishment = results[results.length - 1];
  const title = adminAdded && row.dpa ? "Dangerous Permissions Add" : "Dangerous Permissions Update";
  logEvent(guild, "events", title, `<@${executor}> changed <@&${roleId}>. The change was reversed. ${punishment === "banned" ? "Banned." : "The ban did not go through."}`);
}

function halted(guildId) {
  try {
    return !!require("./antinuke/store").get(guildId).policy.halted;
  } catch {
    return false;
  }
}

async function handleVanity(guild, entry) {
  const row = load(guild.id);
  if (!row.vanity || halted(guild.id)) return;
  const change = changesOf(entry).find((item) => item.key === "vanity_url_code");
  if (!change && guild.vanityURLCode === row.vanity_code) return;
  const next = change ? changeValue(change, "new") : guild.vanityURLCode;
  const executor = executorId(entry);
  if (trusted(guild, executor)) {
    save({ ...load(guild.id), vanity_code: next ? String(next) : null });
    return;
  }
  const saved = row.vanity_code || "";
  if (String(next || "") === String(saved)) return;
  const tasks = [];
  if (claim(`vanity-restore:${guild.id}:${next || ""}`)) tasks.push(restoreVanity(guild, saved || null));
  else tasks.push(Promise.resolve(false));
  if (executor && claim(`vanity-ban:${guild.id}:${executor}`)) tasks.push(punish(guild, executor, "ban", "Security banned a vanity change"));
  else tasks.push(Promise.resolve(executor ? "already" : "failed"));
  const [restored, punishment] = await Promise.all(tasks);
  const back = restored || String(guild.vanityURLCode || "") === String(saved);
  logEvent(
    guild,
    "events",
    "Vanity Protection",
    `<@${executor || "unknown"}> changed the vanity to \`${next || "none"}\`. ${back ? `Restored \`${saved || "none"}\`.` : "The vanity could not be restored yet."} ${punishment === "banned" ? "Banned." : "The ban did not go through."}`
  );
}

async function denyBot(guild, botUserId, adderId) {
  const row = load(guild.id);
  if (!row.deny_bots) return;
  if (trusted(guild, adderId)) return;
  if (!claim(`bot:${guild.id}:${botUserId}`)) return;
  const tasks = [punish(guild, botUserId, "ban", "Security denied a bot join")];
  if (adderId) tasks.push(punish(guild, adderId, "ban", "Security banned the member who added a bot"));
  const results = await Promise.all(tasks);
  logEvent(
    guild,
    "events",
    "Deny Bot Joins",
    `<@${botUserId}> joined${adderId ? ` through <@${adderId}>` : ""}. ${results[0] === "banned" ? "The bot was banned." : "The bot ban did not go through."} ${adderId ? (results[1] === "banned" ? "The member was banned." : "The member ban did not go through.") : ""}`
  );
}

async function handleMass(guild, entry, kind) {
  const row = load(guild.id);
  const enabled = kind === "kick" ? row.mass_kick : row.mass_ban;
  if (!enabled) return;
  const executor = executorId(entry);
  if (!executor || trusted(guild, executor)) return;
  const count = burst(guild.id, executor, kind, Number(entry.createdTimestamp) || Date.now());
  const threshold = kind === "kick" ? row.mass_kick_threshold : row.mass_ban_threshold;
  const punishment = kind === "kick" ? row.mass_kick_punishment : row.mass_ban_punishment;
  const title = kind === "kick" ? "Mass Member Kick" : "Mass Member Ban";
  const target = targetId(entry);
  logEvent(guild, "events", title, `<@${executor}> ${kind === "kick" ? "kicked" : "banned"} <@${target}> at ${stamp(Number(entry.createdTimestamp) || Date.now())} (${count}/${threshold})`);
  if (count < threshold) return;
  if (!claim(`mass:${kind}:${guild.id}:${executor}`)) return;
  bursts.delete(`${guild.id}:${executor}:${kind}`);
  const result = await punish(guild, executor, punishment, `Security ${title.toLowerCase()} threshold`);
  logEvent(guild, "events", title, `<@${executor}> passed ${threshold} in 8 seconds. ${result === "failed" ? "The punishment did not go through." : `Punishment: ${result}.`}`);
}

function roleIds(change) {
  return listOf(changeValue(change, "new")).map((role) => String(role?.id || role)).filter(Boolean);
}

async function watchRolesChanged(guild, entry) {
  const watched = watchRoles(guild.id);
  if (!watched.size) return;
  const executor = executorId(entry);
  const target = targetId(entry);
  const when = stamp(Number(entry.createdTimestamp) || Date.now());
  for (const change of changesOf(entry)) {
    const ids = roleIds(change).filter((id) => watched.has(id));
    if (!ids.length) continue;
    const verb = change.key === "$remove" ? "removed" : change.key === "$add" ? "gave" : "";
    if (!verb) continue;
    for (const roleId of ids) {
      const sentence = verb === "gave"
        ? `<@${executor}> gave <@&${roleId}> to <@${target}> at ${when}`
        : `<@${executor}> removed <@&${roleId}> from <@${target}> at ${when}`;
      logEvent(guild, "watch", "Watchlist", sentence);
    }
  }
}

function watchSentence(entry) {
  const action = entry.action;
  const target = targetId(entry);
  if (action === AuditLogEvent.MemberBanAdd) return `banned <@${target}>`;
  if (action === AuditLogEvent.MemberBanRemove) return `unbanned <@${target}>`;
  if (action === AuditLogEvent.MemberKick) return `kicked <@${target}>`;
  if (action === AuditLogEvent.MemberRoleUpdate) return `changed roles for <@${target}>`;
  if (action === AuditLogEvent.BotAdd) return `added bot <@${target}>`;
  if (action === AuditLogEvent.RoleCreate) return `created <@&${target}>`;
  if (action === AuditLogEvent.RoleDelete) return `deleted <@&${target}>`;
  if (action === AuditLogEvent.ChannelDelete) return `deleted <#${target}>`;
  if (action === AuditLogEvent.MemberUpdate) {
    const timeout = changesOf(entry).find((change) => change.key === "communication_disabled_until");
    if (timeout && changeValue(timeout, "new")) return `timed out <@${target}>`;
    if (timeout) return `cleared a timeout on <@${target}>`;
  }
  return "";
}

async function watchUserActions(guild, entry) {
  const users = watchUsers(guild.id);
  const executor = executorId(entry);
  if (!executor || !users.has(executor)) return;
  const sentence = watchSentence(entry);
  if (!sentence) return;
  logEvent(guild, "watch", "Watched member", `<@${executor}> ${sentence} at ${stamp(Number(entry.createdTimestamp) || Date.now())}`);
}

async function handleAudit(guild, entry) {
  if (!guild?.id || !entry) return;
  const when = Number(entry.createdTimestamp || Date.now());
  if (Date.now() - when > 20000) return;
  noteAudit(guild, entry);
  const action = entry.action;
  const tasks = [watchRolesChanged(guild, entry), watchUserActions(guild, entry)];
  if (action === AuditLogEvent.RoleUpdate) tasks.push(handleRole(guild, entry, false));
  if (action === AuditLogEvent.RoleCreate) tasks.push(handleRole(guild, entry, true));
  if (action === AuditLogEvent.GuildUpdate) tasks.push(handleVanity(guild, entry));
  if (action === AuditLogEvent.BotAdd) tasks.push(denyBot(guild, targetId(entry), executorId(entry)));
  if (action === AuditLogEvent.MemberKick) tasks.push(handleMass(guild, entry, "kick"));
  if (action === AuditLogEvent.MemberBanAdd) tasks.push(handleMass(guild, entry, "ban"));
  await Promise.all(tasks);
}

async function handleMemberAdd(member) {
  const user = member?.user || member;
  if (!user?.bot && !member?.bot) return;
  const guild = member.guild;
  if (!guild || !load(guild.id).deny_bots) return;
  const id = String(member.id || user.id);
  let adder = findRecent(guild.id, AuditLogEvent.BotAdd, id);
  if (!adder && typeof guild.fetchAuditLogs === "function") {
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 1 }).catch(() => null);
    const entry = listOf(logs?.entries)[0];
    if (entry && (!targetId(entry) || targetId(entry) === id)) adder = executorId(entry);
  }
  if (!adder) return;
  await denyBot(guild, id, adder);
}

async function handleGuildUpdate(before, after) {
  if (!after?.id || before?.vanityURLCode === after.vanityURLCode) return;
  if (halted(after.id)) return;
  const row = load(after.id);
  if (!row.vanity) return;
  if (String(after.vanityURLCode || "") === String(row.vanity_code || "")) return;
  const executor = findRecent(after.id, AuditLogEvent.GuildUpdate, after.id);
  if (!executor || trusted(after, executor)) return;
  if (!claim(`vanity-restore:${after.id}:${after.vanityURLCode || ""}`)) return;
  const restored = await restoreVanity(after, row.vanity_code || null);
  logEvent(after, "events", "Vanity Protection", `The vanity changed to \`${after.vanityURLCode || "none"}\`. ${restored ? `Restored \`${row.vanity_code || "none"}\`.` : "The vanity could not be restored yet."}`);
}

const boundClients = new WeakSet();

function bind(client) {
  if (!client || boundClients.has(client)) return;
  boundClients.add(client);
  client.on("guildAuditLogEntryCreate", (entry, guild) => {
    handleAudit(guild, entry).catch((error) => console.error("[security]", error));
  });
  client.on("guildMemberAdd", (member) => {
    handleMemberAdd(member).catch((error) => console.error("[security]", error));
  });
  client.on("guildUpdate", (before, after) => {
    handleGuildUpdate(before, after).catch((error) => console.error("[security]", error));
  });
}

function denied(message) {
  return reply(message, "Access Denied", "Only the server owner and Anti-Nuke admins can change security.");
}

function switched(on) {
  return on ? "on" : "off";
}

async function setToggle(message, field, label, enabled) {
  let row = save({ ...load(message.guild.id), [field]: enabled ? 1 : 0 });
  if (field === "vanity" && enabled) {
    let code = message.guild.vanityURLCode || null;
    if (typeof message.guild.fetchVanityData === "function") {
      const data = await message.guild.fetchVanityData().catch(() => null);
      if (data && Object.prototype.hasOwnProperty.call(data, "code")) code = data.code || null;
    }
    row = save({ ...row, vanity_code: code });
  }
  let channelNote = "";
  if (enabled) {
    const channel = await ensureChannel(message.guild, "events").catch(() => null);
    channelNote = channel ? ` Events show in <#${channel.id}>. Only administrators can see it.` : " I couldn't create the private event channel.";
  }
  const saved = field === "vanity" && enabled ? ` Saved vanity: \`${row.vanity_code || "none"}\`.` : "";
  return reply(message, "Security", `**${label}** is ${switched(enabled)}.${saved}${channelNote}`);
}

function whole(value) {
  if (!/^\d+$/.test(String(value || ""))) return null;
  const number = Number(value);
  if (number < 1 || number > 25) return null;
  return number;
}

async function setMass(message, kind, args) {
  const row = load(message.guild.id);
  const enabledField = kind === "kick" ? "mass_kick" : "mass_ban";
  const thresholdField = kind === "kick" ? "mass_kick_threshold" : "mass_ban_threshold";
  const punishmentField = kind === "kick" ? "mass_kick_punishment" : "mass_ban_punishment";
  const label = kind === "kick" ? "Mass Member Kick" : "Mass Member Ban";
  const usageKey = kind === "kick" ? "massmemberkick" : "massmemberban";
  const sub = String(args[1] || "").toLowerCase();
  if (!sub) return replyUsage(message, usageKey);
  if (sub === "on" || sub === "off" || sub === "enable" || sub === "disable") {
    const enabled = sub === "on" || sub === "enable";
    save({ ...row, [enabledField]: enabled ? 1 : 0 });
    let note = "";
    if (enabled) {
      const channel = await ensureChannel(message.guild, "events").catch(() => null);
      note = channel ? ` Events show in <#${channel.id}>.` : "";
    }
    const current = load(message.guild.id);
    return reply(message, "Security", `**${label}** is ${switched(enabled)}. Threshold ${current[thresholdField]} in 8 seconds. Punishment: ${current[punishmentField]}.${note}`);
  }
  if (sub === "threshold") {
    const number = whole(args[2]);
    if (!number) return replyUsage(message, usageKey);
    save({ ...row, [thresholdField]: number });
    return reply(message, "Security", `**${label}** threshold is ${number} in 8 seconds.`);
  }
  if (sub === "punishment") {
    const punishment = String(args[2] || "").toLowerCase();
    if (!["ban", "kick", "strip"].includes(punishment)) return replyUsage(message, usageKey);
    save({ ...row, [punishmentField]: punishment });
    return reply(message, "Security", `**${label}** punishment is ${punishment}.`);
  }
  return replyUsage(message, usageKey);
}

function statusText(guild) {
  const row = load(guild.id);
  const roles = [...watchRoles(guild.id)];
  const users = [...watchUsers(guild.id)];
  return [
    `**Vanity Protection** · ${row.vanity ? "On" : "Off"}`,
    row.vanity ? `Saved vanity: \`${row.vanity_code || "none"}\`` : "Disabled. No threshold.",
    "",
    `**Dangerous Permissions Add** · ${row.dpa ? "On" : "Off"}`,
    "Disabled modules do nothing. Enabled: administrator added to a role is removed and that member is banned. No threshold.",
    "",
    `**Dangerous Permissions Update** · ${row.dpu ? "On" : "Off"}`,
    "Enabled: Ban Members, Kick Members, Manage Server, or Manage Webhooks added to a role is removed and that member is banned. No threshold.",
    "",
    `**Deny Bot Joins** · ${row.deny_bots ? "On" : "Off"}`,
    "Enabled: the bot and the member who added it are banned. No threshold.",
    "",
    `**Mass Member Kick** · ${row.mass_kick ? "On" : "Off"}`,
    `Threshold ${row.mass_kick_threshold} in 8 seconds · punishment ${row.mass_kick_punishment}`,
    "",
    `**Mass Member Ban** · ${row.mass_ban ? "On" : "Off"}`,
    `Threshold ${row.mass_ban_threshold} in 8 seconds · punishment ${row.mass_ban_punishment}`,
    "",
    `**Watch roles** · ${roles.length ? roles.map((id) => `<@&${id}>`).join(", ") : "none"}`,
    `**Watched members** · ${users.length ? users.map((id) => `<@${id}>`).join(", ") : "none"}`,
    `**Event log** · ${row.events_channel_id ? `<#${row.events_channel_id}>` : "not created"}`,
    `**Watch log** · ${row.watch_channel_id ? `<#${row.watch_channel_id}>` : "not created"}`,
    "",
    "Whitelist: the server owner, this bot, and Anti-Nuke admins."
  ].join("\n");
}

async function watchRole(message, argument, remove) {
  const role = await resolveRole(message, argument);
  if (!role?.id || role.id === message.guild.id) return replyUsage(message, remove ? "unwatchrole" : "setwatchrole");
  const roles = watchRoles(message.guild.id);
  if (remove) {
    if (!roles.has(role.id)) return reply(message, "Watchlist", `<@&${role.id}> is not on the watchlist.`);
    statements.removeWatchRole.run(String(message.guild.id), String(role.id));
    roles.delete(role.id);
    return reply(message, "Watchlist", `Stopped watching <@&${role.id}>.`);
  }
  if (roles.has(role.id)) return reply(message, "Watchlist", `<@&${role.id}> is already on the watchlist.`);
  statements.addWatchRole.run(String(message.guild.id), String(role.id));
  roles.add(role.id);
  const channel = roles.size === 1 ? await ensureChannel(message.guild, "watch").catch(() => null) : guildChannel(message.guild, "watch");
  const where = channel ? ` Logs show in <#${channel.id}>. Only administrators can see it.` : "";
  return reply(message, "Watchlist", `Watching <@&${role.id}>.${where}`);
}

function guildChannel(guild, kind) {
  const row = load(guild.id);
  const id = kind === "watch" ? row.watch_channel_id : row.events_channel_id;
  return id && guild.channels?.cache?.get?.(id);
}

async function watchMember(message, argument, remove) {
  const member = await resolveMember(message, argument);
  const id = member?.id;
  if (!id) return replyUsage(message, remove ? "unwatchuser" : "watchuser");
  const users = watchUsers(message.guild.id);
  if (remove) {
    if (!users.has(id)) return reply(message, "Watchlist", `<@${id}> is not being watched.`);
    statements.removeWatchUser.run(String(message.guild.id), String(id));
    users.delete(id);
    return reply(message, "Watchlist", `Stopped watching <@${id}>.`);
  }
  if (users.has(id)) return reply(message, "Watchlist", `<@${id}> is already being watched.`);
  statements.addWatchUser.run(String(message.guild.id), String(id));
  users.add(id);
  const channel = users.size === 1 && !load(message.guild.id).watch_channel_id
    ? await ensureChannel(message.guild, "watch").catch(() => null)
    : guildChannel(message.guild, "watch");
  const where = channel ? ` Moderation they do shows in <#${channel.id}>.` : "";
  return reply(message, "Watchlist", `Watching <@${id}>.${where}`);
}

async function handleCommand(message, name, args) {
  const action = COMMANDS[name];
  if (!action) return false;
  if (!canConfigure(message)) {
    await denied(message);
    return true;
  }
  if (action === "config") {
    await reply(message, "Security", statusText(message.guild));
    return true;
  }
  if (action === "dpa" || action === "dpu" || action === "vanity" || action === "bots") {
    const flag = String(args[1] || "").toLowerCase();
    const enabled = flag === "on" || flag === "enable";
    const disabled = flag === "off" || flag === "disable";
    if (!enabled && !disabled) {
      const key = { dpa: "dangerouspermissionsadd", dpu: "dangerouspermissionsupdate", vanity: "vanityprotection", bots: "denybotjoins" }[action];
      await replyUsage(message, key);
      return true;
    }
    const field = { dpa: "dpa", dpu: "dpu", vanity: "vanity", bots: "deny_bots" }[action];
    const label = { dpa: "Dangerous Permissions Add", dpu: "Dangerous Permissions Update", vanity: "Vanity Protection", bots: "Deny Bot Joins" }[action];
    await setToggle(message, field, label, enabled);
    return true;
  }
  if (action === "masskick" || action === "massban") {
    await setMass(message, action === "masskick" ? "kick" : "ban", args);
    return true;
  }
  if (action === "watchrole" || action === "unwatchrole") {
    await watchRole(message, args.slice(1).join(" "), action === "unwatchrole");
    return true;
  }
  if (action === "watchuser" || action === "unwatchuser") {
    await watchMember(message, args.slice(1).join(" "), action === "unwatchuser");
    return true;
  }
  return false;
}

module.exports = {
  bind,
  handleCommand,
  handleAudit,
  handleMemberAdd,
  handleGuildUpdate,
  ensureChannel,
  stamp,
  load
};
