const { connection } = require("../db");

connection.exec(`
CREATE TABLE IF NOT EXISTS management_users (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  added_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS godmode_users (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  added_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS staff_access (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  added_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS antinuke_admins (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  added_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS vc_ranks (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  rank_key TEXT NOT NULL,
  set_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS event_logs (
  guild_id TEXT NOT NULL,
  category TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, category)
);

CREATE TABLE IF NOT EXISTS voice_guards (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  godmode INTEGER NOT NULL DEFAULT 0,
  shield INTEGER NOT NULL DEFAULT 0,
  stfu INTEGER NOT NULL DEFAULT 0,
  last_channel_id TEXT,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS voice_follows (
  guild_id TEXT NOT NULL,
  follower_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, follower_id)
);

CREATE TABLE IF NOT EXISTS voice_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_voice_history_guild
  ON voice_history(guild_id, id);

CREATE TABLE IF NOT EXISTS lockdown_channels (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
);

CREATE TABLE IF NOT EXISTS voice_rank_roles (
  guild_id TEXT PRIMARY KEY,
  plus_role_id TEXT,
  premium_role_id TEXT,
  premium_plus_role_id TEXT
);

CREATE TABLE IF NOT EXISTS text_lock_snapshots (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  send_messages TEXT NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
);
`);

function key(value) {
  return value == null ? null : String(value);
}

