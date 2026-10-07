const { EmbedBuilder, PermissionFlagsBits } = require("discord.js");
const db = require("./db");
const {
  PERMISSIONS,
  normalizePermission,
  isGuildOwner,
  hasFakePermission,
  hasAdministratorFakePermission,
  canManageFakePermissions,
  canUseBanCommands,
  canForeverBan,
  canManageRoles,
  permissionHelpText
} = require("./fake-permissions");
const access = require("./systems/access");
const { card } = require("./feedback");

const ACCENT = 0x2b2d31;
const tempbanTimers = new Map();
const unbanAllTasks = new Map();
const allowedForeverUnbans = new Set();
const FOREVERBAN_REASON_PREFIX = "FOREVERBAN";
const ALT_ACCOUNT_AGE_MS = 30 * 86_400_000;

function embed(title, description, guild) {
  return card(title, description, { guild });
}

function reply(message, title, description) {
  return message.reply({ embeds: [embed(title, description, message.guild)] });
}

function missingPerm(message, permission) {
  if (permission === "ban_members") {
    return reply(
      message,
      "Missing Fake Permission",
      "Only the server owner, a role with fake `administrator`, or a role granted `ban_members` can use ban commands.\n\nGrant it with `-fp add @role ban_members`."
    );
  }
  if (permission === "manage_roles") {
    return reply(
      message,
      "Missing Fake Permission",
      "Only the server owner, a role with fake `administrator`, or a role granted `manage_roles` can use this command.\n\nGrant it with `-fp add @role manage_roles`."
    );
  }
  if (permission === "foreverban_members") {
    return reply(
      message,
      "Missing Fake Permission",
      "Only the **server owner** can use foreverban, unless they grant `foreverban_members`.\n\nOwner grant: `-fp add @role foreverban_members` or `-fp add @user foreverban_members`.\nFake `administrator` cannot use this."
    );
  }
  if (permission === "administrator") {
    return reply(
      message,
      "Missing Fake Permission",
      "Only the server owner or a role granted fake `administrator` can use this command.\n\nGrant it with `-fp add @role administrator`."
    );
  }
  return reply(
    message,
    "Missing Fake Permission",
    `Your roles need the \`${permission}\` fake permission to use this command.`
  );
}

function parseDuration(text) {
  const match = /^(\d+)(s|m|h|d|w)$/i.exec(String(text || "").trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isInteger(amount) || amount <= 0) return null;
  const unit = match[2].toLowerCase();
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  const ms = amount * multipliers[unit];
  if (ms > 365 * 86_400_000) return null;
  return { ms, label: `${amount}${unit}` };
}

function formatTime(timestamp) {
  return `<t:${Math.floor(timestamp / 1000)}:R>`;
}

function recordHistory(guildId, userId, action, reason, moderatorId) {
  db.addBanHistory({
    guild_id: guildId,
    user_id: userId,
    action,
    reason: reason || null,
    moderator_id: moderatorId,
    created_at: Date.now()
  });
}

async function resolveRole(message, argument) {
  const mention = message.mentions?.roles?.first?.();
  if (mention) return mention;
  const raw = String(argument || "").replace(/[<@&>]/g, "");
  if (/^\d{17,20}$/.test(raw)) {
    return message.guild.roles.cache.get(raw) || message.guild.roles.fetch(raw).catch(() => null);
  }
  const name = String(argument || "").toLowerCase();
  return [...message.guild.roles.cache.values()].find((role) => role.name.toLowerCase() === name) || null;
}

async function resolveUserId(message, argument) {
  const mentioned = message.mentions?.users?.first?.() || message.mentions?.members?.first?.()?.user;
  if (mentioned) return mentioned.id;
  const raw = String(argument || "").replace(/[<@!>]/g, "");
  if (/^\d{17,20}$/.test(raw)) return raw;
  const query = String(argument || "").toLowerCase();
  if (!query) return null;
  const member = [...message.guild.members.cache.values()].find((item) => (
    item.user?.username?.toLowerCase() === query || item.displayName?.toLowerCase() === query
  ));
  if (member) return member.id;
  const bans = await message.guild.bans.fetch().catch(() => null);
  const banned = bans && [...bans.values()].find((ban) => (
    ban.user?.username?.toLowerCase() === query || ban.user?.globalName?.toLowerCase() === query
  ));
  return banned?.user?.id || null;
}

function botCanBan(guild) {
  return guild.members.me?.permissions?.has?.(PermissionFlagsBits.BanMembers) !== false;
}

function botCanManageRoles(guild) {
  return guild.members.me?.permissions?.has?.(PermissionFlagsBits.ManageRoles) !== false;
}

