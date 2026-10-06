const store = require("./store");
const authority = require("./authority");
const logging = require("./logging");
const roles = require("./roles");
const { resolveMember, resolveUserId, resolveRole, resolveChannel, resolveOsTarget } = require("./resolve");
const { reply } = require("./ui");
const {
  cleanReason,
  discordTime,
  mentionRole,
  mentionUser,
  pageOf,
  parseLimit
} = require("./util");
const { MAX_ALLOWANCE, MAX_ROLE_LIMIT, PAGE_SIZE } = require("./constants");
const db = require("../db");

function deny(message, description = "You do not have permission to do that.") {
  return reply(message, "Not Allowed", description);
}

function roleFailure(error) {
  if (error?.code === 50013) return "I don't have permission to manage that role. Move my role higher and grant Manage Roles.";
  if (error?.code === 10011) return "That role no longer exists.";
  if (error?.code === 50001) return "I can't access that member.";
  return "The role update could not be completed. Check my role position and permissions.";
}

async function roleById(guild, roleId) {
  if (!roleId) return null;
  return guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
}

function isHumanMember(member, guild) {
  if (!member || member.user?.bot) return false;
  if (member.id === guild.client?.user?.id) return false;
  return true;
}

function blockedTarget(guild, userId, member) {
  if (userId === guild.ownerId) return "The server owner cannot be blacklisted.";
  if (store.isOsUser(guild.id, userId) || (member && authority.isOs(member))) {
    return "OS cannot be blacklisted. Remove OS first if this user should lose authority.";
  }
  const staff = require("../systems/store").getStaff(guild.id, userId);
  if (staff?.tier === "god" || require("../systems/store").isAntinukeAdmin(guild.id, userId)) {
    return "Gods and Anti-Nuke admins cannot be blacklisted.";
  }
  return null;
}

async function finishRoleRemoval(guild, rows, role, reason) {
  let removed = 0;
  let failed = 0;
  if (!role) return { removed, failed };
  for (const row of rows) {
    const member = guild.members.cache.get(row.target_id) || await guild.members.fetch(row.target_id).catch(() => null);
    if (!member?.roles?.cache?.has(role.id)) continue;
    try {
      await roles.withRateLimit(() => roles.removeRole(member, role, reason));
      removed += 1;
    } catch (error) {
      failed += 1;
    }
  }
  return { removed, failed };
}

async function addGiver(message, userArg) {
  const actor = message.member;
  if (!authority.canManageGivers(actor)) return deny(message);
  const member = await resolveMember(message, userArg);
  if (!isHumanMember(member, message.guild)) {
    return reply(message, "Missing User", "Mention a human member or provide their user ID.");
  }
  if (store.isBlacklisted(message.guild.id, member.id)) {
    return reply(message, "Vouch Blacklisted", `${mentionUser(member.id)} is vouch blacklisted and cannot become a giver.`);
  }
  if (!authority.outranks(actor, member.id, member)) {
    return deny(message, "You can only add givers below your authority.");
  }
  const outcome = store.addGiver(message.guild.id, member.id, actor.id);
  if (outcome.already) return reply(message, "Already a Giver", `${mentionUser(member.id)} can already give vouches.`);
  const allowance = store.allowance(message.guild.id, member.id);
  await logging.record(message.guild, {
    action: "giver_add",
    actorId: actor.id,
    targetId: member.id,
    reason: "Giver authorized",
    details: { allowance: allowance.max }
  });
  return reply(
    message,
    "Giver Added",
    `${mentionUser(member.id)} can now give vouches.\nAvailable vouches: **${allowance.remaining}/${allowance.max}**.`
  );
}

async function removeGiver(message, userArg, reason) {
  const actor = message.member;
  if (!authority.canManageGivers(actor)) return deny(message);
  const userId = await resolveUserId(message, userArg);
  if (!userId) return reply(message, "Missing User", "Mention a user or provide their user ID.");
  const member = message.guild.members.cache.get(userId) || null;
  if (!authority.outranks(actor, userId, member)) return deny(message, "You can only remove givers below your authority.");
  const removed = store.removeGiver(message.guild.id, userId, actor.id, cleanReason(reason) || "Giver permission removed");
  if (!removed) return reply(message, "Not a Giver", `${mentionUser(userId)} is not an active giver.`);
  await logging.record(message.guild, {
    action: "giver_remove",
    actorId: actor.id,
    targetId: userId,
    reason: cleanReason(reason) || "Giver permission removed"
  });
  return reply(
    message,
    "Giver Removed",
    `${mentionUser(userId)} can no longer give vouches. People they already vouched keep those vouches.`
  );
}

