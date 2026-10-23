const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const store = require("./store");
const engine = require("./engine");
const panel = require("./panel");
const { ACCENT } = require("../vouch/constants");
const { reply } = require("../vouch/ui");
const { replyUsage } = require("../usage");
const { resolveMember } = require("../vouch/resolve");
const { whenLine } = require("../systems/logs");

function commandName(args, prefix) {
  const head = String(args[0] || "").toLowerCase();
  return head.startsWith(String(prefix || "").toLowerCase()) ? head.slice(prefix.length) : head;
}

function denied(message, detail) {
  store.incident(message.guild.id, {
    severity: "info",
    action: "unauthorized",
    executorId: message.author.id,
    result: "denied",
    detail
  });
  return reply(message, "Access Denied", "Only the server owner and anti-nuke administrators can use this.");
}

function statusText(guild) {
  const config = store.get(guild.id);
  const check = engine.health(guild);
  const last = store.lastIncident(guild.id);
  const listed = store.whitelist(guild.id);
  return [
    config.active ? "Protection is on." : "Protection is not active. Run `-antinuke setup` and confirm it.",
    "",
    panel.summary(guild, config),
    "",
    `**Whitelist counts:** ${listed.filter((row) => row.kind === "user").length} users, ${listed.filter((row) => row.kind === "bot").length} bots`,
    `**Last incident:** ${last ? `${last.action} · ${last.result || last.severity} · ${whenLine(last.at)}` : "none"}`,
    `**Health:** ${check.active}${check.missing.length ? ` · missing ${check.missing.join(", ")}` : ""}`
  ].join("\n");
}

async function logs(message, page = 0) {
  const result = store.incidents(message.guild.id, page, 5);
  const pages = Math.max(1, Math.ceil(result.total / 5));
  const body = result.rows.length
    ? result.rows.map((row) => `**${row.action}** · ${row.severity}\n${row.detail || row.result || "recorded"}\n${whenLine(row.at)}`).join("\n\n")
    : "No incidents yet.";
  const owner = message.author.id;
  return message.reply({
    embeds: [new EmbedBuilder().setColor(ACCENT).setTitle("Anti-Nuke Logs").setDescription(body.slice(0, 4000)).setFooter({ text: `Page ${page + 1} / ${pages}` })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`spanter:anuke:logs:${message.guild.id}:${owner}:${page - 1}`).setLabel("Back").setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
      new ButtonBuilder().setCustomId(`spanter:anuke:logs:${message.guild.id}:${owner}:${page + 1}`).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(page + 1 >= pages)
    )]
  });
}

async function confirmAction(message, action) {
  return message.reply({
    embeds: [new EmbedBuilder().setColor(ACCENT).setTitle(action === "lock" ? "Start Lockdown" : "End Lockdown").setDescription(action === "lock"
      ? "This raises verification if that option is on and removes dangerous roles from nobody until an incident names an executor. Temporary voice channels are left alone."
      : "This restores only the verification level and roles the lockdown system changed.")],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`spanter:anuke:go:${message.guild.id}:${message.author.id}:${action}`).setLabel("Confirm").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`spanter:anuke:go:${message.guild.id}:${message.author.id}:cancel`).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    )]
  });
}

async function runTest(message) {
  const guild = message.guild;
  const config = store.get(guild.id);
  if (!config.active) return reply(message, "Not Active", "Confirm `-antinuke setup` before running a test.");
  const at = Date.now();
  const actor = `test-${message.author.id}`;
  engine.resetForTests();
  const samples = [];
  for (let index = 0; index < 3; index += 1) {
    samples.push(await engine.consider(guild, {
      id: `sim-ban-${index}-${at}`,
      action: "ban",
      module: "massBan",
      executorId: actor,
      targetId: `target-${index}`,
      at,
      detail: "Simulated ban"
    }, false));
  }
  samples.push(await engine.handleChannelDelete({
    id: `sim-empty-${at}`,
    guild,
    name: "empty",
    type: 2,
    members: { size: 0 }
  }, false));
  samples.push(await engine.handleChannelDelete({
    id: `sim-full-${at}`,
    guild,
    name: "full",
    type: 2,
    members: { size: 2 },
    permissionOverwrites: { cache: new Map() }
  }, false));
  engine.resetForTests();
  const lines = samples.map((sample, index) => `${index + 1}. ${sample.reason || sample.severity || "done"} · ${sample.punishment || sample.ignored || "recorded"}`);
  return reply(message, "Anti-Nuke Test", `Simulated only. Nobody was banned, kicked, or edited.\n\n${lines.join("\n")}`);
}