function canAssignRole(moderator, role) {
  if (!role || role.id === moderator.guild.id || role.name === "@everyone") return false;
  if (role.managed) return false;
  const modPos = moderator.roles?.highest?.position ?? 0;
  const botPos = moderator.guild.members.me?.roles?.highest?.position;
  if (moderator.id !== moderator.guild.ownerId && role.position >= modPos) return false;
  if (Number.isInteger(botPos) && role.position >= botPos) return false;
  return true;
}

function canModerate(moderator, targetMember) {
  if (!targetMember) return true;
  if (targetMember.id === moderator.guild.ownerId) return false;
  if (targetMember.id === moderator.id) return false;
  const modPos = moderator.roles?.highest?.position ?? 0;
  const targetPos = targetMember.roles?.highest?.position ?? 0;
  if (targetMember.roles?.highest && moderator.roles?.highest && targetPos >= modPos && moderator.id !== moderator.guild.ownerId) {
    return false;
  }
  return true;
}

async function applyBan(guild, userId, { reason, purgeDays, moderatorId }) {
  const days = Number.isInteger(purgeDays) ? purgeDays : db.getBanPurgeDays(guild.id);
  await guild.members.ban(userId, {
    deleteMessageSeconds: Math.max(0, Math.min(7, days)) * 86400,
    reason: reason || "No reason provided"
  });
  db.removeTempban(guild.id, userId);
  clearTempbanTimer(guild.id, userId);
  recordHistory(guild.id, userId, "ban", reason, moderatorId);
}

function tempbanKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function clearTempbanTimer(guildId, userId) {
  const key = tempbanKey(guildId, userId);
  const timer = tempbanTimers.get(key);
  if (timer) clearTimeout(timer);
  tempbanTimers.delete(key);
}

function scheduleTempban(client, row) {
  const delay = Math.max(0, row.expires_at - Date.now());
  const key = tempbanKey(row.guild_id, row.user_id);
  clearTempbanTimer(row.guild_id, row.user_id);
  const timer = setTimeout(() => {
    expireTempban(client, row.guild_id, row.user_id).catch((error) => {
      console.error(`[tempban expire] ${row.guild_id}:${row.user_id}`, error);
    });
  }, delay);
  timer.unref?.();
  tempbanTimers.set(key, timer);
}

async function expireTempban(client, guildId, userId) {
  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  db.removeTempban(guildId, userId);
  clearTempbanTimer(guildId, userId);
  if (!guild || db.isForeverbanned(guildId, userId)) return;
  allowedForeverUnbans.delete(tempbanKey(guildId, userId));
  await guild.members.unban(userId, "Temporary ban expired").catch(() => {});
  recordHistory(guildId, userId, "unban", "Temporary ban expired", client.user?.id);
}

function startTempbanScheduler(client) {
  for (const row of db.listTempbans()) scheduleTempban(client, row);
}

async function enforceHardban(member) {
  if (db.isForeverbanned(member.guild.id, member.id)) return;
  if (!db.isHardbanned(member.guild.id, member.id)) return;
  const record = db.getHardban(member.guild.id, member.id);
  await member.ban({
    reason: record?.reason ? `Hardbanned: ${record.reason}` : "Hardbanned"
  }).catch((error) => {
    console.error(`[hardban enforce] ${member.guild.id}:${member.id}`, error);
  });
}

function normalizeIdentity(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s._-]+/g, "");
}

function foreverbanIdentities(record) {
  return [record.username, record.global_name, record.display_name].map(normalizeIdentity).filter(Boolean);
}

function memberIdentities(member) {
  return [
    member.user?.username,
    member.user?.globalName,
    member.displayName
  ].map(normalizeIdentity).filter(Boolean);
}

function isLikelyForeverbanAlt(member, records) {
  const names = new Set(memberIdentities(member));
  if (!names.size) return null;
  const createdAt = member.user?.createdTimestamp;
  const young = Number.isFinite(createdAt) && Date.now() - createdAt < ALT_ACCOUNT_AGE_MS;
  for (const record of records) {
    const bannedNames = foreverbanIdentities(record);
    const matched = bannedNames.find((name) => names.has(name));
    if (!matched) continue;
    if (young || matched === normalizeIdentity(member.user?.username)) return record;
  }
  return null;
}

function foreverbanReason(reason) {
  const text = reason || "No reason provided";
  return text.startsWith(FOREVERBAN_REASON_PREFIX) ? text : `${FOREVERBAN_REASON_PREFIX} | ${text}`;
}

async function applyForeverban(guild, userId, { reason, moderatorId, member, user }) {
  const targetUser = user || member?.user || { id: userId };
  await guild.members.ban(userId, {
    deleteMessageSeconds: 7 * 86400,
    reason: foreverbanReason(reason)
  });
  db.removeTempban(guild.id, userId);
  clearTempbanTimer(guild.id, userId);
  db.addForeverban({
    guild_id: guild.id,
    user_id: userId,
    reason: reason || "No reason provided",
    moderator_id: moderatorId,
    created_at: Date.now(),
    username: targetUser.username || null,
    global_name: targetUser.globalName || null,
    display_name: member?.displayName || targetUser.globalName || targetUser.username || null,
    account_created_at: targetUser.createdTimestamp || null
  });
  recordHistory(guild.id, userId, "foreverban", reason, moderatorId);
}