async function giveVouch(message, userArg, reasonText) {
  const actor = message.member;
  const guild = message.guild;
  if (!actor) return deny(message);
  if (store.isBlacklisted(guild.id, actor.id) && actor.id !== guild.ownerId) {
    return reply(message, "Vouch Blacklisted", "You are vouch blacklisted and cannot give vouches.");
  }
  if (!authority.canGive(actor)) return deny(message, "You are not allowed to give vouches.");

  const target = await resolveMember(message, userArg);
  if (!target) return reply(message, "Missing User", "Mention a server member or provide their user ID.");
  if (!isHumanMember(target, guild)) return reply(message, "Invalid Target", "Vouches can only be given to a human member.");
  if (target.id === actor.id) return reply(message, "Invalid Target", "You cannot vouch for yourself.");
  if (store.isBlacklisted(guild.id, target.id)) {
    return reply(message, "Vouch Blacklisted", `${mentionUser(target.id)} is vouch blacklisted and cannot receive a vouch.`);
  }
  if (store.getActiveVouch(guild.id, target.id)) {
    return reply(message, "Already Vouched", `${mentionUser(target.id)} already has an active vouch.`);
  }
  if (db.isHardbanned(guild.id, target.id) || db.isForeverbanned(guild.id, target.id)) {
    return reply(message, "Invalid Target", "That member is banned by this bot and cannot be vouched.");
  }

  const config = store.getConfig(guild.id);
  const role = await roleById(guild, config.vouch_role_id);
  if (!role) return reply(message, "Vouch Role Required", "Set the vouch role before giving vouches.");
  if (!roles.botCanManageRole(guild, role)) {
    return reply(message, "Cannot Assign Role", "I need Manage Roles and a role higher than the vouch role.");
  }
  if (store.isRoleStripped(guild.id, target.id, role.id)) {
    return reply(message, "Role Blocked", "That user is blocked from receiving the vouch role.");
  }
  const roleLimit = store.getLimitedRole(guild.id, role.id);
  if (roleLimit && !target.roles.cache.has(role.id) && roles.countMembersWithRole(guild, role.id) >= roleLimit.max_members) {
    return reply(message, "Role Limit Reached", `The vouch role is already at **${roleLimit.max_members}** members.`);
  }

  const current = store.allowance(guild.id, actor.id);
  if (current.remaining <= 0) {
    return reply(message, "No Vouches Remaining", `You are at **${current.used}/${current.max}**. Take a vouch or raise the allowance first.`);
  }

  const reason = cleanReason(reasonText);
  const reserved = store.reserveVouch({ guildId: guild.id, giverId: actor.id, targetId: target.id, reason });
  if (!reserved.ok) {
    if (reserved.code === "allowance") {
      return reply(message, "No Vouches Remaining", `You are at **${reserved.used}/${reserved.max}**.`);
    }
    return reply(message, "Already Vouched", `${mentionUser(target.id)} already has an active vouch.`);
  }

  try {
    await roles.addRole(target, role, `Vouch by ${actor.id}`);
  } catch (error) {
    store.cancelVouch(reserved.id);
    await logging.record(guild, {
      action: "vouch_failed",
      actorId: actor.id,
      targetId: target.id,
      reason: reason || roleFailure(error),
      details: { code: error?.code || null }
    });
    return reply(message, "Vouch Failed", roleFailure(error));
  }

  const after = store.allowance(guild.id, actor.id);
  await logging.record(guild, {
    action: "vouch_give",
    actorId: actor.id,
    targetId: target.id,
    reason: reason || "No reason provided"
  });
  return reply(
    message,
    "Vouch Given",
    `${mentionUser(actor.id)} vouched for ${mentionUser(target.id)}.${reason ? `\nReason: ${reason}` : ""}\nAvailable vouches: **${after.remaining}/${after.max}**.`
  );
}

async function takeVouch(message, userArg, reasonText) {
  const actor = message.member;
  const guild = message.guild;
  if (!actor) return deny(message);
  if (store.isBlacklisted(guild.id, actor.id) && actor.id !== guild.ownerId) {
    return reply(message, "Vouch Blacklisted", "You are vouch blacklisted and cannot manage vouches.");
  }
  const userId = await resolveUserId(message, userArg);
  if (!userId) return reply(message, "Missing User", "Mention a user or provide their user ID.");
  const active = store.getActiveVouch(guild.id, userId);
  if (!active) return reply(message, "No Active Vouch", `${mentionUser(userId)} does not have an active vouch.`);
  const isGiverOfRecord = active.giver_id === actor.id && authority.canGive(actor);
  const canManage = authority.canManageGivers(actor);
  if (!isGiverOfRecord && !canManage) return deny(message, "Only the giver, a vouch admin, OS, or the server owner can take this vouch.");

  const reason = cleanReason(reasonText) || "Vouch removed";
  const config = store.getConfig(guild.id);
  const role = await roleById(guild, config.vouch_role_id);
  const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
  const needsRemoval = !!(member && role && member.roles.cache.has(role.id));
  const removed = store.deactivateVouch(guild.id, userId, actor.id, reason);
  if (needsRemoval) {
    try {
      await roles.removeRole(member, role, `Vouch taken by ${actor.id}`);
    } catch (error) {
      if (removed?.id) store.reactivateVouch(removed.id);
      await logging.record(guild, {
        action: "vouch_failed",
        actorId: actor.id,
        targetId: userId,
        reason: roleFailure(error)
      });
      return reply(message, "Vouch Failed", roleFailure(error));
    }
  }
  const allowance = store.allowance(guild.id, active.giver_id);
  await logging.record(guild, {
    action: "vouch_take",
    actorId: actor.id,
    targetId: userId,
    reason,
    details: { giverId: active.giver_id }
  });
  return reply(
    message,
    "Vouch Removed",
    `Removed the vouch for ${mentionUser(userId)}.\nGiver ${mentionUser(active.giver_id)} now has **${allowance.remaining}/${allowance.max}** available.`
  );
}

