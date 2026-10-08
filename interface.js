const {
  ActionRowBuilder,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  MessageFlags
} = require("discord.js");
const db = require("./db");
const { withChannelLock } = require("./channel-lock");
const { renderVoiceChannelInterface } = require("./voice");
const { consumeActionCooldown } = require("./action-cooldowns");
const access = require("./systems/access");
const { logThrottledError } = require("./log-throttle");
const { card } = require("./feedback");

function result(title, description, guild) {
  return { embeds: [card(title, description, { guild })] };
}

function privateResult(title, description) {
  return { ...result(title, description), flags: MessageFlags.Ephemeral };
}

async function getMemberChannel(guild, userId) {
  const member = await guild.members.fetch(userId);
  return { member, channel: member.voice.channel };
}

async function ownedChannel(guild, userId) {
  const { member, channel } = await getMemberChannel(guild, userId);
  const row = channel ? db.getTempChannel(channel.id) : null;
  return { member, channel, row, owns: !!row && row.owner_id === userId };
}

async function requireOwner(interaction) {
  const owned = await ownedChannel(interaction.guild, interaction.user.id);
  return owned.owns ? owned : null;
}

async function withOwnedChannel(channel, userId, operation) {
  return withChannelLock(channel.id, async () => {
    const row = db.getTempChannel(channel.id);
    if (!row || row.owner_id !== userId) return false;
    const member = channel.guild.members.cache.get(userId);
    if (member?.voice?.channelId !== undefined && member.voice.channelId !== channel.id) return false;
    if (member?.voice?.channelId === undefined && !channel.members.has(userId)) return false;
    return (await operation()) !== false;
  });
}

async function actionCooldownReply(target, channel, action) {
  const remainingMs = consumeActionCooldown(target.user?.id || target.author.id, channel.id, action);
  if (!remainingMs) return null;
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
  const payload = target.user
    ? privateResult("Please Wait", `Try this action again in **${seconds} second${seconds === 1 ? "" : "s"}**.`)
    : result("Please Wait", `Try this action again in **${seconds} second${seconds === 1 ? "" : "s"}**.`);
  if (target.user) await target.editReply(payload);
  else await target.reply(payload);
  return true;
}

function cooldownOperationError(error, label) {
  logThrottledError(`vc-action:${label}`, `[VC action] ${label}`, error);
  if (error.status === 429 || error.code === 429) {
    const retryAfterMs = Number(error.retryAfter) ||
      (Number(error.rawError?.retry_after) ? Number(error.rawError.retry_after) * 1000 : 0);
    const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    return privateResult("Temporarily Rate Limited", `Discord is rate limiting this action. Try again in **${seconds} second${seconds === 1 ? "" : "s"}**.`);
  }
  return privateResult("Unable to Complete", "That voice-channel action could not be completed. Please try again later.");
}

async function handleOperationError(target, error, label) {
  const payload = cooldownOperationError(error, label);
  try {
    if (target.user) {
      if (target.deferred) return await target.editReply(payload);
      if (target.replied) return await target.followUp(payload);
      return await target.reply(payload);
    }
    return await target.reply({ embeds: payload.embeds });
  } catch (replyError) {
    logThrottledError(`vc-action-response:${label}`, `[VC action error response] ${label}`, replyError);
    return null;
  }
}

function userMenu(customId, placeholder) {
  return new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .setMinValues(1)
      .setMaxValues(1)
  );
}