async function enforceForeverban(member) {
  const guildId = member.guild.id;
  let record = db.getForeverban(guildId, member.id);
  if (!record) {
    record = isLikelyForeverbanAlt(member, db.listForeverbans(guildId));
    if (record) {
      db.addForeverban({
        ...record,
        user_id: member.id,
        created_at: Date.now(),
        username: member.user?.username || record.username,
        global_name: member.user?.globalName || record.global_name,
        display_name: member.displayName || record.display_name,
        account_created_at: member.user?.createdTimestamp || record.account_created_at,
        reason: `Alt of ${record.user_id}: ${record.reason || "foreverban"}`
      });
    }
  }
  if (!record) return;
  await member.guild.members.ban(member.id, {
    deleteMessageSeconds: 7 * 86400,
    reason: foreverbanReason(record.reason)
  }).catch((error) => {
    console.error(`[foreverban enforce] ${guildId}:${member.id}`, error);
  });
}

async function restoreForeverban(ban) {
  const key = tempbanKey(ban.guild.id, ban.user.id);
  if (allowedForeverUnbans.has(key)) {
    allowedForeverUnbans.delete(key);
    return;
  }
  const record = db.getForeverban(ban.guild.id, ban.user.id);
  if (!record) return;
  await ban.guild.members.ban(ban.user.id, {
    deleteMessageSeconds: 0,
    reason: foreverbanReason(record.reason)
  }).catch((error) => {
    console.error(`[foreverban restore] ${ban.guild.id}:${ban.user.id}`, error);
  });
}

function fakePermissionsHelp(prefix) {
  return [
    "Only the **server owner** and people granted fake `administrator` can add or remove fake permissions.",
    "Discord Administrator / Manage Roles do not count. `ban_members` and `foreverban_members` cannot use `-fp add`.",
    "",
    `\`${prefix}fp add @role ban_members\` — let that role use ban commands`,
    `\`${prefix}fp add @user ban_members\` — grant a specific user`,
    `\`${prefix}fp add @role administrator\` — let that role manage fake permissions and all normal moderation`,
    `\`${prefix}fp add @role foreverban_members\` — owner-only grant for \`-fb\` / \`-fub\``,
    `\`${prefix}fp remove <role> <permission>\``,
    `\`${prefix}fp list\``,
    `\`${prefix}fp reset\``,
    `\`${prefix}fp template save [name]\``,
    `\`${prefix}fp template load [name]\``,
    "",
    permissionHelpText()
  ].join("\n");
}