async function allowAdmin(message, userArg) {
  const actor = message.member;
  if (!authority.canManageAdmins(actor)) return deny(message, "Only OS and the server owner can add vouch admins.");
  const member = await resolveMember(message, userArg);
  if (!isHumanMember(member, message.guild)) return reply(message, "Missing User", "Mention a human member or provide their user ID.");
  if (store.isBlacklisted(message.guild.id, member.id)) {
    return reply(message, "Vouch Blacklisted", `${mentionUser(member.id)} is vouch blacklisted and cannot become a vouch admin.`);
  }
  if (!authority.outranks(actor, member.id, member)) return deny(message, "You cannot change someone at or above your authority.");
  const outcome = store.addAdmin(message.guild.id, member.id, actor.id);
  if (outcome.already) return reply(message, "Already a Vouch Admin", `${mentionUser(member.id)} is already a vouch admin.`);
  await logging.record(message.guild, {
    action: "admin_add",
    actorId: actor.id,
    targetId: member.id,
    reason: "Vouch admin authorized"
  });
  return reply(message, "Vouch Admin Added", `${mentionUser(member.id)} is now a vouch admin.`);
}

async function removeAdmin(message, userArg, reasonText) {
  const actor = message.member;
  if (!authority.canManageAdmins(actor)) return deny(message, "Only OS and the server owner can remove vouch admins.");
  const userId = await resolveUserId(message, userArg);
  if (!userId) return reply(message, "Missing User", "Mention a user or provide their user ID.");
  const member = message.guild.members.cache.get(userId) || null;
  if (!authority.outranks(actor, userId, member)) return deny(message, "You cannot change someone at or above your authority.");
  const reason = cleanReason(reasonText) || "Vouch admin removed";
  const removed = store.removeAdmin(message.guild.id, userId, actor.id, reason);
  if (!removed) return reply(message, "Not a Vouch Admin", `${mentionUser(userId)} is not a vouch admin.`);
  await logging.record(message.guild, {
    action: "admin_remove",
    actorId: actor.id,
    targetId: userId,
    reason
  });
  return reply(message, "Vouch Admin Removed", `${mentionUser(userId)} is no longer a vouch admin.`);
}

async function setUserLimit(message, userArg, rawLimit) {
  const actor = message.member;
  if (!authority.canManageGivers(actor)) return deny(message);
  const userId = await resolveUserId(message, userArg);
  if (!userId) return reply(message, "Missing User", "Mention a user or provide their user ID.");
  const member = message.guild.members.cache.get(userId) || null;
  if (actor.id !== userId && !authority.outranks(actor, userId, member)) {
    return deny(message, "You can only change allowances for people below your authority.");
  }
  const max = parseLimit(rawLimit, MAX_ALLOWANCE);
  if (max == null) return reply(message, "Invalid Allowance", `Provide a whole number from 0 to ${MAX_ALLOWANCE}.`);
  store.setAllowance(message.guild.id, userId, max, actor.id);
  const allowance = store.allowance(message.guild.id, userId);
  await logging.record(message.guild, {
    action: "limit_set",
    actorId: actor.id,
    targetId: userId,
    reason: `Allowance set to ${max}`,
    details: allowance
  });
  return reply(
    message,
    "Allowance Updated",
    `${mentionUser(userId)} can have **${max}** active vouches.\nCurrently **${allowance.used}/${allowance.max}** used. Remaining: **${allowance.remaining}**.`
  );
}

async function clearUserLimit(message, userArg) {
  const actor = message.member;
  if (!authority.canManageGivers(actor)) return deny(message);
  const userId = await resolveUserId(message, userArg);
  if (!userId) return reply(message, "Missing User", "Mention a user or provide their user ID.");
  const member = message.guild.members.cache.get(userId) || null;
  if (actor.id !== userId && !authority.outranks(actor, userId, member)) {
    return deny(message, "You can only change allowances for people below your authority.");
  }
  store.clearAllowance(message.guild.id, userId);
  const allowance = store.allowance(message.guild.id, userId);
  await logging.record(message.guild, {
    action: "limit_reset",
    actorId: actor.id,
    targetId: userId,
    reason: "Custom allowance removed"
  });
  return reply(message, "Allowance Reset", `${mentionUser(userId)} is back to the default allowance of **${allowance.max}**. Remaining: **${allowance.remaining}**.`);
}

