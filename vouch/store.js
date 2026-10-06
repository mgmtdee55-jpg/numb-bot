const { connection } = require("../db");
const { DEFAULT_ALLOWANCE, DEFAULT_PREFIX } = require("./constants");

connection.exec(`
CREATE TABLE IF NOT EXISTS bot_settings (
  guild_id TEXT PRIMARY KEY,
  prefix TEXT
);

CREATE TABLE IF NOT EXISTS command_aliases (
  guild_id TEXT NOT NULL,
  shortcut TEXT NOT NULL,
  command_text TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, shortcut)
);

CREATE TABLE IF NOT EXISTS vouch_config (
  guild_id TEXT PRIMARY KEY,
  vouch_role_id TEXT,
  reward_role_id TEXT,
  stripstaff_role_id TEXT,
  log_channel_id TEXT,
  founder_role_id TEXT
);

CREATE TABLE IF NOT EXISTS vouch_os (
  guild_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  added_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, target_id, target_type)
);

CREATE TABLE IF NOT EXISTS vouch_admins (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  added_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  removed_at INTEGER,
  removed_by TEXT,
  remove_reason TEXT,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS vouch_givers (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  added_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  removed_at INTEGER,
  removed_by TEXT,
  remove_reason TEXT,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS vouch_allowances (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  max_vouches INTEGER NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS vouches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  giver_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  removed_at INTEGER,
  removed_by TEXT,
  remove_reason TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vouches_one_active
  ON vouches(guild_id, target_id) WHERE active = 1;

CREATE INDEX IF NOT EXISTS idx_vouches_giver
  ON vouches(guild_id, giver_id, active);

CREATE TABLE IF NOT EXISTS vouch_blacklist (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT,
  added_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS vouch_role_limits (
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  max_members INTEGER NOT NULL,
  set_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, role_id)
);

CREATE TABLE IF NOT EXISTS vouch_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT,
  target_id TEXT,
  reason TEXT,
  automatic INTEGER NOT NULL DEFAULT 0,
  details TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vouch_logs_guild
  ON vouch_logs(guild_id, created_at);

CREATE TABLE IF NOT EXISTS vouch_punishments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  reason TEXT,
  actor_id TEXT,
  removed_roles TEXT,
  automatic INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS forced_nicknames (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  set_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS forced_role_strips (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  set_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, role_id)
);

CREATE TABLE IF NOT EXISTS vouch_caps (
  guild_id TEXT PRIMARY KEY,
  global_max INTEGER,
  giver_max INTEGER
);
`);

