const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

function resolveDbPath(input) {
  const target = input || "./data/vc.sqlite";
  try {
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) return path.join(target, "vc.sqlite");
  } catch {
    return target;
  }
  if (target.endsWith("/") || target.endsWith("\\")) return path.join(target, "vc.sqlite");
  return target;
}

const dbPath = resolveDbPath(process.env.DB_PATH);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

let db;
try {
  db = new Database(dbPath);
} catch (error) {
  console.error(`Unable to open the database at ${dbPath}.`, error);
  process.exit(1);
}
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.exec(`
CREATE TABLE IF NOT EXISTS guild_config (
  guild_id TEXT PRIMARY KEY,
  j2c_channel_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  server_interface_channel_id TEXT NOT NULL,
  server_interface_message_id TEXT
);

CREATE TABLE IF NOT EXISTS temp_channels (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  owner_id TEXT,
  interface_message_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vc_bans (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY(channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS vc_permits (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY(channel_id, user_id)
);
`);

function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing("guild_config", "name_template", "TEXT NOT NULL DEFAULT '{nickname}''s Channel'");
addColumnIfMissing("guild_config", "user_limit", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("guild_config", "bitrate", "INTEGER NOT NULL DEFAULT 64000");
addColumnIfMissing("guild_config", "cleanup_seconds", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("guild_config", "server_interface_enabled", "INTEGER NOT NULL DEFAULT 1");
addColumnIfMissing("guild_config", "category_ids", "TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing("temp_channels", "empty_since", "INTEGER");
addColumnIfMissing("temp_channels", "deleted_at", "INTEGER");
addColumnIfMissing("temp_channels", "creator_id", "TEXT");
db.exec("UPDATE temp_channels SET creator_id = owner_id WHERE creator_id IS NULL");

db.exec(`
CREATE TABLE IF NOT EXISTS fake_permissions (
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  permission TEXT NOT NULL,
  PRIMARY KEY (guild_id, role_id, permission)
);

CREATE TABLE IF NOT EXISTS fake_permission_templates (
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, name)
);

CREATE TABLE IF NOT EXISTS hardbans (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT,
  moderator_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS tempbans (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT,
  moderator_id TEXT,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS ban_settings (
  guild_id TEXT PRIMARY KEY,
  purge_days INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ban_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  moderator_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fake_user_permissions (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  permission TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id, permission)
);

CREATE TABLE IF NOT EXISTS foreverbans (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT,
  moderator_id TEXT,
  created_at INTEGER NOT NULL,
  username TEXT,
  global_name TEXT,
  display_name TEXT,
  account_created_at INTEGER,
  PRIMARY KEY (guild_id, user_id)
);
`);

const saveConfigStatement = db.prepare(`
  INSERT INTO guild_config (
    guild_id, j2c_channel_id, category_id, server_interface_channel_id,
    server_interface_message_id, name_template, user_limit, bitrate,
    cleanup_seconds, server_interface_enabled, category_ids
  ) VALUES (
    @guild_id, @j2c_channel_id, @category_id, @server_interface_channel_id,
    @server_interface_message_id, @name_template, @user_limit, @bitrate,
    @cleanup_seconds, @server_interface_enabled, @category_ids
  )
  ON CONFLICT(guild_id) DO UPDATE SET
    j2c_channel_id = excluded.j2c_channel_id,
    category_id = excluded.category_id,
    server_interface_channel_id = excluded.server_interface_channel_id,
    server_interface_message_id = excluded.server_interface_message_id,
    name_template = excluded.name_template,
    user_limit = excluded.user_limit,
    bitrate = excluded.bitrate,
    cleanup_seconds = excluded.cleanup_seconds,
    server_interface_enabled = excluded.server_interface_enabled,
    category_ids = excluded.category_ids
`);
const saveConfigTransaction = db.transaction((row) => saveConfigStatement.run(row));

module.exports = {
  getConfig(guildId) {
    return db.prepare("SELECT * FROM guild_config WHERE guild_id = ?").get(guildId);
  },
  setConfig(row) {
    return saveConfigTransaction({
      server_interface_channel_id: "disabled",
      server_interface_message_id: null,
      name_template: "{nickname}'s Channel",
      user_limit: 0,
      bitrate: 64000,
      cleanup_seconds: 0,
      server_interface_enabled: 1,
      category_ids: "[]",
      ...row
    });
  },
  updateServerInterface(guildId, channelId, messageId) {
    return db.prepare(`
      UPDATE guild_config
      SET server_interface_channel_id = ?, server_interface_message_id = ?
      WHERE guild_id = ?
    `).run(channelId, messageId, guildId);
  },
  addTemp(row) {
    return db.prepare(`
      INSERT OR IGNORE INTO temp_channels
      (channel_id,guild_id,owner_id,interface_message_id,created_at,empty_since,deleted_at,creator_id)
      VALUES (@channel_id,@guild_id,@owner_id,@interface_message_id,@created_at,NULL,NULL,@owner_id)
    `).run(row);
  },
  updateTempInterface(channelId, messageId) {
    db.prepare("UPDATE temp_channels SET interface_message_id = ? WHERE channel_id = ?").run(messageId, channelId);
  },
  getTempChannel(channelId) {
    return db.prepare("SELECT * FROM temp_channels WHERE channel_id = ? AND deleted_at IS NULL").get(channelId);
  },
  getTempChannels(guildId) {
    return db.prepare("SELECT * FROM temp_channels WHERE guild_id = ? AND deleted_at IS NULL").all(guildId);
  },
  setOwner(channelId, ownerId) {
    const result = db.prepare(`
      UPDATE temp_channels SET owner_id = ?
      WHERE channel_id = ? AND deleted_at IS NULL AND owner_id IS NULL
    `).run(ownerId, channelId);
    return result.changes > 0;
  },
  forceOwner(channelId, ownerId) {
    const result = db.prepare(`
      UPDATE temp_channels SET owner_id = ?
      WHERE channel_id = ? AND deleted_at IS NULL
    `).run(ownerId, channelId);
    return result.changes > 0;
  },
  clearOwner(channelId, ownerId) {
    return db.prepare(`
      UPDATE temp_channels SET owner_id = NULL
      WHERE channel_id = ? AND owner_id = ? AND deleted_at IS NULL
    `).run(channelId, ownerId).changes > 0;
  },
  setEmptySince(channelId, timestamp) {
    db.prepare("UPDATE temp_channels SET empty_since = ? WHERE channel_id = ? AND deleted_at IS NULL").run(timestamp, channelId);
  },
  markTempDeleted(channelId) {
    db.prepare(`
      UPDATE temp_channels SET deleted_at = COALESCE(deleted_at, ?), empty_since = NULL
      WHERE channel_id = ?
    `).run(Date.now(), channelId);
  },
  addBan(channelId, userId) {
    db.prepare("INSERT OR IGNORE INTO vc_bans(channel_id,user_id) VALUES(?,?)").run(channelId, userId);
  },
  removeBan(channelId, userId) {
    db.prepare("DELETE FROM vc_bans WHERE channel_id=? AND user_id=?").run(channelId, userId);
  },
  isBanned(channelId, userId) {
    return !!db.prepare("SELECT 1 FROM vc_bans WHERE channel_id=? AND user_id=?").get(channelId, userId);
  },
  addPermit(channelId, userId) {
    db.prepare("INSERT OR IGNORE INTO vc_permits(channel_id,user_id) VALUES(?,?)").run(channelId, userId);
  },
  removePermit(channelId, userId) {
    db.prepare("DELETE FROM vc_permits WHERE channel_id=? AND user_id=?").run(channelId, userId);
  },
  isPermitted(channelId, userId) {
    return !!db.prepare("SELECT 1 FROM vc_permits WHERE channel_id=? AND user_id=?").get(channelId, userId);
  },
  addFakePermission(guildId, roleId, permission) {
    db.prepare(
      "INSERT OR IGNORE INTO fake_permissions(guild_id, role_id, permission) VALUES(?,?,?)"
    ).run(guildId, roleId, permission);
  },
  removeFakePermission(guildId, roleId, permission) {
    return db.prepare(
      "DELETE FROM fake_permissions WHERE guild_id=? AND role_id=? AND permission=?"
    ).run(guildId, roleId, permission).changes > 0;
  },
  listFakePermissions(guildId) {
    return db.prepare(
      "SELECT role_id, permission FROM fake_permissions WHERE guild_id=? ORDER BY role_id, permission"
    ).all(guildId);
  },
  fakePermissionsForRoles(guildId, roleIds) {
    if (!roleIds.length) return [];
    const placeholders = roleIds.map(() => "?").join(",");
    return db.prepare(
      `SELECT DISTINCT permission FROM fake_permissions WHERE guild_id=? AND role_id IN (${placeholders})`
    ).all(guildId, ...roleIds).map((row) => row.permission);
  },
  roleHasFakePermission(guildId, roleId, permission) {
    return !!db.prepare(
      "SELECT 1 FROM fake_permissions WHERE guild_id=? AND role_id=? AND permission=?"
    ).get(guildId, roleId, permission);
  },
  resetFakePermissions(guildId, { includeForeverban = false } = {}) {
    db.prepare("DELETE FROM fake_permissions WHERE guild_id=? AND permission != 'foreverban_members'").run(guildId);
    db.prepare("DELETE FROM fake_user_permissions WHERE guild_id=? AND permission != 'foreverban_members'").run(guildId);
    if (includeForeverban) {
      db.prepare("DELETE FROM fake_permissions WHERE guild_id=? AND permission = 'foreverban_members'").run(guildId);
      db.prepare("DELETE FROM fake_user_permissions WHERE guild_id=? AND permission = 'foreverban_members'").run(guildId);
    }
  },
  addFakeUserPermission(guildId, userId, permission) {
    db.prepare(
      "INSERT OR IGNORE INTO fake_user_permissions(guild_id, user_id, permission) VALUES(?,?,?)"
    ).run(guildId, userId, permission);
  },
  removeFakeUserPermission(guildId, userId, permission) {
    return db.prepare(
      "DELETE FROM fake_user_permissions WHERE guild_id=? AND user_id=? AND permission=?"
    ).run(guildId, userId, permission).changes > 0;
  },
  listFakeUserPermissions(guildId) {
    return db.prepare(
      "SELECT user_id, permission FROM fake_user_permissions WHERE guild_id=? ORDER BY user_id, permission"
    ).all(guildId);
  },
  fakePermissionsForUser(guildId, userId) {
    return db.prepare(
      "SELECT permission FROM fake_user_permissions WHERE guild_id=? AND user_id=?"
    ).all(guildId, userId).map((row) => row.permission);
  },
  addForeverban(row) {
    db.prepare(`
      INSERT INTO foreverbans(
        guild_id, user_id, reason, moderator_id, created_at,
        username, global_name, display_name, account_created_at
      ) VALUES (
        @guild_id, @user_id, @reason, @moderator_id, @created_at,
        @username, @global_name, @display_name, @account_created_at
      )
      ON CONFLICT(guild_id, user_id) DO UPDATE SET
        reason = excluded.reason,
        moderator_id = excluded.moderator_id,
        created_at = excluded.created_at,
        username = excluded.username,
        global_name = excluded.global_name,
        display_name = excluded.display_name,
        account_created_at = excluded.account_created_at
    `).run(row);
  },
  removeForeverban(guildId, userId) {
    return db.prepare("DELETE FROM foreverbans WHERE guild_id=? AND user_id=?").run(guildId, userId).changes > 0;
  },
  isForeverbanned(guildId, userId) {
    return !!db.prepare("SELECT 1 FROM foreverbans WHERE guild_id=? AND user_id=?").get(guildId, userId);
  },
  getForeverban(guildId, userId) {
    return db.prepare("SELECT * FROM foreverbans WHERE guild_id=? AND user_id=?").get(guildId, userId);
  },
  listForeverbans(guildId) {
    return db.prepare("SELECT * FROM foreverbans WHERE guild_id=? ORDER BY created_at DESC").all(guildId);
  },
  saveFakePermissionTemplate(userId, name, payload) {
    db.prepare(`
      INSERT INTO fake_permission_templates(user_id, name, payload, updated_at)
      VALUES(?,?,?,?)
      ON CONFLICT(user_id, name) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `).run(userId, name, payload, Date.now());
  },
  getFakePermissionTemplate(userId, name) {
    return db.prepare(
      "SELECT name, payload FROM fake_permission_templates WHERE user_id=? AND name=?"
    ).get(userId, name);
  },
  listFakePermissionTemplates(userId) {
    return db.prepare(
      "SELECT name, payload, updated_at FROM fake_permission_templates WHERE user_id=? ORDER BY name"
    ).all(userId);
  },
  getBanPurgeDays(guildId) {
    return db.prepare("SELECT purge_days FROM ban_settings WHERE guild_id=?").get(guildId)?.purge_days ?? 0;
  },
  setBanPurgeDays(guildId, days) {
    db.prepare(`
      INSERT INTO ban_settings(guild_id, purge_days) VALUES(?,?)
      ON CONFLICT(guild_id) DO UPDATE SET purge_days = excluded.purge_days
    `).run(guildId, days);
  },
  addHardban(row) {
    db.prepare(`
      INSERT INTO hardbans(guild_id, user_id, reason, moderator_id, created_at)
      VALUES(@guild_id, @user_id, @reason, @moderator_id, @created_at)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET
        reason = excluded.reason,
        moderator_id = excluded.moderator_id,
        created_at = excluded.created_at
    `).run(row);
  },
  removeHardban(guildId, userId) {
    return db.prepare("DELETE FROM hardbans WHERE guild_id=? AND user_id=?").run(guildId, userId).changes > 0;
  },
  isHardbanned(guildId, userId) {
    return !!db.prepare("SELECT 1 FROM hardbans WHERE guild_id=? AND user_id=?").get(guildId, userId);
  },
  getHardban(guildId, userId) {
    return db.prepare("SELECT * FROM hardbans WHERE guild_id=? AND user_id=?").get(guildId, userId);
  },
  listHardbans(guildId) {
    return db.prepare("SELECT * FROM hardbans WHERE guild_id=? ORDER BY created_at DESC").all(guildId);
  },
  clearHardbans(guildId) {
    const rows = db.prepare("SELECT * FROM hardbans WHERE guild_id=?").all(guildId);
    db.prepare("DELETE FROM hardbans WHERE guild_id=?").run(guildId);
    return rows;
  },
  addTempban(row) {
    db.prepare(`
      INSERT INTO tempbans(guild_id, user_id, reason, moderator_id, expires_at)
      VALUES(@guild_id, @user_id, @reason, @moderator_id, @expires_at)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET
        reason = excluded.reason,
        moderator_id = excluded.moderator_id,
        expires_at = excluded.expires_at
    `).run(row);
  },
  removeTempban(guildId, userId) {
    db.prepare("DELETE FROM tempbans WHERE guild_id=? AND user_id=?").run(guildId, userId);
  },
  getTempban(guildId, userId) {
    return db.prepare("SELECT * FROM tempbans WHERE guild_id=? AND user_id=?").get(guildId, userId);
  },
  listTempbans() {
    return db.prepare("SELECT * FROM tempbans").all();
  },
  addBanHistory(row) {
    db.prepare(`
      INSERT INTO ban_history(guild_id, user_id, action, reason, moderator_id, created_at)
      VALUES(@guild_id, @user_id, @action, @reason, @moderator_id, @created_at)
    `).run(row);
  },
  getBanHistoryForUser(guildId, userId) {
    return db.prepare(`
      SELECT * FROM ban_history WHERE guild_id=? AND user_id=? ORDER BY created_at DESC LIMIT 10
    `).all(guildId, userId);
  },
  getRecentBanHistory(guildId, limit = 10) {
    return db.prepare(`
      SELECT * FROM ban_history WHERE guild_id=? ORDER BY created_at DESC LIMIT ?
    `).all(guildId, limit);
  },
  close() {
    db.close();
  },
  connection: db
};
