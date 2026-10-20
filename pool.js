const {
  ActionRowBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  OverwriteType,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");
const db = require("./db");
const { card } = require("./feedback");
const { withChannelLock } = require("./channel-lock");
const { logThrottledError } = require("./log-throttle");
const voice = require("./voice");
const breakthru = require("./breakthru");

const SESSION_TIMEOUT = 10 * 60 * 1000;
const CREATE_WINDOW_MS = 5000;
const CREATE_LIMIT = 5;
const paceConfig = { limit: CREATE_LIMIT, windowMs: CREATE_WINDOW_MS };
const CREATE_TIMEOUT_MS = 12000;
const sessions = new Map();
const lanes = new Map();

const CLEANUP_OPTIONS = [
  [0, "Instant"],
  [30, "30 seconds"],
  [60, "1 minute"],
  [300, "5 minutes"],
  [600, "10 minutes"],
  [1800, "30 minutes"]
];

const DEFAULTS = {
  initial_count: 15,
  refill_after: 5,
  refill_batch: 10,
  max_empty: 30,
  name_template: "{nickname}'s Channel",
  cleanup_seconds: 0
};

function embed(title, description) {
  return card(title, description);
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function withTimeout(work, ms) {
  let finished = false;
  const pending = Promise.resolve(work);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      finished = true;
      const error = new Error("Pool channel create timed out");
      error.code = "POOL_TIMEOUT";
      reject(error);
    }, ms);
    timer.unref?.();
    pending.then(
      (value) => {
        clearTimeout(timer);
        if (!finished) resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        if (!finished) reject(error);
      }
    );
  });
}

function retryDelayMs(error) {
  const bodySeconds = Number(error?.retry_after ?? error?.rawError?.retry_after);
  const libraryMs = Number(error?.retryAfter);
  let ms = 1000;
  if (Number.isFinite(bodySeconds) && bodySeconds > 0) ms = bodySeconds * 1000;
  else if (Number.isFinite(libraryMs) && libraryMs > 0) ms = libraryMs;
  return Math.min(15000, Math.ceil(ms) + 50);
}

function lane(guildId) {
  let state = lanes.get(guildId);
  if (!state) {
    state = { running: false, pending: 0, cancelled: false, creates: [], unsettled: new Set(), idle: Promise.resolve(), wake: null };
    lanes.set(guildId, state);
  }
  return state;
}

