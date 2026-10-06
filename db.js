const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const dbPath = process.env.DB_PATH || "./data/vc.sqlite";
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
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
  close() {
    db.close();
  }
};