async function claimChannel(interaction, channel, row) {
  const claimed = await withChannelLock(channel.id, async () => {
    const current = db.getTempChannel(channel.id);
    if (!current) return "missing";
    const member = channel.guild.members.cache.get(interaction.user.id);
    if (member?.voice?.channelId !== undefined && member.voice.channelId !== channel.id) return "not-in-channel";
    if (member?.voice?.channelId === undefined && !channel.members.has(interaction.user.id)) return "not-in-channel";
    if (current.owner_id) return current.owner_id === interaction.user.id ? "already-owner" : "owned";
    return db.setOwner(channel.id, interaction.user.id) ? "claimed" : "owned";
  });
  if (claimed === "owned") {
    await interaction.editReply(privateResult("Owner Only", "Only the current channel owner can use this control."));
  } else if (claimed === "already-owner") {
    await interaction.editReply(privateResult("Already Owner", "You already own this voice channel."));
  } else if (claimed === "missing") {
    await interaction.editReply(privateResult("Not Managed", "This is not a managed temporary voice channel."));
  } else if (claimed === "not-in-channel") {
    await interaction.editReply(privateResult("Join a Voice Channel", "You must still be inside the channel you want to claim."));
  } else if (claimed !== "claimed") {
    await interaction.editReply(privateResult("Claim Unavailable", "This channel was just claimed. Try again if it becomes unowned."));
  } else {
    const current = db.getTempChannel(channel.id);
    try {
      await renderVoiceChannelInterface(
        channel,
        current?.owner_id || null,
        current?.interface_message_id || row.interface_message_id,
        true
      );
    } catch (error) {
      logThrottledError(`claim-interface-refresh:${channel.guild.id}`, `[temp interface refresh after claim] ${channel.id}`, error);
    }
    await interaction.editReply(privateResult("Claimed", "You now own this voice channel."));
  }
}

async function handleButton(interaction) {
  const action = interaction.customId.slice("vc_".length);
  if (action === "limit") {
    const owned = await requireOwner(interaction);
    if (!owned) {
      return interaction.reply(privateResult(
        "Owner Only",
        "Only the current owner of a managed temporary voice channel can use this control."
      ));
    }
    const modal = new ModalBuilder().setCustomId("vc_limit_modal").setTitle("Voice Channel Limit");
    const input = new TextInputBuilder()
      .setCustomId("limit")
      .setLabel("User limit (0–99; 0 is unlimited)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(2);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (action === "claim") {
    const { channel } = await getMemberChannel(interaction.guild, interaction.user.id);
    if (!channel) return interaction.editReply(privateResult("Join a Voice Channel", "You must be inside the channel you want to claim."));
    const row = db.getTempChannel(channel.id);
    if (!row) return interaction.editReply(privateResult("Not Managed", "This is not a managed temporary voice channel."));
    const cooldownReply = await actionCooldownReply(interaction, channel, "claim");
    if (cooldownReply) return cooldownReply;
    return claimChannel(interaction, channel, row);
  }

  const owned = await requireOwner(interaction);
  if (!owned) {
    return interaction.editReply(privateResult(
      "Owner Only",
      "Only the current owner of a managed temporary voice channel can use this control."
    ));
  }
  const { channel } = owned;

  if (action === "lock") {
    const cooldownReply = await actionCooldownReply(interaction, channel, action);
    if (cooldownReply) return cooldownReply;
    const ok = await withOwnedChannel(channel, interaction.user.id, () => channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
      Connect: false
    }));
    if (!ok) return interaction.editReply(privateResult("Owner Only", "Only the current channel owner can use this control."));
    return interaction.editReply(privateResult("Locked", "Your voice channel is now locked."));
  }
  if (action === "unlock") {
    const cooldownReply = await actionCooldownReply(interaction, channel, action);
    if (cooldownReply) return cooldownReply;
    const ok = await withOwnedChannel(channel, interaction.user.id, () => channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
      Connect: true
    }));
    if (!ok) return interaction.editReply(privateResult("Owner Only", "Only the current channel owner can use this control."));
    return interaction.editReply(privateResult("Unlocked", "Your voice channel is now unlocked."));
  }
  if (action === "ghost" || action === "unghost") {
    const actor = interaction.member || interaction.guild?.members?.cache?.get(interaction.user?.id);
    if (!access.canGhost(actor, action)) {
      return interaction.editReply(privateResult("Rank Required", "Hiding or showing a VC requires Voice Premium or higher."));
    }
  }
  if (action === "ghost") {
    const cooldownReply = await actionCooldownReply(interaction, channel, action);
    if (cooldownReply) return cooldownReply;
    const ok = await withOwnedChannel(channel, interaction.user.id, () => channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
      ViewChannel: false
    }));
    if (!ok) return interaction.editReply(privateResult("Owner Only", "Only the current channel owner can use this control."));
    return interaction.editReply(privateResult("Hidden", "Your voice channel is now hidden."));
  }
  if (action === "unghost") {
    const cooldownReply = await actionCooldownReply(interaction, channel, action);
    if (cooldownReply) return cooldownReply;
    const ok = await withOwnedChannel(channel, interaction.user.id, () => channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
      ViewChannel: true
    }));
    if (!ok) return interaction.editReply(privateResult("Owner Only", "Only the current channel owner can use this control."));
    return interaction.editReply(privateResult("Visible", "Your voice channel is visible again."));
  }
  if (["kick", "ban", "unban", "permit"].includes(action)) {
    const descriptions = {
      kick: "Select a member in your voice channel to kick.",
      ban: "Select a member to prevent them from joining this voice channel.",
      unban: "Select a member to allow them to join again.",
      permit: "Select a member to permit to join this voice channel."
    };
    return interaction.editReply({
      ...privateResult(`${action[0].toUpperCase()}${action.slice(1)} User`, descriptions[action]),
      components: [userMenu(`vc_select_${action}`, "Select a server member")]
    });
  }
  const cooldownReply = await actionCooldownReply(interaction, channel, action);
  if (cooldownReply) return cooldownReply;

  return interaction.editReply(privateResult("Unavailable", "This interface control is not available."));
}

