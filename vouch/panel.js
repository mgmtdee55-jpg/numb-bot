const { ActionRowBuilder, StringSelectMenuBuilder } = require("discord.js");
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

function panelRow(selected = "overview") {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("spanter:vouch")
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
  return message.reply({ embeds: [panelEmbed(prefix)], components: [panelRow()] });
}

async function handleSelect(interaction, prefix) {
  const section = interaction.values?.[0] || "overview";
  await interaction.update({ embeds: [panelEmbed(prefix, section)], components: [panelRow(section)] });
  return true;
}

module.exports = { openPanel, handleSelect };
