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
  TextInputStyle,
  UserSelectMenuBuilder
} = require("discord.js");
const store = require("./store");
const engine = require("./engine");
const { ACCENT } = require("../vouch/constants");
const { reply } = require("../vouch/ui");
const access = require("../systems/access");

const sessions = new Map();
const STEP_COUNT = 9;

function keyOf(guildId, userId) {
  return `${guildId}:${userId}`;
}

function canConfigure(member) {
  if (!member?.guild) return false;
  if (access.isServerOwner(member)) return true;
  if (access.isAntinukeAdmin(member)) return true;
  const config = store.get(member.guild.id);
  const row = store.whitelistOne(member.guild.id, member.id);
  return !!(row && config.policy.modifySettings);
}

function sessionFor(guildId, userId) {
  const session = sessions.get(keyOf(guildId, userId));
  if (!session) return null;
  if (Date.now() - session.at > 10 * 60 * 1000) {
    sessions.delete(keyOf(guildId, userId));
    return null;
  }
  return session;
}

function touch(session) {
  session.at = Date.now();
  sessions.set(keyOf(session.guildId, session.userId), session);
}

function deny(message) {
  const config = store.get(message.guild.id);
  store.incident(message.guild.id, {
    severity: "info",
    action: "unauthorized",
    executorId: message.author.id,
    result: "denied",
    detail: "Tried to open anti-nuke controls without permission."
  });
  return reply(message, "Access Denied", "Only the server owner and anti-nuke administrators can change this. A trusted account can do it only when settings permission is explicitly on.");
}

function id(mode, guildId, userId, action) {
  return `spanter:anuke:${mode}:${guildId}:${userId}:${action}`;
}

function button(label, customId, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
}

function nav(mode, guildId, userId, { back = true, next = true, skip = false, cancel = true, confirm = false }) {
  const row = [];
  if (back) row.push(button("Back", id(mode, guildId, userId, "back")));
  if (next) row.push(button("Next", id(mode, guildId, userId, "next"), ButtonStyle.Primary));
  if (skip) row.push(button("Skip", id(mode, guildId, userId, "skip")));
  if (confirm) row.push(button("Confirm & Activate", id(mode, guildId, userId, "confirm"), ButtonStyle.Success));
  if (cancel) row.push(button("Cancel", id(mode, guildId, userId, "cancel"), ButtonStyle.Danger));
  return new ActionRowBuilder().addComponents(row.slice(0, 5));
}

function embed(title, description) {
  return new EmbedBuilder().setColor(ACCENT).setTitle(title).setDescription(String(description || "").slice(0, 4000));
}

function moduleText(config) {
  return store.MODULES.map(([key, label]) => `${config.modules[key] ? "on" : "off"} · ${label}`).join("\n");
}

function thresholdText(config) {
  return store.THRESHOLD_FIELDS.map(([key, label]) => {
    const rule = config.thresholds[key];
    return `${label}: ${rule.count} within ${rule.seconds}s`;
  }).join("\n");
}

function summary(guild, config, listed = null) {
  const users = listed || store.whitelist(guild.id);
  const check = engine.health(guild);
  return [
    "**Modules**",
    moduleText(config),
    "",
    "**Thresholds**",
    thresholdText(config),
    "",
    `**Whitelist:** ${users.length} entries`,
    users.slice(0, 10).map((row) => `${row.kind} · ${row.name || "unknown"} · ${row.user_id}`).join("\n") || "none",
    "",
    "**Lockdown**",
    store.LOCK_FIELDS.map(([key, label]) => `${config.lockdown[key] ? "on" : "off"} · ${label}`).join("\n"),
    "",
    "**Bypass**",
    store.POLICY_FIELDS.map(([key, label]) => `${config.policy[key] ? "on" : "off"} · ${label}`).join("\n"),
    "",
    `**Log:** ${config.logChannelId ? `<#${config.logChannelId}>` : "not set"}`,
    `**Snapshots:** every ${config.snapshotMinutes} minutes, keep ${config.snapshotKeep}`,
    `**Health:** ${check.active}${check.missing.length ? ` · missing ${check.missing.join(", ")}` : ""}`,
    "",
    "Empty voice channels may be deleted. A voice channel with people in it is an instant kick.",
    "Snapshots cannot restore messages or every setting. Vanity URLs cannot always be restored.",
    "A compromised trusted account can bypass the punishments you explicitly enabled.",
    "Lockdown does not lock temporary voice channels or disconnect members."
  ].join("\n");
}