async function handleSelect(interaction) {
  await interaction.deferUpdate();
  const owned = await requireOwner(interaction);
  if (!owned) {
    return interaction.editReply(privateResult(
      "Owner Only",
      "Only the current owner of a managed temporary voice channel can use this control."
    ));
  }
  const targetId = interaction.values[0];
  const target = await interaction.guild.members.fetch(targetId).catch((error) => {
    if (error.code === 10007) return null;
    throw error;
  });
  if (!target) {
    return interaction.editReply(result("User Not Found", "That server member could not be found."));
  }

  const action = interaction.customId.slice("vc_select_".length);
  if (action === "kick" && target.voice.channelId !== owned.channel.id) {
    return interaction.editReply(result("Not In Channel", "That member is not in your voice channel."));
  }
  if (action === "kick" || action === "ban") {
    const blocked = shieldBlock(target);
    if (blocked) return interaction.editReply(blocked);
  }
  const cooldownReply = await actionCooldownReply(interaction, owned.channel, action);
  if (cooldownReply) return cooldownReply;
  if (action === "kick") {
    const ok = await withOwnedChannel(owned.channel, interaction.user.id, () =>
      target.voice.channelId === owned.channel.id
        ? target.voice.disconnect("VoiceMaster kick")
        : false
    );
    if (!ok) return interaction.editReply(privateResult("Owner Only", "Only the current channel owner can use this control."));
    return interaction.editReply(result("Kicked", `<@${target.id}> was removed from your voice channel.`));
  }
  if (action === "ban") {
    const ok = await withOwnedChannel(owned.channel, interaction.user.id, async () => {
      await owned.channel.permissionOverwrites.edit(target.id, {
        ViewChannel: true,
        Connect: false
      });
      db.removePermit(owned.channel.id, target.id);
      db.addBan(owned.channel.id, target.id);
      if (target.voice.channelId === owned.channel.id) {
        await target.voice.disconnect("VoiceMaster ban");
      }
    });
    if (!ok) return interaction.editReply(privateResult("Owner Only", "Only the current channel owner can use this control."));
    return interaction.editReply(result("Banned", `<@${target.id}> cannot join this voice channel.`));
  }
  if (action === "unban") {
    const ok = await withOwnedChannel(owned.channel, interaction.user.id, async () => {
      if (db.isPermitted(owned.channel.id, target.id)) {
        await owned.channel.permissionOverwrites.edit(target.id, {
          ViewChannel: true,
          Connect: true
        });
      } else {
        await owned.channel.permissionOverwrites.delete(target.id);
      }
      db.removeBan(owned.channel.id, target.id);
    });
    if (!ok) return interaction.editReply(privateResult("Owner Only", "Only the current channel owner can use this control."));
    return interaction.editReply(result("Unbanned", `<@${target.id}> is allowed to join again.`));
  }
  if (action === "permit") {
    const ok = await withOwnedChannel(owned.channel, interaction.user.id, async () => {
      await owned.channel.permissionOverwrites.edit(target.id, {
        ViewChannel: true,
        Connect: true
      });
      db.removeBan(owned.channel.id, target.id);
      db.addPermit(owned.channel.id, target.id);
    });
    if (!ok) return interaction.editReply(privateResult("Owner Only", "Only the current channel owner can use this control."));
    return interaction.editReply(result("Permitted", `<@${target.id}> may join this voice channel.`));
  }
  return interaction.editReply(result("Unavailable", "That user action is not available."));
}