async function handleFakePermissions(message, args, prefix) {
  if (!canManageFakePermissions(message.member)) {
    return missingPerm(message, "administrator");
  }
  const sub = (args[1] || "").toLowerCase();
  if (!sub) {
    return reply(message, "Fake Permissions", fakePermissionsHelp(prefix));
  }

  if (sub === "list") {
    const roles = db.listFakePermissions(message.guild.id);
    const users = db.listFakeUserPermissions(message.guild.id);
    if (!roles.length && !users.length) return reply(message, "Fake Permissions", "No fake permissions are configured.");
    const lines = [
      ...roles.map((row) => `<@&${row.role_id}> — \`${row.permission}\``),
      ...users.map((row) => `<@${row.user_id}> — \`${row.permission}\``)
    ];
    return reply(message, "Fake Permissions", lines.join("\n").slice(0, 4000));
  }

  if (sub === "reset") {
    db.resetFakePermissions(message.guild.id, { includeForeverban: isGuildOwner(message.member) });
    return reply(
      message,
      "Fake Permissions Reset",
      isGuildOwner(message.member)
        ? "All fake permissions in this server were cleared."
        : "Fake permissions were cleared. `foreverban_members` grants were kept (owner-only)."
    );
  }

  if (sub === "add" || sub === "remove") {
    const permission = normalizePermission(args[3]);
    const role = await resolveRole(message, args[2]);
    const userId = role ? null : await resolveUserId(message, args[2]);
    if ((!role && !userId) || !permission) {
      return reply(
        message,
        "Usage",
        `\`${prefix}fp ${sub} @role/@user <permission>\`\n\nExample: \`${prefix}fp add @Mods ban_members\`\nForeverban: \`${prefix}fp add @role foreverban_members\``
      );
    }
    if (permission === "foreverban_members" && !isGuildOwner(message.member)) {
      return reply(message, "Owner Only", "Only the server owner can grant or remove `foreverban_members`.");
    }
    if (sub === "add") {
      if (role) db.addFakePermission(message.guild.id, role.id, permission);
      else db.addFakeUserPermission(message.guild.id, userId, permission);
      const who = role ? `<@&${role.id}>` : `<@${userId}>`;
      return reply(message, "Fake Permission Added", `${who} now has \`${permission}\`.`);
    }
    const removed = role
      ? db.removeFakePermission(message.guild.id, role.id, permission)
      : db.removeFakeUserPermission(message.guild.id, userId, permission);
    const who = role ? `<@&${role.id}>` : `<@${userId}>`;
    return reply(
      message,
      removed ? "Fake Permission Removed" : "Not Assigned",
      removed ? `Removed \`${permission}\` from ${who}.` : `${who} did not have \`${permission}\`.`
    );
  }

  if (sub === "template") {
    const action = (args[2] || "list").toLowerCase();
    const name = (args[3] || "default").slice(0, 32);
    if (action === "save") {
      const rows = db.listFakePermissions(message.guild.id);
      const payload = JSON.stringify(rows.map((row) => ({
        roleName: message.guild.roles.cache.get(row.role_id)?.name || row.role_id,
        permission: row.permission
      })));
      db.saveFakePermissionTemplate(message.author.id, name, payload);
      return reply(message, "Template Saved", `Saved **${rows.length}** fake permission(s) as \`${name}\`. Use this in another server with \`${prefix}fp template load ${name}\`.`);
    }
    if (action === "load") {
      const template = db.getFakePermissionTemplate(message.author.id, name);
      if (!template) return reply(message, "Template Missing", `No template named \`${name}\` is saved for you.`);
      let entries = [];
      try { entries = JSON.parse(template.payload); } catch { entries = []; }
      let applied = 0;
      let skipped = 0;
      for (const entry of entries) {
        const role = [...message.guild.roles.cache.values()]
          .find((item) => item.name === entry.roleName);
        const permission = normalizePermission(entry.permission);
        if (!role || !permission) {
          skipped += 1;
          continue;
        }
        db.addFakePermission(message.guild.id, role.id, permission);
        applied += 1;
      }
      return reply(message, "Template Loaded", `Applied **${applied}** fake permission(s). Skipped **${skipped}**.`);
    }
    const templates = db.listFakePermissionTemplates(message.author.id);
    if (!templates.length) {
      return reply(message, "Templates", `No templates saved. Use \`${prefix}fp template save [name]\`.`);
    }
    return reply(
      message,
      "Templates",
      templates.map((item) => `\`${item.name}\``).join("\n")
    );
  }

  return reply(message, "Fake Permissions", fakePermissionsHelp(prefix));
}

async function banCheck(message, userId) {
  if (!userId) return reply(message, "Usage", "`-banned <user>` or `-ban check <user>`");
  const discordBan = await message.guild.bans.fetch(userId).catch(() => null);
  const foreverban = db.getForeverban(message.guild.id, userId);
  const hardban = db.getHardban(message.guild.id, userId);
  const tempban = db.getTempban(message.guild.id, userId);
  const history = db.getBanHistoryForUser(message.guild.id, userId)[0];
  if (!discordBan && !foreverban && !hardban && !tempban) {
    return reply(message, "Not Banned", `<@${userId}> is not banned in this server.`);
  }
  const lines = [`**User:** <@${userId}> (\`${userId}\`)`];
  if (foreverban) {
    lines.push("**Foreverban:** yes — this cannot be lifted with `-unban`. Use `-fub`.");
    lines.push(`**Foreverban reason:** ${foreverban.reason || "No reason provided"}`);
  }
  if (hardban) lines.push(`**Hardban:** yes — ${hardban.reason || "No reason provided"}`);
  if (tempban) lines.push(`**Tempban:** expires ${formatTime(tempban.expires_at)}`);
  if (discordBan) lines.push(`**Discord reason:** ${discordBan.reason || "No reason provided"}`);
  else if (history) lines.push(`**Last recorded:** ${history.action} — ${history.reason || "No reason provided"}`);
  return reply(message, "Ban Check", lines.join("\n"));
}

async function listBans(message, title, rows) {
  if (!rows.length) return reply(message, title, "None.");
  return reply(
    message,
    title,
    rows.slice(0, 20).map((row) => row).join("\n").slice(0, 4000)
  );
}

