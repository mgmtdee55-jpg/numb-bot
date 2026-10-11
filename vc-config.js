const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");
const db = require("./db");
const access = require("./systems/access");
const { ACCENT } = require("./vouch/constants");
const { reply } = require("./vouch/ui");
const { MAX_TEMP_CATEGORIES } = require("./voice");

const KEPT = "Existing voice channels and categories stay in place.";
const CLEANUP_OPTIONS = [
  [0, "Instant"],
  [30, "30 seconds"],
  [60, "1 minute"],
  [300, "5 minutes"],
  [600, "10 minutes"],
  [1800, "30 minutes"]
];
const BITRATE_OPTIONS = [8000, 16000, 32000, 48000, 64000, 96000, 128000, 256000, 384000];
const drafts = new Map();

function canView(member) {
  return access.isServerOwner(member) || access.isBotOwner(member?.id) || access.isGod(member);
}

function channelLabel(id) {
  return id && id !== "disabled" ? `<#${id}>` : "Not set";
}

function categoryIds(config) {
  if (!config) return [];
  let parsed = [];
  try {
    parsed = Array.isArray(config.category_ids) ? config.category_ids : JSON.parse(config.category_ids || "[]");
  } catch {
    parsed = [];
  }
  if (!Array.isArray(parsed)) parsed = [];
  return [...new Set([config.category_id, ...parsed].filter(Boolean))].slice(0, MAX_TEMP_CATEGORIES);
}

function bitrateOptions(guild) {
  const maximum = guild?.maximumBitrate || 64000;
  return BITRATE_OPTIONS.filter((bitrate) => bitrate <= maximum);
}

function cleanupLabel(seconds) {
  return CLEANUP_OPTIONS.find(([value]) => value === Number(seconds))?.[1] || `${Number(seconds) || 0} seconds`;
}

function limitLabel(value) {
  return Number(value) === 0 ? "Unlimited" : String(value);
}

function project(guild) {
  const saved = db.getConfig(guild.id);
  const draft = drafts.get(guild.id) || {};
  const categories = Array.isArray(draft.category_ids) ? draft.category_ids : categoryIds(saved);
  return {
    saved: Boolean(saved),
    pending: !saved && Object.keys(draft).length > 0,
    j2c_channel_id: draft.j2c_channel_id || saved?.j2c_channel_id || null,
    categories,
    name_template: draft.name_template ?? saved?.name_template ?? "{nickname}'s Channel",
    user_limit: draft.user_limit ?? saved?.user_limit ?? 0,
    bitrate: draft.bitrate ?? saved?.bitrate ?? 64000,
    cleanup_seconds: draft.cleanup_seconds ?? saved?.cleanup_seconds ?? 0,
    server_interface_enabled: Number(draft.server_interface_enabled ?? saved?.server_interface_enabled ?? 0) ? 1 : 0,
    server_interface_channel_id: draft.server_interface_channel_id || saved?.server_interface_channel_id || "disabled"
  };
}

function settingsEmbed(guild, note) {
  const view = project(guild);
  const embed = new EmbedBuilder().setColor(ACCENT).setTitle("VoiceMaster Configuration");
  const lines = [];
  if (note) lines.push(note, "");
  if (!view.saved && !view.pending) {
    lines.push("VoiceMaster is not set up. Choose a join channel and at least one category.", KEPT);
  } else {
    lines.push(
      `**Join to create:** ${channelLabel(view.j2c_channel_id)}`,
      `**Categories:** ${view.categories.length ? view.categories.map((id) => `<#${id}>`).join(", ") : "Not set"}`,
      `**Name:** \`${view.name_template}\``,
      `**User limit:** ${limitLabel(view.user_limit)}`,
      `**Bitrate:** ${Math.round(Number(view.bitrate) / 1000)} kbps`,
      `**Empty cleanup:** ${cleanupLabel(view.cleanup_seconds)}`,
      `**Server interface:** ${view.server_interface_enabled ? `On · ${channelLabel(view.server_interface_channel_id)}` : "Off"}`,
      "",
      view.pending
        ? `Choose a join channel and at least one category to finish saving. ${KEPT}`
        : `Only the server owner can change these settings. ${KEPT}`
    );
  }
  embed.setDescription(lines.join("\n"));
  return { embed, config: db.getConfig(guild.id) };
}