async function handleModal(interaction) {
  if (interaction.customId !== "vc_limit_modal") return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const owned = await requireOwner(interaction);
  if (!owned) {
    return interaction.editReply(privateResult(
      "Owner Only",
      "Only the current owner of a managed temporary voice channel can use this control."
    ));
  }
  const value = interaction.fields.getTextInputValue("limit").trim();
  if (!/^\d{1,2}$/.test(value)) {
    return interaction.editReply(privateResult("Invalid Limit", "Use a whole number from `0` to `99`."));
  }
  const limit = Number(value);
  if (limit < 0 || limit > 99) {
    return interaction.editReply(privateResult("Invalid Limit", "Use a whole number from `0` to `99`."));
  }
  const cooldownReply = await actionCooldownReply(interaction, owned.channel, "limit");
  if (cooldownReply) return cooldownReply;
  const ok = await withOwnedChannel(owned.channel, interaction.user.id, () => owned.channel.setUserLimit(limit));
  if (!ok) return interaction.editReply(privateResult("Owner Only", "Only the current channel owner can use this control."));
  return interaction.editReply(privateResult("Limit Updated", `User limit set to **${limit}**.`));
}

async function runTextAction(message, action) {
  const channel = message.member?.voice?.channel;
  const row = channel ? db.getTempChannel(channel.id) : null;
  if (action === "claim") {
    if (!channel || !row) return message.reply(result("Not Managed", "Join a managed temporary voice channel to claim it."));
    const cooldownReply = await actionCooldownReply(message, channel, "claim");
    if (cooldownReply) return cooldownReply;
    const claimed = await withChannelLock(channel.id, async () => {
      const current = db.getTempChannel(channel.id);
      if (!current) return "missing";
      if (message.member?.voice?.channelId !== channel.id) return "not-in-channel";
      if (current.owner_id) return current.owner_id === message.author.id ? "already-owner" : "owned";
      return db.setOwner(channel.id, message.author.id) ? "claimed" : "owned";
    });
    if (claimed === "not-in-channel") return message.reply(result("Join a Voice Channel", "You must still be inside the channel you want to claim."));
    if (claimed === "already-owner" || claimed === "owned") {
      const description = claimed === "already-owner"
        ? "You already own this voice channel."
        : "Only the current owner can use this control.";
      return message.reply(result("Claim Unavailable", description));
    }
    if (claimed !== "claimed") return message.reply(result("Not Managed", "This channel is no longer managed."));
    const current = db.getTempChannel(channel.id);
    try {
      await renderVoiceChannelInterface(
        channel,
        current?.owner_id || null,
        current?.interface_message_id || row.interface_message_id,
        true
      );
    } catch (error) {
      logThrottledError(`claim-interface-refresh:${message.guild.id}`, `[temp interface refresh after claim] ${channel.id}`, error);
    }
    return message.reply(result("Claimed", "You now own this voice channel."));
  }
  if (!channel || !row || row.owner_id !== message.author.id) {
    return message.reply(result("Owner Only", "Only the current owner can control this temporary voice channel."));
  }
  if ((action === "ghost" || action === "unghost") && !access.canGhost(message.member, action)) {
    return message.reply(result("Rank Required", "Hiding or showing a VC requires Voice Premium or higher."));
  }
  const cooldownReply = await actionCooldownReply(message, channel, action);
  if (cooldownReply) return cooldownReply;
  const ok = await withOwnedChannel(channel, message.author.id, async () => {
    if (action === "lock") {
      await channel.permissionOverwrites.edit(message.guild.roles.everyone, { Connect: false });
    } else if (action === "unlock") {
      await channel.permissionOverwrites.edit(message.guild.roles.everyone, { Connect: true });
    } else if (action === "ghost") {
      await channel.permissionOverwrites.edit(message.guild.roles.everyone, { ViewChannel: false });
    } else if (action === "unghost") {
      await channel.permissionOverwrites.edit(message.guild.roles.everyone, { ViewChannel: true });
    }
  });
  if (!ok) return message.reply(result("Owner Only", "Only the current owner can control this temporary voice channel."));
  return message.reply(result("Voice Channel Updated", `The voice channel was ${action === "ghost" ? "hidden" : action === "unghost" ? "shown" : `${action}ed`}.`));
}