async function handleBan(message, args, prefix) {
  const sub = (args[1] || "").toLowerCase();
  if (["check", "list", "purge", "recent"].includes(sub) || !args[1]) {
    if (!canUseBanCommands(message.member)) return missingPerm(message, "ban_members");
  }

  if (sub === "check") return banCheck(message, await resolveUserId(message, args[2]));
  if (sub === "list") {
    const bans = await message.guild.bans.fetch().catch(() => new Map());
    const lines = [...bans.values()].map((ban) => `• ${ban.user?.tag || ban.user?.username || ban.user?.id} (\`${ban.user?.id}\`) — ${ban.reason || "No reason"}`);
    return listBans(message, "Banned Users", lines);
  }
  if (sub === "purge") {
    const days = Number(args[2]);
    if (!Number.isInteger(days) || days < 0 || days > 7) {
      return reply(message, "Usage", `\`${prefix}ban purge <0-7>\`\nCurrent default: **${db.getBanPurgeDays(message.guild.id)}** day(s).`);
    }
    db.setBanPurgeDays(message.guild.id, days);
    return reply(message, "Ban Purge Updated", `Bans now delete **${days}** day(s) of message history by default.`);
  }
  if (sub === "recent") {
    const rows = db.getRecentBanHistory(message.guild.id, 10);
    const lines = rows.map((row) => `• <@${row.user_id}> — **${row.action}** — ${row.reason || "No reason"} ${formatTime(row.created_at)}`);
    return listBans(message, "Recent Bans", lines);
  }
  if (!args[1]) {
    return reply(
      message,
      "Ban Commands",
      [
        `\`${prefix}ban <user> [reason]\``,
        `\`${prefix}ban check <user>\``,
        `\`${prefix}ban list\``,
        `\`${prefix}ban purge <0-7>\``,
        `\`${prefix}ban recent\``,
        `\`${prefix}banned <user>\``,
        `\`${prefix}softban <user> [reason]\``,
        `\`${prefix}tempban <user> <duration> [reason]\``,
        `\`${prefix}unban <user>\``,
        `\`${prefix}unbanall\``,
        `\`${prefix}hardban <user> [reason]\` — requires \`administrator\``,
        `\`${prefix}fb <user> [reason]\` / \`${prefix}foreverban\` — owner-tier ban`,
        `\`${prefix}fub <user>\` / \`${prefix}foreverunban\` — only way to lift a foreverban`
      ].join("\n")
    );
  }

  if (!canUseBanCommands(message.member)) return missingPerm(message, "ban_members");
  const userId = await resolveUserId(message, args[1]);
  if (!userId) return reply(message, "Usage", `\`${prefix}ban <user> [reason]\``);
  const target = await message.guild.members.fetch(userId).catch(() => null);
  if (target && !canModerate(message.member, target)) {
    return reply(message, "Unable to Ban", "You cannot ban that member.");
  }
  if (!botCanBan(message.guild)) {
    return reply(message, "Bot Missing Permission", "I need the Discord **Ban Members** permission to do that.");
  }
  const reason = args.slice(2).join(" ").trim() || "No reason provided";
  try {
    await applyBan(message.guild, userId, { reason, moderatorId: message.author.id });
  } catch (error) {
    return reply(message, "Unable to Ban", error.message || "Discord rejected that ban.");
  }
  return reply(message, "Member Banned", `<@${userId}> was banned. Reason: ${reason}`);
}

async function handleHardban(message, args, prefix) {
  if (!hasAdministratorFakePermission(message.member)) return missingPerm(message, "administrator");
  const sub = (args[1] || "").toLowerCase();
  if (sub === "list") {
    const rows = db.listHardbans(message.guild.id);
    const lines = rows.map((row) => `• <@${row.user_id}> — ${row.reason || "No reason"}`);
    return listBans(message, "Hardbanned Users", lines);
  }
  if (sub === "reset") {
    if (!botCanBan(message.guild)) {
      return reply(message, "Bot Missing Permission", "I need the Discord **Ban Members** permission to do that.");
    }
    const rows = db.clearHardbans(message.guild.id);
    let unbanned = 0;
    for (const row of rows) {
      const ok = await message.guild.members.unban(row.user_id, "Hardban reset").then(() => true).catch(() => false);
      if (ok) unbanned += 1;
      recordHistory(message.guild.id, row.user_id, "unban", "Hardban reset", message.author.id);
    }
    return reply(message, "Hardbans Reset", `Cleared **${rows.length}** hardban(s) and unbanned **${unbanned}**.`);
  }
  const userId = await resolveUserId(message, args[1]);
  if (!userId) return reply(message, "Usage", `\`${prefix}hardban <user> [reason]\``);
  const target = await message.guild.members.fetch(userId).catch(() => null);
  if (target && !canModerate(message.member, target)) {
    return reply(message, "Unable to Hardban", "You cannot hardban that member.");
  }
  if (!botCanBan(message.guild)) {
    return reply(message, "Bot Missing Permission", "I need the Discord **Ban Members** permission to do that.");
  }
  const reason = args.slice(2).join(" ").trim() || "No reason provided";
  try {
    await applyBan(message.guild, userId, { reason, moderatorId: message.author.id });
  } catch (error) {
    return reply(message, "Unable to Hardban", error.message || "Discord rejected that ban.");
  }
  db.addHardban({
    guild_id: message.guild.id,
    user_id: userId,
    reason,
    moderator_id: message.author.id,
    created_at: Date.now()
  });
  recordHistory(message.guild.id, userId, "hardban", reason, message.author.id);
  return reply(message, "Member Hardbanned", `<@${userId}> is hardbanned and will be banned again if they rejoin.`);
}

