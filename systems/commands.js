const vouchStore = require("../vouch/store");
const roles = require("../vouch/roles");
const { MAX_ALLOWANCE, MAX_ROLE_LIMIT } = require("../vouch/constants");
const { card } = require("../feedback");
const { reply } = require("../vouch/ui");
const catalog = require("../vouch/catalog");
const vouchLogging = require("../vouch/logging");
const store = require("./store");
const access = require("./access");
const logs = require("./logs");
const voice = require("./voice");
const channels = require("./channels");
const modsetup = require("./modsetup");
const afk = require("../afk");

const RANK_COMMANDS = new Set(access.VOICE_COMMANDS);

function commandName(args, prefix) {
  const head = String(args[0] || "").toLowerCase();
  const normalized = String(prefix || "").toLowerCase();
  return head.startsWith(normalized) ? head.slice(prefix.length) : head;
}

function deny(message, description) {
  return reply(message, "Access Denied", description);
}

function audit(message, action, targetId, reason) {
  return vouchLogging.record(message.guild, {
    action,
    actorId: message.author.id,
    targetId: targetId || null,
    reason
  });
}

async function resolveMember(message, argument) {
  const id = String(argument || "").replace(/[<@!>]/g, "");
  if (/^\d{17,20}$/.test(id)) {
    return message.guild.members.cache.get(id) || await message.guild.members.fetch(id).catch(() => null);
  }
  const name = String(argument || "").toLowerCase();
  if (!name) return null;
  return [...message.guild.members.cache.values()].find((member) => {
    return member.user?.username?.toLowerCase() === name || member.displayName?.toLowerCase() === name;
  }) || null;
}

async function resolveRole(message, argument) {
  const mentioned = message.mentions?.roles?.first?.() || message.mentions?.roles?.values?.().next?.().value;
  if (mentioned) return mentioned;
  const id = String(argument || "").replace(/[<@&>]/g, "");
  if (/^\d{17,20}$/.test(id)) {
    return message.guild.roles.cache.get(id) || await message.guild.roles.fetch(id).catch(() => null);
  }
  const name = String(argument || "").trim().toLowerCase();
  if (!name) return null;
  return [...message.guild.roles.cache.values()].find((role) => role.name.toLowerCase() === name) || null;
}

function wholeNumber(raw, max) {
  if (!/^\d+$/.test(String(raw || ""))) return null;
  const value = Number(raw);
  if (value > max) return null;
  return value;
}

function canLimit(member) {
  return access.canUseLogs(member);
}

function rankList(guild) {
  const rows = store.listRanks(guild.id);
  if (!rows.length) return "Nobody has a VC rank.";
  return access.LADDER.map((rank) => {
    const members = rows.filter((row) => row.rank_key === rank.key).map((row) => `<@${row.user_id}>`);
    return `**${rank.label}**\n${members.length ? members.join(", ") : "none"}`;
  }).join("\n\n");
}

async function giveVoiceRole(member, role) {
  if (typeof member.roles?.add === "function") {
    await roles.addRole(member, role.id, "VC rank assigned");
    return;
  }
  member.roles?.cache?.set(role.id, role);
}

async function takeVoiceRole(member, roleId) {
  if (!member.roles?.cache?.has?.(roleId)) return;
  if (typeof member.roles?.remove === "function") {
    await roles.removeRole(member, roleId, "VC rank changed");
    return;
  }
  member.roles.cache.delete(roleId);
}

async function assignVoiceRank(message, member, rank) {
  if (!access.canAssignRanks(message.member)) {
    return deny(message, "Only Gods and the server owner can assign VC ranks.");
  }
  if (!member || !rank) {
    return reply(message, "Usage", "`-vc rank assign @user <plus|premium|premium plus>`");
  }
  if (member.user?.bot) return reply(message, "Invalid Target", "Bots cannot hold a VC rank.");
  const roleId = store.roleIdForRank(message.guild.id, rank.key);
  const role = roleId && (message.guild.roles.cache.get(roleId) || await message.guild.roles.fetch(roleId).catch(() => null));
  if (!role) {
    return reply(message, "Role Not Set", `Set the **${rank.label}** role first with \`-voice plus\`, \`-voice premium\`, or \`-vouch premium plus\`.`);
  }
  for (const id of store.voiceRoleIds(message.guild.id)) {
    if (id !== role.id) await takeVoiceRole(member, id);
  }
  await giveVoiceRole(member, role);
  store.setRank(message.guild.id, member.id, rank.key, message.author.id);
  return reply(message, "Rank Assigned", `<@${member.id}> is **${rank.label}**.\nAssigned by <@${message.author.id}>.\nCommands: ${access.commandsForRank(rank.key).join(", ")}`);
}