function canConfigure(userId, guild, member) {
  if (!userId || !guild) return false;
  if (guild.ownerId && String(userId) === String(guild.ownerId)) return true;
  if (require("./systems/access").isBotOwner(userId)) return true;
  if (member && require("./systems/access").staffTier(member) === "god") return true;
  try {
    if (member?.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
  } catch {
    return false;
  }
  return false;
}

function occupantCount(channel) {
  const size = channel?.members?.size;
  return Number.isFinite(size) ? size : 0;
}

function humanMembers(channel) {
  const members = [];
  const values = channel?.members?.values?.();
  if (!values) return members;
  for (const member of values) {
    if (!member?.id || member.user?.bot) continue;
    members.push(member);
  }
  return members;
}

function waitingName(template) {
  const named = String(template || "Open Call")
    .replaceAll("{nickname}", "Open")
    .replaceAll("{username}", "Open")
    .replaceAll("{user.mention}", "Open")
    .trim();
  return (named || "Open Call").slice(0, 100);
}

function cleanupLabel(seconds) {
  return CLEANUP_OPTIONS.find(([value]) => value === Number(seconds))?.[1] || `${seconds} seconds`;
}

function parseWhole(raw, label, min, max) {
  const text = String(raw ?? "").trim();
  if (!/^\d+$/.test(text)) return { error: `${label} must be a whole number.` };
  const value = Number(text);
  if (value < min || value > max) return { error: `${label} must be between ${min} and ${max}.` };
  return { value };
}

function validateValues(values) {
  const initial = parseWhole(values.initial_count, "The starting pool size", 1, 50);
  if (initial.error) return initial.error;
  const after = parseWhole(values.refill_after, "The refill threshold", 1, 50);
  if (after.error) return after.error;
  const batch = parseWhole(values.refill_batch, "The refill batch", 1, 50);
  if (batch.error) return batch.error;
  const maxEmpty = parseWhole(values.max_empty, "The empty pool cap", 1, 50);
  if (maxEmpty.error) return maxEmpty.error;
  if (initial.value > maxEmpty.value) return "The starting pool size cannot be higher than the empty pool cap.";
  const name = String(values.name_template || "").trim();
  if (!name) return "Enter a pool channel name.";
  if (name.length > 100) return "Pool channel names must be 100 characters or fewer.";
  if (!values.category_id) return "Choose an existing voice category.";
  if (!CLEANUP_OPTIONS.some(([seconds]) => seconds === Number(values.cleanup_seconds))) {
    return "Choose a cleanup time the bot already uses.";
  }
  return null;
}

function freshValues(guild) {
  const existing = db.getConfig(guild.id);
  const pool = db.getPoolConfig(guild.id);
  return {
    initial_count: pool?.initial_count ?? DEFAULTS.initial_count,
    refill_after: pool?.refill_after ?? DEFAULTS.refill_after,
    refill_batch: pool?.refill_batch ?? DEFAULTS.refill_batch,
    max_empty: pool?.max_empty ?? DEFAULTS.max_empty,
    name_template: pool?.name_template || existing?.name_template || DEFAULTS.name_template,
    cleanup_seconds: pool?.cleanup_seconds ?? existing?.cleanup_seconds ?? DEFAULTS.cleanup_seconds,
    category_id: pool?.category_id || null
  };
}

function summaryText(guild, values) {
  const category = guild.channels?.cache?.get?.(values.category_id);
  return [
    `Starting empty pools: **${values.initial_count}**`,
    `Category: ${category ? `<#${category.id}>` : "Missing category"}`,
    `Name: \`${values.name_template}\``,
    `Refill after **${values.refill_after}** claims, **${values.refill_batch}** at a time`,
    `Empty cap: **${values.max_empty}**`,
    `Cleanup: ${cleanupLabel(values.cleanup_seconds)} (same timer as temporary calls)`
  ].join("\n");
}

function buttonRow(userId, buttons) {
  return new ActionRowBuilder().addComponents(
    ...buttons.map(({ id, label, style = ButtonStyle.Secondary, disabled = false }) =>
      new ButtonBuilder()
        .setCustomId(`pool:${userId}:${id}`)
        .setLabel(label)
        .setStyle(style)
        .setDisabled(disabled)
    )
  );
}

function wizardPayload(wizard) {
  const { guild, userId, values, step } = wizard;
  const components = [];
  let title = "Pool Setup";
  let description = "";
  if (step === 0) {
    title = "Pool Setup · Starting Size";
    description = `How many empty pools should be created now?\nCurrent: **${values.initial_count}**\nDefault is 15.`;
    components.push(buttonRow(userId, [{ id: "edit-initial", label: "Change number" }]));
  } else if (step === 1) {
    title = "Pool Setup · Category";
    description = "Choose an existing category. The bot will not create one.";
    components.push(new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(`pool:${userId}:category`)
        .setPlaceholder("Select a category")
        .setChannelTypes(ChannelType.GuildCategory)
        .setMinValues(1)
        .setMaxValues(1)
    ));
  } else if (step === 2) {
    title = "Pool Setup · Name";
    description = `Current name: \`${values.name_template}\`\nPlaceholders: \`{nickname}\`, \`{username}\`, \`{user.mention}\`. Empty pools use Open until someone claims one.`;
    components.push(buttonRow(userId, [{ id: "edit-name", label: "Change name" }]));
  } else if (step === 3) {
    title = "Pool Setup · Refill Threshold";
    description = `Create more pools after this many claims.\nCurrent: **${values.refill_after}**\nDefault is 5.`;
    components.push(buttonRow(userId, [{ id: "edit-after", label: "Change number" }]));
  } else if (step === 4) {
    title = "Pool Setup · Refill Batch";
    description = `How many empty pools to add each refill.\nCurrent: **${values.refill_batch}**\nDefault is 10. The cap still applies.`;
    components.push(buttonRow(userId, [{ id: "edit-batch", label: "Change number" }]));
  } else if (step === 5) {
    title = "Pool Setup · Empty Cap";
    description = `Most empty unclaimed pools allowed at once.\nCurrent: **${values.max_empty}**\nDefault is 30. Discord allows 50 channels in a category.`;
    components.push(buttonRow(userId, [{ id: "edit-max", label: "Change number" }]));
  } else if (step === 6) {
    title = "Pool Setup · Cleanup";
    description = "Claimed pools use the same empty-channel cleanup as other temporary calls.";
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`pool:${userId}:cleanup`)
        .setPlaceholder("Cleanup delay")
        .addOptions(CLEANUP_OPTIONS.map(([seconds, label]) => ({
          label,
          value: String(seconds),
          default: Number(values.cleanup_seconds) === seconds
        })))
    ));
  } else {
    title = "Pool Setup · Review";
    description = `Save these settings and create the starting pools?\n\n${summaryText(guild, values)}`;
  }
  components.push(buttonRow(userId, [
    { id: "back", label: "Back", disabled: step === 0 },
    { id: "next", label: "Next", style: ButtonStyle.Primary },
    { id: "cancel", label: "Cancel", style: ButtonStyle.Danger }
  ]));
  return { embeds: [embed(title, description)], components };
}

function sessionKey(guildId) {
  return String(guildId);
}

function destroySession(wizard) {
  clearTimeout(wizard.timeout);
  if (sessions.get(sessionKey(wizard.guild.id)) === wizard) sessions.delete(sessionKey(wizard.guild.id));
}

function sessionIsStale(wizard) {
  return !wizard || !wizard.expiresAt || wizard.expiresAt <= Date.now();
}

function saveSession(wizard) {
  clearTimeout(wizard.timeout);
  wizard.expiresAt = Date.now() + SESSION_TIMEOUT;
  sessions.set(sessionKey(wizard.guild.id), wizard);
  wizard.timeout = setTimeout(() => {
    if (sessions.get(sessionKey(wizard.guild.id)) !== wizard) return;
    sessions.delete(sessionKey(wizard.guild.id));
    wizard.message?.edit?.({
      embeds: [embed("Pool Setup Expired", "Nothing was saved. Run `-poolsetup` to start again.")],
      components: []
    }).catch(() => null);
  }, SESSION_TIMEOUT);
  wizard.timeout.unref?.();
}

function numberModal(userId, field, label, current) {
  return new ModalBuilder()
    .setCustomId(`pool-number:${userId}:${field}`)
    .setTitle(label)
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("number")
        .setLabel(label)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(current))
        .setMaxLength(2)
    ));
}

function nameModal(userId, current) {
  return new ModalBuilder()
    .setCustomId(`pool-name:${userId}`)
    .setTitle("Pool channel name")
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("name")
        .setLabel("Name")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(current).slice(0, 100))
        .setMaxLength(100)
    ));
}

