const { connection } = require("../db");

const MODULES = [
  ["massBan", "Mass ban"],
  ["massKick", "Mass kick"],
  ["channelDelete", "Channel deletion"],
  ["roleDelete", "Role deletion"],
  ["permissions", "Permission escalation"],
  ["vanity", "Vanity URL"],
  ["serverSettings", "Server settings"],
  ["compromisedBot", "Compromised bots"],
  ["webhook", "Webhooks"],
  ["antiRaid", "Anti-raid"],
  ["lockdown", "Emergency lockdown"],
  ["snapshots", "Snapshots and recovery"]
];

const THRESHOLD_FIELDS = [
  ["banWarning", "Ban warning", 3, 5],
  ["banLock", "Ban lockdown", 5, 10],
  ["kickWarning", "Kick warning", 3, 5],
  ["kickLock", "Kick lockdown", 5, 10],
  ["combinedEmergency", "Combined member emergency", 8, 15],
  ["channelWarning", "Channel deletion warning", 2, 5],
  ["channelLock", "Channel deletion lockdown", 3, 8],
  ["roleWarning", "Role deletion warning", 2, 5],
  ["roleLock", "Role deletion lockdown", 3, 8],
  ["webhookWarning", "Webhook warning", 2, 10],
  ["webhookLock", "Webhook lockdown", 3, 10],
  ["raidWarning", "Join warning", 10, 10],
  ["raidEmergency", "Join emergency", 20, 10]
];

const LOCK_FIELDS = [
  ["stripRoles", "Remove dangerous roles from the executor"],
  ["restrictStaff", "Remove dangerous roles the executor is holding"],
  ["restrictOps", "Raise verification while locked down"],
  ["alertOwner", "Alert the server owner"],
  ["logIncident", "Send the incident to the security log"],
  ["snapshot", "Save a snapshot"],
  ["recover", "Recreate deleted channels and roles when we still have them"],
  ["raidMode", "Treat a join burst plus destructive activity as a raid"]
];

const POLICY_FIELDS = [
  ["bypassPunishment", "Trusted accounts skip automatic punishment"],
  ["bypassLockdown", "Trusted accounts do not trigger lockdown"],
  ["dangerousChanges", "Trusted users may change dangerous permissions"],
  ["botsDestructive", "Trusted bots may take destructive actions"],
  ["modifySettings", "Trusted accounts may edit anti-nuke settings"]
];

function modules(on = true) {
  return Object.fromEntries(MODULES.map(([key]) => [key, !!on]));
}

function thresholds() {
  return Object.fromEntries(THRESHOLD_FIELDS.map(([key, , count, seconds]) => [key, { count, seconds }]));
}

function lockdown() {
  return Object.fromEntries(LOCK_FIELDS.map(([key]) => [key, true]));
}

function policy() {
  return {
    bypassPunishment: true,
    bypassLockdown: false,
    dangerousChanges: false,
    botsDestructive: false,
    modifySettings: false,
    halted: false
  };
}

function defaults() {
  return {
    active: 0,
    modules: modules(true),
    thresholds: thresholds(),
    lockdown: lockdown(),
    policy: policy(),
    logChannelId: null,
    snapshotMinutes: 60,
    snapshotKeep: 5,
    lockdownActive: 0,
    lockState: null
  };
}

connection.exec(`
CREATE TABLE IF NOT EXISTS antinuke_guard (
  guild_id TEXT PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 0,
  modules TEXT NOT NULL,
  thresholds TEXT NOT NULL,
  lockdown TEXT NOT NULL,
  policy TEXT NOT NULL,
  log_channel_id TEXT,
  snapshot_minutes INTEGER NOT NULL DEFAULT 60,
  snapshot_keep INTEGER NOT NULL DEFAULT 5,
  lockdown_active INTEGER NOT NULL DEFAULT 0,
  lock_state TEXT,
  last_incident_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS antinuke_whitelist (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  added_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE IF NOT EXISTS antinuke_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  setting TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS antinuke_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  severity TEXT NOT NULL,
  action TEXT NOT NULL,
  executor_id TEXT,
  target_id TEXT,
  count INTEGER,
  window_ms INTEGER,
  threshold INTEGER,
  whitelisted INTEGER NOT NULL DEFAULT 0,
  lockdown INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS antinuke_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  data TEXT NOT NULL
);
`);