function voiceRankInfo(message, member) {
  const row = store.getRank(message.guild.id, member.id);
  const key = row?.rank_key || access.voiceRankKey(member);
  const rank = access.rankByKey(key);
  if (!rank) return reply(message, "No Rank", `<@${member.id}> does not have a VC rank.`);
  return reply(message, "VC Rank", [
    `**Member:** <@${member.id}>`,
    `**Rank:** ${rank.label}`,
    `**Assigned by:** ${row?.set_by ? `<@${row.set_by}>` : "not recorded"}`,
    `**Commands:** ${access.commandsForRank(rank.key).join(", ")}`
  ].join("\n"));
}

async function clearVoiceRank(message, member) {
  if (!access.canAssignRanks(message.member)) return deny(message, "Only Gods and the server owner can remove VC ranks.");
  if (!member) return reply(message, "Missing User", "Mention a member or provide their user ID.");
  const row = store.getRank(message.guild.id, member.id);
  if (!row && !access.voiceRankKey(member)) return reply(message, "No Rank", `<@${member.id}> does not have a VC rank.`);
  for (const id of store.voiceRoleIds(message.guild.id)) await takeVoiceRole(member, id);
  store.clearRank(message.guild.id, member.id);
  return reply(message, "Rank Removed", `<@${member.id}> was removed from the VC ranks.`);
}

async function handleVoiceRank(message, args) {
  const sub = (args[1] || "").toLowerCase();
  if (sub === "unrank") return clearVoiceRank(message, await resolveMember(message, args[2]));
  if (sub === "rankinfo") return voiceRankInfo(message, await resolveMember(message, args[2]) || message.member);
  const action = (args[2] || "list").toLowerCase();
  if (action === "assign") {
    const member = await resolveMember(message, args[3]);
    return assignVoiceRank(message, member, access.parseRank(args.slice(4).join(" ")));
  }
  if (action === "info") return voiceRankInfo(message, await resolveMember(message, args[3]) || message.member);
  return reply(message, "VC Ranks", `${access.ladderText()}\n\n${rankList(message.guild)}`);
}

async function bindVoiceRole(message, rankKey, roleArg) {
  if (!access.canAssignRanks(message.member)) return deny(message, "Only Gods and the server owner can set VC rank roles.");
  const role = await resolveRole(message, roleArg);
  if (!role || role.id === message.guild.id || role.managed) return reply(message, "Missing Role", "Mention a role that I can manage.");
  store.setVoiceRole(message.guild.id, rankKey, role.id);
  const rank = access.rankByKey(rankKey);
  return reply(message, "Voice Rank Role Set", `**${rank.label}** is now <@&${role.id}>. Unauthorized adds are reversed.`);
}