async function handleSoftban(message, args, prefix) {
  if (!canUseBanCommands(message.member)) return missingPerm(message, "ban_members");
  const userId = await resolveUserId(message, args[1]);
  if (!userId) return reply(message, "Usage", `\`${prefix}softban <user> [reason]\``);
  const target = await message.guild.members.fetch(userId).catch(() => null);
  if (target && !canModerate(message.member, target)) {
    return reply(message, "Unable to Softban", "You cannot softban that member.");
  }
  const personalRefusal = require("./personal-ban").refusal(message, userId);
  if (personalRefusal) return personalRefusal;
  if (!botCanBan(message.guild)) {
    return reply(message, "Bot Missing Permission", "I need the Discord **Ban Members** permission to do that.");
  }
  const reason = args.slice(2).join(" ").trim() || "No reason provided";
  try {
    await applyBan(message.guild, userId, { reason, moderatorId: message.author.id });
    await message.guild.members.unban(userId, "Softban");
  } catch (error) {
    return reply(message, "Unable to Softban", error.message || "Discord rejected that softban.");
  }
  recordHistory(message.guild.id, userId, "softban", reason, message.author.id);
  return reply(message, "Member Softbanned", `<@${userId}> was softbanned. Reason: ${reason}`);
}

async function handleTempban(message, args, prefix) {
  if (!canUseBanCommands(message.member)) return missingPerm(message, "ban_members");
  const userId = await resolveUserId(message, args[1]);
  const duration = parseDuration(args[2]);
  if (!userId || !duration) {
    return reply(message, "Usage", `\`${prefix}tempban <user> <duration> [reason]\`\nDuration examples: \`10m\`, \`2h\`, \`1d\``);
  }
  const target = await message.guild.members.fetch(userId).catch(() => null);
  if (target && !canModerate(message.member, target)) {
    return reply(message, "Unable to Tempban", "You cannot tempban that member.");
  }
  if (!botCanBan(message.guild)) {
    return reply(message, "Bot Missing Permission", "I need the Discord **Ban Members** permission to do that.");
  }
  const reason = args.slice(3).join(" ").trim() || "No reason provided";
  const expiresAt = Date.now() + duration.ms;
  try {
    await applyBan(message.guild, userId, { reason, moderatorId: message.author.id });
  } catch (error) {
    return reply(message, "Unable to Tempban", error.message || "Discord rejected that ban.");
  }
  const row = {
    guild_id: message.guild.id,
    user_id: userId,
    reason,
    moderator_id: message.author.id,
    expires_at: expiresAt
  };
  db.addTempban(row);
  recordHistory(message.guild.id, userId, "tempban", `${reason} (${duration.label})`, message.author.id);
  scheduleTempban(message.client || message.guild.client, row);
  return reply(message, "Member Temporarily Banned", `<@${userId}> is banned for **${duration.label}**. Reason: ${reason}`);
}

async function handleUnban(message, args, prefix) {
  if (!canUseBanCommands(message.member)) return missingPerm(message, "ban_members");
  const userId = await resolveUserId(message, args[1]);
  if (!userId) return reply(message, "Usage", `\`${prefix}unban <id or username>\``);
  if (db.isForeverbanned(message.guild.id, userId)) {
    return reply(message, "Foreverbanned", "That user has a **foreverban**. `-unban` cannot lift it. Only `-fub` / `-foreverunban` can.");
  }
  const personalBan = require("./personal-ban");
  const personalRefusal = personalBan.refusal(message, userId);
  if (personalRefusal) return personalRefusal;
  personalBan.liftIfAllowed(message, userId);
  if (db.isHardbanned(message.guild.id, userId)) {
    return reply(message, "Hardbanned", "That user is hardbanned. An administrator must use `-hardban reset` or remove the hardban first.");
  }
  if (!botCanBan(message.guild)) {
    return reply(message, "Bot Missing Permission", "I need the Discord **Ban Members** permission to do that.");
  }
  try {
    await message.guild.members.unban(userId, args.slice(2).join(" ") || "Unbanned");
  } catch (error) {
    return reply(message, "Unable to Unban", "That user does not appear to be banned, or Discord rejected the unban.");
  }
  db.removeTempban(message.guild.id, userId);
  clearTempbanTimer(message.guild.id, userId);
  recordHistory(message.guild.id, userId, "unban", args.slice(2).join(" ") || "Unbanned", message.author.id);
  return reply(message, "Member Unbanned", `<@${userId}> was unbanned.`);
}