async function addBlacklist(message, userArg, reasonText) {
  const actor = message.member;
  if (!authority.canManageGivers(actor)) return deny(message);
  const userId = await resolveUserId(message, userArg);
  if (!userId) return reply(message, "Missing User", "Mention a user or provide their user ID.");
  const member = message.guild.members.cache.get(userId) || await message.guild.members.fetch(userId).catch(() => null);
  if (member?.user?.bot || userId === message.guild.client?.user?.id) {
    return reply(message, "Invalid Target", "Bots cannot be vouch blacklisted.");
  }
  const protectedReason = blockedTarget(message.guild, userId, member);
  if (protectedReason) return reply(message, "Protected User", protectedReason);
  if (!authority.outranks(actor, userId, member)) return deny(message, "You can only blacklist people below your authority.");
  const reason = cleanReason(reasonText);
  store.addBlacklist(message.guild.id, userId, reason, actor.id);
  store.removeGiver(message.guild.id, userId, actor.id, "Blacklisted");
  store.removeAdmin(message.guild.id, userId, actor.id, "Blacklisted");
  await logging.record(message.guild, {
    action: "blacklist_add",
    actorId: actor.id,
    targetId: userId,
    reason: reason || "Blacklisted"
  });
  return reply(message, "User Blacklisted", `${mentionUser(userId)} cannot receive vouches, give vouches, or become staff in this system.`);
}

async function removeBlacklist(message, userArg) {
  const actor = message.member;
  if (!authority.canManageGivers(actor)) return deny(message);
  const userId = await resolveUserId(message, userArg);
  if (!userId) return reply(message, "Missing User", "Mention a user or provide their user ID.");
  if (!store.removeBlacklist(message.guild.id, userId)) {
    return reply(message, "Not Blacklisted", `${mentionUser(userId)} is not on the vouch blacklist.`);
  }
  await logging.record(message.guild, {
    action: "blacklist_remove",
    actorId: actor.id,
    targetId: userId,
    reason: "Removed from vouch blacklist"
  });
  return reply(message, "Blacklist Removed", `${mentionUser(userId)} was removed from the vouch blacklist. Giver and admin access were not restored.`);
}

async function listBlacklist(message, pageArg) {
  const guild = message.guild;
  const total = store.countBlacklist(guild.id);
  if (!total) return reply(message, "Vouch Blacklist", "Nobody is vouch blacklisted.");
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(pageOf(pageArg), pages);
  const rows = store.listBlacklist(guild.id, PAGE_SIZE, (page - 1) * PAGE_SIZE);
  const lines = rows.map((row, index) => {
    const reason = row.reason ? ` — ${row.reason}` : "";
    return `**${(page - 1) * PAGE_SIZE + index + 1}.** ${mentionUser(row.user_id)}${reason}\nAdded ${discordTime(row.created_at)} by ${mentionUser(row.added_by)}`;
  });
  return reply(message, "Vouch Blacklist", `${lines.join("\n\n")}\n\nPage ${page} of ${pages}`);
}

async function usableRole(message, role) {
  if (!role || role.id === message.guild.id || role.managed) {
    await reply(message, "Invalid Role", "Choose a normal server role the bot can manage.");
    return false;
  }
  if (!roles.botCanManageRole(message.guild, role)) {
    await reply(message, "Cannot Manage Role", "Move my role above that role and grant me Manage Roles.");
    return false;
  }
  return true;
}

async function setVouchRole(message, roleArg) {
  if (!authority.isOsOrOwner(message.member)) return deny(message, "Only OS and the server owner can set the vouch role.");
  const role = await resolveRole(message, roleArg);
  if (!(await usableRole(message, role))) return null;
  store.setVouchRole(message.guild.id, role.id);
  await logging.record(message.guild, {
    action: "config_change",
    actorId: message.author.id,
    targetId: role.id,
    reason: "Vouch role configured",
    details: { vouchRoleId: role.id }
  });
  return reply(message, "Vouch Role Set", `${mentionRole(role.id)} is the vouch role. Only an active vouch should hold it.`);
}

async function clearVouchRole(message) {
  if (!authority.isOsOrOwner(message.member)) return deny(message, "Only OS and the server owner can clear the vouch role.");
  store.setVouchRole(message.guild.id, null);
  await logging.record(message.guild, {
    action: "config_change",
    actorId: message.author.id,
    reason: "Vouch role cleared"
  });
  return reply(message, "Vouch Role Cleared", "The vouch role was unset. Active vouch records were kept. New vouches cannot be given until a role is set.");
}

