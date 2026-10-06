const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, MessageFlags, StringSelectMenuBuilder } = require("discord.js");
const store = require("./store");
const access = require("./access");
const vouchStore = require("../vouch/store");
const { bindAntinukeLog } = require("./logs");
const { reply, embed } = require("../vouch/ui");

const STEPS = [
  { key: "vouch", label: "Vouch role", createName: "Vouched" },
  { key: "premiumplus", label: "Voice Premium Plus", createName: "Voice Premium Plus" },
  { key: "premium", label: "Voice Premium", createName: "Voice Premium" },
  { key: "plus", label: "Voice Plus", createName: "Voice Plus" },
  { key: "logs", label: "Event log channels", createName: "Spanter Logs" },
  { key: "antinuke", label: "Anti-Nuke and vouch log", createName: "antinuke-logs" }
];

function sessionKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

const sessions = new Map();

function currentRoleId(guildId, key) {
  if (key === "vouch") return vouchStore.getConfig(guildId).vouch_role_id;
  const roles = store.getVoiceRoles(guildId);
  if (key === "premiumplus") return roles?.premium_plus_role_id || null;
  if (key === "premium") return roles?.premium_role_id || null;
  if (key === "plus") return roles?.plus_role_id || null;
  return null;
}

function saveRole(guildId, key, roleId) {
  if (key === "vouch") {
    vouchStore.setVouchRole(guildId, roleId);
    return;
  }
  const column = key === "premiumplus" ? "premiumplus" : key === "premium" ? "premium" : "plus";
  store.setVoiceRole(guildId, column, roleId);
}

async function createNamedRole(guild, name) {
  if (typeof guild.roles?.create !== "function") return null;
  return guild.roles.create({ name, reason: "Mod setup" });
}

async function createLogChannels(guild) {
  if (typeof guild.channels?.create !== "function") return 0;
  const category = await guild.channels.create({
    name: "Spanter Logs",
    type: ChannelType.GuildCategory,
    reason: "Mod setup"
  });
  let count = 0;
  for (const categoryName of access.LOG_CATEGORIES) {
    const channel = await guild.channels.create({
      name: `${categoryName}-logs`,
      type: ChannelType.GuildText,
      parent: category?.id,
      reason: "Mod setup"
    });
    store.setLog(guild.id, categoryName, channel.id);
    count += 1;
  }
  return count;
}

async function createAntinukeLog(guild) {
  if (typeof guild.channels?.create !== "function") return null;
  const parent = [...guild.channels.cache.values()].find((channel) => channel.name === "Spanter Logs" && channel.type === ChannelType.GuildCategory);
  return guild.channels.create({
    name: "antinuke-logs",
    type: ChannelType.GuildText,
    parent: parent?.id,
    reason: "Mod setup"
  });
}

function roleOptions(guild) {
  return [...guild.roles.cache.values()]
    .filter((role) => role.id !== guild.id && role.name !== "@everyone" && !role.managed)
    .sort((a, b) => b.position - a.position)
    .slice(0, 24)
    .map((role) => ({ label: role.name.slice(0, 100), value: role.id }));
}

function componentsFor(step, guild) {
  const rows = [];
  if (step.key !== "logs" && step.key !== "antinuke") {
    const options = roleOptions(guild);
    if (options.length) {
      rows.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`spanter:modsetup:pick:${step.key}`)
          .setPlaceholder(`Choose the ${step.label}`)
          .addOptions(options)
      ));
    }
  }
  if (step.key === "antinuke") {
    rows.push(new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId("spanter:modsetup:channel:antinuke")
        .setPlaceholder("Choose the Anti-Nuke log channel")
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    ));
  }
  const buttons = [
    new ButtonBuilder()
      .setCustomId(`spanter:modsetup:create:${step.key}`)
      .setLabel(step.key === "logs" ? "Create event logs" : step.key === "antinuke" ? "Create antinuke-logs" : "Create for me")
      .setStyle(ButtonStyle.Primary)
  ];
  if (step.key === "logs") {
    buttons.push(new ButtonBuilder()
      .setCustomId("spanter:modsetup:here:logs")
      .setLabel("Use this channel for event logs")
      .setStyle(ButtonStyle.Secondary));
  }
  if (step.key === "antinuke") {
    buttons.push(new ButtonBuilder()
      .setCustomId("spanter:modsetup:here:antinuke")
      .setLabel("Use this channel")
      .setStyle(ButtonStyle.Secondary));
  }
  const existing = step.key === "logs"
    ? store.listLogs(guild.id).some((row) => row.category !== access.ANTINUKE_LOG)
    : step.key === "antinuke"
      ? store.getLog(guild.id, access.ANTINUKE_LOG) || vouchStore.getConfig(guild.id).log_channel_id
      : currentRoleId(guild.id, step.key);
  if (existing) {
    buttons.push(new ButtonBuilder()
      .setCustomId(`spanter:modsetup:keep:${step.key}`)
      .setLabel("Keep current")
      .setStyle(ButtonStyle.Secondary));
  }
  rows.push(new ActionRowBuilder().addComponents(buttons.slice(0, 5)));
  return rows;
}

