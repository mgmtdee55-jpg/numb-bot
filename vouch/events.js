const store = require("./store");
const logging = require("./logging");
const roles = require("./roles");
const protection = require("./protection");
const db = require("../db");
const { logThrottledError } = require("../log-throttle");

async function memberOf(guild, userId) {
  return guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
}

async function reconcileGuild(guild) {
  if (!guild?.id) return;
  const config = store.getConfig(guild.id);
  if (config.vouch_role_id) {
    const role = guild.roles.cache.get(config.vouch_role_id) || await guild.roles.fetch(config.vouch_role_id).catch(() => null);
    if (!role) {
      store.setVouchRole(guild.id, null);
      await logging.record(guild, {
        action: "config_change",
        reason: "Vouch role was deleted",
        automatic: true
      });
    } else {
      for (const vouch of store.listAllActive(guild.id)) {
        if (store.isRoleStripped(guild.id, vouch.target_id, role.id)) continue;
        if (db.isHardbanned(guild.id, vouch.target_id) || db.isForeverbanned(guild.id, vouch.target_id)) continue;
        const member = await memberOf(guild, vouch.target_id);
        if (!member || member.user?.bot) continue;
        if (!member.roles.cache.has(role.id)) {
          await roles.withRateLimit(() => roles.addRole(member, role, "Restore vouch role after restart")).catch((error) => {
            logThrottledError(`vouch-reconcile-add:${guild.id}`, `[vouch reconcile] ${vouch.target_id}`, error);
          });
        }
      }
      if ((guild.memberCount || 0) <= 1000 && typeof guild.members.fetch === "function") {
        await guild.members.fetch().catch(() => null);
      }
      const holders = role.members?.values ? [...role.members.values()] : [...guild.members.cache.values()].filter((member) => member.roles?.cache?.has(role.id));
      for (const member of holders) {
        if (member.user?.bot) continue;
        if (!store.getActiveVouch(guild.id, member.id)) {
          await roles.withRateLimit(() => roles.removeRole(member, role, "Remove vouch role without an active vouch")).catch((error) => {
            logThrottledError(`vouch-reconcile-remove:${guild.id}`, `[vouch reconcile] ${member.id}`, error);
          });
        }
      }
    }
  }

  for (const row of store.listForcedNicks(guild.id)) {
    const member = await memberOf(guild, row.user_id);
    if (!member || member.nickname === row.nickname) continue;
    await roles.applyNickname(member, row.nickname, "Restore forced nickname").catch(() => null);
  }

  for (const row of store.listAllForcedRoleStrips(guild.id)) {
    const member = await memberOf(guild, row.user_id);
    if (!member?.roles?.cache?.has(row.role_id)) continue;
    if (store.getConfig(guild.id).vouch_role_id === row.role_id) {
      store.deactivateVouch(guild.id, member.id, guild.client?.user?.id || null, "Forced role strip");
    }
    await roles.removeRole(member, row.role_id, "Enforce forced role strip").catch(() => null);
  }
}

async function reconcileAll(client) {
  for (const guild of client.guilds?.cache?.values?.() || []) {
    try {
      await reconcileGuild(guild);
    } catch (error) {
      logThrottledError(`vouch-reconcile:${guild.id}`, `[vouch reconcile] ${guild.id}`, error);
    }
  }
}

async function handleGuildMemberAdd(member) {
  if (!member?.guild || member.user?.bot) return;
  if (db.isHardbanned(member.guild.id, member.id) || db.isForeverbanned(member.guild.id, member.id)) return;
  const config = store.getConfig(member.guild.id);
  if (config.vouch_role_id && store.getActiveVouch(member.guild.id, member.id)) {
    if (!store.isRoleStripped(member.guild.id, member.id, config.vouch_role_id)) {
      const role = member.guild.roles.cache.get(config.vouch_role_id) || await member.guild.roles.fetch(config.vouch_role_id).catch(() => null);
      if (role && !member.roles.cache.has(role.id)) {
        await roles.addRole(member, role, "Restore vouch role on join").catch((error) => {
          logThrottledError(`vouch-join:${member.guild.id}`, `[vouch join] ${member.id}`, error);
        });
      }
    }
  }
  const forced = store.getForcedNick(member.guild.id, member.id);
  if (forced && member.nickname !== forced.nickname) {
    await roles.applyNickname(member, forced.nickname, "Restore forced nickname on join").catch(() => null);
  }
  for (const row of store.listForcedRoleStrips(member.guild.id, member.id)) {
    if (!member.roles.cache.has(row.role_id)) continue;
    await roles.removeRole(member, row.role_id, "Enforce forced role strip on join").catch(() => null);
  }
}

function handleGuildMemberRemove() {
  return undefined;
}

async function handleRoleDelete(role) {
  const guild = role?.guild;
  if (!guild || !role?.id) return;
  const config = store.getConfig(guild.id);
  if (config.vouch_role_id === role.id) {
    store.setVouchRole(guild.id, null);
    await logging.record(guild, {
      action: "config_change",
      targetId: role.id,
      reason: "Configured vouch role was deleted",
      automatic: true
    });
  }
  if (config.reward_role_id === role.id) store.setRewardRole(guild.id, null);
  if (config.founder_role_id === role.id) store.setFounderRole(guild.id, null);
  if (config.stripstaff_role_id === role.id) store.setStripstaffRole(guild.id, null);
  if (store.isOsRole(guild.id, role.id)) store.removeOs(guild.id, role.id, "role");
  if (store.getLimitedRole(guild.id, role.id)) store.deleteLimitedRole(guild.id, role.id);
  store.deleteForcedStripsForRole(guild.id, role.id);
}

async function handleChannelDelete(channel) {
  const guild = channel?.guild;
  if (!guild || !channel?.id) return;
  const systemStore = require("../systems/store");
  const antinukeLog = systemStore.getLog(guild.id, "antinuke");
  if (store.getConfig(guild.id).log_channel_id === channel.id || antinukeLog === channel.id) {
    store.setLogChannel(guild.id, null);
    if (antinukeLog === channel.id) systemStore.removeLog(guild.id, "antinuke");
    await logging.record(guild, {
      action: "config_change",
      targetId: channel.id,
      reason: "Vouch log channel was deleted",
      automatic: true
    });
  }
}

module.exports = {
  reconcileGuild,
  reconcileAll,
  handleGuildMemberAdd,
  handleGuildMemberRemove,
  handleRoleDelete,
  handleChannelDelete,
  handleGuildMemberUpdate: protection.handleGuildMemberUpdate
};