async function start(message) {
  if (!canConfigure(message.author.id, message.guild, message.member)) {
    return message.reply({ embeds: [embed("Owner Only", "Only the server owner can use `-poolsetup`.")] });
  }
  const existing = sessions.get(sessionKey(message.guild.id));
  if (existing && !sessionIsStale(existing)) {
    return message.reply({ embeds: [embed("Pool Setup Open", "A pool setup is already open. Finish or cancel that one first.")] });
  }
  if (existing) destroySession(existing);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`pool-open:${message.author.id}`)
      .setLabel("Open pool setup")
      .setStyle(ButtonStyle.Primary)
  );
  return message.reply({
    embeds: [embed("Pool Setup", "Open the private setup wizard to create standby voice channels.")],
    components: [row]
  });
}

function stepError(values, step) {
  if (step === 0) return parseWhole(values.initial_count, "The starting pool size", 1, 50).error || null;
  if (step === 1) return values.category_id ? null : "Choose an existing voice category.";
  if (step === 2) {
    const name = String(values.name_template || "").trim();
    if (!name) return "Enter a pool channel name.";
    if (name.length > 100) return "Pool channel names must be 100 characters or fewer.";
    return null;
  }
  if (step === 3) return parseWhole(values.refill_after, "The refill threshold", 1, 50).error || null;
  if (step === 4) return parseWhole(values.refill_batch, "The refill batch", 1, 50).error || null;
  if (step === 5) return parseWhole(values.max_empty, "The empty pool cap", 1, 50).error || null;
  if (step === 6 && !CLEANUP_OPTIONS.some(([seconds]) => seconds === Number(values.cleanup_seconds))) {
    return "Choose a cleanup time the bot already uses.";
  }
  return null;
}

async function saveWizard(interaction, wizard) {
  if (wizard.saving) {
    return interaction.reply({
      embeds: [embed("Setup In Progress", "This pool setup is already being saved.")],
      flags: MessageFlags.Ephemeral
    }).catch(() => null);
  }
  wizard.saving = true;
  await interaction.deferUpdate();
  try {
    const problem = validateValues(wizard.values);
    if (problem) {
      wizard.saving = false;
      wizard.step = 7;
      return wizard.message.edit({
        embeds: [embed("Pool Setup Needs Attention", `${problem}\n\nNothing was saved.`)],
        components: wizardPayload(wizard).components
      });
    }
    const category = await wizard.guild.channels.fetch(wizard.values.category_id).catch((error) => {
      if (error?.code === 10003) return null;
      throw error;
    });
    if (!category || category.type !== ChannelType.GuildCategory) {
      wizard.saving = false;
      wizard.step = 1;
      return wizard.message.edit({
        embeds: [embed("Pool Setup Needs Attention", "That category is gone. Choose an existing one. Nothing was saved.")],
        components: wizardPayload(wizard).components
      });
    }
    const previous = db.getPoolConfig(wizard.guild.id);
    db.savePoolConfig({
      guild_id: wizard.guild.id,
      category_id: category.id,
      name_template: wizard.values.name_template.trim(),
      initial_count: Number(wizard.values.initial_count),
      refill_after: Number(wizard.values.refill_after),
      refill_batch: Number(wizard.values.refill_batch),
      max_empty: Number(wizard.values.max_empty),
      cleanup_seconds: Number(wizard.values.cleanup_seconds),
      generation_stopped: 0,
      cycle_claims: previous?.cycle_claims || 0,
      refill_open: 0
    });
    const voiceConfig = db.getConfig(wizard.guild.id);
    if (voiceConfig) {
      db.setConfig({ ...voiceConfig, cleanup_seconds: Number(wizard.values.cleanup_seconds) });
    }
    const empty = db.countPoolChannels(wizard.guild.id, "empty");
    const target = Math.min(Number(wizard.values.initial_count), Number(wizard.values.max_empty));
    const needed = Math.max(0, target - empty);
    destroySession(wizard);
    if (needed) requestCreates(wizard.guild, needed);
    await wizard.message.edit({
      embeds: [embed(
        "Pool Setup Saved",
        `${summaryText(wizard.guild, wizard.values)}\n\n${needed ? `Creating **${needed}** empty pools.` : "The starting pools are already there."}`
      )],
      components: []
    });
  } catch (error) {
    wizard.saving = false;
    logThrottledError(`pool-setup:${wizard.guild.id}`, `[pool setup] ${wizard.guild.id}`, error);
    await wizard.message.edit({
      embeds: [embed("Pool Setup Not Saved", "Setup could not be completed. Your previous pool configuration is unchanged.")],
      components: wizardPayload(wizard).components
    }).catch(() => null);
  }
}

function wizardFromInteraction(interaction, userId) {
  return {
    guild: interaction.guild,
    userId,
    values: freshValues(interaction.guild),
    step: 0,
    saving: false,
    message: interaction.message || null,
    timeout: null,
    expiresAt: 0
  };
}

function liveWizard(interaction, userId) {
  const key = sessionKey(interaction.guildId || interaction.guild?.id);
  let wizard = sessions.get(key);
  if (wizard && (sessionIsStale(wizard) || String(wizard.userId) !== String(userId))) {
    destroySession(wizard);
    wizard = null;
  }
  if (!wizard) wizard = wizardFromInteraction(interaction, userId);
  if (interaction.message) wizard.message = interaction.message;
  wizard.guild = interaction.guild || wizard.guild;
  saveSession(wizard);
  return wizard;
}