async function handleUnbanAll(message, args) {
  if (!canUseBanCommands(message.member)) return missingPerm(message, "ban_members");
  const wait = require("./systems/cooldowns").consume(message.guild.id, message.author.id, "unbanall");
  if (wait && (args[1] || "").toLowerCase() !== "cancel") {
    return reply(message, "Please Wait", require("./systems/cooldowns").waitText(wait));
  }
  const sub = (args[1] || "").toLowerCase();
  if (sub === "cancel") {
    const task = unbanAllTasks.get(message.guild.id);
    if (!task) return reply(message, "No Mass Unban", "There is no mass unban running in this server.");
    task.cancelled = true;
    return reply(message, "Mass Unban Cancelling", "The mass unban will stop after the current user.");
  }
  if (unbanAllTasks.has(message.guild.id)) {
    return reply(message, "Mass Unban Running", "A mass unban is already running. Use `-unbanall cancel` to stop it.");
  }
  if (!botCanBan(message.guild)) {
    return reply(message, "Bot Missing Permission", "I need the Discord **Ban Members** permission to do that.");
  }
  const bans = [...(await message.guild.bans.fetch().catch(() => new Map())).values()];
  const task = { cancelled: false };
  unbanAllTasks.set(message.guild.id, task);
  await reply(message, "Mass Unban Started", `Unbanning **${bans.length}** user(s). Hardbans, **foreverbans**, and personal bans you cannot lift are skipped.`);
  let unbanned = 0;
  let skipped = 0;
  try {
    for (const ban of bans) {
      if (task.cancelled) break;
      const userId = ban.user?.id;
      if (!userId || db.isHardbanned(message.guild.id, userId) || db.isForeverbanned(message.guild.id, userId)) {
        skipped += 1;
        continue;
      }
      const personal = require("./personal-ban");
      if (db.getPersonalBan(message.guild.id, userId) && !personal.canLift(message.member, db.getPersonalBan(message.guild.id, userId))) {
        skipped += 1;
        continue;
      }
      personal.liftIfAllowed(message, userId);
      const ok = await message.guild.members.unban(userId, "Mass unban").then(() => true).catch(() => false);
      if (ok) {
        unbanned += 1;
        db.removeTempban(message.guild.id, userId);
        clearTempbanTimer(message.guild.id, userId);
        recordHistory(message.guild.id, userId, "unban", "Mass unban", message.author.id);
      }
    }
  } finally {
    unbanAllTasks.delete(message.guild.id);
  }
  return message.reply({
    embeds: [embed(
      task.cancelled ? "Mass Unban Cancelled" : "Mass Unban Finished",
      `Unbanned **${unbanned}**. Skipped **${skipped}**.`,
      message.guild
    )]
  });
}

async function handleRole(message, args, prefix) {
  if (!canManageRoles(message.member)) return missingPerm(message, "manage_roles");
  const sub = (args[1] || "").toLowerCase();
  if (sub !== "add") {
    return reply(message, "Role Commands", `\`${prefix}role add <member> <role>\``);
  }
  const userId = await resolveUserId(message, args[2]);
  const role = await resolveRole(message, args[3]);
  if (!userId || !role) {
    return reply(message, "Usage", `\`${prefix}role add <member> <role>\`\n\nExample: \`${prefix}role add @user @Mods\``);
  }
  const target = await message.guild.members.fetch(userId).catch(() => null);
  if (!target) return reply(message, "Unknown Member", "That member is not in this server.");
  if (!botCanManageRoles(message.guild)) {
    return reply(message, "Bot Missing Permission", "I need the Discord **Manage Roles** permission to do that.");
  }
  if (!canAssignRole(message.member, role)) {
    return reply(message, "Unable to Add Role", "That role is managed, @everyone, or higher than you or the bot.");
  }
  if (target.roles.cache.has(role.id)) {
    return reply(message, "Already Has Role", `<@${target.id}> already has <@&${role.id}>.`);
  }
  try {
    await target.roles.add(role, `Role add by ${message.author.id}`);
  } catch (error) {
    return reply(message, "Unable to Add Role", error.message || "Discord rejected that role change.");
  }
  return reply(message, "Role Added", `Added <@&${role.id}> to <@${target.id}>.`);
}