function button(id, label, style = ButtonStyle.Primary, disabled = false) {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
}

function homePayload(guild, member, note) {
  const { embed } = settingsEmbed(guild, note);
  if (!access.isServerOwner(member)) return { embeds: [embed], components: [] };
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        button("spanter:vcconfig:j2c", "Join to create"),
        button("spanter:vcconfig:categories", "Categories"),
        button("spanter:vcconfig:name", "Name"),
        button("spanter:vcconfig:limit", "User limit")
      ),
      new ActionRowBuilder().addComponents(
        button("spanter:vcconfig:bitrate", "Bitrate"),
        button("spanter:vcconfig:cleanup", "Cleanup"),
        button("spanter:vcconfig:interface", "Interface")
      )
    ]
  };
}

function backRow() {
  return new ActionRowBuilder().addComponents(button("spanter:vcconfig:back", "Back", ButtonStyle.Secondary));
}

function pickerPayload(guild, kind) {
  const view = project(guild);
  const embed = new EmbedBuilder().setColor(ACCENT).setTitle("VoiceMaster Configuration");
  const components = [];
  if (kind === "j2c") {
    embed.setDescription(
      `Current: ${channelLabel(view.j2c_channel_id)}\n` +
      `Choose the voice channel people join to start a call. ${KEPT}`
    );
    components.push(new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId("spanter:vcconfig:set:j2c")
        .setPlaceholder("Select the join to create channel")
        .setChannelTypes(ChannelType.GuildVoice)
        .setMinValues(1)
        .setMaxValues(1)
    ));
  } else if (kind === "categories") {
    embed.setDescription(
      `Current: ${view.categories.length ? view.categories.map((id) => `<#${id}>`).join(", ") : "Not set"}\n` +
      `Choose up to ${MAX_TEMP_CATEGORIES} categories for new calls, in order. ${KEPT}`
    );
    components.push(new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId("spanter:vcconfig:set:categories")
        .setPlaceholder("Select up to 3 categories")
        .setChannelTypes(ChannelType.GuildCategory)
        .setMinValues(1)
        .setMaxValues(MAX_TEMP_CATEGORIES)
    ));
  } else if (kind === "bitrate") {
    const options = bitrateOptions(guild);
    embed.setDescription(
      `Current: ${Math.round(Number(view.bitrate) / 1000)} kbps\n` +
      `Choose a bitrate this server can use. ${KEPT}`
    );
    if (options.length) {
      components.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("spanter:vcconfig:set:bitrate")
          .setPlaceholder("Select a bitrate")
          .addOptions(options.map((bitrate) => ({
            label: `${bitrate / 1000} kbps`,
            value: String(bitrate),
            default: Number(view.bitrate) === bitrate
          })))
      ));
    }
  } else if (kind === "cleanup") {
    embed.setDescription(
      `Current: ${cleanupLabel(view.cleanup_seconds)}\n` +
      `Choose how long an empty call waits before cleanup. ${KEPT}`
    );
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("spanter:vcconfig:set:cleanup")
        .setPlaceholder("Select a cleanup time")
        .addOptions(CLEANUP_OPTIONS.map(([seconds, label]) => ({
          label,
          value: String(seconds),
          default: Number(view.cleanup_seconds) === seconds
        })))
    ));
  } else if (kind === "interface") {
    const on = Boolean(view.server_interface_enabled);
    embed.setDescription(
      `Current: ${on ? `On · ${channelLabel(view.server_interface_channel_id)}` : "Off"}\n` +
      `Turn the shared server interface on or off. ${KEPT}`
    );
    components.push(new ActionRowBuilder().addComponents(
      button("spanter:vcconfig:interface:on", "Turn on", ButtonStyle.Success, on),
      button("spanter:vcconfig:interface:off", "Turn off", ButtonStyle.Secondary, !on)
    ));
  }
  components.push(backRow());
  return { embeds: [embed], components };
}