async function setRewardRole(message, roleArg) {
  if (!authority.isOsOrOwner(message.member)) return deny(message, "Only OS and the server owner can set the reward role.");
  if (String(roleArg || "").toLowerCase() === "remove") {
    store.setRewardRole(message.guild.id, null);
    await logging.record(message.guild, {
      action: "config_change",
      actorId: message.author.id,
      reason: "Reward role cleared"
    });
    return reply(message, "Reward Role Cleared", "The reward role was removed. The vouch role was not changed.");
  }
  const role = await resolveRole(message, roleArg);
  if (!role || role.id === message.guild.id) return reply(message, "Invalid Role", "Mention a role, role ID, or role name.");
  const vouchRoleId = store.getConfig(message.guild.id).vouch_role_id;
  store.setRewardRole(message.guild.id, role.id);
  await logging.record(message.guild, {
    action: "config_change",
    actorId: message.author.id,
    targetId: role.id,
    reason: "Reward role configured"
  });
  const note = role.id === vouchRoleId
    ? "\nThis is the same role as the vouch role. They are still stored as separate settings."
    : "\nThis does not replace the vouch role and is not granted when someone is vouched.";
  return reply(message, "Reward Role Set", `${mentionRole(role.id)} is the reward role.${note}`);
}

async function setStripstaffRole(message, roleArg) {
  if (!authority.isOsOrOwner(message.member)) return deny(message, "Only OS and the server owner can set the stripstaff role.");
  if (String(roleArg || "").toLowerCase() === "remove") {
    store.setStripstaffRole(message.guild.id, null);
    await logging.record(message.guild, {
      action: "config_change",
      actorId: message.author.id,
      reason: "Legacy stripstaff role cleared"
    });
    return reply(message, "Stripstaff Role Cleared", "Automatic permission stripping is unchanged. The optional legacy role was cleared.");
  }
  const role = await resolveRole(message, roleArg);
  if (!role || role.id === message.guild.id) return reply(message, "Invalid Role", "Mention a role, role ID, or role name.");
  store.setStripstaffRole(message.guild.id, role.id);
  await logging.record(message.guild, {
    action: "config_change",
    actorId: message.author.id,
    targetId: role.id,
    reason: "Legacy stripstaff role configured"
  });
  return reply(
    message,
    "Stripstaff Role Set",
    `${mentionRole(role.id)} will also be removed during STRIPSTAFF. Staff roles are still removed by permission.`
  );
}

async function addOs(message, targetArg) {
  if (!authority.canManageAdmins(message.member)) return deny(message, "Only OS and the server owner can configure OS.");
  const target = await resolveOsTarget(message, targetArg);
  if (!target) return reply(message, "Missing Target", "Mention a role or user, or provide an ID.");
  if (target.ambiguous) return reply(message, "Ambiguous Target", "That matches both a user and a role. Use a mention or ID.");
  if (target.type === "user") {
    if (!isHumanMember(target.member, message.guild)) return reply(message, "Invalid Target", "OS can only be granted to a human member.");
    if (store.isBlacklisted(message.guild.id, target.id)) {
      return reply(message, "Vouch Blacklisted", "Remove the vouch blacklist before making this user OS.");
    }
    if (!authority.outranks(message.member, target.id, target.member) && message.member.id !== message.guild.ownerId) {
      return deny(message, "You cannot change someone at or above your authority.");
    }
  }
  const created = store.addOs(message.guild.id, target.id, target.type, message.author.id);
  if (!created) return reply(message, "Already OS", "That target is already OS.");
  await logging.record(message.guild, {
    action: "config_change",
    actorId: message.author.id,
    targetId: target.id,
    reason: `OS ${target.type} added`
  });
  const label = target.type === "role" ? mentionRole(target.id) : mentionUser(target.id);
  return reply(message, "OS Added", `${label} is now OS and is exempt from STRIPSTAFF.`);
}

async function removeOs(message, targetArg) {
  if (!authority.canManageAdmins(message.member)) return deny(message, "Only OS and the server owner can configure OS.");
  const target = await resolveOsTarget(message, targetArg);
  if (!target) return reply(message, "Missing Target", "Mention a role or user, or provide an ID.");
  if (target.ambiguous) return reply(message, "Ambiguous Target", "That matches both a user and a role. Use a mention or ID.");
  if (target.type === "user" && target.id === message.guild.ownerId) {
    return reply(message, "Protected User", "The server owner is above OS and cannot be removed here.");
  }
  if (target.type === "user" && !authority.outranks(message.member, target.id, target.member) && message.member.id !== message.guild.ownerId) {
    return deny(message, "You cannot change someone at or above your authority.");
  }
  const removed = store.removeOs(message.guild.id, target.id, target.type);
  if (!removed) return reply(message, "Not OS", "That target is not configured as OS.");
  await logging.record(message.guild, {
    action: "config_change",
    actorId: message.author.id,
    targetId: target.id,
    reason: `OS ${target.type} removed`
  });
  const label = target.type === "role" ? mentionRole(target.id) : mentionUser(target.id);
  return reply(message, "OS Removed", `${label} is no longer OS.`);
}