async function showWizard(interaction, wizard) {
  saveSession(wizard);
  const payload = wizardPayload(wizard);
  try {
    if (interaction.deferred) {
      await interaction.editReply(payload);
      return;
    }
    if (typeof interaction.update === "function" && interaction.message) {
      await interaction.update(payload);
      return;
    }
  } catch (error) {
    logThrottledError(`pool-setup:${wizard.guild?.id}`, `[pool setup] ${wizard.guild?.id}`, error);
  }
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => null);
    return;
  }
  await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => null);
}

async function handleInteraction(interaction) {
  try {
    return await handlePoolInteraction(interaction);
  } catch (error) {
    logThrottledError(`pool-setup:${interaction.guild?.id}`, `[pool setup] ${interaction.guild?.id}`, error);
    const payload = { embeds: [embed("Pool Setup", "That setup step did not save. Use Next again, or run `-poolsetup` to reopen it.")], flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => null);
    else await interaction.reply(payload).catch(() => null);
    return true;
  }
}

async function handlePoolInteraction(interaction) {
  const customId = interaction.customId || "";
  if (customId.startsWith("pool-open:")) {
    const expected = customId.split(":")[1];
    if (expected !== interaction.user.id || !canConfigure(interaction.user.id, interaction.guild, interaction.member)) {
      await interaction.reply({ embeds: [embed("Owner Only", "Only the server owner can use `-poolsetup`.")], flags: MessageFlags.Ephemeral });
      return true;
    }
    const current = sessions.get(sessionKey(interaction.guild.id));
    if (current && !sessionIsStale(current) && current.userId !== interaction.user.id) {
      await interaction.reply({ embeds: [embed("Pool Setup Open", "A pool setup is already open.")], flags: MessageFlags.Ephemeral });
      return true;
    }
    if (current && sessionIsStale(current)) destroySession(current);
    const wizard = current && !sessionIsStale(current) ? current : wizardFromInteraction(interaction, interaction.user.id);
    wizard.guild = interaction.guild;
    saveSession(wizard);
    const sent = await interaction.reply({ ...wizardPayload(wizard), flags: MessageFlags.Ephemeral, fetchReply: true });
    wizard.message = sent || wizard.message;
    saveSession(wizard);
    return true;
  }
  if (customId.startsWith("pool-name:")) {
    const userId = customId.split(":")[1];
    if (userId !== interaction.user.id || !canConfigure(interaction.user.id, interaction.guild, interaction.member)) {
      await interaction.reply({ embeds: [embed("Owner Only", "Only the server owner can use the pool setup wizard.")], flags: MessageFlags.Ephemeral });
      return true;
    }
    const wizard = liveWizard(interaction, userId);
    const name = interaction.fields.getTextInputValue("name").trim();
    if (!name || name.length > 100) {
      await interaction.reply({ embeds: [embed("Pool Setup Needs Attention", "Enter a name of 1 to 100 characters.")], flags: MessageFlags.Ephemeral });
      return true;
    }
    wizard.values.name_template = name;
    saveSession(wizard);
    await interaction.reply({ embeds: [embed("Name Saved", `\`${name}\``)], flags: MessageFlags.Ephemeral });
    await wizard.message?.edit?.(wizardPayload(wizard));
    return true;
  }
  if (customId.startsWith("pool-number:")) {
    const [, userId, field] = customId.split(":");
    if (userId !== interaction.user.id || !canConfigure(interaction.user.id, interaction.guild, interaction.member)) {
      await interaction.reply({ embeds: [embed("Owner Only", "Only the server owner can use the pool setup wizard.")], flags: MessageFlags.Ephemeral });
      return true;
    }
    const wizard = liveWizard(interaction, userId);
    const labels = {
      initial_count: ["The starting pool size", 1, 50],
      refill_after: ["The refill threshold", 1, 50],
      refill_batch: ["The refill batch", 1, 50],
      max_empty: ["The empty pool cap", 1, 50]
    };
    const spec = labels[field];
    if (!spec) return true;
    const parsed = parseWhole(interaction.fields.getTextInputValue("number"), spec[0], spec[1], spec[2]);
    if (parsed.error) {
      await interaction.reply({ embeds: [embed("Pool Setup Needs Attention", parsed.error)], flags: MessageFlags.Ephemeral });
      return true;
    }
    wizard.values[field] = parsed.value;
    saveSession(wizard);
    await interaction.reply({ embeds: [embed("Number Saved", `**${parsed.value}**`)], flags: MessageFlags.Ephemeral });
    await wizard.message?.edit?.(wizardPayload(wizard));
    return true;
  }
  if (!customId.startsWith("pool:")) return false;
  const [, userId, action] = customId.split(":");
  if (userId !== interaction.user.id || !canConfigure(interaction.user.id, interaction.guild, interaction.member)) {
    await interaction.reply({ embeds: [embed("Owner Only", "Only the server owner can use the pool setup wizard.")], flags: MessageFlags.Ephemeral });
    return true;
  }
  const wizard = liveWizard(interaction, userId);
  if (action === "category" && interaction.isChannelSelectMenu?.()) {
    wizard.values.category_id = interaction.values[0];
    await showWizard(interaction, wizard);
    return true;
  }
  if (action === "cleanup" && interaction.isStringSelectMenu?.()) {
    wizard.values.cleanup_seconds = Number(interaction.values[0]);
    await showWizard(interaction, wizard);
    return true;
  }
  if (action === "edit-initial") {
    await interaction.showModal(numberModal(userId, "initial_count", "Starting pools", wizard.values.initial_count));
    return true;
  }
  if (action === "edit-after") {
    await interaction.showModal(numberModal(userId, "refill_after", "Claims before refill", wizard.values.refill_after));
    return true;
  }
  if (action === "edit-batch") {
    await interaction.showModal(numberModal(userId, "refill_batch", "Pools per refill", wizard.values.refill_batch));
    return true;
  }
  if (action === "edit-max") {
    await interaction.showModal(numberModal(userId, "max_empty", "Empty pool cap", wizard.values.max_empty));
    return true;
  }
  if (action === "edit-name") {
    await interaction.showModal(nameModal(userId, wizard.values.name_template));
    return true;
  }
  if (action === "cancel") {
    destroySession(wizard);
    await interaction.update({ embeds: [embed("Pool Setup Cancelled", "Nothing was saved.")], components: [] });
    return true;
  }
  if (action === "back") {
    wizard.step = Math.max(0, wizard.step - 1);
    await showWizard(interaction, wizard);
    return true;
  }
  if (action === "next") {
    if (wizard.step >= 7) {
      await saveWizard(interaction, wizard);
      return true;
    }
    const problem = stepError(wizard.values, wizard.step);
    if (problem) {
      await interaction.reply({ embeds: [embed("Pool Setup Needs Attention", problem)], flags: MessageFlags.Ephemeral });
      return true;
    }
    wizard.step += 1;
    await showWizard(interaction, wizard);
    return true;
  }
  return true;
}

