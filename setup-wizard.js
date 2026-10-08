const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");
const db = require("./db");
const { present } = require("./feedback");
const { createServerInterface, MAX_TEMP_CATEGORIES } = require("./voice");

const sessions = new Map();
const SESSION_TIMEOUT = 10 * 60 * 1000;
const CLEANUP_OPTIONS = [
  [0, "Instant"],
  [30, "30 seconds"],
  [60, "1 minute"],
  [300, "5 minutes"],
  [600, "10 minutes"],
  [1800, "30 minutes"]
];
const BITRATE_OPTIONS = [8000, 16000, 32000, 48000, 64000, 96000, 128000, 256000, 384000];

function configuredCategories(config) {
  let categories = [];
  try {
    categories = Array.isArray(config.category_ids)
      ? config.category_ids
      : JSON.parse(config.category_ids || "[]");
  } catch {
    categories = [];
  }
  return [...new Set([config.category_id, ...categories].filter(Boolean))].slice(0, MAX_TEMP_CATEGORIES);
}

function sessionKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function embed(title, description) {
  return new EmbedBuilder().setColor(0x2b2d31).setTitle(title).setDescription(present(title, description));
}

function buttonRow(userId, buttons) {
  return new ActionRowBuilder().addComponents(
    ...buttons.map(({ id, label, style = ButtonStyle.Secondary, disabled = false }) =>
      new ButtonBuilder()
        .setCustomId(`setup:${userId}:${id}`)
        .setLabel(label)
        .setStyle(style)
        .setDisabled(disabled)
    )
  );
}

function navRows(userId, { backDisabled = false, nextDisabled = false, skip = false } = {}) {
  const buttons = [
    { id: "back", label: "Back", disabled: backDisabled },
    { id: "next", label: "Next", style: ButtonStyle.Primary, disabled: nextDisabled }
  ];
  if (skip) buttons.push({ id: "skip", label: "Skip" });
  buttons.push({ id: "cancel", label: "Cancel", style: ButtonStyle.Danger });
  return buttonRow(userId, [
    ...buttons
  ]);
}

function bitrateOptions(guild) {
  const maximum = guild.maximumBitrate || 64000;
  return BITRATE_OPTIONS.filter((bitrate) => bitrate <= maximum);
}

function formatLimit(value) {
  return value === 0 ? "Unlimited (0)" : String(value);
}

function configSummary(guild, config) {
  const j2c = guild.channels.cache.get(config.j2c_channel_id);
  const categories = configuredCategories(config);
  const cleanup = CLEANUP_OPTIONS.find(([seconds]) => seconds === config.cleanup_seconds)?.[1] ||
    `${config.cleanup_seconds} seconds`;
  return [
    `Join to Create: ${j2c ? `<#${j2c.id}>` : "Missing channel"}`,
    `Categories: ${categories.length
      ? categories.map((categoryId) => `<#${categoryId}>`).join(", ")
      : "Missing category"}`,
    `VC name: \`${config.name_template || "{nickname}'s Channel"}\``,
    `User limit: ${formatLimit(config.user_limit ?? 0)}`,
    `Bitrate: ${Math.round((config.bitrate || 64000) / 1000)} kbps`,
    `Cleanup: ${cleanup}`,
    `Server interface: ${config.server_interface_enabled ? "Yes" : "No"}`
  ].join("\n");
}

function currentConfigValues(config) {
  return {
    j2c_channel_id: config.j2c_channel_id,
    category_id: config.category_id,
    category_ids: configuredCategories(config),
    name_template: config.name_template || "{nickname}'s Channel",
    user_limit: config.user_limit ?? 0,
    limit_tens: String(Math.floor((config.user_limit ?? 0) / 10)),
    limit_ones: String((config.user_limit ?? 0) % 10),
    limit_tens_selected: true,
    limit_ones_selected: true,
    bitrate: config.bitrate || 64000,
    cleanup_seconds: config.cleanup_seconds ?? 0,
    server_interface_enabled: !!config.server_interface_enabled
  };
}

function newConfigValues() {
  return {
    j2c_channel_id: null,
    category_id: null,
    category_ids: [],
    name_template: "{nickname}'s Channel",
    user_limit: 0,
    limit_tens: "0",
    limit_ones: "0",
    limit_tens_selected: false,
    limit_ones_selected: false,
    bitrate: null,
    cleanup_seconds: 0,
    server_interface_enabled: true
  };
}