async function setLogChannel(message, channelArg) {
  if (!authority.isOsOrOwner(message.member)) return deny(message, "Only OS and the server owner can set the vouch log channel.");
  const { bindAntinukeLog } = require("../systems/logs");
  if (String(channelArg || "").toLowerCase() === "remove") {
    bindAntinukeLog(message.guild.id, null);
    await logging.record(message.guild, {
      action: "config_change",
      actorId: message.author.id,
      reason: "Vouch log channel cleared"
    });
    return reply(message, "Logs Channel Cleared", "Vouch actions are still stored in the database.");
  }
  const channel = await resolveChannel(message, channelArg);
  if (!channel || (typeof channel.isTextBased === "function" && !channel.isTextBased())) {
    return reply(message, "Missing Channel", "Mention a text channel or provide its ID.");
  }
  bindAntinukeLog(message.guild.id, channel.id);
  await logging.record(message.guild, {
    action: "config_change",
    actorId: message.author.id,
    targetId: channel.id,
    reason: "Vouch log channel configured"
  });
  return reply(message, "Logs Channel Set", `Vouch logs will be sent to <#${channel.id}>.`);
}

async function wipeAll(message) {
  if (!authority.isOsOrOwner(message.member)) return deny(message, "Only OS and the server owner can wipe active vouches.");
  const rows = store.deactivateAll(message.guild.id, message.author.id, "wipe");
  const role = await roleById(message.guild, store.getConfig(message.guild.id).vouch_role_id);
  const outcome = await finishRoleRemoval(message.guild, rows, role, "Vouch wipe");
  await logging.record(message.guild, {
    action: "vouch_wipe",
    actorId: message.author.id,
    reason: "Active vouches cleared",
    details: { count: rows.length, rolesRemoved: outcome.removed, failed: outcome.failed }
  });
  return reply(
    message,
    "Vouches Wiped",
    `Closed **${rows.length}** active vouch${rows.length === 1 ? "" : "es"}. Removed the vouch role from **${outcome.removed}** member(s).${outcome.failed ? ` ${outcome.failed} role update(s) failed.` : ""}\nGivers, admins, blacklist, limits, and logs were kept.`
  );
}

async function stripGiver(message, userArg) {
  if (!authority.isOsOrOwner(message.member)) return deny(message, "Only OS and the server owner can strip a giver's vouches.");
  const userId = await resolveUserId(message, userArg);
  if (!userId) return reply(message, "Missing User", "Mention a user or provide their user ID.");
  const rows = store.deactivateByGiver(message.guild.id, userId, message.author.id, "vouchstrip");
  if (!rows.length) return reply(message, "Nothing to Strip", `${mentionUser(userId)} has no active vouches.`);
  const role = await roleById(message.guild, store.getConfig(message.guild.id).vouch_role_id);
  const outcome = await finishRoleRemoval(message.guild, rows, role, `Vouch strip by ${message.author.id}`);
  await logging.record(message.guild, {
    action: "vouch_strip",
    actorId: message.author.id,
    targetId: userId,
    reason: "Removed every active vouch from this giver",
    details: { count: rows.length, rolesRemoved: outcome.removed }
  });
  return reply(
    message,
    "Vouch Strip",
    `Removed **${rows.length}** active vouch${rows.length === 1 ? "" : "es"} given by ${mentionUser(userId)}. Role removals: **${outcome.removed}**.`
  );
}

async function setRoleLimit(message, tokens) {
  if (!authority.isOsOrOwner(message.member)) return deny(message, "Only OS and the server owner can limit roles.");
  if (!tokens?.length || tokens.length < 2) {
    return reply(message, "Usage", "`-limit @role <number>`");
  }
  const rawNumber = tokens[tokens.length - 1];
  const max = parseLimit(rawNumber, MAX_ROLE_LIMIT);
  if (max == null) return reply(message, "Invalid Limit", `Provide a whole number from 0 to ${MAX_ROLE_LIMIT}.`);
  const role = await resolveRole(message, tokens.slice(0, -1).join(" "));
  if (!role || role.id === message.guild.id) return reply(message, "Invalid Role", "Mention a role, role ID, or role name.");
  store.setLimitedRole(message.guild.id, role.id, max, message.author.id);
  const count = roles.countMembersWithRole(message.guild, role.id);
  await logging.record(message.guild, {
    action: "role_limit",
    actorId: message.author.id,
    targetId: role.id,
    reason: `Limit set to ${max}`,
    details: { count, max }
  });
  return reply(message, "Role Limit Set", `${role.name} is limited to **${max}** members. Current count: **${count}/${max}**.`);
}

async function listLimitedRoles(message) {
  const rows = store.listLimitedRoles(message.guild.id);
  if (!rows.length) return reply(message, "Limited Roles", "No roles have a member limit.");
  if (typeof message.guild.members.fetch === "function" && (message.guild.memberCount || 0) <= 1000) {
    await message.guild.members.fetch().catch(() => null);
  }
  const lines = rows.map((row) => {
    const role = message.guild.roles.cache.get(row.role_id);
    const count = roles.countMembersWithRole(message.guild, row.role_id);
    return `${role?.name || "Deleted role"} — ${count}/${row.max_members}`;
  });
  return reply(message, "Limited Roles", lines.join("\n"));
}