async function handleGod(message, args) {
  const sub = (args[1] || "").toLowerCase();
  if (sub === "rank" || sub === "unrank" || sub === "rankinfo") {
    return reply(message, "VC Ranks", "Use `-vc rank`, `-vc rank assign @user <rank>`, `-vc unrank @user`, and `-vc rankinfo`.");
  }
  if (!access.canManageGodmode(message.member)) {
    return deny(message, "Gods and the server owner can manage Godmode.");
  }
  if (sub === "add" || sub === "take" || sub === "info") {
    const member = await resolveMember(message, args[2]);
    if (!member) return reply(message, "Missing User", "Mention a member or provide their user ID.");
    if (sub === "info") {
      const row = store.getGodmode(message.guild.id, member.id);
      const rank = access.rankByKey(store.getRank(message.guild.id, member.id)?.rank_key);
      return reply(message, "Godmode Status", [
        `**Member:** <@${member.id}>`,
        `**Godmode:** ${row ? "yes" : "no"}`,
        `**Management:** ${store.isManagement(message.guild.id, member.id) ? "yes" : "no"}`,
        `**VC rank:** ${rank?.label || "none"}`
      ].join("\n"));
    }
    if (sub === "add") {
      if (member.user?.bot) return reply(message, "Invalid Target", "Bots cannot receive Godmode.");
      store.addGodmode(message.guild.id, member.id, message.author.id);
      return reply(message, "Godmode Granted", `<@${member.id}> now has Godmode.`);
    }
    if (!store.removeGodmode(message.guild.id, member.id)) return reply(message, "No Godmode", `<@${member.id}> does not have Godmode.`);
    return reply(message, "Godmode Removed", `<@${member.id}> no longer has Godmode.`);
  }
  return reply(message, "Godmode", [
    "`-god add @user` — give Godmode",
    "`-god take @user` — remove Godmode",
    "`-god info @user` — view Godmode status",
    "",
    "VC ranks use `-vc rank assign @user <plus|premium|premium plus>`."
  ].join("\n"));
}

async function handleManagement(message, args, prefix) {
  const sub = (args[1] || "").toLowerCase();
  if (sub === "add" || sub === "take") {
    if (!access.canManageManagement(message.member)) {
      return deny(message, "Management cannot grant or remove Management access. Gods and the server owner can.");
    }
    const member = await resolveMember(message, args[2]);
    if (!member) return reply(message, "Missing User", "Mention a member or provide their user ID.");
    if (sub === "add") {
      if (member.user?.bot) return reply(message, "Invalid Target", "Bots cannot receive Management.");
      const created = store.addManagement(message.guild.id, member.id, message.author.id);
      return reply(message, created ? "Management Granted" : "Already Management", `<@${member.id}> ${created ? "can now manage Godmode" : "already has Management"}.`);
    }
    if (!store.removeManagement(message.guild.id, member.id)) return reply(message, "Not Management", `<@${member.id}> does not have Management.`);
    return reply(message, "Management Removed", `<@${member.id}> can no longer manage Godmode.`);
  }
  const rows = store.listManagement(message.guild.id);
  const people = rows.length ? rows.map((row) => `<@${row.user_id}>`).join("\n") : "Nobody has Management.";
  return reply(message, "Management", [
    "Management is a standalone access level with no tiers. These users can manage Godmode. They cannot grant or remove Management access.",
    "",
    people,
    "",
    `\`${prefix}m add @user\``,
    `\`${prefix}m take @user\``,
    `\`${prefix}m list\``
  ].join("\n"));
}

async function handleRoleLimit(message, args) {
  if (!canLimit(message.member)) return deny(message, "OS, the server owner, the bot owner, or an Anti-Nuke admin can set role limits.");
  const action = (args[2] || "").toLowerCase();
  if (action === "view" || !action) {
    const rows = vouchStore.listLimitedRoles(message.guild.id);
    if (!rows.length) return reply(message, "Role Limits", "No roles have a member limit.");
    const lines = rows.map((row) => {
      const role = message.guild.roles.cache.get(row.role_id);
      const count = roles.countMembersWithRole(message.guild, row.role_id);
      return `${role ? `<@&${role.id}>` : "Deleted role"} — ${count}/${row.max_members}`;
    });
    return reply(message, "Role Limits", lines.join("\n"));
  }
  if (action === "remove") {
    const role = await resolveRole(message, args.slice(3).join(" "));
    if (!role) return reply(message, "Missing Role", "Mention a role or provide its ID.");
    if (!vouchStore.deleteLimitedRole(message.guild.id, role.id)) return reply(message, "No Limit", `${role.name} does not have a limit.`);
    await audit(message, "role_limit", role.id, `Removed the member cap from ${role.name}`);
    return reply(message, "Role Limit Removed", `${role.name} no longer has a member limit.`);
  }
  if (action === "set") {
    const raw = args[args.length - 1];
    const max = wholeNumber(raw, MAX_ROLE_LIMIT);
    if (max == null) return reply(message, "Invalid Limit", `Provide a whole number from 0 to ${MAX_ROLE_LIMIT}.`);
    const role = await resolveRole(message, args.slice(3, -1).join(" "));
    if (!role || role.id === message.guild.id) return reply(message, "Missing Role", "Mention a role or provide its ID.");
    vouchStore.setLimitedRole(message.guild.id, role.id, max, message.author.id);
    await audit(message, "role_limit", role.id, `${role.name} capped at ${max}`);
    const count = roles.countMembersWithRole(message.guild, role.id);
    return reply(message, "Role Limit Set", `${role.name} is limited to **${max}** members. Current count: **${count}/${max}**.`);
  }
  return reply(message, "Role Limits", "`-role limit set @role <#>`\n`-role limit remove @role`\n`-role limit view`");
}