async function runLimitTextAction(message, value) {
  const channel = message.member?.voice?.channel;
  const row = channel ? db.getTempChannel(channel.id) : null;
  if (!channel || !row || row.owner_id !== message.author.id) {
    return message.reply(result("Owner Only", "Only the current owner can control this temporary voice channel."));
  }
  if (!/^\d{1,2}$/.test(value || "")) {
    return message.reply(result("Invalid Limit", "Use a whole number from `0` to `99`."));
  }
  const limit = Number(value);
  if (limit > 99) return message.reply(result("Invalid Limit", "Use a whole number from `0` to `99`."));
  const cooldownReply = await actionCooldownReply(message, channel, "limit");
  if (cooldownReply) return cooldownReply;
  const ok = await withOwnedChannel(channel, message.author.id, () => channel.setUserLimit(limit));
  if (!ok) return message.reply(result("Owner Only", "Only the current owner can control this temporary voice channel."));
  return message.reply(result("Limit Updated", `User limit set to **${limit}**.`));
}

async function transferOwnership(message, target) {
  const channel = message.member?.voice?.channel;
  const row = channel ? db.getTempChannel(channel.id) : null;
  if (!channel || !row) {
    return message.reply(result("Not Managed", "Join a managed temporary voice channel to transfer it."));
  }
  if (row.owner_id !== message.author.id) {
    return message.reply(result("Owner Only", "Only the current owner can transfer this voice channel."));
  }
  if (!target) {
    return message.reply(result("Missing User", "Mention the member you want to give this channel to."));
  }
  if (target.user?.bot) {
    return message.reply(result("Invalid Target", "Bots cannot own a voice channel."));
  }
  if (target.id === message.author.id) {
    return message.reply(result("Invalid Target", "You already own this voice channel."));
  }
  if (target.voice?.channelId !== channel.id && !channel.members?.has?.(target.id)) {
    return message.reply(result("Not In Channel", "That member needs to be in your voice channel."));
  }
  const cooldownReply = await actionCooldownReply(message, channel, "transfer");
  if (cooldownReply) return cooldownReply;
  const transferred = await withChannelLock(channel.id, async () => {
    const current = db.getTempChannel(channel.id);
    if (!current || current.owner_id !== message.author.id) return "not-owner";
    if (target.voice?.channelId !== channel.id && !channel.members?.has?.(target.id)) return "not-in-channel";
    return db.transferOwner(channel.id, message.author.id, target.id) ? "transferred" : "failed";
  });
  if (transferred === "not-in-channel") {
    return message.reply(result("Not In Channel", "That member needs to be in your voice channel."));
  }
  if (transferred !== "transferred") {
    return message.reply(result("Owner Only", "Only the current owner can transfer this voice channel."));
  }
  const current = db.getTempChannel(channel.id);
  try {
    await renderVoiceChannelInterface(
      channel,
      current?.owner_id || target.id,
      current?.interface_message_id || row.interface_message_id,
      true
    );
  } catch (error) {
    logThrottledError(`transfer-interface-refresh:${message.guild.id}`, `[temp interface refresh after transfer] ${channel.id}`, error);
  }
  return message.reply(result("Ownership Transferred", `<#${channel.id}> now belongs to <@${target.id}>.`));
}