function renderWizard(guild, session) {
  const config = session.draft;
  const step = session.step;
  const guildId = session.guildId;
  const userId = session.userId;
  const components = [];
  let body = "";
  let title = "Anti-Nuke Setup";
  if (step === 0) {
    title = "Anti-Nuke · Modules";
    body = "Every module starts on. Turn individual modules off only if you mean to.\n\n" + moduleText(config);
    components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(id("w", guildId, userId, "modules"))
      .setPlaceholder("Enabled modules")
      .setMinValues(0)
      .setMaxValues(store.MODULES.length)
      .addOptions(store.MODULES.map(([key, label]) => ({ label, value: key, default: !!config.modules[key] })))));
  } else if (step === 1 || step === 2 || step === 3) {
    const slice = step === 1 ? [0, 5] : step === 2 ? [5, 9] : [9, 13];
    const fields = store.THRESHOLD_FIELDS.slice(slice[0], slice[1]);
    const selected = fields.some(([key]) => key === session.field) ? session.field : fields[0][0];
    session.field = selected;
    const rule = config.thresholds[selected];
    title = step === 1 ? "Anti-Nuke · Bans and kicks" : step === 2 ? "Anti-Nuke · Channels and roles" : "Anti-Nuke · Webhooks and raids";
    body = `${thresholdText(config)}\n\nEditing **${fields.find(([key]) => key === selected)[1]}**: ${rule.count} within ${rule.seconds}s\nBans and kicks are counted separately and once together. Joining members are never mass-banned.`;
    components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(id("w", guildId, userId, "field"))
      .setPlaceholder("Threshold")
      .addOptions(fields.map(([key, label]) => ({ label, value: key, default: key === selected })))));
    components.push(new ActionRowBuilder().addComponents(
      button("Count -", id("w", guildId, userId, "count-")),
      button("Count +", id("w", guildId, userId, "count+")),
      button("Seconds -", id("w", guildId, userId, "seconds-")),
      button("Seconds +", id("w", guildId, userId, "seconds+"))
    ));
  } else if (step === 4) {
    title = "Anti-Nuke · Whitelist";
    const rows = session.draftList || [];
    body = [
      "Trusted accounts are not added automatically.",
      "A compromised trusted account can bypass the punishments you turn on.",
      "The server owner cannot be locked out.",
      "",
      rows.map((row) => `${row.kind} · ${row.name || "unknown"} · \`${row.user_id}\``).join("\n") || "Nobody is whitelisted.",
      "",
      store.POLICY_FIELDS.map(([key, label]) => `${config.policy[key] ? "on" : "off"} · ${label}`).join("\n")
    ].join("\n");
    components.push(new ActionRowBuilder().addComponents(new UserSelectMenuBuilder()
      .setCustomId(id("w", guildId, userId, "user"))
      .setPlaceholder("Select a user or bot")
      .setMinValues(1)
      .setMaxValues(1)));
    if (rows.length) {
      components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId(id("w", guildId, userId, "unwhite"))
        .setPlaceholder("Remove one entry")
        .addOptions(rows.slice(0, 25).map((row) => ({ label: `${row.kind} ${row.name || row.user_id}`.slice(0, 100), value: row.user_id })))));
    }
    components.push(new ActionRowBuilder().addComponents(
      button("Manual ID", id("w", guildId, userId, "manual")),
      button("Clear", id("w", guildId, userId, "clear")),
      button("Bypass punishment", id("w", guildId, userId, "policy:bypassPunishment")),
      button("Bypass lockdown", id("w", guildId, userId, "policy:bypassLockdown"))
    ));
    components.push(new ActionRowBuilder().addComponents(
      button("Dangerous changes", id("w", guildId, userId, "policy:dangerousChanges")),
      button("Bot destructive", id("w", guildId, userId, "policy:botsDestructive")),
      button("Edit settings", id("w", guildId, userId, "policy:modifySettings"))
    ));
  } else if (step === 5) {
    title = "Anti-Nuke · Lockdown";
    body = "These are the only lockdown actions. Temporary voice channels are not locked and members are not disconnected.\n\n" + store.LOCK_FIELDS.map(([key, label]) => `${config.lockdown[key] ? "on" : "off"} · ${label}`).join("\n");
    components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(id("w", guildId, userId, "lock"))
      .setMinValues(0)
      .setMaxValues(store.LOCK_FIELDS.length)
      .setPlaceholder("Lockdown actions")
      .addOptions(store.LOCK_FIELDS.map(([key, label]) => ({ label: label.slice(0, 100), value: key, default: !!config.lockdown[key] })))));
  } else if (step === 6) {
    title = "Anti-Nuke · Security log";
    body = `Current log: ${config.logChannelId ? `<#${config.logChannelId}>` : "not set"}\nIncidents include the action, people, counts, whitelist, lockdown, result, and time. Regular members do not see this log.`;
    components.push(new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder()
      .setCustomId(id("w", guildId, userId, "log"))
      .setPlaceholder("Security log channel")
      .addChannelTypes(ChannelType.GuildText)
      .setMinValues(1)
      .setMaxValues(1)));
  } else if (step === 7) {
    title = "Anti-Nuke · Snapshots";
    body = `A snapshot is taken every ${config.snapshotMinutes} minutes and ${config.snapshotKeep} are kept.\nSnapshots store channels, roles, and overwrites. They do not store tokens or passwords.\nRecovery will not delete existing channels or roles. Vanity URLs cannot always be restored.`;
    components.push(new ActionRowBuilder().addComponents(
      button("Interval -", id("w", guildId, userId, "interval-")),
      button("Interval +", id("w", guildId, userId, "interval+")),
      button("Keep -", id("w", guildId, userId, "keep-")),
      button("Keep +", id("w", guildId, userId, "keep+"))
    ));
  } else {
    title = "Anti-Nuke · Review";
    body = `${summary(guild, config, session.draftList)}\n\nNothing is saved until you confirm.`;
  }
  const optional = step === 4 || step === 6;
  components.push(nav("w", guildId, userId, { next: step < 8, skip: optional, confirm: step === 8 }));
  return { embeds: [embed(title, body)], components: components.slice(0, 5) };
}

