const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");
const db = require("./db");
const access = require("./systems/access");
const { ACCENT } = require("./vouch/constants");
const { reply } = require("./vouch/ui");

function canView(member) {
  return access.isServerOwner(member) || access.isBotOwner(member?.id) || access.isGod(member);
}

function channelLabel(id) {
  return id && id !== "disabled" ? `<#${id}>` : "Not set";
}

function settingsEmbed(guild) {
  const config = db.getConfig(guild.id);
  const embed = new EmbedBuilder().setColor(ACCENT).setTitle("VoiceMaster Configuration");
  if (!config) {
    embed.setDescription("VoiceMaster is not set up. The server owner can run `-vc setup`.");
    return { embed, config };
  }
  let categories = [];
  try {
    categories = JSON.parse(config.category_ids || "[]");
  } catch {
    categories = [];
  }
  const categoryLines = [config.category_id, ...categories].filter(Boolean);
  embed.setDescription([
    `**Join to create:** ${channelLabel(config.j2c_channel_id)}`,
    `**Categories:** ${categoryLines.length ? categoryLines.map((id) => `<#${id}>`).join(", ") : "Not set"}`,
    `**Name:** ${config.name_template || "Not set"}`,
    `**User limit:** ${config.user_limit || 0}`,
    `**Bitrate:** ${config.bitrate || 64000}`,
    `**Empty cleanup:** ${config.cleanup_seconds || 0}s`,
    `**Server interface:** ${config.server_interface_enabled ? channelLabel(config.server_interface_channel_id) : "Off"}`,
    "",
    "Only the server owner can change these settings."
  ].join("\n"));
  return { embed, config };
}

function payload(message) {
  const { embed } = settingsEmbed(message.guild);
  const components = [];
  if (access.isServerOwner(message.member)) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("spanter:vcconfig:setup").setLabel("Configure").setStyle(ButtonStyle.Primary)
    ));
  }
  return { embeds: [embed], components };
}

async function show(message) {
  if (!canView(message.member)) {
    return reply(message, "Access Denied", "Only Gods can view this. Only the server owner can change it.");
  }
  return message.reply(payload(message));
}

async function handleButton(interaction) {
  if (interaction.customId !== "spanter:vcconfig:setup") return false;
  if (!access.isServerOwner(interaction.member)) {
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(ACCENT).setDescription("Only the server owner can change VoiceMaster settings.")],
      flags: 64
    }).catch(() => null);
    return true;
  }
  const button = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`setup-open:${interaction.user.id}`)
      .setLabel("Open private setup wizard")
      .setStyle(ButtonStyle.Primary)
  );
  await interaction.reply({
    embeds: [new EmbedBuilder().setColor(ACCENT).setTitle("VoiceMaster Setup").setDescription("Open the private setup wizard to configure temporary voice channels.")],
    components: [button]
  });
  return true;
}

module.exports = { show, handleButton, canView, settingsEmbed };