const statements = {
  get: connection.prepare("SELECT * FROM antinuke_guard WHERE guild_id=?"),
  save: connection.prepare(`
    INSERT INTO antinuke_guard (
      guild_id, active, modules, thresholds, lockdown, policy, log_channel_id,
      snapshot_minutes, snapshot_keep, lockdown_active, lock_state, last_incident_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      active=excluded.active, modules=excluded.modules, thresholds=excluded.thresholds,
      lockdown=excluded.lockdown, policy=excluded.policy, log_channel_id=excluded.log_channel_id,
      snapshot_minutes=excluded.snapshot_minutes, snapshot_keep=excluded.snapshot_keep,
      lockdown_active=excluded.lockdown_active, lock_state=excluded.lock_state,
      last_incident_at=excluded.last_incident_at, updated_at=excluded.updated_at
  `),
  addWhitelist: connection.prepare(`
    INSERT INTO antinuke_whitelist (guild_id, user_id, kind, name, added_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET kind=excluded.kind, name=excluded.name, added_by=excluded.added_by
  `),
  removeWhitelist: connection.prepare("DELETE FROM antinuke_whitelist WHERE guild_id=? AND user_id=?"),
  clearWhitelist: connection.prepare("DELETE FROM antinuke_whitelist WHERE guild_id=?"),
  listWhitelist: connection.prepare("SELECT * FROM antinuke_whitelist WHERE guild_id=? ORDER BY created_at"),
  oneWhitelist: connection.prepare("SELECT * FROM antinuke_whitelist WHERE guild_id=? AND user_id=?"),
  change: connection.prepare("INSERT INTO antinuke_changes (guild_id, user_id, setting, at) VALUES (?, ?, ?, ?)"),
  incident: connection.prepare(`
    INSERT INTO antinuke_incidents (
      guild_id, at, severity, action, executor_id, target_id, count, window_ms, threshold, whitelisted, lockdown, result, detail
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  recentIncidents: connection.prepare("SELECT * FROM antinuke_incidents WHERE guild_id=? ORDER BY id DESC LIMIT ? OFFSET ?"),
  countIncidents: connection.prepare("SELECT COUNT(*) AS total FROM antinuke_incidents WHERE guild_id=?"),
  lastIncident: connection.prepare("SELECT * FROM antinuke_incidents WHERE guild_id=? ORDER BY id DESC LIMIT 1"),
  touchIncident: connection.prepare("UPDATE antinuke_guard SET last_incident_at=? WHERE guild_id=?"),
  addSnapshot: connection.prepare("INSERT INTO antinuke_snapshots (guild_id, at, data) VALUES (?, ?, ?)"),
  listSnapshots: connection.prepare("SELECT id, guild_id, at FROM antinuke_snapshots WHERE guild_id=? ORDER BY id DESC LIMIT ?"),
  getSnapshot: connection.prepare("SELECT * FROM antinuke_snapshots WHERE guild_id=? AND id=?"),
  trimSnapshots: connection.prepare(`
    DELETE FROM antinuke_snapshots WHERE guild_id=? AND id NOT IN (
      SELECT id FROM antinuke_snapshots WHERE guild_id=? ORDER BY id DESC LIMIT ?
    )
  `)
};

function readJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || "");
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function shape(row) {
  const base = defaults();
  if (!row) return base;
  return {
    active: Number(row.active) || 0,
    modules: { ...base.modules, ...readJson(row.modules, {}) },
    thresholds: { ...base.thresholds, ...readJson(row.thresholds, {}) },
    lockdown: { ...base.lockdown, ...readJson(row.lockdown, {}) },
    policy: { ...base.policy, ...readJson(row.policy, {}) },
    logChannelId: row.log_channel_id || null,
    snapshotMinutes: Number(row.snapshot_minutes) || 60,
    snapshotKeep: Number(row.snapshot_keep) || 5,
    lockdownActive: Number(row.lockdown_active) || 0,
    lockState: readJson(row.lock_state, null),
    lastIncidentAt: row.last_incident_at || null
  };
}

function get(guildId) {
  return shape(statements.get.get(String(guildId)));
}

function saved(guildId) {
  return statements.get.get(String(guildId)) ? get(guildId) : null;
}

function save(guildId, config, userId, setting) {
  const next = { ...defaults(), ...config };
  statements.save.run(
    String(guildId),
    next.active ? 1 : 0,
    JSON.stringify(next.modules),
    JSON.stringify(next.thresholds),
    JSON.stringify(next.lockdown),
    JSON.stringify(next.policy),
    next.logChannelId || null,
    clamp(next.snapshotMinutes, 5, 1440, 60),
    clamp(next.snapshotKeep, 1, 30, 5),
    next.lockdownActive ? 1 : 0,
    next.lockState ? JSON.stringify(next.lockState) : null,
    next.lastIncidentAt || null,
    Date.now()
  );
  if (userId && setting) statements.change.run(String(guildId), String(userId), String(setting).slice(0, 180), Date.now());
  return get(guildId);
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function setThreshold(config, key, count, seconds) {
  if (!config.thresholds[key]) return false;
  config.thresholds[key] = {
    count: clamp(count, 1, 50, config.thresholds[key].count),
    seconds: clamp(seconds, 1, 120, config.thresholds[key].seconds)
  };
  return true;
}

function whitelist(guildId) {
  return statements.listWhitelist.all(String(guildId));
}

function whitelistOne(guildId, userId) {
  return statements.oneWhitelist.get(String(guildId), String(userId)) || null;
}

function addWhitelist(guildId, userId, kind, name, addedBy) {
  statements.addWhitelist.run(String(guildId), String(userId), kind === "bot" ? "bot" : "user", name || null, addedBy ? String(addedBy) : null, Date.now());
}

function removeWhitelist(guildId, userId) {
  return statements.removeWhitelist.run(String(guildId), String(userId)).changes > 0;
}

function clearWhitelist(guildId) {
  return statements.clearWhitelist.run(String(guildId)).changes;
}

function incident(guildId, row) {
  const info = statements.incident.run(
    String(guildId),
    row.at || Date.now(),
    row.severity || "info",
    row.action || "event",
    row.executorId ? String(row.executorId) : null,
    row.targetId ? String(row.targetId) : null,
    row.count ?? null,
    row.windowMs ?? null,
    row.threshold ?? null,
    row.whitelisted ? 1 : 0,
    row.lockdown ? 1 : 0,
    row.result || null,
    row.detail ? String(row.detail).slice(0, 500) : null
  );
  statements.touchIncident.run(row.at || Date.now(), String(guildId));
  return Number(info.lastInsertRowid);
}

function incidents(guildId, page = 0, size = 5) {
  const total = statements.countIncidents.get(String(guildId))?.total || 0;
  const rows = statements.recentIncidents.all(String(guildId), size, Math.max(0, page) * size);
  return { total, rows, page };
}

function lastIncident(guildId) {
  return statements.lastIncident.get(String(guildId)) || null;
}

function stripSecrets(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripSecrets);
  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|password|secret/i.test(key)) continue;
    clean[key] = stripSecrets(item);
  }
  return clean;
}

function addSnapshot(guildId, data, keep) {
  const clean = stripSecrets(JSON.parse(JSON.stringify(data)));
  statements.addSnapshot.run(String(guildId), Date.now(), JSON.stringify(clean));
  statements.trimSnapshots.run(String(guildId), String(guildId), keep || 5);
}

function snapshots(guildId, limit = 5) {
  return statements.listSnapshots.all(String(guildId), limit);
}

function halt(guildId, userId) {
  const config = get(guildId);
  config.active = 0;
  config.policy.halted = true;
  config.lockdownActive = 0;
  config.lockState = null;
  return save(guildId, config, userId, "antinukealloff");
}

function snapshot(guildId, id) {
  const row = statements.getSnapshot.get(String(guildId), Number(id));
  if (!row) return null;
  return { id: row.id, at: row.at, data: readJson(row.data, {}) };
}

module.exports = {
  MODULES,
  THRESHOLD_FIELDS,
  LOCK_FIELDS,
  POLICY_FIELDS,
  defaults,
  get,
  saved,
  save,
  setThreshold,
  clamp,
  whitelist,
  whitelistOne,
  addWhitelist,
  removeWhitelist,
  clearWhitelist,
  incident,
  incidents,
  lastIncident,
  addSnapshot,
  snapshots,
  snapshot,
  halt
};