function voiceSettings(guild) {
  return db.getConfig(guild.id) || {};
}

async function applySettings(guild, channel, member) {
  const poolConfig = db.getPoolConfig(guild.id);
  const settings = voiceSettings(guild);
  const template = poolConfig?.name_template || settings.name_template || DEFAULTS.name_template;
  const payload = {
    name: voice.renderName(template, member),
    bitrate: voice.clampBitrate(guild, settings.bitrate),
    userLimit: voice.clampUserLimit(settings.user_limit)
  };
  if (typeof channel.permissionOverwrites?.set === "function") {
    payload.permissionOverwrites = [
      {
        id: guild.roles?.everyone?.id || guild.id,
        type: OverwriteType.Role,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
      },
      {
        id: member.id,
        type: OverwriteType.Member,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
      }
    ];
  }
  if (typeof channel.edit === "function") await channel.edit(payload, "VoiceMaster: claim pool channel");
  breakthru.allow(channel);
}

async function showInterface(channel, ownerId) {
  try {
    await voice.renderVoiceChannelInterface(channel, ownerId);
  } catch (error) {
    try {
      await voice.renderVoiceChannelInterface(channel, ownerId);
    } catch (retryError) {
      logThrottledError(`pool-interface:${channel.guild?.id}`, `[pool interface] ${channel.id}`, retryError);
    }
  }
}

async function rememberTemp(guild, channel, member) {
  db.addTemp({
    channel_id: channel.id,
    guild_id: guild.id,
    owner_id: member.id,
    interface_message_id: null,
    created_at: Date.now()
  });
  await voice.adoptOwnedChannel(guild, channel, member.id);
}

function seenChannel(member, voiceState) {
  const fromMember = member?.voice?.channelId || member?.voice?.channel?.id;
  if (fromMember != null) return fromMember;
  return voiceState?.channelId || voiceState?.channel?.id || null;
}

function stillThere(member, channelId, moveFrom, voiceState) {
  const current = seenChannel(member, voiceState);
  if (current == null) return true;
  if (String(current) === String(channelId)) return true;
  if (moveFrom && String(current) === String(moveFrom)) return true;
  return false;
}

function alreadyThere(member, channelId, voiceState) {
  const current = seenChannel(member, voiceState);
  return current != null && String(current) === String(channelId);
}

function landedIn(member, channelId, voiceState) {
  const current = seenChannel(member, voiceState);
  if (current == null) return true;
  return String(current) === String(channelId);
}

async function moveMember(guild, member, channelId, voiceState) {
  const reason = "VoiceMaster: pool channel";
  if (typeof voiceState?.setChannel === "function") {
    await voiceState.setChannel(channelId, reason);
    return;
  }
  if (typeof member?.voice?.setChannel === "function") {
    await member.voice.setChannel(channelId, reason);
    return;
  }
  await guild.members.edit(member.id, { channel: channelId, reason });
}

function leftDuringMove(error) {
  return Number(error?.code) === 40032 || Number(error?.code) === 10065;
}

async function claimFor(guild, member, channel, { moveFrom = null, voiceState = null } = {}) {
  if (!member?.id || member.user?.bot) return null;
  return withChannelLock(`pool:${channel.id}`, async () => {
    const claimed = db.claimPoolChannel(channel.id, member.id);
    if (!claimed) return null;
    if (!stillThere(member, channel.id, moveFrom, voiceState)) {
      db.releasePoolClaim(channel.id, member.id);
      return null;
    }
    try {
      await applySettings(guild, channel, member);
      if (!alreadyThere(member, channel.id, voiceState)) {
        await moveMember(guild, member, channel.id, voiceState);
      }
      if (!landedIn(member, channel.id, voiceState)) {
        if (occupantCount(channel) === 0) db.releasePoolClaim(channel.id, member.id);
        return null;
      }
      await rememberTemp(guild, channel, member);
      await showInterface(channel, member.id);
      scheduleRefill(guild);
      return channel;
    } catch (error) {
      if (landedIn(member, channel.id, voiceState) && !leftDuringMove(error)) {
        logThrottledError(`pool-claim:${guild.id}`, `[pool claim] ${guild.id}:${channel.id}`, error);
        if (!db.getTempChannel(channel.id)) await rememberTemp(guild, channel, member);
        await showInterface(channel, member.id);
        scheduleRefill(guild);
        return channel;
      }
      if (occupantCount(channel) === 0) db.releasePoolClaim(channel.id, member.id);
      return null;
    }
  });
}