function textModal(id, title, inputId, label, value, maxLength) {
  const input = new TextInputBuilder()
    .setCustomId(inputId)
    .setLabel(label)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(maxLength);
  if (value) input.setValue(String(value).slice(0, maxLength));
  return new ModalBuilder()
    .setCustomId(id)
    .setTitle(title)
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function fieldValue(interaction, name) {
  if (typeof interaction.fields?.getTextInputValue === "function") {
    return interaction.fields.getTextInputValue(name);
  }
  return interaction.fields?.[name];
}

async function loadChannel(guild, id) {
  if (!id || !guild?.channels) return null;
  const cached = guild.channels.cache?.get?.(id);
  if (cached) return cached;
  if (typeof guild.channels.fetch !== "function") return null;
  return guild.channels.fetch(id).catch((error) => {
    if (error?.code === 10003) return null;
    throw error;
  });
}

function savedRow(guildId, existing, next) {
  const categories = [...new Set(
    (Array.isArray(next.category_ids) ? next.category_ids : categoryIds(existing)).filter(Boolean)
  )].slice(0, MAX_TEMP_CATEGORIES);
  return {
    guild_id: guildId,
    j2c_channel_id: next.j2c_channel_id || existing?.j2c_channel_id,
    category_id: categories[0],
    category_ids: JSON.stringify(categories),
    server_interface_channel_id: next.server_interface_channel_id || existing?.server_interface_channel_id || "disabled",
    server_interface_message_id: next.server_interface_message_id !== undefined
      ? next.server_interface_message_id
      : (existing?.server_interface_message_id ?? null),
    name_template: next.name_template ?? existing?.name_template ?? "{nickname}'s Channel",
    user_limit: Number(next.user_limit ?? existing?.user_limit ?? 0),
    bitrate: Number(next.bitrate ?? existing?.bitrate ?? 64000),
    cleanup_seconds: Number(next.cleanup_seconds ?? existing?.cleanup_seconds ?? 0),
    server_interface_enabled: Number(next.server_interface_enabled ?? existing?.server_interface_enabled ?? 0) ? 1 : 0
  };
}

function remember(guildId, patch) {
  const existing = db.getConfig(guildId);
  const next = { ...(drafts.get(guildId) || {}), ...patch };
  const j2c = next.j2c_channel_id || existing?.j2c_channel_id;
  const categories = Array.isArray(next.category_ids) ? next.category_ids : categoryIds(existing);
  if (!j2c || !categories.length) {
    drafts.set(guildId, next);
    return { note: `Choose a join channel and at least one category to finish saving. ${KEPT}` };
  }
  db.setConfig(savedRow(guildId, existing, next));
  drafts.delete(guildId);
  return { note: `Saved. ${KEPT}` };
}

async function applyJ2c(interaction) {
  const channel = await loadChannel(interaction.guild, interaction.values?.[0]);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    return { note: `Join to create has to be a voice channel in this server. ${KEPT}` };
  }
  return remember(interaction.guild.id, { j2c_channel_id: channel.id });
}

async function applyCategories(interaction) {
  const ids = [...new Set(interaction.values || [])].slice(0, MAX_TEMP_CATEGORIES);
  if (!ids.length) return { note: `Choose at least one category. ${KEPT}` };
  const categories = [];
  for (const id of ids) {
    const channel = await loadChannel(interaction.guild, id);
    if (!channel || channel.type !== ChannelType.GuildCategory) {
      return { note: `Each category has to be a category in this server. ${KEPT}` };
    }
    categories.push(channel.id);
  }
  return remember(interaction.guild.id, { category_ids: categories });
}

function applyName(interaction) {
  const name = String(fieldValue(interaction, "name") || "").trim();
  if (!name || name.length > 100) {
    return { note: `The name template has to be 1 to 100 characters. ${KEPT}` };
  }
  return remember(interaction.guild.id, { name_template: name });
}

function applyLimit(interaction) {
  const text = String(fieldValue(interaction, "limit") || "").trim();
  if (!/^\d{1,2}$/.test(text) || Number(text) > 99) {
    return { note: `The user limit has to be a whole number from 0 to 99. ${KEPT}` };
  }
  return remember(interaction.guild.id, { user_limit: Number(text) });
}

function applyBitrate(interaction) {
  const bitrate = Number(interaction.values?.[0]);
  if (!bitrateOptions(interaction.guild).includes(bitrate)) {
    return { note: `Choose a bitrate this server can use. ${KEPT}` };
  }
  return remember(interaction.guild.id, { bitrate });
}

function applyCleanup(interaction) {
  const seconds = Number(interaction.values?.[0]);
  if (!CLEANUP_OPTIONS.some(([value]) => value === seconds)) {
    return { note: `Choose a cleanup time. ${KEPT}` };
  }
  return remember(interaction.guild.id, { cleanup_seconds: seconds });
}

