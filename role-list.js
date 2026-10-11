const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");

const COLOR = 0x2b2d31;
const PAGE_SIZE = 10;

function authorName(source) {
  const author = source?.author || source?.user || {};
  const user = source?.member?.user || {};
  return author.username || author.globalName || user.username || user.globalName || source?.member?.displayName || "user";
}

function avatarUrl(source) {
  const author = source?.author || source?.user;
  if (typeof author?.displayAvatarURL === "function") {
    const url = author.displayAvatarURL({ extension: "png", size: 128 });
    if (url) return url;
  }
  return null;
}

function memberCount(guild, role) {
  const listed = role?.members;
  if (listed && typeof listed.size === "number" && typeof listed.values === "function") return listed.size;
  let count = 0;
  for (const member of guild.members?.cache?.values?.() || []) {
    if (member.roles?.cache?.has?.(role.id)) count += 1;
  }
  return count;
}

function sortedRoles(guild) {
  return [...(guild.roles?.cache?.values?.() || [])]
    .filter((role) => role && role.id !== guild.id && role.name !== "@everyone")
    .sort((a, b) => (Number(b.position) || 0) - (Number(a.position) || 0) || String(a.name).localeCompare(String(b.name)));
}

async function loadRoles(guild) {
  if (typeof guild.roles?.fetch === "function") await guild.roles.fetch().catch(() => null);
  const total = Number(guild.memberCount) || 0;
  const cached = guild.members?.cache?.size || 0;
  if (typeof guild.members?.fetch === "function" && total > cached && total <= 5000) {
    await guild.members.fetch().catch(() => null);
  }
  return sortedRoles(guild);
}

function pageCount(total) {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

function rolePayload(source, ownerId, roles, page) {
  const pages = pageCount(roles.length);
  const safe = Math.min(Math.max(0, page), pages - 1);
  const start = safe * PAGE_SIZE;
  const slice = roles.slice(start, start + PAGE_SIZE);
  const lines = slice.map((role, index) => {
    const count = memberCount(source.guild, role);
    const label = count === 1 ? "member" : "members";
    return `${start + index + 1}. <@&${role.id}> → ${count} ${label}`;
  });
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setDescription(lines.join("\n") || "This server has no roles to list.")
    .setFooter({ text: `${roles.length} role${roles.length === 1 ? "" : "s"}, Page ${safe + 1}/${pages}` });
  const author = { name: authorName(source) };
  const iconURL = avatarUrl(source);
  if (iconURL) author.iconURL = iconURL;
  embed.setAuthor(author);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`spanter:roles:${ownerId}:${safe}:prev`).setEmoji({ name: "⬅️" }).setStyle(ButtonStyle.Secondary).setDisabled(safe <= 0),
    new ButtonBuilder().setCustomId(`spanter:roles:${ownerId}:${safe}:next`).setEmoji({ name: "➡️" }).setStyle(ButtonStyle.Secondary).setDisabled(safe >= pages - 1),
    new ButtonBuilder().setCustomId(`spanter:roles:${ownerId}:${safe}:search`).setEmoji({ name: "🔍" }).setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}

function searchModal(ownerId) {
  return new ModalBuilder()
    .setCustomId(`spanter:roles:${ownerId}:find`)
    .setTitle("Search roles")
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("role").setLabel("Role name").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
    ));
}

function refuse(interaction) {
  return interaction.reply({
    embeds: [new EmbedBuilder().setColor(COLOR).setDescription("**Not Yours**\nOnly the person who opened this can change it.")],
    flags: 64
  }).catch(() => null);
}

async function showRoles(message) {
  const roles = await loadRoles(message.guild);
  return message.reply(rolePayload(message, message.author.id, roles, 0));
}

function findRole(roles, query) {
  const name = String(query || "").trim().toLowerCase();
  if (!name) return -1;
  const exact = roles.findIndex((role) => role.name.toLowerCase() === name);
  if (exact !== -1) return exact;
  return roles.findIndex((role) => role.name.toLowerCase().includes(name));
}

async function handleInteraction(interaction) {
  const id = String(interaction.customId || "");
  if (!id.startsWith("spanter:roles:")) return false;
  const [, , ownerId, marker, action] = id.split(":");
  if (ownerId && interaction.user?.id && ownerId !== interaction.user.id) {
    await refuse(interaction);
    return true;
  }
  const roles = sortedRoles(interaction.guild);
  if (marker === "find") {
    const query = interaction.fields?.getTextInputValue?.("role") || "";
    const index = findRole(roles, query);
    if (index === -1) {
      await interaction.reply({
        embeds: [new EmbedBuilder().setColor(COLOR).setDescription(`No role matches **${String(query).slice(0, 80)}**.`)],
        flags: 64
      }).catch(() => null);
      return true;
    }
    await interaction.update(rolePayload(interaction, ownerId, roles, Math.floor(index / PAGE_SIZE)));
    return true;
  }
  const page = Number(marker) || 0;
  if (action === "search") {
    await interaction.showModal(searchModal(ownerId));
    return true;
  }
  const pages = pageCount(roles.length);
  let next = page;
  if (action === "prev") next = Math.max(0, page - 1);
  if (action === "next") next = Math.min(pages - 1, page + 1);
  await interaction.update(rolePayload(interaction, ownerId, roles, next));
  return true;
}

module.exports = { showRoles, handleInteraction, PAGE_SIZE };