function wizardPayload(wizard) {
  const { guild, userId, values, step } = wizard;
  const components = [];
  let title;
  let description;

  if (step === 0) {
    title = "VoiceMaster Setup · Join to Create";
    description = "Choose the voice channel members will join to create their temporary channel.";
    components.push(
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`setup:${userId}:j2c`)
          .setPlaceholder("Select the Join to Create voice channel")
          .setChannelTypes(ChannelType.GuildVoice)
          .setMinValues(1)
          .setMaxValues(1)
      )
    );
  } else if (step === 1) {
    title = "VoiceMaster Setup · Category";
    description =
      `Choose up to ${MAX_TEMP_CATEGORIES} overflow categories, in order. ` +
      "New VCs fill the first until it reaches Discord's 50-channel cap (or 99 connected members), then use the next.";
    components.push(
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`setup:${userId}:categories`)
          .setPlaceholder("Select up to 3 overflow categories")
          .setChannelTypes(ChannelType.GuildCategory)
          .setMinValues(1)
          .setMaxValues(MAX_TEMP_CATEGORIES)
      )
    );
  } else if (step === 2) {
    title = "VoiceMaster Setup · Temporary VC Name";
    description =
      `Current template: \`${values.name_template}\`\n` +
      "Supported placeholders: `{nickname}`, `{username}`, `{user.mention}`.";
    components.push(buttonRow(userId, [
      { id: "name", label: "Enter VC name" }
    ]));
  } else if (step === 3) {
    title = "VoiceMaster Setup · User Limit";
    description =
      `Select both digits (current: **${formatLimit(values.user_limit)}**). ` +
      "Use 00 for unlimited.";
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`setup:${userId}:limit_tens`)
          .setPlaceholder("Tens digit (0–9)")
          .addOptions(Array.from({ length: 10 }, (_, digit) => ({
            label: String(digit),
            value: String(digit),
            default: values.limit_tens === String(digit)
          })))
      ),
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`setup:${userId}:limit_ones`)
          .setPlaceholder("Ones digit (0–9)")
          .addOptions(Array.from({ length: 10 }, (_, digit) => ({
            label: String(digit),
            value: String(digit),
            default: values.limit_ones === String(digit)
          })))
      )
    );
  } else if (step === 4) {
    title = "VoiceMaster Setup · Bitrate";
    description = "Choose a bitrate available to this server.";
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`setup:${userId}:bitrate`)
          .setPlaceholder("Select a bitrate")
          .addOptions(bitrateOptions(guild).map((bitrate) => ({
            label: `${bitrate / 1000} kbps`,
            value: String(bitrate),
            default: Number(values.bitrate) === bitrate
          })))
      )
    );
  } else if (step === 5) {
    title = "VoiceMaster Setup · Cleanup";
    description = "Choose how long an empty temporary channel stays before cleanup.";
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`setup:${userId}:cleanup`)
          .setPlaceholder("Select empty-channel cleanup time")
          .addOptions(CLEANUP_OPTIONS.map(([seconds, label]) => ({
            label,
            value: String(seconds),
            default: Number(values.cleanup_seconds) === seconds
          })))
      )
    );
  } else if (step === 6) {
    title = "VoiceMaster Setup · Server Interface";
    description = "Create one persistent server-interface channel and message? Default: Yes.";
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`setup:${userId}:server-interface`)
          .setPlaceholder("Create a server interface?")
          .addOptions([
            { label: "Yes", value: "yes", default: values.server_interface_enabled },
            { label: "No", value: "no", default: !values.server_interface_enabled }
          ])
      )
    );
  } else {
    title = "VoiceMaster Setup · Review";
    description = `Confirm these settings:\n\n${configSummary(guild, {
      ...values,
      server_interface_channel_id: "disabled",
      server_interface_enabled: values.server_interface_enabled ? 1 : 0
    })}`;
    components.push(buttonRow(userId, [
      { id: "confirm", label: "Confirm Setup", style: ButtonStyle.Success },
      { id: "back", label: "Back" },
      { id: "cancel", label: "Cancel", style: ButtonStyle.Danger }
    ]));
    return { embeds: [embed(title, description)], components };
  }

  components.push(navRows(userId, {
    backDisabled: step === 0,
    nextDisabled: step === 3 &&
      (!values.limit_tens_selected || !values.limit_ones_selected),
    skip: step === 2 || step === 6
  }));
  return { embeds: [embed(title, description)], components };
}

