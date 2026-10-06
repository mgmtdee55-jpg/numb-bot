const { ChannelType, PermissionFlagsBits } = require("discord.js");
const access = require("./access");
const store = require("./store");
const cooldowns = require("./cooldowns");
const { embed, reply } = require("../vouch/ui");

function deny(message) {
  return reply(message, "Access Denied", "Founders, Gods, and the server owner can control channels.");
}

function isVoice(channel) {
  return channel?.type === ChannelType.GuildVoice || channel?.type === ChannelType.GuildStageVoice;
}

function isText(channel) {
  return channel?.type === ChannelType.GuildText || channel?.type === ChannelType.GuildAnnouncement;
}

function lockPatch(channel, locked) {
  const value = locked ? false : null;
  if (channel.type === ChannelType.GuildCategory) return { SendMessages: value, Connect: value };
  if (isVoice(channel)) return { Connect: value };
  return { SendMessages: value };
}

async function resolveChannel(message, arg) {
  const mentioned = message.mentions?.channels?.first?.();
  if (mentioned) return mentioned;
  const id = String(arg || "").replace(/[<#>]/g, "");
  if (/^\d{17,20}$/.test(id)) {
    return message.guild.channels.cache.get(id) || await message.guild.channels.fetch(id).catch(() => null);
  }
  if (!arg) return message.channel;
  const name = String(arg).replace(/^#/, "").toLowerCase();
  return [...message.guild.channels.cache.values()].find((channel) => channel.name?.toLowerCase() === name) || null;
}

function canEdit(channel) {
  return channel && typeof channel.permissionOverwrites?.edit === "function";
}

function sendState(channel, guild) {
  const everyoneId = guild.roles?.everyone?.id || guild.id;
  const overwrite = channel.permissionOverwrites?.cache?.get?.(everyoneId);
  if (!overwrite) return "inherit";
  const bit = PermissionFlagsBits.SendMessages;
  if (overwrite.deny?.has?.(bit)) return "deny";
  if (overwrite.allow?.has?.(bit)) return "allow";
  return "inherit";
}

function restoredSend(state) {
  if (state === "allow") return true;
  if (state === "deny") return false;
  return null;
}

async function ensureAccess(message) {
  if (!access.canUseChannels(message.member)) {
    await deny(message);
    return false;
  }
  const me = message.guild.members?.me;
  if (me?.permissions && !me.permissions.has(PermissionFlagsBits.ManageChannels) && !me.permissions.has(PermissionFlagsBits.Administrator)) {
    await reply(message, "Bot Missing Permission", "I need Manage Channels to change channel permissions.");
    return false;
  }
  return true;
}

async function editEveryone(channel, guild, data) {
  await channel.permissionOverwrites.edit(guild.roles.everyone, data);
}

async function setLock(message, args, locked) {
  if (!(await ensureAccess(message))) return;
  const channel = await resolveChannel(message, args[1]);
  if (!canEdit(channel)) return reply(message, "Missing Channel", "Mention a channel, or run this in the channel you want to change.");
  try {
    await editEveryone(channel, message.guild, lockPatch(channel, locked));
  } catch (error) {
    return reply(message, "Cannot Edit Channel", "I could not change that channel's permissions.");
  }
  const name = channel.name ? `#${channel.name}` : `<#${channel.id}>`;
  return reply(message, locked ? "Channel Locked" : "Channel Unlocked", `${name} is ${locked ? "locked" : "unlocked"} for @everyone.`);
}

async function setHidden(message, args, hidden) {
  if (!(await ensureAccess(message))) return;
  const channel = await resolveChannel(message, args[1]);
  if (!canEdit(channel)) return reply(message, "Missing Channel", "Mention a channel, or run this in the channel you want to change.");
  try {
    await editEveryone(channel, message.guild, { ViewChannel: hidden ? false : null });
  } catch (error) {
    return reply(message, "Cannot Edit Channel", "I could not change that channel's permissions.");
  }
  const name = channel.name ? `#${channel.name}` : `<#${channel.id}>`;
  return reply(message, hidden ? "Channel Hidden" : "Channel Visible", `${name} is ${hidden ? "hidden from" : "visible to"} @everyone.`);
}

async function setAllText(message, locked) {
  if (!(await ensureAccess(message))) return;
  const wait = cooldowns.consume(message.guild.id, message.author.id, locked ? "lockall" : "unlockall");
  if (wait) return reply(message, "Please Wait", cooldowns.waitText(wait));
  let count = 0;
  for (const channel of message.guild.channels.cache.values()) {
    if (!isText(channel) || !canEdit(channel)) continue;
    try {
      if (locked) {
        store.saveTextLock(message.guild.id, channel.id, sendState(channel, message.guild));
        await editEveryone(channel, message.guild, { SendMessages: false });
      } else {
        const saved = store.getTextLock(message.guild.id, channel.id);
        await editEveryone(channel, message.guild, { SendMessages: restoredSend(saved) });
        store.clearTextLock(message.guild.id, channel.id);
      }
      count += 1;
    } catch (error) {
      continue;
    }
  }
  return reply(
    message,
    locked ? "Text Channels Locked" : "Text Channels Unlocked",
    `${locked ? "Locked" : "Unlocked"} **${count}** text channel(s) for @everyone.`
  );
}

async function nuke(message, args) {
  if (!(await ensureAccess(message))) return;
  const wait = cooldowns.consume(message.guild.id, message.author.id, "nuke");
  if (wait) return reply(message, "Please Wait", `Nuke can be used again in **${Math.max(1, Math.ceil(wait / 1000))}** seconds.`);
  const channel = await resolveChannel(message, args[1]);
  if (!channel || channel.type === ChannelType.GuildCategory || typeof channel.clone !== "function" || typeof channel.delete !== "function") {
    return reply(message, "Missing Channel", "Mention a text or voice channel, or run this in the channel you want to nuke.");
  }
  const me = message.guild.members?.me;
  if (me?.permissions && !me.permissions.has(PermissionFlagsBits.ManageChannels) && !me.permissions.has(PermissionFlagsBits.Administrator)) {
    return reply(message, "Bot Missing Permission", "I need Manage Channels to nuke a channel.");
  }
  let copy;
  try {
    copy = await channel.clone({ reason: `Nuked by ${message.author.id}` });
    if (Number.isInteger(channel.position) && typeof copy.setPosition === "function") {
      await copy.setPosition(channel.position).catch(() => null);
    }
  } catch (error) {
    return reply(message, "Nuke Failed", "I could not clone that channel. Check my Manage Channels permission and role position.");
  }
  const label = channel.name ? `#${channel.name}` : `<#${channel.id}>`;
  const description = `${label} was cloned and the old one was deleted.`;
  const sameChannel = message.channel?.id === channel.id;
  if (sameChannel && typeof copy.send === "function") {
    await copy.send({ embeds: [embed("Channel Nuked", description)] }).catch(() => null);
  }
  await channel.delete(`Nuked by ${message.author.id}`);
  if (sameChannel) return true;
  return reply(message, "Channel Nuked", description);
}

async function handleCommand(message, name, args) {
  if (name === "lock") return setLock(message, args, true);
  if (name === "unlock") return setLock(message, args, false);
  if (name === "hide") return setHidden(message, args, true);
  if (name === "unhide") return setHidden(message, args, false);
  if (name === "lockall") return setAllText(message, true);
  if (name === "unlockall") return setAllText(message, false);
  if (name === "nuke") return nuke(message, args);
  return false;
}

module.exports = { handleCommand };
