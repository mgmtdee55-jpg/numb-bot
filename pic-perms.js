const { EmbedBuilder, PermissionFlagsBits } = require("discord.js");
const { ACCENT } = require("./vouch/constants");
const { reply } = require("./vouch/ui");
const { resolveRole } = require("./vouch/resolve");
const access = require("./systems/access");
const store = require("./systems/store");

function canUse(member) {
  if (!member) return false;
  if (access.isServerOwner(member) || access.isBotOwner(member.id)) return true;
  if (access.hasStaff(member, "boss")) return true;
  try {
    return !!member.permissions?.has?.(PermissionFlagsBits.Administrator);
  } catch {
    return false;
  }
}

function deny(message) {
  return reply(message, "Access Denied", "CEOs, Founders, Bosses, and Admins can change picture permissions.");
}

function botCanEdit(guild) {
  const permissions = guild.members?.me?.permissions;
  if (!permissions?.has) return true;
  return permissions.has(PermissionFlagsBits.Administrator) || permissions.has(PermissionFlagsBits.ManageRoles);
}

function picEmbed(enabled, roleId) {
  const word = enabled ? "enabled" : "disabled";
  return new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(enabled ? "Pic Perms Enabled" : "Pic Perms Disabled")
    .setDescription(`<@&${roleId}>\n• Embed Links: **${word}**\n• Attach Files: **${word}**`);
}

async function setRole(message, args) {
  if (!canUse(message.member)) return deny(message);
  const role = await resolveRole(message, args.slice(1).join(" "));
  if (!role || role.id === message.guild.id) {
    return reply(message, "Missing Role", "Use `-setpicrole @role` or a role id.");
  }
  store.setPicRole(message.guild.id, role.id);
  return reply(message, "Pic Role Set", `Picture permissions now use <@&${role.id}>.\n\`-pic off\` and \`-pic on\` change this channel.`);
}

async function toggle(message, enabled) {
  if (!canUse(message.member)) return deny(message);
  const roleId = store.getPicRole(message.guild.id);
  if (!roleId) return reply(message, "Pic Role Not Set", "Set it first with `-setpicrole @role` or a role id.");
  const role = message.guild.roles.cache.get(roleId)
    || await message.guild.roles.fetch(roleId).catch(() => null);
  if (!role || role.id === message.guild.id) {
    return reply(message, "Pic Role Missing", "That role is gone. Set it again with `-setpicrole @role`.");
  }
  const channel = message.channel;
  if (typeof channel?.permissionOverwrites?.edit !== "function") {
    return reply(message, "Missing Channel", "Run this in the channel you want to change.");
  }
  if (!botCanEdit(message.guild)) {
    return reply(message, "Bot Missing Permission", "I need Manage Roles to change picture permissions.");
  }
  try {
    await channel.permissionOverwrites.edit(role, {
      EmbedLinks: enabled,
      AttachFiles: enabled
    });
  } catch {
    return reply(message, "Cannot Edit Channel", "I could not change picture permissions in this channel.");
  }
  return message.reply({
    embeds: [picEmbed(enabled, role.id)],
    allowedMentions: { parse: [], roles: [String(role.id)] }
  });
}

async function handleCommand(message, name, args) {
  if (name === "setpicrole") return setRole(message, args);
  const mode = String(args[1] || "").toLowerCase();
  if (mode === "off") return toggle(message, false);
  if (mode === "on") return toggle(message, true);
  return reply(
    message,
    "Picture Permissions",
    "`-setpicrole @role` chooses the role.\n`-pic off` turns embed links and file attachments off in this channel.\n`-pic on` turns them back on."
  );
}

module.exports = { handleCommand, picEmbed };