async function handleVouchLimit(message, args) {
  if (!canLimit(message.member)) return deny(message, "OS, the server owner, the bot owner, or an Anti-Nuke admin can set vouch limits.");
  const scope = (args[3] || "").toLowerCase();
  if (scope === "global" || scope === "giver") {
    const max = wholeNumber(args[4], MAX_ALLOWANCE);
    if (max == null) return reply(message, "Invalid Limit", `Provide a whole number from 0 to ${MAX_ALLOWANCE}.`);
    if (scope === "global") vouchStore.setGlobalCap(message.guild.id, max);
    else vouchStore.setGiverCap(message.guild.id, max);
    await audit(message, "limit_set", null, `${scope} vouch cap set to ${max}`);
    return reply(message, "Vouch Limit Updated", `The ${scope} vouch cap is **${max}**. User overrides still win.`);
  }
  if (scope === "user") {
    const member = await resolveMember(message, args[4]);
    const max = wholeNumber(args[5], MAX_ALLOWANCE);
    if (!member || max == null) return reply(message, "Usage", "`-antinuke vouch limit user @user <#>`");
    vouchStore.setAllowance(message.guild.id, member.id, max, message.author.id);
    await audit(message, "limit_set", member.id, `User vouch cap set to ${max}`);
    return reply(message, "Vouch Limit Updated", `<@${member.id}> can give **${max}** active vouches.`);
  }
  if (scope === "remove") {
    const member = await resolveMember(message, args[4]);
    if (!member) return reply(message, "Missing User", "Mention the member whose override should be removed.");
    if (!vouchStore.clearAllowance(message.guild.id, member.id)) return reply(message, "No Override", `<@${member.id}> does not have a vouch limit override.`);
    await audit(message, "limit_reset", member.id, "User vouch cap removed");
    return reply(message, "Override Removed", `<@${member.id}> now uses the global or giver cap.`);
  }
  if (scope === "view" || !scope) {
    const caps = vouchStore.getCaps(message.guild.id);
    const overrides = vouchStore.listAllowances(message.guild.id);
    const lines = [
      `**Global cap:** ${caps.globalMax == null ? "default" : caps.globalMax}`,
      `**Giver cap:** ${caps.giverMax == null ? "default" : caps.giverMax}`,
      "**User overrides**",
      overrides.length ? overrides.map((row) => `<@${row.user_id}> — ${row.max_vouches}`).join("\n") : "none"
    ];
    return reply(message, "Vouch Limits", lines.join("\n"));
  }
  return reply(message, "Vouch Limits", [
    "`-antinuke vouch limit global <#>`",
    "`-antinuke vouch limit giver <#>`",
    "`-antinuke vouch limit user @user <#>`",
    "`-antinuke vouch limit remove @user`",
    "`-antinuke vouch limit view`"
  ].join("\n"));
}