async function handleForeverban(message, args, prefix) {
  if (!canForeverBan(message.member)) return missingPerm(message, "foreverban_members");
  const sub = (args[1] || "").toLowerCase();
  if (sub === "list") {
    const rows = db.listForeverbans(message.guild.id);
    const lines = rows.map((row) => `• <@${row.user_id}> (\`${row.user_id}\`) — ${row.reason || "No reason"}`);
    return listBans(message, "Foreverbanned Users", lines);
  }
  const userId = await resolveUserId(message, args[1]);
  if (!userId) {
    return reply(
      message,
      "Foreverban",
      `\`${prefix}fb <user> [reason]\`\n\`${prefix}fb list\`\nThis is the highest ban. \`-unban\` and \`-unbanall\` cannot lift it. Only \`${prefix}fub\` can.`
    );
  }
  if (userId === message.guild.ownerId) {
    return reply(message, "Unable to Foreverban", "The server owner cannot be foreverbanned.");
  }
  const target = await message.guild.members.fetch(userId).catch(() => null);
  if (target && !isGuildOwner(message.member) && !canModerate(message.member, target)) {
    return reply(message, "Unable to Foreverban", "You cannot foreverban that member.");
  }
  if (!botCanBan(message.guild)) {
    return reply(message, "Bot Missing Permission", "I need the Discord **Ban Members** permission to do that.");
  }
  const reason = args.slice(2).join(" ").trim() || "No reason provided";
  try {
    await applyForeverban(message.guild, userId, {
      reason,
      moderatorId: message.author.id,
      member: target,
      user: target?.user
    });
  } catch (error) {
    return reply(message, "Unable to Foreverban", error.message || "Discord rejected that ban.");
  }
  return reply(
    message,
    "Member Foreverbanned",
    `<@${userId}> is **foreverbanned**.\n\nThis deletes 7 days of messages, rebans them if they rejoin or get unbanned from Discord, and treats matching new accounts as alts.\nOnly \`${prefix}fub\` can lift this.`
  );
}

async function handleForeverunban(message, args, prefix) {
  if (!canForeverBan(message.member)) return missingPerm(message, "foreverban_members");
  const userId = await resolveUserId(message, args[1]);
  if (!userId) return reply(message, "Usage", `\`${prefix}fub <user>\` / \`${prefix}foreverunban <user>\``);
  if (!db.isForeverbanned(message.guild.id, userId)) {
    return reply(message, "Not Foreverbanned", "That user does not have a foreverban.");
  }
  const personalBan = require("./personal-ban");
  const personalRefusal = personalBan.refusal(message, userId);
  if (personalRefusal) return personalRefusal;
  personalBan.liftIfAllowed(message, userId);
  if (!botCanBan(message.guild)) {
    return reply(message, "Bot Missing Permission", "I need the Discord **Ban Members** permission to do that.");
  }
  allowedForeverUnbans.add(tempbanKey(message.guild.id, userId));
  db.removeForeverban(message.guild.id, userId);
  db.removeHardban(message.guild.id, userId);
  db.removeTempban(message.guild.id, userId);
  clearTempbanTimer(message.guild.id, userId);
  try {
    await message.guild.members.unban(userId, `Foreverunban by ${message.author.id}`);
  } catch {
    allowedForeverUnbans.delete(tempbanKey(message.guild.id, userId));
  }
  recordHistory(message.guild.id, userId, "foreverunban", "Foreverunban", message.author.id);
  return reply(message, "Foreverban Lifted", `<@${userId}> can rejoin. The foreverban record is gone.`);
}

async function handleCommand(message, args, prefix) {
  if (!access.canModerate(message.member)) {
    await reply(message, "Access Denied", "Moderation commands are limited to Gods and the server owner.");
    return true;
  }
  const command = args[0].toLowerCase();
  if (command === `${prefix}foreverban`.toLowerCase() || command === `${prefix}fb`.toLowerCase()) {
    await handleForeverban(message, args, prefix);
    return true;
  }
  if (command === `${prefix}foreverunban`.toLowerCase() || command === `${prefix}fub`.toLowerCase()) {
    await handleForeverunban(message, args, prefix);
    return true;
  }
  if (command === `${prefix}role`.toLowerCase()) {
    await handleRole(message, args, prefix);
    return true;
  }
  if (command === `${prefix}fakepermissions`.toLowerCase() || command === `${prefix}fp`.toLowerCase()) {
    await handleFakePermissions(message, args, prefix);
    return true;
  }
  if (command === `${prefix}ban`.toLowerCase()) {
    await handleBan(message, args, prefix);
    return true;
  }
  if (command === `${prefix}banned`.toLowerCase()) {
    if (!canUseBanCommands(message.member)) {
      await missingPerm(message, "ban_members");
      return true;
    }
    await banCheck(message, await resolveUserId(message, args[1]));
    return true;
  }
  if (command === `${prefix}hardban`.toLowerCase()) {
    await handleHardban(message, args, prefix);
    return true;
  }
  if (command === `${prefix}softban`.toLowerCase()) {
    await handleSoftban(message, args, prefix);
    return true;
  }
  if (command === `${prefix}tempban`.toLowerCase()) {
    await handleTempban(message, args, prefix);
    return true;
  }
  if (command === `${prefix}unban`.toLowerCase()) {
    await handleUnban(message, args, prefix);
    return true;
  }
  if (command === `${prefix}unbanall`.toLowerCase()) {
    await handleUnbanAll(message, args);
    return true;
  }
  return false;
}

module.exports = {
  handleCommand,
  startTempbanScheduler,
  enforceHardban,
  enforceForeverban,
  restoreForeverban,
  PERMISSIONS
};