async function claimJoin(guild, member, channelId) {
  const row = db.getPoolChannel(channelId);
  if (!row || row.status !== "empty" || String(row.guild_id) !== String(guild.id)) return null;
  const channel = guild.channels?.cache?.get?.(channelId) || await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return null;
  return claimFor(guild, member, channel);
}

async function moveFromLobby(guild, member, lobbyId, voiceState) {
  const config = db.getPoolConfig(guild.id);
  if (!config) return { channel: null, reason: "pools are not set up" };
  const current = seenChannel(member, voiceState);
  if (current && lobbyId && String(current) !== String(lobbyId)) {
    return { channel: null, reason: "member left join-to-create" };
  }
  const empties = db.listPoolChannels(guild.id, "empty");
  if (!empties.length) return { channel: null, reason: "no empty pool" };
  for (const row of empties) {
    let channel = guild.channels?.cache?.get?.(row.channel_id) || null;
    if (!channel && typeof guild.channels?.fetch === "function") {
      channel = await guild.channels.fetch(row.channel_id).catch(() => null);
    }
    if (!channel || occupantCount(channel) > 0) continue;
    const claimed = await claimFor(guild, member, channel, { moveFrom: lobbyId, voiceState });
    if (claimed) return { channel: claimed, reason: null };
    const after = seenChannel(member, voiceState);
    if (after && lobbyId && String(after) !== String(lobbyId)) {
      return { channel: null, reason: "member left join-to-create" };
    }
  }
  return { channel: null, reason: "no empty pool could be claimed" };
}

function finishRefill(guildId) {
  const config = db.getPoolConfig(guildId);
  const state = lane(guildId);
  if (!config?.refill_open || state.pending > 0 || state.running) return;
  const empty = db.countPoolChannels(guildId, "empty");
  if (empty >= config.refill_after || empty >= config.max_empty) {
    db.setPoolRefill(guildId, { cycleClaims: 0, refillOpen: false });
  }
}

function scheduleRefill(guild) {
  const config = db.getPoolConfig(guild.id);
  if (!config || config.generation_stopped || config.refill_open) return 0;
  if (config.cycle_claims < config.refill_after) return 0;
  const empty = db.countPoolChannels(guild.id, "empty");
  const room = Math.max(0, config.max_empty - empty);
  const batch = Math.min(config.refill_batch, room);
  db.setPoolRefill(guild.id, { cycleClaims: config.cycle_claims, refillOpen: true });
  if (batch <= 0) {
    db.setPoolRefill(guild.id, { cycleClaims: 0, refillOpen: false });
    return 0;
  }
  requestCreates(guild, batch);
  return batch;
}

async function pace(state) {
  const now = Date.now();
  while (state.creates.length && now - state.creates[0] >= paceConfig.windowMs) state.creates.shift();
  if (state.creates.length >= paceConfig.limit) {
    const wait = paceConfig.windowMs - (now - state.creates[0]);
    if (wait > 0) await sleep(wait);
  }
  state.creates.push(Date.now());
}

function hardStop(error) {
  const code = Number(error?.code);
  return code === 50013 || code === 30013 || code === 10003 || error?.code === "POOL_NO_CATEGORY";
}

async function createEmpty(guild, config) {
  const category = guild.channels?.cache?.get?.(config.category_id) ||
    await guild.channels.fetch(config.category_id).catch((error) => {
      if (error?.code === 10003) return null;
      throw error;
    });
  if (!category || category.type !== ChannelType.GuildCategory) {
    const error = new Error("Pool category is missing");
    error.code = "POOL_NO_CATEGORY";
    throw error;
  }
  const state = lane(guild.id);
  if (!state.unsettled) state.unsettled = new Set();
  if (state.unsettled.size >= 2) {
    const error = new Error("Pool create is waiting for Discord");
    error.code = "POOL_WAITING";
    throw error;
  }
  const settings = voiceSettings(guild);
  const creating = guild.channels.create({
    name: waitingName(config.name_template),
    type: ChannelType.GuildVoice,
    parent: category.id,
    bitrate: voice.clampBitrate(guild, settings.bitrate),
    userLimit: 0,
    permissionOverwrites: [{
      id: guild.roles?.everyone?.id || guild.id,
      type: OverwriteType.Role,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
    }],
    reason: "VoiceMaster: empty pool channel"
  });
  const tracked = Promise.resolve(creating);
  state.unsettled.add(tracked);
  tracked.then(
    () => state.unsettled.delete(tracked),
    () => state.unsettled.delete(tracked)
  );
  let channel;
  try {
    channel = await withTimeout(tracked, CREATE_TIMEOUT_MS);
  } catch (error) {
    if (error?.code === "POOL_TIMEOUT") {
      tracked.then((late) => {
        if (!late?.id || db.getPoolChannel(late.id)) return;
        db.insertPoolChannel({
          channel_id: late.id,
          guild_id: guild.id,
          status: "empty",
          created_at: Date.now()
        });
      }).catch(() => null);
    }
    throw error;
  }
  if (db.getPoolChannel(channel.id)) return channel;
  try {
    db.insertPoolChannel({
      channel_id: channel.id,
      guild_id: guild.id,
      status: "empty",
      created_at: Date.now()
    });
  } catch (error) {
    if (occupantCount(channel) === 0 && typeof channel.delete === "function") {
      await channel.delete("VoiceMaster: pool record failed").catch(() => null);
    }
    throw error;
  }
  return channel;
}