function startTimeout(wizard) {
  clearTimeout(wizard.timeout);
  wizard.expiresAt = Date.now() + SESSION_TIMEOUT;
  wizard.timeout = setTimeout(async () => {
    const key = sessionKey(wizard.guild.id, wizard.userId);
    if (sessions.get(key) !== wizard) return;
    sessions.delete(key);
    await wizard.message.edit({
      embeds: [embed("Setup Expired", "No configuration was changed. Run `-vc setup` to start again.")],
      components: []
    }).catch((error) => console.error(`[setup expiration] ${wizard.guild.id}`, error));
  }, SESSION_TIMEOUT);
  wizard.timeout.unref?.();
}

function saveSession(wizard) {
  sessions.set(sessionKey(wizard.guild.id, wizard.userId), wizard);
  startTimeout(wizard);
}

function destroySession(wizard) {
  clearTimeout(wizard.timeout);
  sessions.delete(sessionKey(wizard.guild.id, wizard.userId));
}

function sessionIsStale(wizard) {
  return !wizard || !wizard.message || !wizard.expiresAt || wizard.expiresAt <= Date.now();
}

async function openWizard(interaction, config = null) {
  const wizard = {
    guild: interaction.guild,
    userId: interaction.user.id,
    values: config ? currentConfigValues(config) : newConfigValues(),
    existingConfig: config,
    step: 0,
    confirming: false,
    message: null,
    timeout: null,
    expiresAt: 0
  };
  const firstPayload = wizardPayload(wizard);
  await interaction.reply({ ...firstPayload, flags: MessageFlags.Ephemeral });
  wizard.message = await interaction.fetchReply();
  saveSession(wizard);
}

async function start(message) {
  const setupButton = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`setup-open:${message.author.id}`)
      .setLabel("Open private setup wizard")
      .setStyle(ButtonStyle.Primary)
  );
  return message.reply({
    embeds: [embed("VoiceMaster Setup", "Open the private setup wizard to configure temporary voice channels.")],
    components: [setupButton]
  });
}

function openExistingPayload(userId, guild, config) {
  return {
    embeds: [embed("Already Configured", `Current setup:\n\n${configSummary(guild, config)}\n\nReconfigure?`)],
    components: [
      buttonRow(userId, [
        { id: "reconfigure", label: "Reconfigure", style: ButtonStyle.Primary },
        { id: "cancel-existing", label: "Cancel", style: ButtonStyle.Danger }
      ])
    ]
  };
}

async function validateConfig(guild, values) {
  const categories = [...new Set(values.category_ids || (values.category_id ? [values.category_id] : []))];
  if (!values.j2c_channel_id || !categories.length || !values.name_template?.trim()) {
    return "Choose a Join to Create channel, at least one category, and a non-empty VC name.";
  }
  if (categories.length > MAX_TEMP_CATEGORIES) return `Choose no more than ${MAX_TEMP_CATEGORIES} categories.`;
  if (values.name_template.length > 100) return "VC name templates must be 100 characters or fewer.";
  if (!Number.isInteger(Number(values.user_limit)) || values.user_limit < 0 || values.user_limit > 99) {
    return "User limit must be between 0 and 99.";
  }
  if (!Number.isInteger(Number(values.bitrate)) || !bitrateOptions(guild).includes(Number(values.bitrate))) {
    return "Choose a bitrate currently available to this server.";
  }
  if (!CLEANUP_OPTIONS.some(([seconds]) => seconds === Number(values.cleanup_seconds))) {
    return "Choose a valid empty-channel cleanup time.";
  }
  if (typeof values.server_interface_enabled !== "boolean") return "Choose whether to create a server interface.";

  let j2c;
  let categoriesFound;
  try {
    [j2c, categoriesFound] = await Promise.all([
      guild.channels.fetch(values.j2c_channel_id),
      Promise.all(categories.map((categoryId) => guild.channels.fetch(categoryId)))
    ]);
  } catch (error) {
    if (error.code === 10003) return "One of the selected channels no longer exists. Select it again.";
    throw error;
  }
  if (!j2c || j2c.type !== ChannelType.GuildVoice) return "Join to Create must be an existing voice channel.";
  if (categoriesFound.some((category) => !category || category.type !== ChannelType.GuildCategory)) {
    return "Choose existing categories.";
  }
  return null;
}