function addColumnIfMissing(table, column, definition) {
  const columns = connection.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    connection.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing("vouch_config", "founder_role_id", "TEXT");

const statements = {
  getPrefix: connection.prepare("SELECT prefix FROM bot_settings WHERE guild_id=?"),
  setPrefix: connection.prepare(`
    INSERT INTO bot_settings(guild_id, prefix) VALUES(?,?)
    ON CONFLICT(guild_id) DO UPDATE SET prefix=excluded.prefix
  `),
  getAlias: connection.prepare("SELECT command_text FROM command_aliases WHERE guild_id=? AND shortcut=?"),
  setAlias: connection.prepare(`
    INSERT INTO command_aliases(guild_id, shortcut, command_text, created_by, created_at)
    VALUES(?,?,?,?,?)
    ON CONFLICT(guild_id, shortcut) DO UPDATE SET
      command_text=excluded.command_text,
      created_by=excluded.created_by,
      created_at=excluded.created_at
  `),
  removeAlias: connection.prepare("DELETE FROM command_aliases WHERE guild_id=? AND shortcut=?"),
  listAliases: connection.prepare("SELECT shortcut, command_text, created_by, created_at FROM command_aliases WHERE guild_id=? ORDER BY shortcut"),
  getConfig: connection.prepare("SELECT * FROM vouch_config WHERE guild_id=?"),
  ensureConfig: connection.prepare("INSERT OR IGNORE INTO vouch_config(guild_id) VALUES(?)"),
  getOs: connection.prepare("SELECT 1 FROM vouch_os WHERE guild_id=? AND target_id=? AND target_type=?"),
  addOs: connection.prepare("INSERT OR IGNORE INTO vouch_os(guild_id, target_id, target_type, added_by, created_at) VALUES(?,?,?,?,?)"),
  removeOs: connection.prepare("DELETE FROM vouch_os WHERE guild_id=? AND target_id=? AND target_type=?"),
  listOs: connection.prepare("SELECT target_id, target_type, added_by, created_at FROM vouch_os WHERE guild_id=? ORDER BY target_type, created_at"),
  osRoles: connection.prepare("SELECT target_id FROM vouch_os WHERE guild_id=? AND target_type='role'"),
  getAdmin: connection.prepare("SELECT * FROM vouch_admins WHERE guild_id=? AND user_id=?"),
  getGiver: connection.prepare("SELECT * FROM vouch_givers WHERE guild_id=? AND user_id=?"),
  listActiveGivers: connection.prepare("SELECT * FROM vouch_givers WHERE guild_id=? AND active=1 ORDER BY created_at ASC"),
  getAllowance: connection.prepare("SELECT max_vouches FROM vouch_allowances WHERE guild_id=? AND user_id=?"),
  setAllowance: connection.prepare(`
    INSERT INTO vouch_allowances(guild_id, user_id, max_vouches, updated_by, updated_at)
    VALUES(?,?,?,?,?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      max_vouches=excluded.max_vouches,
      updated_by=excluded.updated_by,
      updated_at=excluded.updated_at
  `),
  clearAllowance: connection.prepare("DELETE FROM vouch_allowances WHERE guild_id=? AND user_id=?"),
  listAllowances: connection.prepare("SELECT * FROM vouch_allowances WHERE guild_id=? ORDER BY updated_at DESC"),
  getCaps: connection.prepare("SELECT global_max, giver_max FROM vouch_caps WHERE guild_id=?"),
  ensureCaps: connection.prepare("INSERT OR IGNORE INTO vouch_caps(guild_id, global_max, giver_max) VALUES(?, NULL, NULL)"),
  setGlobalCap: connection.prepare("UPDATE vouch_caps SET global_max=? WHERE guild_id=?"),
  setGiverCap: connection.prepare("UPDATE vouch_caps SET giver_max=? WHERE guild_id=?"),
  countByGiver: connection.prepare("SELECT COUNT(*) AS n FROM vouches WHERE guild_id=? AND giver_id=? AND active=1"),
  getActive: connection.prepare("SELECT * FROM vouches WHERE guild_id=? AND target_id=? AND active=1"),
  listByGiver: connection.prepare("SELECT * FROM vouches WHERE guild_id=? AND giver_id=? AND active=1 ORDER BY created_at ASC, id ASC"),
  insertVouch: connection.prepare(`
    INSERT INTO vouches(guild_id, giver_id, target_id, reason, created_at, active)
    VALUES(?,?,?,?,?,1)
  `),
  deleteVouch: connection.prepare("DELETE FROM vouches WHERE id=? AND active=1"),
  latestRemoved: connection.prepare("SELECT * FROM vouches WHERE guild_id=? AND target_id=? AND active=0 ORDER BY removed_at DESC, id DESC LIMIT 1"),
  countActive: connection.prepare("SELECT COUNT(*) AS n FROM vouches WHERE guild_id=? AND active=1"),
  listActive: connection.prepare("SELECT * FROM vouches WHERE guild_id=? AND active=1 ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"),
  allActive: connection.prepare("SELECT * FROM vouches WHERE guild_id=? AND active=1 ORDER BY id ASC"),
  isBlacklisted: connection.prepare("SELECT 1 FROM vouch_blacklist WHERE guild_id=? AND user_id=?"),
  getBlacklist: connection.prepare("SELECT * FROM vouch_blacklist WHERE guild_id=? AND user_id=?"),
  addBlacklist: connection.prepare(`
    INSERT INTO vouch_blacklist(guild_id, user_id, reason, added_by, created_at)
    VALUES(?,?,?,?,?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      reason=excluded.reason,
      added_by=excluded.added_by,
      created_at=excluded.created_at
  `),
  removeBlacklist: connection.prepare("DELETE FROM vouch_blacklist WHERE guild_id=? AND user_id=?"),
  countBlacklist: connection.prepare("SELECT COUNT(*) AS n FROM vouch_blacklist WHERE guild_id=?"),
  listBlacklist: connection.prepare("SELECT * FROM vouch_blacklist WHERE guild_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?"),
  getRoleLimit: connection.prepare("SELECT * FROM vouch_role_limits WHERE guild_id=? AND role_id=?"),
  setRoleLimit: connection.prepare(`
    INSERT INTO vouch_role_limits(guild_id, role_id, max_members, set_by, created_at)
    VALUES(?,?,?,?,?)
    ON CONFLICT(guild_id, role_id) DO UPDATE SET
      max_members=excluded.max_members,
      set_by=excluded.set_by,
      created_at=excluded.created_at
  `),
  deleteRoleLimit: connection.prepare("DELETE FROM vouch_role_limits WHERE guild_id=? AND role_id=?"),
  listRoleLimits: connection.prepare("SELECT * FROM vouch_role_limits WHERE guild_id=? ORDER BY created_at ASC"),
  addLog: connection.prepare(`
    INSERT INTO vouch_logs(guild_id, action, actor_id, target_id, reason, automatic, details, created_at)
    VALUES(?,?,?,?,?,?,?,?)
  `),
  listLogs: connection.prepare("SELECT * FROM vouch_logs WHERE guild_id=? ORDER BY id DESC LIMIT ?"),
  addPunishment: connection.prepare(`
    INSERT INTO vouch_punishments(guild_id, user_id, type, reason, actor_id, removed_roles, automatic, created_at)
    VALUES(?,?,?,?,?,?,?,?)
  `),
  listPunishments: connection.prepare("SELECT * FROM vouch_punishments WHERE guild_id=? ORDER BY id DESC LIMIT ?"),
  punishmentsFor: connection.prepare("SELECT * FROM vouch_punishments WHERE guild_id=? AND user_id=? ORDER BY id DESC"),
  setNick: connection.prepare(`
    INSERT INTO forced_nicknames(guild_id, user_id, nickname, set_by, created_at)
    VALUES(?,?,?,?,?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      nickname=excluded.nickname,
      set_by=excluded.set_by,
      created_at=excluded.created_at
  `),
  getNick: connection.prepare("SELECT * FROM forced_nicknames WHERE guild_id=? AND user_id=?"),
  clearNick: connection.prepare("DELETE FROM forced_nicknames WHERE guild_id=? AND user_id=?"),
  listNicks: connection.prepare("SELECT * FROM forced_nicknames WHERE guild_id=?"),
  addStrip: connection.prepare("INSERT OR IGNORE INTO forced_role_strips(guild_id, user_id, role_id, set_by, created_at) VALUES(?,?,?,?,?)"),
  stripsForUser: connection.prepare("SELECT * FROM forced_role_strips WHERE guild_id=? AND user_id=? ORDER BY created_at ASC"),
  isStripped: connection.prepare("SELECT 1 FROM forced_role_strips WHERE guild_id=? AND user_id=? AND role_id=?"),
  clearStrips: connection.prepare("DELETE FROM forced_role_strips WHERE guild_id=? AND user_id=?"),
  allStrips: connection.prepare("SELECT * FROM forced_role_strips WHERE guild_id=?"),
  deleteStripsForRole: connection.prepare("DELETE FROM forced_role_strips WHERE guild_id=? AND role_id=?")
};

function key(value) {
  return value == null ? null : String(value);
}

function blankConfig(guildId) {
  return {
    guild_id: key(guildId),
    vouch_role_id: null,
    reward_role_id: null,
    stripstaff_role_id: null,
    log_channel_id: null,
    founder_role_id: null
  };
}

const CONFIG_FIELDS = new Set(["vouch_role_id", "reward_role_id", "stripstaff_role_id", "log_channel_id", "founder_role_id"]);

function setConfigField(guildId, field, value) {
  if (!CONFIG_FIELDS.has(field)) throw new Error(`Unknown vouch config field: ${field}`);
  const guild = key(guildId);
  statements.ensureConfig.run(guild);
  connection.prepare(`UPDATE vouch_config SET ${field}=? WHERE guild_id=?`).run(value == null ? null : String(value), guild);
}

function upsertStaff(table, guildId, userId, addedBy) {
  const select = table === "vouch_admins" ? statements.getAdmin : statements.getGiver;
  const guild = key(guildId);
  const user = key(userId);
  const existing = select.get(guild, user);
  const now = Date.now();
  if (existing?.active) return { already: true, row: existing };
  if (existing) {
    connection.prepare(`
      UPDATE ${table}
      SET active=1, added_by=?, updated_at=?, removed_at=NULL, removed_by=NULL, remove_reason=NULL
      WHERE guild_id=? AND user_id=?
    `).run(addedBy == null ? null : String(addedBy), now, guild, user);
    return { already: false, reactivated: true, row: select.get(guild, user) };
  }
  connection.prepare(`
    INSERT INTO ${table}(guild_id, user_id, added_by, created_at, updated_at, active)
    VALUES(?,?,?,?,?,1)
  `).run(guild, user, addedBy == null ? null : String(addedBy), now, now);
  return { already: false, reactivated: false, row: select.get(guild, user) };
}

function deactivateStaff(table, guildId, userId, removedBy, reason) {
  const select = table === "vouch_admins" ? statements.getAdmin : statements.getGiver;
  const guild = key(guildId);
  const user = key(userId);
  const existing = select.get(guild, user);
  if (!existing?.active) return null;
  const now = Date.now();
  connection.prepare(`
    UPDATE ${table}
    SET active=0, updated_at=?, removed_at=?, removed_by=?, remove_reason=?
    WHERE guild_id=? AND user_id=? AND active=1
  `).run(now, now, removedBy == null ? null : String(removedBy), reason || null, guild, user);
  return existing;
}

const reserveVouch = connection.transaction((row) => {
  const guild = key(row.guildId);
  const giver = key(row.giverId);
  const target = key(row.targetId);
  const existing = statements.getActive.get(guild, target);
  if (existing) return { ok: false, code: "active", vouch: existing };
  const max = getMaxAllowance(guild, giver);
  const used = statements.countByGiver.get(guild, giver).n;
  if (used >= max) return { ok: false, code: "allowance", used, max };
  try {
    const result = statements.insertVouch.run(guild, giver, target, row.reason || null, Date.now());
    return { ok: true, id: Number(result.lastInsertRowid), used: used + 1, max };
  } catch (error) {
    if (String(error.code || "").includes("CONSTRAINT")) return { ok: false, code: "active" };
    throw error;
  }
});

function deactivateMatching(guildId, whereSql, params, removedBy, reason) {
  const rows = connection.prepare(`SELECT * FROM vouches WHERE guild_id=? AND active=1 AND ${whereSql}`).all(key(guildId), ...params);
  if (!rows.length) return [];
  const now = Date.now();
  connection.prepare(`
    UPDATE vouches
    SET active=0, removed_at=?, removed_by=?, remove_reason=?
    WHERE guild_id=? AND active=1 AND ${whereSql}
  `).run(now, removedBy == null ? null : String(removedBy), reason || null, key(guildId), ...params);
  return rows;
}

function capsOf(guildId) {
  return statements.getCaps.get(key(guildId)) || { global_max: null, giver_max: null };
}

function getMaxAllowance(guildId, userId) {
  const custom = statements.getAllowance.get(key(guildId), key(userId));
  if (custom && Number.isInteger(custom.max_vouches)) return custom.max_vouches;
  const caps = capsOf(guildId);
  const giver = statements.getGiver.get(key(guildId), key(userId));
  if (giver?.active && Number.isInteger(caps.giver_max)) return caps.giver_max;
  if (Number.isInteger(caps.global_max)) return caps.global_max;
  return DEFAULT_ALLOWANCE;
}

function allowance(guildId, userId) {
  const max = getMaxAllowance(guildId, userId);
  const used = statements.countByGiver.get(key(guildId), key(userId)).n;
  return { max, used, remaining: Math.max(0, max - used), custom: !!statements.getAllowance.get(key(guildId), key(userId)) };
}

module.exports = {
  DEFAULT_ALLOWANCE,
  checkpoint() {
    connection.pragma("wal_checkpoint(PASSIVE)");
  },
  getPrefix(guildId) {
    return statements.getPrefix.get(key(guildId))?.prefix || process.env.PREFIX || DEFAULT_PREFIX;
  },
  setPrefix(guildId, prefix) {
    statements.setPrefix.run(key(guildId), prefix);
  },
  getAlias(guildId, shortcut) {
    if (!shortcut) return null;
    return statements.getAlias.get(key(guildId), String(shortcut).toLowerCase())?.command_text || null;
  },
  setAlias(guildId, shortcut, commandText, createdBy) {
    statements.setAlias.run(key(guildId), String(shortcut).toLowerCase(), commandText, createdBy == null ? null : String(createdBy), Date.now());
  },
  removeAlias(guildId, shortcut) {
    return statements.removeAlias.run(key(guildId), String(shortcut).toLowerCase()).changes > 0;
  },
  listAliases(guildId) {
    return statements.listAliases.all(key(guildId));
  },
  getConfig(guildId) {
    return statements.getConfig.get(key(guildId)) || blankConfig(guildId);
  },
  setVouchRole(guildId, roleId) {
    setConfigField(guildId, "vouch_role_id", roleId);
  },
  setRewardRole(guildId, roleId) {
    setConfigField(guildId, "reward_role_id", roleId);
  },
  setFounderRole(guildId, roleId) {
    setConfigField(guildId, "founder_role_id", roleId);
  },
  setStripstaffRole(guildId, roleId) {
    setConfigField(guildId, "stripstaff_role_id", roleId);
  },
  setLogChannel(guildId, channelId) {
    setConfigField(guildId, "log_channel_id", channelId);
  },
  addOs(guildId, targetId, targetType, addedBy) {
    return statements.addOs.run(key(guildId), key(targetId), targetType, addedBy == null ? null : String(addedBy), Date.now()).changes > 0;
  },
  removeOs(guildId, targetId, targetType) {
    return statements.removeOs.run(key(guildId), key(targetId), targetType).changes > 0;
  },
  isOsUser(guildId, userId) {
    return !!statements.getOs.get(key(guildId), key(userId), "user");
  },
  isOsRole(guildId, roleId) {
    return !!statements.getOs.get(key(guildId), key(roleId), "role");
  },
  osRoleIds(guildId) {
    return statements.osRoles.all(key(guildId)).map((row) => row.target_id);
  },
  listOs(guildId) {
    return statements.listOs.all(key(guildId));
  },
  addAdmin(guildId, userId, addedBy) {
    return upsertStaff("vouch_admins", guildId, userId, addedBy);
  },
  removeAdmin(guildId, userId, removedBy, reason) {
    return deactivateStaff("vouch_admins", guildId, userId, removedBy, reason);
  },
  getAdmin(guildId, userId) {
    return statements.getAdmin.get(key(guildId), key(userId)) || null;
  },
  isActiveAdmin(guildId, userId) {
    return !!statements.getAdmin.get(key(guildId), key(userId))?.active;
  },
  addGiver(guildId, userId, addedBy) {
    return upsertStaff("vouch_givers", guildId, userId, addedBy);
  },
  removeGiver(guildId, userId, removedBy, reason) {
    return deactivateStaff("vouch_givers", guildId, userId, removedBy, reason);
  },
  getGiver(guildId, userId) {
    return statements.getGiver.get(key(guildId), key(userId)) || null;
  },
  isActiveGiver(guildId, userId) {
    return !!statements.getGiver.get(key(guildId), key(userId))?.active;
  },
  listActiveGivers(guildId) {
    return statements.listActiveGivers.all(key(guildId));
  },
  getMaxAllowance,
  allowance,
  setAllowance(guildId, userId, max, updatedBy) {
    statements.setAllowance.run(key(guildId), key(userId), max, updatedBy == null ? null : String(updatedBy), Date.now());
  },
  clearAllowance(guildId, userId) {
    return statements.clearAllowance.run(key(guildId), key(userId)).changes > 0;
  },
  listAllowances(guildId) {
    return statements.listAllowances.all(key(guildId));
  },
  getCaps(guildId) {
    const caps = capsOf(guildId);
    return {
      globalMax: Number.isInteger(caps.global_max) ? caps.global_max : null,
      giverMax: Number.isInteger(caps.giver_max) ? caps.giver_max : null
    };
  },
  setGlobalCap(guildId, max) {
    const guild = key(guildId);
    statements.ensureCaps.run(guild);
    statements.setGlobalCap.run(max, guild);
  },
  setGiverCap(guildId, max) {
    const guild = key(guildId);
    statements.ensureCaps.run(guild);
    statements.setGiverCap.run(max, guild);
  },
  getActiveVouch(guildId, targetId) {
    return statements.getActive.get(key(guildId), key(targetId)) || null;
  },
  listActiveByGiver(guildId, giverId) {
    return statements.listByGiver.all(key(guildId), key(giverId));
  },
  listActive(guildId, limit, offset) {
    return statements.listActive.all(key(guildId), limit, offset);
  },
  listAllActive(guildId) {
    return statements.allActive.all(key(guildId));
  },
  countActive(guildId) {
    return statements.countActive.get(key(guildId)).n;
  },
  latestRemovedVouch(guildId, targetId) {
    return statements.latestRemoved.get(key(guildId), key(targetId)) || null;
  },
  reserveVouch(row) {
    return reserveVouch(row);
  },
  cancelVouch(id) {
    statements.deleteVouch.run(id);
  },
  reactivateVouch(id) {
    connection.prepare(`
      UPDATE vouches
      SET active=1, removed_at=NULL, removed_by=NULL, remove_reason=NULL
      WHERE id=?
    `).run(id);
  },
  deactivateVouch(guildId, targetId, removedBy, reason) {
    const rows = deactivateMatching(guildId, "target_id=?", [key(targetId)], removedBy, reason);
    return rows[0] || null;
  },
  deactivateByGiver(guildId, giverId, removedBy, reason) {
    return deactivateMatching(guildId, "giver_id=?", [key(giverId)], removedBy, reason);
  },
  deactivateAll(guildId, removedBy, reason) {
    return deactivateMatching(guildId, "1=1", [], removedBy, reason);
  },
  isBlacklisted(guildId, userId) {
    return !!statements.isBlacklisted.get(key(guildId), key(userId));
  },
  getBlacklist(guildId, userId) {
    return statements.getBlacklist.get(key(guildId), key(userId)) || null;
  },
  addBlacklist(guildId, userId, reason, addedBy) {
    statements.addBlacklist.run(key(guildId), key(userId), reason || null, addedBy == null ? null : String(addedBy), Date.now());
  },
  removeBlacklist(guildId, userId) {
    return statements.removeBlacklist.run(key(guildId), key(userId)).changes > 0;
  },
  countBlacklist(guildId) {
    return statements.countBlacklist.get(key(guildId)).n;
  },
  listBlacklist(guildId, limit, offset) {
    return statements.listBlacklist.all(key(guildId), limit, offset);
  },
  getLimitedRole(guildId, roleId) {
    return statements.getRoleLimit.get(key(guildId), key(roleId)) || null;
  },
  setLimitedRole(guildId, roleId, max, setBy) {
    statements.setRoleLimit.run(key(guildId), key(roleId), max, setBy == null ? null : String(setBy), Date.now());
  },
  deleteLimitedRole(guildId, roleId) {
    return statements.deleteRoleLimit.run(key(guildId), key(roleId)).changes > 0;
  },
  listLimitedRoles(guildId) {
    return statements.listRoleLimits.all(key(guildId));
  },
  addLog(entry) {
    statements.addLog.run(
      key(entry.guildId),
      entry.action,
      entry.actorId == null ? null : String(entry.actorId),
      entry.targetId == null ? null : String(entry.targetId),
      entry.reason || null,
      entry.automatic ? 1 : 0,
      entry.details || null,
      entry.createdAt || Date.now()
    );
  },
  listLogs(guildId, limit = 50) {
    return statements.listLogs.all(key(guildId), limit);
  },
  addPunishment(entry) {
    statements.addPunishment.run(
      key(entry.guildId),
      key(entry.userId),
      entry.type,
      entry.reason || null,
      entry.actorId == null ? null : String(entry.actorId),
      entry.removedRoles || null,
      entry.automatic ? 1 : 0,
      entry.createdAt || Date.now()
    );
  },
  listPunishments(guildId, limit = 50) {
    return statements.listPunishments.all(key(guildId), limit);
  },
  punishmentsFor(guildId, userId) {
    return statements.punishmentsFor.all(key(guildId), key(userId));
  },
  setForcedNick(guildId, userId, nickname, setBy) {
    statements.setNick.run(key(guildId), key(userId), nickname, setBy == null ? null : String(setBy), Date.now());
  },
  getForcedNick(guildId, userId) {
    return statements.getNick.get(key(guildId), key(userId)) || null;
  },
  clearForcedNick(guildId, userId) {
    return statements.clearNick.run(key(guildId), key(userId)).changes > 0;
  },
  listForcedNicks(guildId) {
    return statements.listNicks.all(key(guildId));
  },
  addForcedRoleStrip(guildId, userId, roleId, setBy) {
    statements.addStrip.run(key(guildId), key(userId), key(roleId), setBy == null ? null : String(setBy), Date.now());
  },
  listForcedRoleStrips(guildId, userId) {
    return statements.stripsForUser.all(key(guildId), key(userId));
  },
  isRoleStripped(guildId, userId, roleId) {
    return !!statements.isStripped.get(key(guildId), key(userId), key(roleId));
  },
  clearForcedRoleStrips(guildId, userId) {
    return statements.clearStrips.run(key(guildId), key(userId)).changes > 0;
  },
  listAllForcedRoleStrips(guildId) {
    return statements.allStrips.all(key(guildId));
  },
  deleteForcedStripsForRole(guildId, roleId) {
    statements.deleteStripsForRole.run(key(guildId), key(roleId));
  }
};