function statusLines(guild, info) {
  const config = store.getConfig(guild.id);
  const received = info.received
    ? `Vouched by ${mentionUser(info.received.giver_id)} on ${discordTime(info.received.created_at)}${info.received.reason ? ` — ${info.received.reason}` : ""}`
    : "Not vouched";
  return [
    `**Vouch Status:** ${received}`,
    `**Giver Status:** ${info.isGiver ? "Yes" : "No"}`,
    `**Vouch Admin Status:** ${info.isAdmin ? "Yes" : "No"}`,
    `**Vouch Allowance:** ${info.allowance.max}`,
    `**Active Vouches:** ${info.given.length}`,
    `**Used Vouches:** ${info.allowance.used}`,
    `**Remaining Vouches:** ${info.allowance.remaining}`,
    `**Available:** ${info.allowance.remaining}/${info.allowance.max}`,
    `**Blacklist Status:** ${info.blacklisted ? "Blacklisted" : "Clear"}`,
    `**Vouch Role:** ${config.vouch_role_id ? mentionRole(config.vouch_role_id) : "Not set"}`,
    `**Reward Role:** ${config.reward_role_id ? mentionRole(config.reward_role_id) : "Not set"}`
  ];
}

async function showCheck(message, userArg) {
  const userId = userArg ? await resolveUserId(message, userArg) : message.author.id;
  if (!userId) return reply(message, "Missing User", "Mention a user or provide their user ID.");
  const member = message.guild.members.cache.get(userId) || null;
  const info = authority.profile(message.guild, userId, member);
  return reply(message, "Vouch Status", statusLines(message.guild, info).join("\n"));
}

async function showView(message, userArg) {
  const userId = await resolveUserId(message, userArg);
  if (!userId) return reply(message, "Missing User", "Mention a user or provide their user ID.");
  const member = message.guild.members.cache.get(userId) || null;
  const info = authority.profile(message.guild, userId, member);
  const givenLines = info.given.length
    ? info.given.slice(0, 25).map((row) => `• ${mentionUser(row.target_id)} — ${discordTime(row.created_at)}${row.reason ? ` — ${row.reason}` : ""}`)
    : ["• None"];
  if (info.given.length > 25) givenLines.push(`• and ${info.given.length - 25} more`);
  const history = info.lastRemoved
    ? `\n**Last removed vouch:** by ${mentionUser(info.lastRemoved.giver_id)} on ${discordTime(info.lastRemoved.removed_at)}${info.lastRemoved.remove_reason ? ` — ${info.lastRemoved.remove_reason}` : ""}`
    : "";
  const giverSince = info.isGiver ? `\n**Giver since:** ${discordTime(info.giver.created_at)}` : "";
  const adminSince = info.isAdmin ? `\n**Vouch admin since:** ${discordTime(info.admin.created_at)}` : "";
  return reply(
    message,
    "Vouch View",
    `${statusLines(message.guild, info).join("\n")}${giverSince}${adminSince}${history}\n\n**People they vouched (${info.given.length}):**\n${givenLines.join("\n")}`
  );
}

async function memberStillHere(guild, userId) {
  if (guild.members?.cache?.has?.(userId)) return true;
  if (typeof guild.members?.fetch !== "function") return true;
  try {
    const member = await guild.members.fetch(userId);
    return !!member;
  } catch (error) {
    if (error?.code === 10007) return false;
    return true;
  }
}

async function showVouchConfig(message) {
  if (!authority.isOsOrOwner(message.member) && !authority.canGive(message.member)) {
    return deny(message, "Gods, Anti-Nuke admins, the vouch founder role, and the server owner can view vouch config.");
  }
  const config = store.getConfig(message.guild.id);
  const givers = store.listActiveGivers(message.guild.id);
  const caps = store.getCaps(message.guild.id);
  const lines = [
    `**Reward role:** ${config.vouch_role_id ? mentionRole(config.vouch_role_id) : "Not set"}`,
    `**Founder role:** ${config.founder_role_id ? mentionRole(config.founder_role_id) : "Not set"}`,
    `**Active vouches:** ${store.countActive(message.guild.id)}`,
    `**Givers:** ${givers.length ? givers.map((row) => mentionUser(row.user_id)).join(", ") : "none"}`,
    `**Global cap:** ${caps.globalMax == null ? "default" : caps.globalMax}`,
    `**Giver cap:** ${caps.giverMax == null ? "default" : caps.giverMax}`
  ];
  if (config.reward_role_id && config.reward_role_id !== config.vouch_role_id) {
    lines.splice(2, 0, `**Extra reward role:** ${mentionRole(config.reward_role_id)}`);
  }
  return reply(message, "Vouch Config", lines.join("\n"));
}