async function handleStaff(message, tierKey, args, prefix) {
  const tier = access.staffByKey(tierKey);
  const action = (args[1] || "").toLowerCase();
  if (action !== "add" && action !== "remove" && action !== "take") {
    return reply(message, tier.label, `\`${prefix}${tier.command} add @user\`\n\`${prefix}${tier.command} remove @user\``);
  }
  if (!access.canGrantStaff(message.member, tier.key)) {
    const who = tier.key === "god"
      ? "Only the server owner can add or remove God."
      : tier.key === "founder"
        ? "Only a God or the server owner can add or remove Founder."
        : "Only a Founder, a God, or the server owner can add or remove Boss.";
    return deny(message, who);
  }
  const member = await resolveMember(message, args[2]);
  if (!member || member.user?.bot) return reply(message, "Missing User", "Mention a human member or provide their user ID.");
  if (member.id === message.guild.ownerId) return reply(message, "Server Owner", "The server owner is above the staff tiers.");
  const current = store.getStaff(message.guild.id, member.id);
  if (action === "remove" || action === "take") {
    if (current?.tier !== tier.key) return reply(message, "Not Staff", `<@${member.id}> is not ${tier.label}.`);
    store.clearStaff(message.guild.id, member.id);
    await audit(message, "staff_remove", member.id, `${tier.label} removed`);
    return reply(message, `${tier.label} Removed`, `<@${member.id}> is no longer ${tier.label}.`);
  }
  if (current?.tier === "god" && tier.key !== "god") {
    return deny(message, "Only the server owner can change a God, and only with `-ceo`.");
  }
  if (current?.tier === tier.key) return reply(message, `Already ${tier.label}`, `<@${member.id}> is already ${tier.label}.`);
  store.setStaff(message.guild.id, member.id, tier.key, message.author.id);
  await audit(message, "staff_add", member.id, `${tier.label} added`);
  return reply(message, `${tier.label} Added`, `<@${member.id}> is now **${tier.label} • ${tier.title}**.`);
}

function staffRegistry(guild) {
  return access.STAFF.slice().reverse().map((tier) => {
    const rows = store.listStaff(guild.id, tier.key);
    const lines = rows.length ? rows.map((row) => `<@${row.user_id}>`).join("\n") : "none";
    return `**${tier.label} • ${tier.title}**\n${lines}`;
  }).join("\n\n");
}

async function handleAntinuke(message, args, prefix) {
  const sub = (args[1] || "").toLowerCase();
  if (sub === "admins") return reply(message, "Staff Registry", staffRegistry(message.guild));
  if (sub === "vouch") {
    if ((args[2] || "").toLowerCase() === "limit") return handleVouchLimit(message, args);
    return false;
  }
  if (sub === "admin") {
    const action = (args[2] || "").toLowerCase();
    if (action === "list" || !action) {
      const rows = store.listAntinukeAdmins(message.guild.id);
      const lines = rows.length ? rows.map((row) => `<@${row.user_id}>`).join("\n") : "No Anti-Nuke admins.";
      return reply(message, "Anti-Nuke Admins", lines);
    }
    if (!access.isServerOwner(message.member)) {
      return deny(message, "Only the server owner can add or remove Anti-Nuke admins.");
    }
    const member = await resolveMember(message, args[3]);
    if (!member) return reply(message, "Missing User", "Mention a member or provide their user ID.");
    if (action === "add") {
      const created = store.addAntinukeAdmin(message.guild.id, member.id, message.author.id);
      if (created) await audit(message, "antinuke_admin_add", member.id, "Anti-Nuke admin added");
      return reply(message, created ? "Anti-Nuke Admin Added" : "Already an Admin", `<@${member.id}> ${created ? "can assign ranks, logs, and limits" : "is already an Anti-Nuke admin"}.`);
    }
    if (action === "remove" || action === "take") {
      if (!store.removeAntinukeAdmin(message.guild.id, member.id)) return reply(message, "Not an Admin", `<@${member.id}> is not an Anti-Nuke admin.`);
      await audit(message, "antinuke_admin_remove", member.id, "Anti-Nuke admin removed");
      return reply(message, "Anti-Nuke Admin Removed", `<@${member.id}> is no longer an Anti-Nuke admin.`);
    }
  }
  return reply(message, "AntiNuke", [
    `\`${prefix}antinuke admin add @user\``,
    `\`${prefix}antinuke admin remove @user\``,
    `\`${prefix}antinuke admin list\``,
    `\`${prefix}antinuke vouch limit global <#>\``,
    `\`${prefix}antinuke vouch limit giver <#>\``,
    `\`${prefix}antinuke vouch limit user @user <#>\``,
    `\`${prefix}antinuke vouch limit remove @user\``,
    `\`${prefix}antinuke vouch limit view\``
  ].join("\n"));
}