const statements = {
  addManagement: connection.prepare("INSERT OR IGNORE INTO management_users(guild_id, user_id, added_by, created_at) VALUES(?,?,?,?)"),
  removeManagement: connection.prepare("DELETE FROM management_users WHERE guild_id=? AND user_id=?"),
  isManagement: connection.prepare("SELECT 1 FROM management_users WHERE guild_id=? AND user_id=?"),
  listManagement: connection.prepare("SELECT * FROM management_users WHERE guild_id=? ORDER BY created_at ASC"),
  addGodmode: connection.prepare(`
    INSERT INTO godmode_users(guild_id, user_id, added_by, created_at) VALUES(?,?,?,?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET added_by=excluded.added_by, created_at=excluded.created_at
  `),
  removeGodmode: connection.prepare("DELETE FROM godmode_users WHERE guild_id=? AND user_id=?"),
  isGodmode: connection.prepare("SELECT 1 FROM godmode_users WHERE guild_id=? AND user_id=?"),
  getGodmode: connection.prepare("SELECT * FROM godmode_users WHERE guild_id=? AND user_id=?"),
  setStaff: connection.prepare(`
    INSERT INTO staff_access(guild_id, user_id, tier, added_by, created_at) VALUES(?,?,?,?,?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET tier=excluded.tier, added_by=excluded.added_by, created_at=excluded.created_at
  `),
  clearStaff: connection.prepare("DELETE FROM staff_access WHERE guild_id=? AND user_id=?"),
  getStaff: connection.prepare("SELECT * FROM staff_access WHERE guild_id=? AND user_id=?"),
  listStaff: connection.prepare("SELECT * FROM staff_access WHERE guild_id=? AND tier=? ORDER BY created_at ASC"),
  addAntinuke: connection.prepare("INSERT OR IGNORE INTO antinuke_admins(guild_id, user_id, added_by, created_at) VALUES(?,?,?,?)"),
  removeAntinuke: connection.prepare("DELETE FROM antinuke_admins WHERE guild_id=? AND user_id=?"),
  isAntinuke: connection.prepare("SELECT 1 FROM antinuke_admins WHERE guild_id=? AND user_id=?"),
  listAntinuke: connection.prepare("SELECT * FROM antinuke_admins WHERE guild_id=? ORDER BY created_at ASC"),
  setRank: connection.prepare(`
    INSERT INTO vc_ranks(guild_id, user_id, rank_key, set_by, created_at) VALUES(?,?,?,?,?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET rank_key=excluded.rank_key, set_by=excluded.set_by, created_at=excluded.created_at
  `),
  clearRank: connection.prepare("DELETE FROM vc_ranks WHERE guild_id=? AND user_id=?"),
  getRank: connection.prepare("SELECT * FROM vc_ranks WHERE guild_id=? AND user_id=?"),
  listRanks: connection.prepare("SELECT * FROM vc_ranks WHERE guild_id=? ORDER BY created_at ASC"),
  setLog: connection.prepare(`
    INSERT INTO event_logs(guild_id, category, channel_id) VALUES(?,?,?)
    ON CONFLICT(guild_id, category) DO UPDATE SET channel_id=excluded.channel_id
  `),
  removeLog: connection.prepare("DELETE FROM event_logs WHERE guild_id=? AND category=?"),
  clearLogs: connection.prepare("DELETE FROM event_logs WHERE guild_id=?"),
  getLog: connection.prepare("SELECT channel_id FROM event_logs WHERE guild_id=? AND category=?"),
  listLogs: connection.prepare("SELECT category, channel_id FROM event_logs WHERE guild_id=? ORDER BY category"),
  getGuard: connection.prepare("SELECT * FROM voice_guards WHERE guild_id=? AND user_id=?"),
  ensureGuard: connection.prepare("INSERT OR IGNORE INTO voice_guards(guild_id, user_id) VALUES(?,?)"),
  setGuardFlag: connection.prepare("UPDATE voice_guards SET godmode=?, shield=?, stfu=?, last_channel_id=? WHERE guild_id=? AND user_id=?"),
  listGuards: connection.prepare("SELECT * FROM voice_guards WHERE guild_id=? AND (godmode=1 OR shield=1 OR stfu=1)"),
  setFollow: connection.prepare(`
    INSERT INTO voice_follows(guild_id, follower_id, target_id) VALUES(?,?,?)
    ON CONFLICT(guild_id, follower_id) DO UPDATE SET target_id=excluded.target_id
  `),
  clearFollow: connection.prepare("DELETE FROM voice_follows WHERE guild_id=? AND follower_id=?"),
  followsOf: connection.prepare("SELECT follower_id FROM voice_follows WHERE guild_id=? AND target_id=?"),
  getFollow: connection.prepare("SELECT target_id FROM voice_follows WHERE guild_id=? AND follower_id=?"),
  addHistory: connection.prepare("INSERT INTO voice_history(guild_id, user_id, summary, created_at) VALUES(?,?,?,?)"),
  listHistory: connection.prepare("SELECT * FROM voice_history WHERE guild_id=? ORDER BY id DESC LIMIT ?"),
  listHistoryFor: connection.prepare("SELECT * FROM voice_history WHERE guild_id=? AND user_id=? ORDER BY id DESC LIMIT ?"),
  trimHistory: connection.prepare(`
    DELETE FROM voice_history WHERE guild_id=? AND id NOT IN (
      SELECT id FROM voice_history WHERE guild_id=? ORDER BY id DESC LIMIT 50
    )
  `),
  addLockdown: connection.prepare("INSERT OR REPLACE INTO lockdown_channels(guild_id, channel_id, kind) VALUES(?,?,?)"),
  listLockdown: connection.prepare("SELECT * FROM lockdown_channels WHERE guild_id=?"),
  clearLockdown: connection.prepare("DELETE FROM lockdown_channels WHERE guild_id=?"),
  ensureVoiceRoles: connection.prepare("INSERT OR IGNORE INTO voice_rank_roles(guild_id) VALUES(?)"),
  getVoiceRoles: connection.prepare("SELECT * FROM voice_rank_roles WHERE guild_id=?"),
  setPlusRole: connection.prepare("UPDATE voice_rank_roles SET plus_role_id=? WHERE guild_id=?"),
  setPremiumRole: connection.prepare("UPDATE voice_rank_roles SET premium_role_id=? WHERE guild_id=?"),
  setPremiumPlusRole: connection.prepare("UPDATE voice_rank_roles SET premium_plus_role_id=? WHERE guild_id=?"),
  saveTextLock: connection.prepare("INSERT OR IGNORE INTO text_lock_snapshots(guild_id, channel_id, send_messages) VALUES(?,?,?)"),
  getTextLock: connection.prepare("SELECT send_messages FROM text_lock_snapshots WHERE guild_id=? AND channel_id=?"),
  listTextLocks: connection.prepare("SELECT channel_id, send_messages FROM text_lock_snapshots WHERE guild_id=?"),
  clearTextLock: connection.prepare("DELETE FROM text_lock_snapshots WHERE guild_id=? AND channel_id=?"),
  clearTextLocks: connection.prepare("DELETE FROM text_lock_snapshots WHERE guild_id=?")
};