async function bindRewardRole(message, roleArg) {
  if (!authority.isOsOrOwner(message.member)) return deny(message, "Only OS and the server owner can set the reward role.");
  const role = await resolveRole(message, roleArg);
  if (!(await usableRole(message, role))) return null;
  store.setVouchRole(message.guild.id, role.id);
  await logging.record(message.guild, {
    action: "config_change",
    actorId: message.author.id,
    targetId: role.id,
    reason: "Reward role configured",
    details: { vouchRoleId: role.id }
  });
  return reply(message, "Reward Role Set", `${mentionRole(role.id)} is given when someone is vouched.`);
}

async function setFounderRole(message, roleArg) {
  if (!authority.canManageAdmins(message.member)) return deny(message, "Only OS and the server owner can assign the founder role.");
  const role = await resolveRole(message, roleArg);
  if (!role || role.id === message.guild.id) return reply(message, "Missing Role", "Mention a role or provide its ID.");
  const previous = store.getConfig(message.guild.id).founder_role_id;
  if (previous && previous !== role.id) store.removeOs(message.guild.id, previous, "role");
  store.setFounderRole(message.guild.id, role.id);
  store.addOs(message.guild.id, role.id, "role", message.author.id);
  await logging.record(message.guild, {
    action: "config_change",
    actorId: message.author.id,
    targetId: role.id,
    reason: "Founder role configured"
  });
  return reply(message, "Founder Role Set", `${mentionRole(role.id)} is the founder role. Members with it have OS authority.`);
}

async function unsetLinkedRoles(message) {
  if (!authority.isOsOrOwner(message.member)) return deny(message, "Only OS and the server owner can disconnect vouch roles.");
  const config = store.getConfig(message.guild.id);
  if (config.founder_role_id) store.removeOs(message.guild.id, config.founder_role_id, "role");
  store.setVouchRole(message.guild.id, null);
  store.setRewardRole(message.guild.id, null);
  store.setFounderRole(message.guild.id, null);
  await logging.record(message.guild, {
    action: "config_change",
    actorId: message.author.id,
    reason: "Linked vouch roles disconnected"
  });
  return reply(message, "Roles Disconnected", "The reward role and founder role were cleared. Active vouch records were kept.");
}

async function cleanupRegistry(message) {
  if (!authority.isOsOrOwner(message.member)) return deny(message, "Only OS and the server owner can prune the vouch registry.");
  const guild = message.guild;
  let vouches = 0;
  for (const row of store.listAllActive(guild.id)) {
    if (await memberStillHere(guild, row.target_id)) continue;
    store.deactivateVouch(guild.id, row.target_id, message.author.id, "cleanup");
    vouches += 1;
  }
  let givers = 0;
  for (const row of store.listActiveGivers(guild.id)) {
    if (await memberStillHere(guild, row.user_id)) continue;
    if (store.removeGiver(guild.id, row.user_id, message.author.id, "cleanup")) givers += 1;
  }
  await logging.record(guild, {
    action: "config_change",
    actorId: message.author.id,
    reason: "Vouch registry cleaned",
    details: { vouches, givers }
  });
  return reply(
    message,
    "Registry Cleaned",
    `Closed **${vouches}** vouch${vouches === 1 ? "" : "es"} for members who left.\nRemoved **${givers}** giver${givers === 1 ? "" : "s"} who left.`
  );
}

async function listVouches(message, pageArg) {
  if (!authority.isOsOrOwner(message.member) && !authority.canGive(message.member)) {
    return deny(message, "Gods, Anti-Nuke admins, the vouch founder role, and the server owner can list vouches.");
  }
  const total = store.countActive(message.guild.id);
  if (!total) return reply(message, "Active Vouches", "There are no active vouches.");
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(pageOf(pageArg), pages);
  const rows = store.listActive(message.guild.id, PAGE_SIZE, (page - 1) * PAGE_SIZE);
  const lines = rows.map((row, index) => {
    const reason = row.reason ? `\nReason: ${row.reason}` : "";
    return `**${(page - 1) * PAGE_SIZE + index + 1}.** ${mentionUser(row.giver_id)} → ${mentionUser(row.target_id)} · ${discordTime(row.created_at)}${reason}`;
  });
  return reply(message, "Active Vouches", `${lines.join("\n\n")}\n\nPage ${page} of ${pages}`);
}

module.exports = {
  addGiver,
  removeGiver,
  giveVouch,
  takeVouch,
  allowAdmin,
  removeAdmin,
  setUserLimit,
  clearUserLimit,
  addBlacklist,
  removeBlacklist,
  listBlacklist,
  setVouchRole,
  clearVouchRole,
  setRewardRole,
  setStripstaffRole,
  addOs,
  removeOs,
  setLogChannel,
  wipeAll,
  stripGiver,
  setRoleLimit,
  listLimitedRoles,
  showCheck,
  showView,
  listVouches,
  showVouchConfig,
  bindRewardRole,
  setFounderRole,
  unsetLinkedRoles,
  cleanupRegistry
};