function requestCreates(guild, count) {
  const config = db.getPoolConfig(guild.id);
  if (!config || config.generation_stopped || count <= 0) return false;
  const state = lane(guild.id);
  state.cancelled = false;
  state.pending += count;
  if (!state.running) {
    state.running = true;
    state.idle = runLane(guild);
  }
  return true;
}

async function runLane(guild) {
  const state = lane(guild.id);
  try {
    while (state.pending > 0) {
      const config = db.getPoolConfig(guild.id);
      if (!config || config.generation_stopped || state.cancelled) {
        state.pending = 0;
        break;
      }
      if (db.countPoolChannels(guild.id, "empty") >= config.max_empty) {
        state.pending = 0;
        break;
      }
      state.pending -= 1;
      await pace(state);
      try {
        await createEmpty(guild, config);
      } catch (error) {
        if (voice.isRateLimitError(error)) {
          state.pending += 1;
          logThrottledError(`pool-create:${guild.id}`, `[pool create] ${guild.id}`, error);
          await sleep(retryDelayMs(error));
          continue;
        }
        if (error?.code === "POOL_WAITING") {
          state.pending += 1;
          await sleep(CREATE_TIMEOUT_MS);
          continue;
        }
        if (error?.code === "POOL_TIMEOUT") {
          logThrottledError(`pool-create:${guild.id}`, `[pool create] ${guild.id}`, error);
          continue;
        }
        logThrottledError(`pool-create:${guild.id}`, `[pool create] ${guild.id}`, error);
        if (hardStop(error)) {
          state.pending = 0;
          break;
        }
      }
    }
  } finally {
    state.running = false;
    finishRefill(guild.id);
    if (state.pending > 0 && !state.cancelled && !db.getPoolConfig(guild.id)?.generation_stopped) {
      state.running = true;
      state.idle = runLane(guild);
    }
  }
}

function whenIdle(guildId) {
  return lane(guildId).idle;
}

async function stopGeneration(guild) {
  const config = db.getPoolConfig(guild.id);
  if (!config) return false;
  const state = lane(guild.id);
  state.cancelled = true;
  state.pending = 0;
  db.setPoolGeneration(guild.id, true);
  db.setPoolRefill(guild.id, { cycleClaims: config.cycle_claims, refillOpen: false });
  return true;
}

function forgetChannel(channelId) {
  if (!channelId || !db.getPoolChannel(channelId)) return false;
  db.deletePoolChannel(channelId);
  return true;
}

async function resolveChannel(guild, channelId) {
  const cached = guild.channels?.cache?.get?.(channelId);
  if (cached) return cached;
  if (typeof guild.channels?.fetch !== "function") return null;
  return guild.channels.fetch(channelId).catch((error) => {
    if (error?.code === 10003) return null;
    throw error;
  });
}

async function cleanEmpty(guild) {
  const rows = db.listPoolChannels(guild.id, "empty");
  const summary = { found: rows.length, deleted: 0, skipped: 0, failed: 0 };
  for (const row of rows) {
    try {
      const outcome = await withChannelLock(`pool:${row.channel_id}`, async () => {
        const fresh = db.getPoolChannel(row.channel_id);
        if (!fresh || fresh.status !== "empty" || String(fresh.guild_id) !== String(guild.id)) return "skipped";
        const channel = await resolveChannel(guild, row.channel_id);
        if (!channel) {
          db.deletePoolChannel(row.channel_id);
          return "skipped";
        }
        if (channel.type !== ChannelType.GuildVoice || occupantCount(channel) > 0) return "skipped";
        const again = db.getPoolChannel(row.channel_id);
        if (!again || again.status !== "empty") return "skipped";
        await channel.delete("VoiceMaster: clean empty pool");
        db.deletePoolChannel(row.channel_id);
        return "deleted";
      });
      summary[outcome] += 1;
    } catch (error) {
      summary.failed += 1;
      logThrottledError(`pool-clean:${guild.id}`, `[pool clean] ${row.channel_id}`, error);
    }
  }
  return summary;
}

async function channelState(guild, row) {
  try {
    const channel = await resolveChannel(guild, row.channel_id);
    if (!channel) return "missing";
    return occupantCount(channel) > 0 ? "occupied" : "empty";
  } catch {
    return "unknown";
  }
}

async function status(guild) {
  const config = db.getPoolConfig(guild.id);
  if (!config) return null;
  const claimed = db.listPoolChannels(guild.id, "claimed");
  let occupied = 0;
  let awaiting = 0;
  for (const row of claimed) {
    const state = await channelState(guild, row);
    if (state === "occupied") occupied += 1;
    else awaiting += 1;
  }
  const state = lane(guild.id);
  return {
    empty: db.countPoolChannels(guild.id, "empty"),
    occupied,
    awaiting,
    refillAfter: config.refill_after,
    refillBatch: config.refill_batch,
    maxEmpty: config.max_empty,
    running: !config.generation_stopped,
    pending: state.pending > 0 || !!config.refill_open,
    working: !!state.running
  };
}

function statusText(report) {
  return [
    `Empty pools: **${report.empty}**`,
    `Claimed and occupied: **${report.occupied}**`,
    `Claimed and empty, waiting for cleanup: **${report.awaiting}**`,
    `Refill after **${report.refillAfter}** claims, **${report.refillBatch}** at a time`,
    `Empty cap: **${report.maxEmpty}**`,
    `Generation: ${report.running ? "running" : "stopped"}`,
    `Refill: ${report.working ? "in progress" : report.pending ? "pending" : "idle"}`
  ].join("\n");
}