function applyInterfaceOff(guild) {
  return remember(guild.id, { server_interface_enabled: 0 });
}

async function applyInterfaceOn(guild) {
  const existing = db.getConfig(guild.id);
  if (!existing?.j2c_channel_id || !categoryIds(existing).length) {
    return { note: `Set a join channel and a category before turning the server interface on. ${KEPT}` };
  }
  const reuse = existing.server_interface_channel_id && existing.server_interface_channel_id !== "disabled"
    ? { ...existing, server_interface_enabled: 1 }
    : existing;
  let face;
  try {
    const { createServerInterface } = require("./voice");
    face = await createServerInterface(guild, existing, reuse, { deferExistingEdit: false });
  } catch (error) {
    console.error(`[vc config] ${guild.id}`, error);
    return { note: `The server interface could not be turned on. ${KEPT}` };
  }
  if (!face?.text?.id || !face?.message?.id) {
    return { note: `The server interface could not be turned on. ${KEPT}` };
  }
  return remember(guild.id, {
    server_interface_enabled: 1,
    server_interface_channel_id: face.text.id,
    server_interface_message_id: face.message.id
  });
}

async function edit(interaction, payload) {
  if (!interaction.replied && !interaction.deferred && typeof interaction.update === "function") {
    await interaction.update(payload);
    return;
  }
  if (typeof interaction.message?.edit === "function") {
    await interaction.message.edit(payload).catch(() => null);
  }
  if (!interaction.replied && !interaction.deferred && typeof interaction.reply === "function") {
    await interaction.reply({ ...payload, flags: 64 });
  }
}

async function show(message) {
  if (!canView(message.member)) {
    return reply(message, "Access Denied", "Only Gods can view this. Only the server owner can change it.");
  }
  return message.reply(homePayload(message.guild, message.member));
}

async function handleButton(interaction) {
  const id = String(interaction.customId || "");
  if (!id.startsWith("spanter:vcconfig:")) return false;
  if (!access.isServerOwner(interaction.member)) {
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(ACCENT).setDescription("Only the server owner can change VoiceMaster settings.")],
      flags: 64
    }).catch(() => null);
    return true;
  }
  const guild = interaction.guild || interaction.member.guild;
  interaction.guild = guild;
  const action = id.slice("spanter:vcconfig:".length);
  try {
    if (action === "setup" || action === "back") {
      await edit(interaction, homePayload(guild, interaction.member));
      return true;
    }
    if (action === "j2c" || action === "categories" || action === "bitrate" || action === "cleanup" || action === "interface") {
      await edit(interaction, pickerPayload(guild, action));
      return true;
    }
    if (action === "name") {
      const view = project(guild);
      await interaction.showModal(textModal(
        "spanter:vcconfig:modal:name",
        "Temporary VC Name",
        "name",
        "Name template",
        view.name_template,
        100
      ));
      return true;
    }
    if (action === "limit") {
      const view = project(guild);
      await interaction.showModal(textModal(
        "spanter:vcconfig:modal:limit",
        "User Limit",
        "limit",
        "0 for unlimited, up to 99",
        view.user_limit,
        2
      ));
      return true;
    }
    let result;
    if (action === "set:j2c") result = await applyJ2c(interaction);
    else if (action === "set:categories") result = await applyCategories(interaction);
    else if (action === "set:bitrate") result = applyBitrate(interaction);
    else if (action === "set:cleanup") result = applyCleanup(interaction);
    else if (action === "modal:name") result = applyName(interaction);
    else if (action === "modal:limit") result = applyLimit(interaction);
    else if (action === "interface:off") result = applyInterfaceOff(guild);
    else if (action === "interface:on") result = await applyInterfaceOn(guild);
    else result = { note: `That control is not available. ${KEPT}` };
    await edit(interaction, homePayload(guild, interaction.member, result.note));
    return true;
  } catch (error) {
    console.error(`[vc config] ${guild?.id || "unknown"}`, error);
    if (!interaction.replied && !interaction.deferred && typeof interaction.reply === "function") {
      await interaction.reply({
        embeds: [new EmbedBuilder().setColor(ACCENT).setDescription(`That setting could not be saved. ${KEPT}`)],
        flags: 64
      }).catch(() => null);
    }
    return true;
  }
}

module.exports = { show, handleButton, canView, settingsEmbed };