async function showUser(message, member) {
  const user = member?.user || message.author;
  const avatar = typeof user.displayAvatarURL === "function" ? user.displayAvatarURL({ size: 256 }) : null;
  let banner = null;
  if (typeof user.fetch === "function") {
    const fetched = await user.fetch().catch(() => user);
    banner = typeof fetched.bannerURL === "function" ? fetched.bannerURL({ size: 512 }) : null;
  }
  return { user, avatar, banner, member: member || message.member };
}

const VERIFICATION = ["None", "Low", "Medium", "High", "Very High"];

function imageReply(message, title, url, missing) {
  if (!url) return reply(message, title, missing, "error");
  return message.reply({
    embeds: [card(title, "", { guild: message.guild }).setImage(url)]
  });
}

async function roleGranters(guild, member) {
  if (typeof guild.fetchAuditLogs !== "function") return "not recorded";
  const { AuditLogEvent } = require("discord.js");
  const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 25 }).catch(() => null);
  if (!logs?.entries) return "not recorded";
  const found = new Map();
  for (const entry of logs.entries.values()) {
    if (String(entry.targetId) !== String(member.id)) continue;
    for (const change of entry.changes || []) {
      if (change.key !== "$add") continue;
      for (const role of change.new || []) {
        if (!found.has(role.id)) found.set(role.id, entry.executorId || entry.executor?.id || null);
      }
    }
  }
  if (!found.size) return "not recorded";
  return [...found.entries()].map(([roleId, actorId]) => `<@&${roleId}> by ${actorId ? `<@${actorId}>` : "unknown"}`).join("\n");
}

async function handleInfo(message, name, args) {
  if (name === "serverinfo") {
    const guild = message.guild;
    const members = [...guild.members.cache.values()];
    const bots = members.filter((member) => member.user?.bot).length;
    const created = guild.createdTimestamp ? `<t:${Math.floor(guild.createdTimestamp / 1000)}:F>` : "unknown";
    const verification = VERIFICATION[guild.verificationLevel] || "unknown";
    return reply(message, guild.name || "Server", [
      `**ID:** \`${guild.id}\``,
      `**Owner:** <@${guild.ownerId}>`,
      `**Created:** ${created}`,
      `**Members:** ${guild.memberCount ?? members.length}`,
      `**Bots:** ${bots}`,
      `**Verification:** ${verification}`,
      `**Channels:** ${guild.channels.cache.size}`,
      `**Roles:** ${guild.roles.cache.size}`
    ].join("\n"));
  }
  const member = await resolveMember(message, args[1]) || message.member;
  const info = await showUser(message, member);
  if (name === "avatar") return imageReply(message, "Avatar", info.avatar, "This user has no avatar.");
  if (name === "banner") return imageReply(message, "Banner", info.banner, "This user has no banner.");
  const roleList = member.roles?.cache
    ? [...member.roles.cache.values()].filter((role) => role.id !== message.guild.id).map((role) => role.name ? `@${role.name}` : `<@&${role.id}>`)
    : [];
  const joined = member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : "unknown";
  const created = info.user.createdTimestamp ? `<t:${Math.floor(info.user.createdTimestamp / 1000)}:F>` : "unknown";
  const granters = await roleGranters(message.guild, member);
  return reply(message, "User Info", [
    `**User:** <@${info.user.id}>`,
    `**ID:** \`${info.user.id}\``,
    `**Account created:** ${created}`,
    `**Joined:** ${joined}`,
    `**Nickname:** ${member.displayName || info.user.username || "unknown"}`,
    `**Roles:** ${roleList.length ? roleList.join(", ") : "none"}`,
    `**Role grants:** ${granters}`,
    `**Staff rank:** ${access.rankLine(member).replace("Your rank: ", "")}`
  ].join("\n"));
}