function renderDashboard(guild, session) {
  const config = store.get(guild.id);
  const section = session.section || "view";
  const guildId = session.guildId;
  const userId = session.userId;
  const options = [
    ["view", "View configuration"],
    ["modules", "Modules"],
    ["bans", "Ban and kick thresholds"],
    ["channels", "Channel and role thresholds"],
    ["permissions", "Permission escalation"],
    ["vanity", "Vanity and server settings"],
    ["webhooks", "Webhooks"],
    ["raid", "Anti-raid"],
    ["users", "Whitelisted users"],
    ["bots", "Whitelisted bots"],
    ["bypass", "Whitelist bypass"],
    ["lockdown", "Lockdown actions"],
    ["log", "Security log"],
    ["snapshots", "Snapshots"],
    ["health", "Health"],
    ["reset", "Reset to defaults"]
  ];
  const menu = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(id("d", guildId, userId, "section"))
    .setPlaceholder("Configuration section")
    .addOptions(options.map(([value, label]) => ({ label, value, default: value === section }))));
  let body = summary(guild, config);
  const extra = [];
  if (section === "modules") {
    body = moduleText(config);
    extra.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(id("d", guildId, userId, "modules"))
      .setMinValues(0)
      .setMaxValues(store.MODULES.length)
      .setPlaceholder("Enabled modules")
      .addOptions(store.MODULES.map(([key, label]) => ({ label, value: key, default: !!config.modules[key] })))));
  } else if (section === "bans" || section === "channels" || section === "webhooks" || section === "raid") {
    const slice = section === "bans" ? [0, 5] : section === "channels" ? [5, 9] : section === "webhooks" ? [9, 11] : [11, 13];
    const fields = store.THRESHOLD_FIELDS.slice(slice[0], slice[1]);
    session.field = fields.some(([key]) => key === session.field) ? session.field : fields[0][0];
    body = thresholdText(config);
    extra.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(id("d", guildId, userId, "field"))
      .setPlaceholder("Threshold")
      .addOptions(fields.map(([key, label]) => ({ label, value: key, default: key === session.field })))));
    extra.push(new ActionRowBuilder().addComponents(
      button("Count -", id("d", guildId, userId, "count-")),
      button("Count +", id("d", guildId, userId, "count+")),
      button("Seconds -", id("d", guildId, userId, "seconds-")),
      button("Seconds +", id("d", guildId, userId, "seconds+"))
    ));
  } else if (section === "permissions" || section === "vanity") {
    body = section === "permissions"
      ? "Administrator grants are an immediate emergency. Other dangerous grants alert and follow the lockdown policy.\nOccupied voice deletion is always an instant kick and is not a whitelist bypass."
      : "Vanity and server name changes are restored when Discord allows it. Vanity cannot always be restored.";
  } else if (section === "users" || section === "bots") {
    const kind = section === "bots" ? "bot" : "user";
    const rows = store.whitelist(guild.id).filter((row) => row.kind === kind);
    body = rows.map((row) => `${row.name || "unknown"} · \`${row.user_id}\``).join("\n") || `No trusted ${kind}s.`;
    extra.push(new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(id("d", guildId, userId, "user")).setPlaceholder(`Add a ${kind}`).setMinValues(1).setMaxValues(1)));
    if (rows.length) {
      extra.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId(id("d", guildId, userId, "unwhite"))
        .setPlaceholder("Remove one")
        .addOptions(rows.slice(0, 25).map((row) => ({ label: (row.name || row.user_id).slice(0, 100), value: row.user_id })))));
    }
  } else if (section === "bypass") {
    body = store.POLICY_FIELDS.map(([key, label]) => `${config.policy[key] ? "on" : "off"} · ${label}`).join("\n");
    extra.push(new ActionRowBuilder().addComponents(store.POLICY_FIELDS.slice(0, 4).map(([key, label]) => button(label.slice(0, 80), id("d", guildId, userId, `policy:${key}`)))));
    extra.push(new ActionRowBuilder().addComponents(button("Edit settings", id("d", guildId, userId, "policy:modifySettings"))));
  } else if (section === "lockdown") {
    body = store.LOCK_FIELDS.map(([key, label]) => `${config.lockdown[key] ? "on" : "off"} · ${label}`).join("\n");
    extra.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(id("d", guildId, userId, "lock"))
      .setMinValues(0)
      .setMaxValues(store.LOCK_FIELDS.length)
      .addOptions(store.LOCK_FIELDS.map(([key, label]) => ({ label: label.slice(0, 100), value: key, default: !!config.lockdown[key] })))));
  } else if (section === "log") {
    body = config.logChannelId ? `Logging to <#${config.logChannelId}>.` : "No security log channel.";
    extra.push(new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(id("d", guildId, userId, "log")).addChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1)));
  } else if (section === "snapshots") {
    body = `Every ${config.snapshotMinutes} minutes, keep ${config.snapshotKeep}.`;
    extra.push(new ActionRowBuilder().addComponents(
      button("Interval -", id("d", guildId, userId, "interval-")),
      button("Interval +", id("d", guildId, userId, "interval+")),
      button("Keep -", id("d", guildId, userId, "keep-")),
      button("Keep +", id("d", guildId, userId, "keep+"))
    ));
  } else if (section === "health") {
    const check = engine.health(guild);
    body = check.missing.length ? `Degraded. Missing: ${check.missing.join(", ")}` : "Ready. The bot has the permissions this system uses.";
  } else if (section === "reset") {
    body = session.pending === "reset"
      ? "Confirming will turn every module back on and restore the default thresholds. The whitelist is kept until you clear it."
      : "Resetting restores safe defaults. You will be asked to confirm.";
    extra.push(new ActionRowBuilder().addComponents(button(session.pending === "reset" ? "Confirm reset" : "Reset", id("d", guildId, userId, "reset"), ButtonStyle.Danger)));
  }
  return { embeds: [embed("Anti-Nuke Config", body)], components: [menu, ...extra].slice(0, 5) };
}

