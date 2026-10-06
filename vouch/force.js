const store = require("./store");
const access = require("../systems/access");
const logging = require("./logging");
const roles = require("./roles");
const { resolveMember, resolveRole, resolveUserId } = require("./resolve");
const { mentionUser } = require("./util");
const { embed, reply } = require("./ui");
const cooldowns = require("../systems/cooldowns");
const { ActionRowBuilder, StringSelectMenuBuilder, MessageFlags } = require("discord.js");

const NICK_LIMIT = 32;

function usage(prefix) {
  return [
    `\`${prefix}forcenickname @user <nickname>\``,
    `\`${prefix}unforcenickname @user\``,
    `\`${prefix}forcerolestrip @user @role\``,
    `\`${prefix}forcestrip @user @role\` — block one user`,
    `\`${prefix}forcestrip @role\` — remove that role from everyone`,
    `\`${prefix}unforcerolestrip @user\``,
    `\`${prefix}unforcestrip @user\``,
    `\`${prefix}rolestrip @role\``,
    "",
    "Each force command has a **20 second** cooldown."
  ].join("\n");
}

function forceCooldown(message, action) {
  const wait = cooldowns.consume(message.guild.id, message.author.id, action);
  if (!wait) return null;
  return reply(message, "Please Wait", cooldowns.waitText(wait));
}

function panelRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("spanter:force")
      .setPlaceholder("Force Management")
      .addOptions(
        { label: "Overview", value: "overview", description: "What this panel controls" },
        { label: "Nickname", value: "nickname", description: "Force or clear a nickname" },
        { label: "Role Block", value: "block", description: "Stop one user from holding a role" },
        { label: "Role Strip", value: "strip", description: "Remove a role from everyone" }
      )
  );
}

function panelEmbed(prefix, section = "overview") {
  const pages = {
    overview: `Force Management\n\n${usage(prefix)}`,
    nickname: `\`${prefix}forcenickname @user <nickname>\`\nKeeps putting that nickname back if it changes.\n\n\`${prefix}unforcenickname @user\`\nStops enforcing it and clears the nickname.`,
    block: `\`${prefix}forcerolestrip @user @role\`\nAlias: \`${prefix}forcestrip @user @role\`\n\nThe user cannot hold that role. If they already have it, it is removed.\n\n\`${prefix}unforcerolestrip @user\`\nAlias: \`${prefix}unforcestrip @user\``,
    strip: `\`${prefix}rolestrip @role\`\nAlias: \`${prefix}forcestrip @role\`\n\nRemoves the role from everyone who currently has it. If the role is the vouch role, those active vouches are closed.`
  };
  return embed("Force Management", pages[section] || pages.overview, true);
}

async function openPanel(message, prefix) {
  if (!access.canUseForce(message.member)) {
    return reply(message, "Not Allowed", "Only Founders, Gods, and the server owner can use Force Management.");
  }
  return message.reply({ embeds: [panelEmbed(prefix)], components: [panelRow()] });
}

async function handleSelect(interaction, prefix) {
  const member = interaction.member;
  if (member && !member.guild && interaction.guild) member.guild = interaction.guild;
  if (!access.canUseForce(member)) {
    await interaction.reply({
      embeds: [embed("Not Allowed", "Only Founders, Gods, and the server owner can use Force Management.")],
      flags: MessageFlags.Ephemeral
    });
    return true;
  }
  const section = interaction.values?.[0] || "overview";
  await interaction.update({ embeds: [panelEmbed(prefix, section)], components: [panelRow()] });
  return true;
}