async function restart(message) {
  if (!access.canRestart(message.member)) {
    return deny(message, "Founders, Gods, and the server owner can restart the bot.");
  }
  await reply(message, "Restarting", "The bot is shutting down so the process manager can start it again.");
  if (!process.env.NODE_TEST_CONTEXT) {
    const timer = setTimeout(() => process.exit(1), 400);
    timer.unref?.();
  }
  return true;
}

async function handleCommand(message, args, prefix) {
  const name = commandName(args, prefix);
  if (name === "afk") {
    await afk.setAway(message, args.slice(1).join(" "));
    return true;
  }
  if (name === "showallcommands") {
    const pages = catalog.embeds(prefix);
    if (pages[0]?.setFooter) pages[0].setFooter({ text: access.rankLine(message.member) });
    await message.reply({ embeds: pages });
    return true;
  }
  if (name === "logging" || name === "logs") {
    await logs.handleLogging(message, args, prefix);
    return true;
  }
  if (name === "restart") {
    await restart(message);
    return true;
  }
  if (name === "modsetup") {
    await modsetup.open(message);
    return true;
  }
  if (name === "voice") {
    const kind = (args[1] || "").toLowerCase();
    if (kind === "plus") {
      await bindVoiceRole(message, "plus", args.slice(2).join(" "));
      return true;
    }
    if (kind === "premium" && (args[2] || "").toLowerCase() !== "plus") {
      await bindVoiceRole(message, "premium", args.slice(2).join(" "));
      return true;
    }
    if (kind === "premium") {
      await bindVoiceRole(message, "premiumplus", args.slice(3).join(" "));
      return true;
    }
    await reply(message, "Voice Ranks", "`-voice plus @role`\n`-voice premium @role`\n`-vouch premium plus @role`");
    return true;
  }
  if (name === "vouch" && (args[1] || "").toLowerCase() === "premium" && (args[2] || "").toLowerCase() === "plus") {
    await bindVoiceRole(message, "premiumplus", args.slice(3).join(" "));
    return true;
  }
  if (name === "rank" || name === "ranks") {
    await reply(message, "VC Ranks", `${access.ladderText()}\n\n${rankList(message.guild)}`);
    return true;
  }
  if (name === "unrank") {
    await clearVoiceRank(message, await resolveMember(message, args[1]));
    return true;
  }
  if (name === "rankinfo") {
    await voiceRankInfo(message, await resolveMember(message, args[1]) || message.member);
    return true;
  }
  if (name === "god") {
    await handleGod(message, args);
    return true;
  }
  if (name === "m" || name === "management" || name === "mgmt" || name === "managegod") {
    await handleManagement(message, args, prefix);
    return true;
  }
  if (name === "ceo") {
    await handleStaff(message, "god", args, prefix);
    return true;
  }
  if (name === "founder") {
    await handleStaff(message, "founder", args, prefix);
    return true;
  }
  if (name === "boss") {
    await handleStaff(message, "boss", args, prefix);
    return true;
  }
  if (name === "antinuke") {
    const handled = await handleAntinuke(message, args, prefix);
    return handled !== false;
  }
  if (name === "role" && (args[1] || "").toLowerCase() === "limit") {
    await handleRoleLimit(message, args);
    return true;
  }
  if (name === "avatar" || name === "banner" || name === "serverinfo" || name === "userinfo") {
    await handleInfo(message, name, args);
    return true;
  }
  if (await channels.handleCommand(message, name, args) !== false) return true;
  if (name === "lockdown") {
    await voice.lockdown(message, true);
    return true;
  }
  if (name === "unlockdown") {
    await voice.lockdown(message, false);
    return true;
  }
  if (RANK_COMMANDS.has(name)) {
    const target = await resolveMember(message, args[1]);
    await voice.runRankCommand(message, name, target, args[1]);
    return true;
  }
  if (name === "vc") {
    const sub = (args[1] || "").toLowerCase();
    if (sub === "rank" || sub === "unrank" || sub === "rankinfo") {
      await handleVoiceRank(message, args);
      return true;
    }
    if (RANK_COMMANDS.has(sub)) {
      const target = await resolveMember(message, args[2]);
      await voice.runRankCommand(message, sub, target, args[2]);
      return true;
    }
  }
  return false;
}

module.exports = { handleCommand, commandName };