function adjust(config, session, action) {
  const rule = config.thresholds[session.field] || config.thresholds.banWarning;
  if (!session.field) session.field = "banWarning";
  const current = config.thresholds[session.field];
  if (action === "count-") store.setThreshold(config, session.field, current.count - 1, current.seconds);
  if (action === "count+") store.setThreshold(config, session.field, current.count + 1, current.seconds);
  if (action === "seconds-") store.setThreshold(config, session.field, current.count, current.seconds - 1);
  if (action === "seconds+") store.setThreshold(config, session.field, current.count, current.seconds + 1);
  if (action === "interval-") config.snapshotMinutes = store.clamp(config.snapshotMinutes - 15, 5, 1440, 60);
  if (action === "interval+") config.snapshotMinutes = store.clamp(config.snapshotMinutes + 15, 5, 1440, 60);
  if (action === "keep-") config.snapshotKeep = store.clamp(config.snapshotKeep - 1, 1, 30, 5);
  if (action === "keep+") config.snapshotKeep = store.clamp(config.snapshotKeep + 1, 1, 30, 5);
  return rule;
}

async function openWizard(message) {
  if (!canConfigure(message.member)) return deny(message);
  const session = {
    mode: "w",
    step: 0,
    field: "banWarning",
    draft: store.get(message.guild.id),
    guildId: message.guild.id,
    userId: message.author.id,
    at: Date.now(),
    pending: null
  };
  session.draft.active = 0;
  session.draftList = store.whitelist(message.guild.id).map((row) => ({ ...row }));
  touch(session);
  return message.reply(renderWizard(message.guild, session));
}