function saveGuard(guildId, userId, patch) {
  const guild = key(guildId);
  const user = key(userId);
  statements.ensureGuard.run(guild, user);
  const current = statements.getGuard.get(guild, user) || {};
  statements.setGuardFlag.run(
    patch.godmode == null ? current.godmode || 0 : patch.godmode ? 1 : 0,
    patch.shield == null ? current.shield || 0 : patch.shield ? 1 : 0,
    patch.stfu == null ? current.stfu || 0 : patch.stfu ? 1 : 0,
    patch.lastChannelId === undefined ? current.last_channel_id || null : patch.lastChannelId,
    guild,
    user
  );
}

module.exports = {
  addManagement(guildId, userId, addedBy) {
    return statements.addManagement.run(key(guildId), key(userId), key(addedBy), Date.now()).changes > 0;
  },
  removeManagement(guildId, userId) {
    return statements.removeManagement.run(key(guildId), key(userId)).changes > 0;
  },
  isManagement(guildId, userId) {
    return !!statements.isManagement.get(key(guildId), key(userId));
  },
  listManagement(guildId) {
    return statements.listManagement.all(key(guildId));
  },
  addGodmode(guildId, userId, addedBy) {
    statements.addGodmode.run(key(guildId), key(userId), key(addedBy), Date.now());
  },
  removeGodmode(guildId, userId) {
    return statements.removeGodmode.run(key(guildId), key(userId)).changes > 0;
  },
  isGodmode(guildId, userId) {
    return !!statements.isGodmode.get(key(guildId), key(userId));
  },
  getGodmode(guildId, userId) {
    return statements.getGodmode.get(key(guildId), key(userId)) || null;
  },
  addAntinukeAdmin(guildId, userId, addedBy) {
    return statements.addAntinuke.run(key(guildId), key(userId), key(addedBy), Date.now()).changes > 0;
  },
  removeAntinukeAdmin(guildId, userId) {
    return statements.removeAntinuke.run(key(guildId), key(userId)).changes > 0;
  },
  isAntinukeAdmin(guildId, userId) {
    return !!statements.isAntinuke.get(key(guildId), key(userId));
  },
  listAntinukeAdmins(guildId) {
    return statements.listAntinuke.all(key(guildId));
  },
  setStaff(guildId, userId, tier, addedBy) {
    statements.setStaff.run(key(guildId), key(userId), tier, addedBy == null ? null : String(addedBy), Date.now());
  },
  clearStaff(guildId, userId) {
    return statements.clearStaff.run(key(guildId), key(userId)).changes > 0;
  },
  getStaff(guildId, userId) {
    return statements.getStaff.get(key(guildId), key(userId)) || null;
  },
  listStaff(guildId, tier) {
    return statements.listStaff.all(key(guildId), tier);
  },
  setRank(guildId, userId, rankKey, setBy) {
    statements.setRank.run(key(guildId), key(userId), rankKey, key(setBy), Date.now());
  },
  clearRank(guildId, userId) {
    return statements.clearRank.run(key(guildId), key(userId)).changes > 0;
  },
  getRank(guildId, userId) {
    return statements.getRank.get(key(guildId), key(userId)) || null;
  },
  listRanks(guildId) {
    return statements.listRanks.all(key(guildId));
  },
  setLog(guildId, category, channelId) {
    statements.setLog.run(key(guildId), category, key(channelId));
  },
  removeLog(guildId, category) {
    return statements.removeLog.run(key(guildId), category).changes > 0;
  },
  clearLogs(guildId) {
    return statements.clearLogs.run(key(guildId)).changes;
  },
  getLog(guildId, category) {
    return statements.getLog.get(key(guildId), category)?.channel_id || null;
  },
  listLogs(guildId) {
    return statements.listLogs.all(key(guildId));
  },
  getGuard(guildId, userId) {
    return statements.getGuard.get(key(guildId), key(userId)) || null;
  },
  saveGuard,
  listActiveGuards(guildId) {
    return statements.listGuards.all(key(guildId));
  },
  setFollow(guildId, followerId, targetId) {
    statements.setFollow.run(key(guildId), key(followerId), key(targetId));
  },
  clearFollow(guildId, followerId) {
    return statements.clearFollow.run(key(guildId), key(followerId)).changes > 0;
  },
  followersOf(guildId, targetId) {
    return statements.followsOf.all(key(guildId), key(targetId)).map((row) => row.follower_id);
  },
  followTarget(guildId, followerId) {
    return statements.getFollow.get(key(guildId), key(followerId))?.target_id || null;
  },
  addHistory(guildId, userId, summary) {
    const guild = key(guildId);
    statements.addHistory.run(guild, key(userId), summary, Date.now());
    statements.trimHistory.run(guild, guild);
  },
  listHistory(guildId, limit = 15) {
    return statements.listHistory.all(key(guildId), limit);
  },
  listHistoryFor(guildId, userId, limit = 15) {
    return statements.listHistoryFor.all(key(guildId), key(userId), limit);
  },
  addLockdown(guildId, channelId, kind) {
    statements.addLockdown.run(key(guildId), key(channelId), kind);
  },
  listLockdown(guildId) {
    return statements.listLockdown.all(key(guildId));
  },
  clearLockdown(guildId) {
    statements.clearLockdown.run(key(guildId));
  },
  getVoiceRoles(guildId) {
    return statements.getVoiceRoles.get(key(guildId)) || null;
  },
  setVoiceRole(guildId, rankKey, roleId) {
    const guild = key(guildId);
    statements.ensureVoiceRoles.run(guild);
    const statement = rankKey === "premiumplus"
      ? statements.setPremiumPlusRole
      : rankKey === "premium"
        ? statements.setPremiumRole
        : statements.setPlusRole;
    statement.run(key(roleId), guild);
  },
  voiceRoleIds(guildId) {
    const row = statements.getVoiceRoles.get(key(guildId));
    if (!row) return [];
    return [row.plus_role_id, row.premium_role_id, row.premium_plus_role_id].filter(Boolean);
  },
  roleIdForRank(guildId, rankKey) {
    const row = statements.getVoiceRoles.get(key(guildId));
    if (!row || !rankKey) return null;
    if (rankKey === "premiumplus") return row.premium_plus_role_id || null;
    if (rankKey === "premium") return row.premium_role_id || null;
    if (rankKey === "plus") return row.plus_role_id || null;
    return null;
  },
  saveTextLock(guildId, channelId, state) {
    statements.saveTextLock.run(key(guildId), key(channelId), state || "inherit");
  },
  getTextLock(guildId, channelId) {
    return statements.getTextLock.get(key(guildId), key(channelId))?.send_messages || null;
  },
  listTextLocks(guildId) {
    return statements.listTextLocks.all(key(guildId));
  },
  clearTextLock(guildId, channelId) {
    statements.clearTextLock.run(key(guildId), key(channelId));
  },
  clearTextLocks(guildId) {
    statements.clearTextLocks.run(key(guildId));
  }
};
