const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");
const { ACCENT } = require("./vouch/constants");
const { reply } = require("./vouch/ui");

const drafts = new Map();

function draftKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function blankDraft() {
  return { author: "", description: "", footer: "" };
}

function previewEmbed(draft) {
  const embed = new EmbedBuilder().setColor(ACCENT);
  if (draft.author) embed.setAuthor({ name: draft.author.slice(0, 256) });
  embed.setDescription((draft.description || "*Nothing here yet.*\nPaste unicode emoji or custom emoji like `<:name:id>`.").slice(0, 4096));
  if (draft.footer) embed.setFooter({ text: draft.footer.slice(0, 2048) });
  return embed;
}

function panelPayload(draft) {
  const guide = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle("Embed Creator")
    .setDescription([
      "Set the author, description, and footer. The preview is below.",
      "Emoji can be typed into any field, including custom emoji such as `<:name:id>`.",
      "",
      draft.author ? `**Author:** ${draft.author}` : "**Author:** not set",
      draft.footer ? `**Footer:** ${draft.footer}` : "**Footer:** not set"
    ].join("\n"));
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("spanter:embed:author").setLabel("Author").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("spanter:embed:description").setLabel("Description").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("spanter:embed:footer").setLabel("Footer").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("spanter:embed:send").setLabel("Send").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("spanter:embed:clear").setLabel("Clear").setStyle(ButtonStyle.Danger)
  );
  return { embeds: [guide, previewEmbed(draft)], components: [row] };
}

function fieldModal(field, current) {
  const limits = { author: 256, description: 4000, footer: 2048 };
  const styles = {
    author: TextInputStyle.Short,
    description: TextInputStyle.Paragraph,
    footer: TextInputStyle.Short
  };
  const labels = { author: "Author", description: "Description", footer: "Footer" };
  const input = new TextInputBuilder()
    .setCustomId("value")
    .setLabel(labels[field])
    .setStyle(styles[field])
    .setRequired(false)
    .setMaxLength(limits[field]);
  if (current) input.setValue(current.slice(0, limits[field]));
  return new ModalBuilder()
    .setCustomId(`spanter:embed:modal:${field}`)
    .setTitle(labels[field])
    .addComponents(new ActionRowBuilder().addComponents(input));
}

async function open(message) {
  const key = draftKey(message.guild.id, message.author.id);
  const draft = blankDraft();
  drafts.set(key, draft);
  const sent = await message.reply(panelPayload(draft));
  draft.messageId = sent?.id || null;
  return sent;
}

function owns(interaction) {
  return drafts.has(draftKey(interaction.guildId, interaction.user.id));
}

async function refresh(interaction, draft) {
  const payload = panelPayload(draft);
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.update(payload);
}

async function handleInteraction(interaction) {
  const id = interaction.customId || "";
  if (!id.startsWith("spanter:embed:")) return false;
  const key = draftKey(interaction.guildId, interaction.user.id);
  if (!owns(interaction)) {
    await interaction.reply({ content: "This embed panel belongs to someone else.", flags: 64 }).catch(() => null);
    return true;
  }
  const draft = drafts.get(key) || blankDraft();
  if (interaction.isButton?.()) {
    const field = id.slice("spanter:embed:".length);
    if (field === "author" || field === "description" || field === "footer") {
      await interaction.showModal(fieldModal(field, draft[field]));
      return true;
    }
    if (field === "clear") {
      const next = blankDraft();
      next.messageId = draft.messageId;
      drafts.set(key, next);
      await refresh(interaction, next);
      return true;
    }
    if (field === "send") {
      if (!draft.description && !draft.author && !draft.footer) {
        await interaction.reply({ content: "Add an author, description, or footer before sending.", flags: 64 }).catch(() => null);
        return true;
      }
      await interaction.channel.send({ embeds: [previewEmbed({ ...draft, description: draft.description || "\u200b" })] });
      drafts.delete(key);
      await interaction.update({
        embeds: [previewEmbed(draft).setTitle("Embed Sent")],
        components: []
      });
      return true;
    }
  }
  if (interaction.isModalSubmit?.() && id.startsWith("spanter:embed:modal:")) {
    const field = id.slice("spanter:embed:modal:".length);
    if (field === "author" || field === "description" || field === "footer") {
      draft[field] = String(interaction.fields.getTextInputValue("value") || "").trim();
      drafts.set(key, draft);
      await refresh(interaction, draft);
    }
    return true;
  }
  return false;
}

module.exports = { open, handleInteraction, previewEmbed, panelPayload };