async function openDashboard(message) {
  if (!canConfigure(message.member)) return deny(message);
  const session = {
    mode: "d",
    section: "view",
    field: "banWarning",
    guildId: message.guild.id,
    userId: message.author.id,
    at: Date.now(),
    pending: null
  };
  touch(session);
  return message.reply(renderDashboard(message.guild, session));
}

function parse(customId) {
  const parts = String(customId || "").split(":");
  if (parts[0] !== "spanter" || parts[1] !== "anuke") return null;
  return { mode: parts[2], guildId: parts[3], userId: parts[4], action: parts.slice(5).join(":") };
}

async function handleInteraction(interaction) {
  const parsed = parse(interaction.customId);
  if (!parsed) return false;
  if (parsed.userId && interaction.user?.id && parsed.userId !== interaction.user.id) {
    await interaction.reply({ embeds: [embed("Not Yours", "Only the person who opened this can change it.")], flags: 64 }).catch(() => null);
    return true;
  }
  const guild = interaction.guild || interaction.client?.guilds?.cache?.get(parsed.guildId);
  if (!guild) {
    await interaction.reply({ embeds: [embed("Unavailable", "Open this again from the server.")], flags: 64 }).catch(() => null);
    return true;
  }
  const member = interaction.member || guild.members?.cache?.get?.(interaction.user.id);
  if (!canConfigure(member)) {
    store.incident(guild.id, { severity: "info", action: "unauthorized", executorId: interaction.user.id, result: "denied", detail: "Tried to use anti-nuke controls." });
    await interaction.reply({ embeds: [embed("Access Denied", "You cannot change anti-nuke settings.")], flags: 64 }).catch(() => null);
    return true;
  }
  const session = sessionFor(parsed.guildId, parsed.userId);
  if (!session) {
    await interaction.reply({ embeds: [embed("Expired", "Open the setup or config again.")], flags: 64 }).catch(() => null);
    return true;
  }
  try {
    if (interaction.isModalSubmit?.()) {
      const entered = interaction.fields.getTextInputValue("id").replace(/\D/g, "");
      if (entered.length < 17) {
        await interaction.reply({ embeds: [embed("Invalid ID", "Enter a Discord user or bot ID.")], flags: 64 });
        return true;
      }
      const session = sessionFor(parsed.guildId, parsed.userId);
      if (session?.mode === "w") {
        stageEntry(session, entered, "user", "manual id", interaction.user.id);
        touch(session);
        await interaction.reply({ embeds: [embed("Whitelist", `Added \`${entered}\`. It is saved when you confirm.`)], flags: 64 });
        return true;
      }
      store.addWhitelist(guild.id, entered, "user", "manual id", interaction.user.id);
      store.save(guild.id, store.get(guild.id), interaction.user.id, `whitelist add ${entered}`);
      await interaction.reply({ embeds: [embed("Whitelist", `Added \`${entered}\`.`)], flags: 64 });
      return true;
    }
    await apply(interaction, guild, session, parsed.action);
  } catch (error) {
    console.error("[antinuke]", error?.code || error?.message || error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ embeds: [embed("Unavailable", "That could not be completed.")], flags: 64 }).catch(() => null);
    }
  }
  return true;
}