async function confirm(interaction, wizard) {
  if (wizard.confirming) {
    return interaction.reply({
      embeds: [embed("Setup In Progress", "This setup is already being saved.")],
      flags: MessageFlags.Ephemeral
    });
  }
  wizard.confirming = true;
  await interaction.deferUpdate();
  let configurationSaved = false;
  try {
    const validationError = await validateConfig(wizard.guild, wizard.values);
    if (validationError) {
      wizard.confirming = false;
      wizard.step = 7;
      return wizard.message.edit({
        embeds: [embed("Setup Needs Attention", `${validationError}\n\nNo configuration was changed.`)],
        components: wizardPayload(wizard).components
      });
    }

    const existing = wizard.existingConfig || db.getConfig(wizard.guild.id);
    let serverInterface = null;
    let serverChannelId = "disabled";
    let serverMessageId = null;
    if (wizard.values.server_interface_enabled) {
      serverInterface = await createServerInterface(
        wizard.guild,
        wizard.values,
        existing,
        { deferExistingEdit: !!existing }
      );
      serverChannelId = serverInterface.text.id;
      serverMessageId = serverInterface.message.id;
    }

    try {
      db.setConfig({
        guild_id: wizard.guild.id,
        j2c_channel_id: wizard.values.j2c_channel_id,
        category_id: wizard.values.category_ids[0] || wizard.values.category_id,
        category_ids: JSON.stringify(
          [...new Set(wizard.values.category_ids || [])].slice(0, MAX_TEMP_CATEGORIES)
        ),
        server_interface_channel_id: serverChannelId,
        server_interface_message_id: serverMessageId,
        name_template: wizard.values.name_template.trim(),
        user_limit: Number(wizard.values.user_limit),
        bitrate: Number(wizard.values.bitrate),
        cleanup_seconds: Number(wizard.values.cleanup_seconds),
        server_interface_enabled: wizard.values.server_interface_enabled ? 1 : 0
      });
      configurationSaved = true;
    } catch (error) {
      if (serverInterface && serverInterface.createdChannel) {
        await serverInterface.text.delete("VoiceMaster: configuration transaction failed").catch((deleteError) => {
          console.error(`[setup rollback] ${serverInterface.text.id}`, deleteError);
        });
      }
      throw error;
    }

    if (serverInterface && !serverInterface.createdMessage) {
      try {
        await serverInterface.message.edit(serverInterface.payload);
      } catch (error) {
        if (existing) {
          try {
            db.setConfig(existing);
            configurationSaved = false;
            const restoredInterface = await createServerInterface(
              wizard.guild,
              existing,
              existing,
              { deferExistingEdit: true }
            );
            await restoredInterface.message.edit(restoredInterface.payload);
          } catch (rollbackError) {
            console.error(`[setup rollback] ${wizard.guild.id}`, rollbackError);
          }
        }
        throw error;
      }
    }

    destroySession(wizard);
    try {
      const vcFeatures = require("./vc-features");
      const send = typeof interaction.followUp === "function" ? (payload) => interaction.followUp(payload) : null;
      if (send) await vcFeatures.offer(wizard.guild, wizard.userId, send);
    } catch (error) {
      console.error(`[voice feature prompt] ${wizard.guild.id}`, error);
    }
    try {
      await interaction.editReply({
        embeds: [embed("VoiceMaster Setup Complete", configSummary(wizard.guild, {
          ...wizard.values,
          server_interface_enabled: wizard.values.server_interface_enabled ? 1 : 0
        }))],
        components: []
      });
    } catch (error) {
      console.error(`[setup completion response] ${wizard.guild.id}`, error);
      await wizard.message.edit({
        embeds: [embed("VoiceMaster Setup Complete", "Your configuration was saved successfully.")],
        components: []
      }).catch((editError) => console.error(`[setup completion fallback] ${wizard.guild.id}`, editError));
    }
  } catch (error) {
    console.error(`[setup confirmation] ${wizard.guild.id}`, error);
    if (configurationSaved) {
      destroySession(wizard);
      return;
    }
    wizard.confirming = false;
    await wizard.message.edit({
      embeds: [embed("Setup Not Saved", "Setup could not be completed. Your previous configuration is unchanged; you can retry or cancel.")],
      components: wizardPayload(wizard).components
    });
  }
}

