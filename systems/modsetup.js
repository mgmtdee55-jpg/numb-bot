const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, StringSelectMenuBuilder } = require("discord.js");
const store = require("./store");
const access = require("./access");
const vouchStore = require("../vouch/store");
const { bindAntinukeLog, ensureNumbLogs } = require("./logs");
const { PUNISHMENT_LOG } = access;
const { reply, embed } = require("../vouch/ui");

const STEPS = [
  { key: "vouch", label: "Vouch role", createName: "Vouched" },
  { key: "premiumplus", label: "Voice Premium Plus", createName: "Voice Premium Plus" },
  { key: "premium", label: "Voice Premium", createName: "Voice Premium" },
  { key: "plus", label: "Voice Plus", createName: "Voice Plus" },
  { key: "logs", label: "numb bot logs" },
  { key: "ping", label: "Anti-Nuke ping role" }
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

function logsReady(guildId) {
  return !!store.getLog(guildId, PUNISHMENT_LOG) || !!store.getLog(guildId, "antinuke");
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
  if (step.key !== "logs") {
    const options = roleOptions(guild);
    if (options.length) {
      rows.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`spanter:modsetup:pick:${step.key}`)
          .setPlaceholder(step.key === "ping" ? "Choose the role to ping" : `Choose the ${step.label}`)
          .addOptions(options)
      ));
    }
  }
  const buttons = [];
  if (step.key === "logs") {
    buttons.push(new ButtonBuilder()
      .setCustomId("spanter:modsetup:create:logs")
      .setLabel("Create numb bot logs")
      .setStyle(ButtonStyle.Primary));
  } else if (step.key === "ping") {
    buttons.push(new ButtonBuilder()
      .setCustomId("spanter:modsetup:skip:ping")
      .setLabel("Don't ping")
      .setStyle(ButtonStyle.Secondary));
  } else {
    buttons.push(new ButtonBuilder()
      .setCustomId(`spanter:modsetup:create:${step.key}`)
      .setLabel("Create for me")
      .setStyle(ButtonStyle.Primary));
  }
  const existing = step.key === "logs"
    ? logsReady(guild.id)
    : step.key === "ping"
      ? store.getAntinukePing(guild.id)
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
  const configured = new Map(store.listLogs(guild.id).map((row) => [row.category, row.channel_id]));
  const logLines = ["punishments", "antinuke", "message", "role", "server", "member"]
    .map((category) => `**${category}** ${configured.get(category) ? `<#${configured.get(category)}>` : "not set"}`)
    .join("\n");
  const pingRole = store.getAntinukePing(guild.id);
  const existing = step.key === "logs"
    ? logLines
    : step.key === "ping"
      ? pingRole
      : currentRoleId(guild.id, step.key);
  const lines = [
    `Step **${index + 1}** of **${STEPS.length}**: **${step.label}**`,
    "",
    step.key === "logs"
      ? "This creates one **numb bot** category. Bans, kicks, and timeouts share #punishments. Vouches and Anti-Nuke share #antinuke. Role changes share #roles. Running this again reuses those channels."
      : step.key === "ping"
        ? "Choose a role to ping on Anti-Nuke and vouch logs. The people named in the log are not pinged."
        : `Mention is not required. Choose an existing role, or I will create **${step.createName}**.`,
    "",
    existing
      ? (step.key === "logs" ? `Already set:\n${existing}` : `Already set: <@&${existing}>`)
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
      embeds: [embed("Mod Setup Complete", "Vouch, voice ranks, and the numb bot logs are set. Run `-modsetup` again to change them, or `-modlogreset` to clear the saved log channels and start over.")],
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
  if (!STEPS.some((step) => step.key === key)) {
    const channelId = action === "here" ? interaction.channelId : interaction.values?.[0];
    if (channelId && key === "antinuke") bindAntinukeLog(interaction.guild.id, channelId);
    if (channelId && key === "punishments") store.setLog(interaction.guild.id, PUNISHMENT_LOG, channelId);
    await interaction.update({
      embeds: [embed("Setup Updated", "That panel is from an older setup. Run `-modsetup` again. A channel you picked was saved.")],
      components: []
    }).catch(() => null);
    return true;
  }
  const index = STEPS.findIndex((step) => step.key === key);
  const step = STEPS.find((item) => item.key === key);
  try {
    if (action === "pick") {
      const roleId = interaction.values?.[0];
      const role = interaction.guild.roles.cache.get(roleId);
      if (!role) {
        await interaction.reply({ embeds: [embed("Missing Role", "That role is no longer in the server.")], flags: MessageFlags.Ephemeral });
        return true;
      }
      if (step.key === "ping") store.setAntinukePing(interaction.guild.id, role.id);
      else saveRole(interaction.guild.id, step.key, role.id);
    } else if (action === "skip" && step.key === "ping") {
      store.setAntinukePing(interaction.guild.id, null);
    } else if (action === "create") {
      if (step.key === "logs") {
        const count = await ensureNumbLogs(interaction.guild);
        if (!count) {
          await interaction.reply({ embeds: [embed("Cannot Create Channels", "I could not create the numb bot logs. Check Manage Channels.")], flags: MessageFlags.Ephemeral });
          return true;
        }
      } else if (step.createName) {
        const role = await createNamedRole(interaction.guild, step.createName);
        if (!role) {
          await interaction.reply({ embeds: [embed("Cannot Create Role", "I could not create that role. Check Manage Roles.")], flags: MessageFlags.Ephemeral });
          return true;
        }
        saveRole(interaction.guild.id, step.key, role.id);
      }
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