async function adoptRecent(guild, config) {
  if (typeof guild.fetchAuditLogs !== "function") return;
  const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.ChannelCreate, limit: 20 }).catch(() => null);
  const entries = logs?.entries?.values?.() || [];
  for (const entry of entries) {
    const executorId = entry?.executorId || entry?.executor?.id;
    if (!executorId || String(executorId) !== String(guild.client?.user?.id)) continue;
    const createdAt = entry.createdTimestamp || entry.createdAt || 0;
    if (createdAt && Date.now() - createdAt > 10 * 60 * 1000) continue;
    const channelId = entry.targetId || entry.target?.id;
    if (!channelId || db.getPoolChannel(channelId) || db.getTempChannel(channelId)) continue;
    const channel = await resolveChannel(guild, channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildVoice) continue;
    if (String(channel.parentId) !== String(config.category_id)) continue;
    if (occupantCount(channel) > 0) continue;
    db.insertPoolChannel({
      channel_id: channel.id,
      guild_id: guild.id,
      status: "empty",
      created_at: createdAt || Date.now()
    });
  }
}

async function reconcileGuild(guild) {
  const config = db.getPoolConfig(guild.id);
  if (!config) return { removed: 0, claimed: 0, adopted: 0 };
  const before = db.countPoolChannels(guild.id, "empty") + db.countPoolChannels(guild.id, "claimed");
  await adoptRecent(guild, config);
  const adopted = db.countPoolChannels(guild.id, "empty") + db.countPoolChannels(guild.id, "claimed") - before;
  let removed = 0;
  let claimed = 0;
  for (const row of db.listPoolChannels(guild.id)) {
    let channel = null;
    try {
      channel = await resolveChannel(guild, row.channel_id);
    } catch (error) {
      logThrottledError(`pool-reconcile:${guild.id}`, `[pool reconcile] ${row.channel_id}`, error);
      continue;
    }
    if (!channel) {
      db.deletePoolChannel(row.channel_id);
      if (row.status === "claimed") db.markTempDeleted(row.channel_id);
      removed += 1;
      continue;
    }
    if (row.status === "empty") {
      const people = humanMembers(channel);
      if (people.length) {
        const owner = await claimFor(guild, people[0], channel);
        if (owner) claimed += 1;
      }
      continue;
    }
    if (!db.getTempChannel(row.channel_id) && row.owner_id) {
      db.addTemp({
        channel_id: row.channel_id,
        guild_id: guild.id,
        owner_id: row.owner_id,
        interface_message_id: null,
        created_at: row.claimed_at || row.created_at
      });
    }
  }
  if (config.refill_open && !lane(guild.id).running) {
    db.setPoolRefill(guild.id, { cycleClaims: config.cycle_claims, refillOpen: false });
  }
  return { removed, claimed, adopted };
}

async function handleCommand(message, args, prefix) {
  const name = String(args[0] || "").toLowerCase();
  const normalized = String(prefix || "-").toLowerCase();
  const command = name.startsWith(normalized) ? name.slice(prefix.length) : name;
  if (!["poolsetup", "stoppool", "cleanpools", "poolstatus"].includes(command)) return false;
  if (!canConfigure(message.author.id, message.guild, message.member)) {
    await message.reply({ embeds: [embed("Owner Only", "Only the server owner can manage voice pools.")] });
    return true;
  }
  try {
    if (command === "poolsetup") {
      await start(message);
      return true;
    }
    const config = db.getPoolConfig(message.guild.id);
    if (!config) {
      await message.reply({ embeds: [embed("No Pool", "Run `-poolsetup` before using this command.")] });
      return true;
    }
    if (command === "stoppool") {
      await stopGeneration(message.guild);
      await message.reply({
        embeds: [embed("Pools Stopped", "No new pools will be created. Empty pools that are already there can still be joined. Occupied calls were left alone. Run `-poolsetup` when you want generation again.")]
      });
      return true;
    }
    if (command === "cleanpools") {
      const summary = await cleanEmpty(message.guild);
      await message.reply({
        embeds: [embed(
          "Pools Cleaned",
          [
            `Empty pools found: **${summary.found}**`,
            `Deleted: **${summary.deleted}**`,
            `Skipped: **${summary.skipped}**`,
            `Failed: **${summary.failed}**`
          ].join("\n")
        )]
      });
      return true;
    }
    const report = await status(message.guild);
    await message.reply({ embeds: [embed("Pool Status", statusText(report))] });
    return true;
  } catch (error) {
    logThrottledError(`pool-command:${message.guild.id}`, `[pool command] ${message.guild.id}`, error);
    await message.reply({ embeds: [embed("Unable to complete", "That pool command could not be completed.")] }).catch(() => null);
    return true;
  }
}

module.exports = {
  handleCommand,
  handleInteraction,
  claimJoin,
  moveFromLobby,
  reconcileGuild,
  forgetChannel,
  whenIdle,
  validateValues,
  scheduleRefill,
  requestCreates,
  stopGeneration,
  cleanEmpty,
  status,
  CLEANUP_OPTIONS,
  DEFAULTS,
  configurePace(next = {}) {
    if (Number.isInteger(next.limit) && next.limit > 0) paceConfig.limit = next.limit;
    if (Number.isInteger(next.windowMs) && next.windowMs >= 0) paceConfig.windowMs = next.windowMs;
  }
};