async function handleSetupInteraction(interaction) {
  const customId = interaction.customId || "";
  if (customId.startsWith("setup-open:")) {
    const [, expectedUserId] = customId.split(":");
    if (expectedUserId !== interaction.user.id || interaction.user.id !== interaction.guild.ownerId) {
      await interaction.reply({
        embeds: [embed("Owner Only", "Only the server owner can use the setup wizard.")],
        flags: MessageFlags.Ephemeral
      });
      return true;
    }
      const key = sessionKey(interaction.guild.id, interaction.user.id);
    let wizard = sessions.get(key);
    if (wizard && sessionIsStale(wizard)) {
      destroySession(wizard);
      wizard = null;
    }
    if (wizard) {
      await interaction.reply({ ...wizardPayload(wizard), flags: MessageFlags.Ephemeral });
      wizard.message = await interaction.fetchReply();
      startTimeout(wizard);
      return true;
    }
    const config = db.getConfig(interaction.guild.id);
    if (config) {
      await interaction.reply({
        ...openExistingPayload(interaction.user.id, interaction.guild, config),
        flags: MessageFlags.Ephemeral
      });
      return true;
    }
    await openWizard(interaction);
    return true;
  }

  if (customId.startsWith("setup-name:")) {
    const [, userId] = customId.split(":");
    const wizard = sessions.get(sessionKey(interaction.guildId, userId));
    if (!wizard || wizard.userId !== interaction.user.id || interaction.user.id !== interaction.guild?.ownerId) {
      await interaction.reply({ content: "This setup session expired. Run `-vc setup` to start again.", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (sessionIsStale(wizard)) {
      destroySession(wizard);
      await interaction.reply({ content: "This setup session expired. Run `-vc setup` to start again.", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (interaction.message?.id && wizard.message?.id && interaction.message.id !== wizard.message.id) {
      await interaction.reply({ content: "This setup view is no longer active. Run `-vc setup` to reopen the current setup.", flags: MessageFlags.Ephemeral });
      return true;
    }
    const name = interaction.fields.getTextInputValue("name").trim();
    if (!name) {
      await interaction.reply({ content: "Enter a non-empty VC name template.", flags: MessageFlags.Ephemeral });
      return true;
    }
    wizard.values.name_template = name.slice(0, 100);
    startTimeout(wizard);
    await interaction.reply({ content: "Name saved.", flags: MessageFlags.Ephemeral });
    await wizard.message.edit(wizardPayload(wizard));
    return true;
  }

  if (!customId.startsWith("setup:")) return false;
  const [, userId, action] = customId.split(":");
  if (userId !== interaction.user.id || interaction.user.id !== interaction.guild?.ownerId) {
    await interaction.reply({
      embeds: [embed("Owner Only", "Only the server owner can use the setup wizard.")],
      flags: MessageFlags.Ephemeral
    });
    return true;
  }
  if (action === "reconfigure") {
    const config = db.getConfig(interaction.guild.id);
    if (!config) {
      const wizard = {
        guild: interaction.guild,
        userId,
        values: newConfigValues(),
        existingConfig: null,
        step: 0,
        confirming: false,
        message: interaction.message,
        timeout: null
      };
      saveSession(wizard);
      await interaction.update(wizardPayload(wizard));
      return true;
    }
    await openWizardFromUpdate(interaction, config);
    return true;
  }
  if (action === "cancel-existing") {
    await interaction.update({
      embeds: [embed("Setup Cancelled", "The existing configuration was not changed.")],
      components: []
    });
    return true;
  }

  const wizard = sessions.get(sessionKey(interaction.guildId, userId));
  if (!wizard) {
    await interaction.reply({ content: "This setup session expired. Run `-vc setup` to start again.", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (sessionIsStale(wizard)) {
    destroySession(wizard);
    await interaction.reply({ content: "This setup session expired. Run `-vc setup` to start again.", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (interaction.message?.id && wizard.message?.id && interaction.message.id !== wizard.message.id) {
    await interaction.reply({ content: "This setup view is no longer active. Run `-vc setup` to reopen the current setup.", flags: MessageFlags.Ephemeral });
    return true;
  }

  if (action === "cancel") {
    destroySession(wizard);
    await interaction.update({
      embeds: [embed("Setup Cancelled", "No configuration was changed.")],
      components: []
    });
    return true;
  }
  if (action === "confirm") {
    await confirm(interaction, wizard);
    return true;
  }
  if (action === "back") {
    wizard.step = Math.max(0, wizard.step - 1);
    startTimeout(wizard);
    await interaction.update(wizardPayload(wizard));
    return true;
  }
  if (action === "next" || action === "skip") {
    if (action === "skip" && wizard.step !== 2 && wizard.step !== 6) {
      await interaction.reply({ content: "Skip is not available on this setup step.", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (wizard.step === 0 && !wizard.values.j2c_channel_id) {
      await interaction.reply({ content: "Select a Join to Create voice channel before continuing.", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (wizard.step === 1 && !(wizard.values.category_ids?.length || wizard.values.category_id)) {
      await interaction.reply({ content: "Select at least one category before continuing.", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (wizard.step === 2 && !wizard.values.name_template?.trim()) {
      await interaction.reply({ content: "Enter a VC name template or skip to keep the current default.", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (wizard.step === 3 &&
        (!wizard.values.limit_tens_selected || !wizard.values.limit_ones_selected)) {
      await interaction.reply({ content: "Select both user-limit digits before continuing.", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (wizard.step === 4 && !bitrateOptions(wizard.guild).includes(Number(wizard.values.bitrate))) {
      await interaction.reply({ content: "Select a server bitrate before continuing.", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (wizard.step === 5 &&
        !CLEANUP_OPTIONS.some(([seconds]) => seconds === Number(wizard.values.cleanup_seconds))) {
      await interaction.reply({ content: "Select a cleanup time before continuing.", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (wizard.step === 6 && action === "skip" && !wizard.existingConfig) {
      wizard.values.server_interface_enabled = true;
    }
    wizard.step = Math.min(7, wizard.step + 1);
    startTimeout(wizard);
    await interaction.update(wizardPayload(wizard));
    return true;
  }
  if (action === "name") {
    const modal = new ModalBuilder()
      .setCustomId(`setup-name:${userId}`)
      .setTitle("Temporary VC Name");
    const input = new TextInputBuilder()
      .setCustomId("name")
      .setLabel("Name template")
      .setPlaceholder("{nickname}'s Channel")
      .setValue(wizard.values.name_template.slice(0, 100))
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(100);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
    return true;
  }
  if (interaction.isChannelSelectMenu()) {
    const selected = interaction.values[0];
    if (action === "j2c") {
      wizard.values.j2c_channel_id = selected;
    } else if (action === "categories" || action === "category") {
      wizard.values.category_ids = [...new Set(interaction.values)].slice(0, MAX_TEMP_CATEGORIES);
      wizard.values.category_id = wizard.values.category_ids[0] || null;
    } else {
      await interaction.reply({ content: "That setup selection is not recognized.", flags: MessageFlags.Ephemeral });
      return true;
    }
  } else if (interaction.isStringSelectMenu()) {
    const value = interaction.values[0];
    if (action === "limit_tens" || action === "limit_ones") {
      wizard.values[action] = value;
      wizard.values[`${action}_selected`] = true;
      wizard.values.user_limit = Number(`${wizard.values.limit_tens}${wizard.values.limit_ones}`);
    } else if (action === "bitrate") {
      wizard.values.bitrate = Number(value);
    } else if (action === "cleanup") {
      wizard.values.cleanup_seconds = Number(value);
    } else if (action === "server-interface") {
      wizard.values.server_interface_enabled = value === "yes";
    } else {
      await interaction.reply({ content: "That setup selection is not recognized.", flags: MessageFlags.Ephemeral });
      return true;
    }
  } else {
    return false;
  }

  startTimeout(wizard);
  await interaction.update(wizardPayload(wizard));
  return true;
}

async function openWizardFromUpdate(interaction, config) {
  const wizard = {
    guild: interaction.guild,
    userId: interaction.user.id,
    values: currentConfigValues(config),
    existingConfig: config,
    step: 0,
    confirming: false,
    message: interaction.message,
    timeout: null,
    expiresAt: 0
  };
  saveSession(wizard);
  await interaction.update(wizardPayload(wizard));
}

module.exports = { start, handleSetupInteraction };
