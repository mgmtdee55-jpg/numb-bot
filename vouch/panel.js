const { ActionRowBuilder, MessageFlags, StringSelectMenuBuilder } = require("discord.js");
const { embed } = require("./ui");

function pages(prefix) {
  const p = prefix;
  return {
    overview: [
      "Vouch",
      "Vouches, giver access, roles, and limits.",
      "",
      `\`${p}vouch give @user [reason]\``,
      `\`${p}vouch take @user [reason]\``,
      `\`${p}antinuke vouch list\` — vouched users`
    ].join("\n"),
    setup: [
      "Setup",
      "",
      `\`${p}antinuke vouch\` — view vouch config`,
      `\`${p}antinuke vouch set <role>\` — bind the reward role`,
      `\`${p}antinuke vouch founder <role>\` — assign the founder role`,
      `\`${p}antinuke vouch unset\` — disconnect linked roles`
    ].join("\n"),
    givers: [
      "Givers & Registry",
      "",
      `\`${p}antinuke vouch addgiver <user>\` — authorize a giver`,
      `\`${p}antinuke vouch removegiver <user>\` — remove a giver`,
      `\`${p}antinuke vouch list\` — view vouched users`,
      `\`${p}antinuke vouch cleanup\` — prune entries for members who left`,
      `\`${p}antinuke vouch limit view\` — view vouch caps`
    ].join("\n")
  };
}

function panelRow(selected = "overview", userId = "") {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`spanter:vouch:${userId}`)
      .setPlaceholder("Vouch")
      .addOptions(
        { label: "Vouch", value: "overview", description: "Give and take vouches", default: selected === "overview" },
        { label: "Setup", value: "setup", description: "Reward role, founder role, config", default: selected === "setup" },
        { label: "Givers & Registry", value: "givers", description: "Givers, list, and cleanup", default: selected === "givers" }
      )
  );
}

function panelEmbed(prefix, section = "overview") {
  const body = pages(prefix);
  return embed("Vouch", body[section] || body.overview, true);
}

function openPanel(message, prefix) {
  return message.reply({ embeds: [panelEmbed(prefix)], components: [panelRow("overview", message.author.id)] });
}

async function handleSelect(interaction, prefix) {
  const ownerId = String(interaction.customId || "").startsWith("spanter:vouch:")
    ? interaction.customId.slice("spanter:vouch:".length)
    : "";
  if (ownerId && interaction.user?.id && ownerId !== interaction.user.id) {
    await interaction.reply({
      embeds: [embed("Not Yours", "Only the person who opened this can change it.")],
      flags: MessageFlags.Ephemeral
    }).catch(() => null);
    return true;
  }
  const section = interaction.values?.[0] || "overview";
  await interaction.update({ embeds: [panelEmbed(prefix, section)], components: [panelRow(section, ownerId || interaction.user?.id || "")] });
  return true;
}

module.exports = { openPanel, handleSelect };