async function handleCommand(message, args, prefix) {
  const name = commandName(args, prefix);
  const sub = String(args[1] || "").toLowerCase();
  if (name === "antinuke" && sub === "vouch") return false;
  const known = ["antinuke", "antinukeconfig", "antinukestatus", "antinuketest", "antinukelogs", "antinukelockdown", "antinukeunlock", "antinukewhitelist", "antinukealloff"];
  if (!known.includes(name)) return false;
  if (!panel.canConfigure(message.member)) return denied(message, `Tried ${name}`);
  if (name === "antinukealloff") {
    store.halt(message.guild.id, message.author.id);
    return reply(message, "Anti-Nuke Off", "Every anti-nuke action is off. Server name and vanity will not be changed. Run `-antinuke setup` and confirm it when you want protection back.");
  }
  const halted = store.get(message.guild.id).policy.halted;
  if (halted && !(name === "antinuke" && sub === "setup")) {
    return reply(message, "Anti-Nuke Off", "Every anti-nuke action is off. Run `-antinuke setup` and confirm it to turn protection back on.");
  }
  if (name === "antinukeconfig") return panel.openDashboard(message);
  if (name === "antinukestatus") return reply(message, "Anti-Nuke Status", statusText(message.guild));
  if (name === "antinuketest") return runTest(message);
  if (name === "antinukelogs") return logs(message, 0);
  if (name === "antinukelockdown") return confirmAction(message, "lock");
  if (name === "antinukeunlock") return confirmAction(message, "unlock");
  if (name === "antinukewhitelist") return whitelistCommand(message, args, prefix);
  if (!sub) {
    return reply(message, "Anti-Nuke", [
      `\`${prefix}antinuke setup\``,
      `\`${prefix}antinukeconfig\``,
      `\`${prefix}antinukestatus\``,
      `\`${prefix}antinuketest\``,
      `\`${prefix}antinukelogs\``,
      `\`${prefix}antinukelockdown\``,
      `\`${prefix}antinukeunlock\``,
      `\`${prefix}antinukewhitelist add @user\``,
      `\`${prefix}antinuke snapshot\``,
      `\`${prefix}antinuke recovery\``,
      `\`${prefix}antinukealloff\``
    ].join("\n"));
  }
  if (sub === "setup") return panel.openWizard(message);
  if (sub === "snapshot") {
    const config = store.get(message.guild.id);
    const data = engine.saveSnapshot(message.guild, config);
    store.save(message.guild.id, config, message.author.id, "snapshot");
    return reply(message, "Snapshot Saved", `Saved ${data.channels.length} channels and ${data.roles.length} roles. Tokens and passwords are not stored.`);
  }
  if (sub === "recovery") {
    const rows = store.snapshots(message.guild.id, 5);
    if (!rows.length) return reply(message, "No Snapshots", "Create one with `-antinuke snapshot`.");
    return message.reply({
      embeds: [new EmbedBuilder().setColor(ACCENT).setTitle("Recovery").setDescription(`${rows.map((row) => `\`${row.id}\` · ${whenLine(row.at)}`).join("\n")}\n\nRecovery does not delete existing channels or roles. Vanity URLs cannot always be restored.`)],
      components: [new ActionRowBuilder().addComponents(rows.slice(0, 5).map((row) => new ButtonBuilder()
        .setCustomId(`spanter:anuke:recover:${message.guild.id}:${message.author.id}:${row.id}`)
        .setLabel(`Restore ${row.id}`.slice(0, 80))
        .setStyle(ButtonStyle.Secondary)))]
    });
  }
  return replyUsage(message, "antinukesetup");
}

async function whitelistCommand(message, args, prefix) {
  const action = String(args[1] || "").toLowerCase();
  if (action === "list") {
    const rows = store.whitelist(message.guild.id);
    return reply(message, "Whitelist", rows.length ? rows.map((row) => `${row.kind} · ${row.name || "unknown"} · \`${row.user_id}\``).join("\n") : "Nobody is whitelisted.");
  }
  if (action !== "add" && action !== "remove") return replyUsage(message, "antinukewhitelist");
  const member = await resolveMember(message, args[2]);
  if (!member) return replyUsage(message, "antinukewhitelist");
  if (action === "remove") {
    const removed = store.removeWhitelist(message.guild.id, member.id);
    store.save(message.guild.id, store.get(message.guild.id), message.author.id, `whitelist remove ${member.id}`);
    return reply(message, removed ? "Whitelist" : "Not Listed", removed ? `<@${member.id}> was removed.` : "That person is not whitelisted.");
  }
  store.addWhitelist(message.guild.id, member.id, member.user?.bot ? "bot" : "user", member.user?.username || member.displayName, message.author.id);
  store.save(message.guild.id, store.get(message.guild.id), message.author.id, `whitelist add ${member.id}`);
  return reply(message, "Whitelist", `<@${member.id}> is trusted. Their actions are still logged. Punishment bypass is ${store.get(message.guild.id).policy.bypassPunishment ? "on" : "off"}. Lockdown bypass is ${store.get(message.guild.id).policy.bypassLockdown ? "on" : "off"}.`);
}