function shieldBlock(target) {
  const text = access.voiceShieldReply(target);
  return text ? result("Voice Shield", text) : null;
}

async function runTargetTextAction(message, action, target) {
  const channel = message.member?.voice?.channel;
  const row = channel ? db.getTempChannel(channel.id) : null;
  if (!channel || !row || row.owner_id !== message.author.id) {
    return message.reply(result("Owner Only", "Only the current owner can control this temporary voice channel."));
  }
  if ((action === "kick" || action === "reject") && target.voice.channelId !== channel.id) {
    return message.reply(result("Not In Channel", "That member is not in your voice channel."));
  }
  if (action === "kick" || action === "reject" || action === "ban") {
    const blocked = shieldBlock(target);
    if (blocked) return message.reply(blocked);
  }
  const cooldownReply = await actionCooldownReply(message, channel, action);
  if (cooldownReply) return cooldownReply;
  const ok = await withOwnedChannel(channel, message.author.id, async () => {
    if (action === "kick" || action === "reject") {
      if (target.voice.channelId !== channel.id) return false;
      await target.voice.disconnect("VoiceMaster kick");
    } else if (action === "ban") {
      await channel.permissionOverwrites.edit(target.id, {
        ViewChannel: true,
        Connect: false
      });
      db.removePermit(channel.id, target.id);
      db.addBan(channel.id, target.id);
      if (target.voice.channelId === channel.id) await target.voice.disconnect("VoiceMaster ban");
    } else if (action === "unban") {
      if (db.isPermitted(channel.id, target.id)) {
        await channel.permissionOverwrites.edit(target.id, {
          ViewChannel: true,
          Connect: true
        });
      } else {
        await channel.permissionOverwrites.delete(target.id);
      }
      db.removeBan(channel.id, target.id);
    } else if (action === "permit") {
      await channel.permissionOverwrites.edit(target.id, {
        ViewChannel: true,
        Connect: true
      });
      db.removeBan(channel.id, target.id);
      db.addPermit(channel.id, target.id);
    }
  });
  if (!ok) return message.reply(result("Owner Only", "Only the current owner can control this temporary voice channel."));
  return message.reply(result(`${action[0].toUpperCase()}${action.slice(1)}`, `<@${target.id}> action completed.`));
}

async function safelyHandleInteraction(handler, interaction, label) {
  try {
    return await handler(interaction);
  } catch (error) {
    return handleOperationError(interaction, error, `${label}:${interaction.guildId || interaction.guild?.id}`);
  }
}

async function safelyHandleMessage(handler, message, ...args) {
  try {
    return await handler(message, ...args);
  } catch (error) {
    return handleOperationError(message, error, `message:${message.guild.id}`);
  }
}

module.exports = {
  handleButton: (interaction) => safelyHandleInteraction(handleButton, interaction, "button"),
  handleSelect: (interaction) => safelyHandleInteraction(handleSelect, interaction, "select"),
  handleModal: (interaction) => safelyHandleInteraction(handleModal, interaction, "modal"),
  runTextAction: (message, action) => safelyHandleMessage(runTextAction, message, action),
  runLimitTextAction: (message, value) => safelyHandleMessage(runLimitTextAction, message, value),
  runTargetTextAction: (message, action, target) =>
    safelyHandleMessage(runTargetTextAction, message, action, target),
  transferOwnership: (message, target) => safelyHandleMessage(transferOwnership, message, target)
};