async function forceNickname(message, userArg, nickname) {
  if (!access.canUseForce(message.member)) return reply(message, "Not Allowed", "Only Founders, Gods, and the server owner can force nicknames.");
  const member = await resolveMember(message, userArg);
  if (!member || member.user?.bot) return reply(message, "Missing User", "Mention a human member or provide their user ID.");
  if (member.id === message.guild.ownerId && message.member.id !== message.guild.ownerId) {
    return reply(message, "Protected User", "Only the server owner can force the owner's nickname.");
  }
  const name = String(nickname || "").trim().replace(/\s+/g, " ");
  if (!name || name.length > NICK_LIMIT) {
    return reply(message, "Invalid Nickname", `Provide a nickname up to ${NICK_LIMIT} characters.`);
  }
  const wait = forceCooldown(message, "forcenickname");
  if (wait) return wait;
  store.setForcedNick(message.guild.id, member.id, name, message.author.id);
  try {
    await roles.applyNickname(member, name, `Forced nickname by ${message.author.id}`);
  } catch (error) {
    store.clearForcedNick(message.guild.id, member.id);
    return reply(message, "Nickname Failed", "I couldn't change that nickname. Check Manage Nicknames and my role position.");
  }
  await logging.record(message.guild, {
    action: "force_nick",
    actorId: message.author.id,
    targetId: member.id,
    reason: name
  });
  return reply(message, "Forced Nickname", `${mentionUser(member.id)} will keep the nickname **${name}**.`);
}

async function unforceNickname(message, userArg) {
  if (!access.canUseForce(message.member)) return reply(message, "Not Allowed", "Only Founders, Gods, and the server owner can clear forced nicknames.");
  const member = await resolveMember(message, userArg);
  const userId = member?.id || await resolveUserId(message, userArg);
  if (!userId) return reply(message, "Missing User", "Mention a user or provide their user ID.");
  if (!store.getForcedNick(message.guild.id, userId)) {
    return reply(message, "No Forced Nickname", "That user does not have a forced nickname.");
  }
  const wait = forceCooldown(message, "unforcenickname");
  if (wait) return wait;
  store.clearForcedNick(message.guild.id, userId);
  if (member?.setNickname) {
    try {
      await roles.applyNickname(member, null, `Forced nickname cleared by ${message.author.id}`);
    } catch (error) {
      await logging.record(message.guild, {
        action: "force_nick_clear",
        actorId: message.author.id,
        targetId: userId,
        reason: "Force removed; nickname could not be reset"
      });
      return reply(message, "Forced Nickname Removed", "The force was removed, but I could not reset the current nickname.");
    }
  }
  await logging.record(message.guild, {
    action: "force_nick_clear",
    actorId: message.author.id,
    targetId: userId,
    reason: "Forced nickname removed"
  });
  return reply(message, "Forced Nickname Removed", "That user can change their nickname again.");
}

async function forceRoleStrip(message, userArg, roleArg) {
  if (!access.canUseForce(message.member)) return reply(message, "Not Allowed", "Only Founders, Gods, and the server owner can block roles.");
  const member = await resolveMember(message, userArg);
  const role = await resolveRole(message, roleArg);
  if (!member || member.user?.bot) return reply(message, "Missing User", "Mention a human member or provide their user ID.");
  if (!role || role.id === message.guild.id) return reply(message, "Invalid Role", "Mention a role, role ID, or role name.");
  if (member.id === message.guild.ownerId && message.member.id !== message.guild.ownerId) {
    return reply(message, "Protected User", "Only the server owner can block roles on the owner.");
  }
  const wait = forceCooldown(message, "forcerolestrip");
  if (wait) return wait;
  store.addForcedRoleStrip(message.guild.id, member.id, role.id, message.author.id);
  if (member.roles.cache.has(role.id)) {
    if (store.getConfig(message.guild.id).vouch_role_id === role.id) {
      store.deactivateVouch(message.guild.id, member.id, message.author.id, "Forced role strip");
    }
    try {
      await roles.removeRole(member, role, `Forced role strip by ${message.author.id}`);
    } catch (error) {
      return reply(message, "Role Blocked", `The block is saved, but I could not remove ${role.name} right now.`);
    }
  }
  await logging.record(message.guild, {
    action: "force_role_strip",
    actorId: message.author.id,
    targetId: member.id,
    reason: `Blocked from ${role.name}`,
    details: { roleId: role.id }
  });
  return reply(message, "Role Blocked", `${mentionUser(member.id)} cannot receive **${role.name}**.`);
}