async function handleInteraction(interaction) {
  const id = String(interaction.customId || "");
  if (!id.startsWith("spanter:anuke:")) return false;
  if (id.startsWith("spanter:anuke:w:") || id.startsWith("spanter:anuke:d:")) return panel.handleInteraction(interaction);
  const parts = id.split(":");
  const guildId = parts[3];
  const userId = parts[4];
  if (userId && interaction.user?.id && userId !== interaction.user.id) {
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(ACCENT).setDescription("**Not Yours**\nOnly the person who opened this can change it.")], flags: 64 }).catch(() => null);
    return true;
  }
  const guild = interaction.guild;
  const member = interaction.member;
  if (!panel.canConfigure(member)) {
    store.incident(guild.id, { severity: "info", action: "unauthorized", executorId: interaction.user.id, result: "denied", detail: "Tried an anti-nuke button." });
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(ACCENT).setDescription("**Access Denied**\nYou cannot use this.")], flags: 64 }).catch(() => null);
    return true;
  }
  if (parts[2] === "logs") {
    const page = Math.max(0, Number(parts[5]) || 0);
    const result = store.incidents(guild.id, page, 5);
    const pages = Math.max(1, Math.ceil(result.total / 5));
    const body = result.rows.length ? result.rows.map((row) => `**${row.action}** · ${row.severity}\n${row.detail || row.result || "recorded"}\n${whenLine(row.at)}`).join("\n\n") : "No incidents yet.";
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(ACCENT).setTitle("Anti-Nuke Logs").setDescription(body.slice(0, 4000)).setFooter({ text: `Page ${page + 1} / ${pages}` })],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`spanter:anuke:logs:${guildId}:${userId}:${page - 1}`).setLabel("Back").setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
        new ButtonBuilder().setCustomId(`spanter:anuke:logs:${guildId}:${userId}:${page + 1}`).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(page + 1 >= pages)
      )]
    });
    return true;
  }
  if (parts[2] === "go") {
    if (parts[5] === "cancel") {
      await interaction.update({ embeds: [new EmbedBuilder().setColor(ACCENT).setDescription("**Cancelled**")], components: [] });
      return true;
    }
    const result = parts[5] === "lock"
      ? await engine.lockdown(guild, store.get(guild.id), null, "Manual lockdown.", true)
      : await engine.unlock(guild, true);
    store.save(guild.id, store.get(guild.id), interaction.user.id, parts[5] === "lock" ? "manual lockdown" : "manual unlock");
    await interaction.update({ embeds: [new EmbedBuilder().setColor(ACCENT).setTitle("Anti-Nuke").setDescription(result.result || "Done.")], components: [] });
    return true;
  }
  if (parts[2] === "recover") {
    const recovered = await engine.recover(guild, parts[5], true);
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(ACCENT).setTitle("Recovery").setDescription(`Created: ${recovered.created.length ? recovered.created.join(", ") : "none"}\nLeft in place: ${recovered.skipped.length}\n${recovered.note}`.slice(0, 4000))],
      components: []
    });
    return true;
  }
  return panel.handleInteraction(interaction);
}

const boundClients = new WeakSet();

function bind(client) {
  if (!client || boundClients.has(client)) return;
  boundClients.add(client);
  client.on("guildAuditLogEntryCreate", (entry, guild) => {
    engine.handleAudit(guild, entry, true).catch((error) => console.error("[antinuke]", error?.message || error));
  });
  client.on("channelDelete", (channel) => {
    engine.handleChannelDelete(channel, true).catch((error) => console.error("[antinuke]", error?.message || error));
  });
  client.on("guildMemberAdd", (member) => {
    engine.handleMemberAdd(member, true).catch((error) => console.error("[antinuke]", error?.message || error));
  });
  client.on("guildUpdate", (before, after) => {
    engine.handleGuildUpdate(before, after, true).catch((error) => console.error("[antinuke]", error?.message || error));
  });
  if (process.env.NODE_TEST_CONTEXT || process.env.npm_lifecycle_event === "test") return;
  const timer = setInterval(() => {
    for (const guild of client.guilds.cache.values()) {
      engine.tickSnapshots(guild).catch((error) => console.error("[antinuke snapshot]", error?.message || error));
    }
  }, 60000);
  timer.unref?.();
}

module.exports = { handleCommand, handleInteraction, bind, engine, store, panel };