function stepEmbed(guild, index) {
  const step = STEPS[index];
  const antinukeId = store.getLog(guild.id, access.ANTINUKE_LOG) || vouchStore.getConfig(guild.id).log_channel_id;
  const existing = step.key === "logs"
    ? store.listLogs(guild.id).filter((row) => row.category !== access.ANTINUKE_LOG).map((row) => `**${row.category}** <#${row.channel_id}>`).join("\n")
    : step.key === "antinuke"
      ? antinukeId
      : currentRoleId(guild.id, step.key);
  const lines = [
    `Step **${index + 1}** of **${STEPS.length}**: **${step.label}**`,
    "",
    step.key === "logs"
      ? "These are message, voice, channel, role, server, and member logs. Anti-Nuke and vouch logs are the next step."
      : step.key === "antinuke"
        ? "Vouch, Anti-Nuke admin, staff rank, and role-limit actions use this channel only."
        : `Mention is not required. Choose an existing role, or I will create **${step.createName}**.`,
    "",
    existing
      ? (step.key === "logs" ? `Already set:\n${existing}` : step.key === "antinuke" ? `Already set: <#${existing}>` : `Already set: <@&${existing}>`)
      : "Nothing is set for this step yet."
  ];
  return embed("Mod Setup", lines.join("\n"), true);
}

async function open(message) {
  if (!access.canSetup(message.member)) {
    return reply(message, "Access Denied", "Gods and the server owner can run mod setup.");
  }
  sessions.set(sessionKey(message.guild.id, message.author.id), 0);
  return message.reply({ embeds: [stepEmbed(message.guild, 0)], components: componentsFor(STEPS[0], message.guild) });
}

async function advance(interaction, index) {
  const next = index + 1;
  if (next >= STEPS.length) {
    sessions.delete(sessionKey(interaction.guild.id, interaction.user.id));
    return interaction.update({
      embeds: [embed("Mod Setup Complete", "Vouch, voice ranks, event logs, and the Anti-Nuke log are set. You can rerun `-modsetup` to change them.")],
      components: []
    });
  }
  sessions.set(sessionKey(interaction.guild.id, interaction.user.id), next);
  return interaction.update({
    embeds: [stepEmbed(interaction.guild, next)],
    components: componentsFor(STEPS[next], interaction.guild)
  });
}

async function handleInteraction(interaction) {
  const customId = interaction.customId || "";
  if (!customId.startsWith("spanter:modsetup:")) return false;
  const member = interaction.member;
  if (!access.canSetup(member)) {
    await interaction.reply({ embeds: [embed("Access Denied", "Gods and the server owner can run mod setup.")], flags: MessageFlags.Ephemeral }).catch(() => null);
    return true;
  }
  const [, , action, key] = customId.split(":");
  const index = sessions.get(sessionKey(interaction.guild.id, interaction.user.id)) ?? STEPS.findIndex((step) => step.key === key);
  const step = STEPS.find((item) => item.key === key) || STEPS[index] || STEPS[0];
  try {
    if (action === "pick") {
      const roleId = interaction.values?.[0];
      const role = interaction.guild.roles.cache.get(roleId);
      if (!role) {
        await interaction.reply({ embeds: [embed("Missing Role", "That role is no longer in the server.")], flags: MessageFlags.Ephemeral });
        return true;
      }
      saveRole(interaction.guild.id, step.key, role.id);
    } else if (action === "channel" && step.key === "antinuke") {
      const channelId = interaction.values?.[0];
      if (!channelId) {
        await interaction.reply({ embeds: [embed("Missing Channel", "Choose a text channel for Anti-Nuke and vouch logs.")], flags: MessageFlags.Ephemeral });
        return true;
      }
      bindAntinukeLog(interaction.guild.id, channelId);
    } else if (action === "create") {
      if (step.key === "logs") {
        const count = await createLogChannels(interaction.guild);
        if (!count) {
          await interaction.reply({ embeds: [embed("Cannot Create Channels", "I could not create log channels. Check Manage Channels.")], flags: MessageFlags.Ephemeral });
          return true;
        }
      } else if (step.key === "antinuke") {
        const channel = await createAntinukeLog(interaction.guild);
        if (!channel) {
          await interaction.reply({ embeds: [embed("Cannot Create Channels", "I could not create #antinuke-logs. Check Manage Channels.")], flags: MessageFlags.Ephemeral });
          return true;
        }
        bindAntinukeLog(interaction.guild.id, channel.id);
      } else {
        const role = await createNamedRole(interaction.guild, step.createName);
        if (!role) {
          await interaction.reply({ embeds: [embed("Cannot Create Role", "I could not create that role. Check Manage Roles.")], flags: MessageFlags.Ephemeral });
          return true;
        }
        saveRole(interaction.guild.id, step.key, role.id);
      }
    } else if (action === "here" && step.key === "antinuke") {
      bindAntinukeLog(interaction.guild.id, interaction.channelId);
    } else if (action === "here") {
      for (const category of access.LOG_CATEGORIES) store.setLog(interaction.guild.id, category, interaction.channelId);
    }
    await advance(interaction, Math.max(0, index));
  } catch (error) {
    console.error("[modsetup]", error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ embeds: [embed("Setup Failed", "I could not finish that step. Check my role position and permissions.")], flags: MessageFlags.Ephemeral }).catch(() => null);
    }
  }
  return true;
}

module.exports = { open, handleInteraction };