async function apply(interaction, guild, session, action) {
  const values = interaction.values || [];
  if (action === "cancel") {
    sessions.delete(keyOf(session.guildId, session.userId));
    await interaction.update({ embeds: [embed("Cancelled", "Nothing new was activated.")], components: [] });
    return;
  }
  if (session.mode === "w") {
    const config = session.draft;
    if (action === "back") session.step = Math.max(0, session.step - 1);
    if (action === "next" || action === "skip") session.step = Math.min(STEP_COUNT - 1, session.step + 1);
    if (action === "modules") {
      for (const [key] of store.MODULES) config.modules[key] = values.includes(key);
    }
    if (action === "field" && values[0]) session.field = values[0];
    if (action === "lock") {
      for (const [key] of store.LOCK_FIELDS) config.lockdown[key] = values.includes(key);
    }
    if (action.startsWith("policy:")) config.policy[action.slice(7)] = !config.policy[action.slice(7)];
    if (action === "user") await stageSelected(session, interaction, values[0]);
    if (action === "unwhite" && values[0]) session.draftList = (session.draftList || []).filter((row) => row.user_id !== String(values[0]));
    if (action === "clear") {
      if (session.pending !== "clear") session.pending = "clear";
      else {
        session.draftList = [];
        session.pending = null;
      }
    }
    if (action === "manual") {
      const modal = new ModalBuilder().setCustomId(id("w", session.guildId, session.userId, "modal")).setTitle("Whitelist ID").addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("id").setLabel("User or bot ID").setStyle(TextInputStyle.Short).setRequired(true))
      );
      await interaction.showModal(modal);
      return;
    }
    if (action === "log" && interaction.channels) {
      config.logChannelId = interaction.channels.first?.()?.id || values[0] || null;
    }
    adjust(config, session, action);
    if (action === "confirm" && session.step === 8) {
      config.active = 1;
      config.policy.halted = false;
      store.clearWhitelist(guild.id);
      for (const row of session.draftList || []) store.addWhitelist(guild.id, row.user_id, row.kind, row.name, row.added_by);
      store.save(guild.id, config, interaction.user.id, "activate");
      const check = engine.health(guild);
      if (config.modules.snapshots) engine.saveSnapshot(guild, config);
      sessions.delete(keyOf(session.guildId, session.userId));
      const state = check.missing.length ? `Degraded. Missing ${check.missing.join(", ")}.` : "Ready.";
      await interaction.update({
        embeds: [embed("Anti-Nuke Active", `${state}\n\n${summary(guild, store.get(guild.id))}`)],
        components: []
      });
      return;
    }
    touch(session);
    await interaction.update(renderWizard(guild, session));
    return;
  }
  const config = store.get(guild.id);
  let setting = action;
  if (action === "section" && values[0]) session.section = values[0];
  if (action === "modules") {
    const turningOff = store.MODULES.some(([key]) => config.modules[key] && !values.includes(key) && ["massBan", "massKick", "channelDelete", "permissions", "lockdown"].includes(key));
    if (turningOff && session.pending !== "modules") {
      session.pending = "modules";
      session.pendingValues = values;
      touch(session);
      await interaction.update({ embeds: [embed("Confirm", "This turns off a critical module. Press the module menu again to confirm.")], components: renderDashboard(guild, session).components });
      return;
    }
    for (const [key] of store.MODULES) config.modules[key] = values.includes(key);
    session.pending = null;
    setting = "modules";
  }
  if (action === "field" && values[0]) session.field = values[0];
  if (action === "lock") {
    for (const [key] of store.LOCK_FIELDS) config.lockdown[key] = values.includes(key);
    setting = "lockdown";
  }
  if (action.startsWith("policy:")) {
    config.policy[action.slice(7)] = !config.policy[action.slice(7)];
    setting = action;
  }
  if (action === "user") {
    const kind = session.section === "bots" ? "bot" : "user";
    await addSelected(guild, interaction, values[0], interaction.user.id, kind);
    setting = "whitelist";
  }
  if (action === "unwhite" && values[0]) {
    store.removeWhitelist(guild.id, values[0]);
    setting = "whitelist remove";
  }
  if (action === "log") config.logChannelId = interaction.channels?.first?.()?.id || values[0] || config.logChannelId;
  adjust(config, session, action);
  if (action === "reset") {
    if (session.pending !== "reset") session.pending = "reset";
    else {
      const fresh = store.defaults();
      fresh.active = 1;
      fresh.logChannelId = config.logChannelId;
      store.save(guild.id, fresh, interaction.user.id, "reset");
      session.pending = null;
    }
  } else if (action !== "section" && action !== "field") {
    store.save(guild.id, config, interaction.user.id, setting);
  }
  touch(session);
  await interaction.update(renderDashboard(guild, session));
}

function stageEntry(session, userId, kind, name, actorId) {
  session.draftList = (session.draftList || []).filter((row) => row.user_id !== String(userId));
  session.draftList.push({
    user_id: String(userId),
    kind: kind === "bot" ? "bot" : "user",
    name: name || null,
    added_by: actorId ? String(actorId) : null
  });
}

async function stageSelected(session, interaction, userId) {
  if (!userId) return;
  const user = interaction.users?.get?.(userId) || await interaction.client?.users?.fetch?.(userId).catch(() => null);
  stageEntry(session, userId, user?.bot ? "bot" : "user", user?.username || user?.tag || null, interaction.user.id);
}

async function addSelected(guild, interaction, userId, actorId, forcedKind) {
  if (!userId) return;
  const user = interaction.users?.get?.(userId) || await interaction.client.users.fetch(userId).catch(() => null);
  const kind = forcedKind || (user?.bot ? "bot" : "user");
  store.addWhitelist(guild.id, userId, kind, user?.username || user?.tag || null, actorId);
}

module.exports = {
  canConfigure,
  openWizard,
  openDashboard,
  handleInteraction,
  summary,
  sessionFor
};