async function unforceRoleStrip(message, userArg) {
  if (!access.canUseForce(message.member)) return reply(message, "Not Allowed", "Only Founders, Gods, and the server owner can clear role blocks.");
  const userId = await resolveUserId(message, userArg);
  if (!userId) return reply(message, "Missing User", "Mention a user or provide their user ID.");
  const existing = store.listForcedRoleStrips(message.guild.id, userId);
  if (!existing.length) {
    return reply(message, "No Role Blocks", "That user has no forced role strips.");
  }
  const wait = forceCooldown(message, "unforcerolestrip");
  if (wait) return wait;
  if (!store.clearForcedRoleStrips(message.guild.id, userId)) {
    return reply(message, "No Role Blocks", "That user has no forced role strips.");
  }
  await logging.record(message.guild, {
    action: "force_role_strip_clear",
    actorId: message.author.id,
    targetId: userId,
    reason: `Cleared ${existing.length} role block(s)`
  });
  return reply(message, "Role Blocks Cleared", `Removed **${existing.length}** role block(s). Those roles were not given back.`);
}

async function stripRoleFromEveryone(message, roleArg) {
  if (!access.canUseForce(message.member)) return reply(message, "Not Allowed", "Only Founders, Gods, and the server owner can strip a role from everyone.");
  const role = await resolveRole(message, roleArg);
  if (!role || role.id === message.guild.id) return reply(message, "Invalid Role", "Mention a role, role ID, or role name.");
  const wait = forceCooldown(message, "rolestrip");
  if (wait) return wait;
  if (!roles.botCanManageRole(message.guild, role)) {
    return reply(message, "Cannot Manage Role", "Move my role above that role and grant me Manage Roles.");
  }
  if (typeof message.guild.members.fetch === "function" && (message.guild.memberCount || 0) <= 2000) {
    await message.guild.members.fetch().catch(() => null);
  }
  const holders = [...message.guild.members.cache.values()].filter((member) => member.roles?.cache?.has(role.id));
  const vouchRole = store.getConfig(message.guild.id).vouch_role_id === role.id;
  let removed = 0;
  let failed = 0;
  let closed = 0;
  for (const member of holders) {
    if (vouchRole && store.deactivateVouch(message.guild.id, member.id, message.author.id, "rolestrip")) closed += 1;
    try {
      await roles.withRateLimit(() => roles.removeRole(member, role, `Role strip by ${message.author.id}`));
      removed += 1;
    } catch (error) {
      failed += 1;
    }
  }
  await logging.record(message.guild, {
    action: "role_strip",
    actorId: message.author.id,
    targetId: role.id,
    reason: `Stripped ${role.name} from ${removed} member(s)`,
    details: { removed, failed, closed }
  });
  const vouchNote = vouchRole ? ` Closed **${closed}** active vouch(es).` : "";
  return reply(message, "Role Stripped", `Removed **${role.name}** from **${removed}** member(s).${failed ? ` ${failed} failed.` : ""}${vouchNote}`);
}

async function dispatchForceStrip(message, first, second) {
  if (!first) {
    return reply(message, "Usage", "`-forcestrip @user @role` blocks a user.\n`-forcestrip @role` removes that role from everyone.");
  }
  if (second) return forceRoleStrip(message, first, second);
  if (/^<@!?\d+>$/.test(first)) {
    return reply(message, "Usage", "Blocking a user also needs a role: `-forcestrip @user @role`.");
  }
  const role = await resolveRole(message, first);
  if (role) return stripRoleFromEveryone(message, first);
  return reply(message, "Usage", "Use `-forcestrip @role` to strip everyone, or `-forcestrip @user @role` to block one user.");
}

module.exports = {
  usage,
  openPanel,
  handleSelect,
  panelEmbed,
  forceNickname,
  unforceNickname,
  forceRoleStrip,
  unforceRoleStrip,
  stripRoleFromEveryone,
  dispatchForceStrip
};
