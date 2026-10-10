const {
  ActionRowBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits
} = require("discord.js");
const { ACCENT } = require("./vouch/constants");
const { card } = require("./feedback");
const { reply } = require("./vouch/ui");
const access = require("./systems/access");
const { hasFakePermission } = require("./fake-permissions");

const PAGE_SIZE = 6;
const SCAN_PAGES = 2;
const CACHE_MS = 60_000;
const VIEWS = {
  voice: "Voice",
  timeout: "Timeouts",
  ban: "Bans"
};
const EMPTY = {
  voice: "No recent server mutes, deafens, or disconnects.",
  timeout: "No recent timeouts.",
  ban: "No recent bans or unbans."
};
const TYPES = {
  voice: [AuditLogEvent.MemberUpdate, AuditLogEvent.MemberDisconnect],
  timeout: [AuditLogEvent.MemberUpdate, AuditLogEvent.AutoModerationUserCommunicationDisabled].filter((type) => type != null),
  ban: [AuditLogEvent.MemberBanAdd, AuditLogEvent.MemberBanRemove]
};

const cache = new Map();

function canView(member) {
  return access.canUseLogs(member) || hasFakePermission(member, "view_audit_log");
}

function botCanRead(guild) {
  const permissions = guild?.members?.me?.permissions;
  if (!permissions?.has) return true;
  return permissions.has(PermissionFlagsBits.ViewAuditLog);
}

function idOf(value) {
  if (value == null || value === "") return "";
  return String(value);
}

function entriesOf(logs) {
  if (!logs?.entries) return [];
  if (typeof logs.entries.values === "function") return [...logs.entries.values()];
  if (Array.isArray(logs.entries)) return logs.entries;
  return [];
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 42);
}

function changeNew(change) {
  if (Object.prototype.hasOwnProperty.call(change, "new")) return change.new;
  return change.new_value;
}

function isOn(value) {
  return value === true || value === "true";
}

function isOff(value) {
  return value === false || value === "false" || value === null;
}

function involves(entry, userId) {
  const want = String(userId);
  const executorId = idOf(entry.executorId || entry.executor?.id);
  const targetId = idOf(entry.targetId || entry.target?.id);
  return executorId === want || targetId === want;
}

function placement(entry, userId) {
  const want = String(userId);
  const executorId = idOf(entry.executorId || entry.executor?.id);
  const targetId = idOf(entry.targetId || entry.target?.id);
  const actor = executorId === want;
  const target = targetId === want;
  if (!actor && !target) return null;
  if (actor && target) return { when: Number(entry.createdTimestamp) || 0, direction: "self", otherId: null };
  if (target) return { when: Number(entry.createdTimestamp) || 0, direction: "in", otherId: executorId || null };
  return { when: Number(entry.createdTimestamp) || 0, direction: "out", otherId: targetId || null };
}

function makeEvent(entry, place, label, extra = {}) {
  return {
    id: `${entry.id}:${label}`,
    when: place.when,
    direction: place.direction,
    otherId: place.otherId,
    label,
    reason: extra.reason !== undefined ? extra.reason : cleanText(entry.reason),
    until: extra.until || null,
    detail: extra.detail || null,
    unnamed: !!extra.unnamed
  };
}

function classify(entry, userId, view) {
  const place = placement(entry, userId);
  if (!place) return [];
  const action = entry.action;
  if (view === "ban") {
    if (action === AuditLogEvent.MemberBanAdd) return [makeEvent(entry, place, "Banned")];
    if (action === AuditLogEvent.MemberBanRemove) return [makeEvent(entry, place, "Unbanned")];
    return [];
  }
  if (view === "timeout") {
    if (action === AuditLogEvent.AutoModerationUserCommunicationDisabled) {
      const reason = cleanText(entry.reason) || cleanText(entry.extra?.autoModerationRuleName);
      return [makeEvent(entry, place, "Timed out", { reason })];
    }
    if (action !== AuditLogEvent.MemberUpdate) return [];
    const change = (entry.changes || []).find((item) => item.key === "communication_disabled_until");
    if (!change) return [];
    const next = changeNew(change);
    if (next) {
      const until = Date.parse(next);
      return [makeEvent(entry, place, "Timed out", { until: Number.isFinite(until) ? until : null })];
    }
    return [makeEvent(entry, place, "Timeout cleared")];
  }
  if (action === AuditLogEvent.MemberDisconnect) {
    const made = makeEvent(entry, place, "Disconnected");
    if (!place.otherId && place.direction !== "self") {
      const count = Number(entry.extra?.count);
      made.detail = Number.isFinite(count) && count > 0 ? `${count} member${count === 1 ? "" : "s"}` : "a member";
      made.unnamed = true;
    }
    return [made];
  }
  if (action !== AuditLogEvent.MemberUpdate) return [];
  const labels = [];
  for (const change of entry.changes || []) {
    const next = changeNew(change);
    if (change.key === "mute") labels.push(isOn(next) ? "Server muted" : isOff(next) ? "Server unmuted" : null);
    if (change.key === "deaf") labels.push(isOn(next) ? "Server deafened" : isOff(next) ? "Server undeafened" : null);
  }
  return labels.filter(Boolean).map((label) => makeEvent(entry, place, label));
}

async function safeFetch(guild, options) {
  if (typeof guild.fetchAuditLogs !== "function") return { error: true };
  try {
    const logs = await guild.fetchAuditLogs(options);
    if (!logs) return { error: true };
    return logs;
  } catch {
    return { error: true };
  }
}

async function fetchType(guild, type, userId) {
  const found = new Map();
  let attempts = 0;
  let failures = 0;
  const collect = (logs) => {
    attempts += 1;
    if (!logs || logs.error) {
      failures += 1;
      return [];
    }
    const entries = entriesOf(logs);
    for (const entry of entries) {
      if (entry?.id && involves(entry, userId)) found.set(String(entry.id), entry);
    }
    return entries;
  };
  collect(await safeFetch(guild, { type, limit: 100, user: userId }));
  let before;
  for (let page = 0; page < SCAN_PAGES; page += 1) {
    const entries = collect(await safeFetch(guild, { type, limit: 100, before }));
    if (entries.length < 100) break;
    before = entries[entries.length - 1]?.id;
    if (!before) break;
  }
  return { entries: [...found.values()], failed: attempts > 0 && failures === attempts };
}

function remember(key, value) {
  cache.set(key, value);
  if (cache.size <= 80) return;
  const oldest = cache.keys().next().value;
  cache.delete(oldest);
}

async function loadView(guild, userId, view) {
  const key = `${guild.id}:${userId}:${view}`;
  const saved = cache.get(key);
  if (saved && Date.now() - saved.at < CACHE_MS) return saved;
  const batches = await Promise.all(TYPES[view].map((type) => fetchType(guild, type, userId)));
  const failed = batches.length > 0 && batches.every((batch) => batch.failed);
  const events = [];
  for (const batch of batches) {
    for (const entry of batch.entries) events.push(...classify(entry, userId, view));
  }
  events.sort((left, right) => right.when - left.when || String(left.id).localeCompare(String(right.id)));
  const result = { at: Date.now(), events, failed };
  if (!failed) remember(key, result);
  return result;
}

function formatLine(event) {
  const when = event.when > 0 ? `<t:${Math.floor(event.when / 1000)}:R>` : "Unknown time";
  const parts = [when, event.label];
  if (event.direction === "self") parts.push("themselves");
  else if (event.otherId) parts.push(`<@${event.otherId}>`);
  else if (event.detail) parts.push(event.detail);
  else if (event.direction === "in") parts.push("unknown");
  if (event.until) parts.push(`until <t:${Math.floor(event.until / 1000)}:R>`);
  if (event.reason) parts.push(event.reason);
  return parts.join(" · ");
}

function section(name, rows, page) {
  const slice = rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  if (!rows.length && page === 0) return { title: `**${name}** · none`, lines: [] };
  if (!slice.length) return null;
  const count = rows.length > PAGE_SIZE ? `${slice.length} of ${rows.length}` : String(rows.length);
  return { title: `**${name}** · ${count}`, lines: slice.map(formatLine) };
}

function pageCount(events) {
  const incoming = events.filter((event) => event.direction === "in").length;
  const outgoing = events.filter((event) => event.direction !== "in").length;
  return Math.max(1, Math.ceil(incoming / PAGE_SIZE), Math.ceil(outgoing / PAGE_SIZE));
}

function describe(userId, view, events, page) {
  const pages = pageCount(events);
  const current = Math.min(Math.max(page, 0), pages - 1);
  const incoming = events.filter((event) => event.direction === "in");
  const outgoing = events.filter((event) => event.direction !== "in");
  const lines = [`<@${userId}>`, `**${VIEWS[view]}** · ${events.length}`];
  if (!events.length) {
    lines.push("", EMPTY[view]);
  } else {
    for (const block of [section("Done to them", incoming, current), section("They did", outgoing, current)]) {
      if (!block) continue;
      lines.push("", block.title, ...block.lines);
    }
  }
  return { description: lines.join("\n").slice(0, 4000), page: current, pages };
}

function buttons(view, targetId, invokerId, page, pages) {
  const row = [
    ["voice", "Voice"],
    ["timeout", "Timeouts"],
    ["ban", "Bans"]
  ].map(([key, label]) => new ButtonBuilder()
    .setCustomId(`spanter:auditlog:${key}:${targetId}:${invokerId}:0`)
    .setLabel(label)
    .setStyle(key === view ? ButtonStyle.Primary : ButtonStyle.Secondary));
  if (pages > 1) {
    row.push(
      new ButtonBuilder()
        .setCustomId(`spanter:auditlog:${view}:${targetId}:${invokerId}:${page - 1}`)
        .setLabel("Back")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId(`spanter:auditlog:${view}:${targetId}:${invokerId}:${page + 1}`)
        .setLabel("Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= pages - 1)
    );
  }
  return [new ActionRowBuilder().addComponents(row)];
}

function payload(userId, invokerId, view, events, page) {
  const body = describe(userId, view, events, page);
  const footer = ["Newest first"];
  if (body.pages > 1) footer.unshift(`Page ${body.page + 1}/${body.pages}`);
  if (events.some((event) => event.unnamed)) footer.push("Discord did not name some disconnected members");
  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle("Audit Log")
    .setDescription(body.description)
    .setFooter({ text: footer.join(" · ").slice(0, 2000) });
  return {
    embeds: [embed],
    components: buttons(view, userId, invokerId, body.page, body.pages),
    allowedMentions: { parse: [] }
  };
}

function parseId(customId) {
  const parts = String(customId || "").split(":");
  if (parts[0] !== "spanter" || parts[1] !== "auditlog" || !VIEWS[parts[2]]) return null;
  if (!/^\d{17,20}$/.test(parts[3] || "") || !/^\d{17,20}$/.test(parts[4] || "")) return null;
  const page = Number(parts[5] || 0);
  return { view: parts[2], targetId: parts[3], invokerId: parts[4], page: Number.isFinite(page) ? page : 0 };
}

async function resolveUser(message, argument) {
  const id = String(argument || "").replace(/[<@!>]/g, "");
  if (/^\d{17,20}$/.test(id)) {
    const member = message.guild.members?.cache?.get(id) || await message.guild.members?.fetch?.(id).catch(() => null);
    if (member?.user) return member.user;
    const user = await message.client?.users?.fetch?.(id).catch(() => null);
    return user || { id };
  }
  const mentioned = message.mentions?.users?.first?.() || message.mentions?.members?.first?.()?.user;
  if (mentioned?.id) return mentioned;
  const name = String(argument || "").trim().toLowerCase();
  if (!name) return null;
  const member = [...(message.guild.members?.cache?.values?.() || [])].find((item) => (
    item.user?.username?.toLowerCase() === name || item.displayName?.toLowerCase() === name
  ));
  return member?.user || null;
}

async function show(message, argument) {
  if (!canView(message.member)) {
    return reply(message, "Access Denied", "Gods and people with view audit log can use this.");
  }
  const user = await resolveUser(message, argument);
  if (!user?.id) return reply(message, "Missing User", "Mention a user or provide their ID.\n`-auditlog @user`");
  if (!botCanRead(message.guild)) {
    return reply(message, "Bot Missing Permission", "I need View Audit Log to read this.");
  }
  const loaded = await loadView(message.guild, user.id, "voice");
  if (loaded.failed) {
    return reply(message, "Audit Log Unavailable", "I couldn't read the audit log. I need View Audit Log.");
  }
  return message.reply(payload(user.id, message.author.id, "voice", loaded.events, 0));
}

async function handleCommand(message, name, args) {
  if (name !== "auditlog") return false;
  await show(message, args[1]);
  return true;
}

async function ephemeral(interaction, title, description) {
  return interaction.reply({
    embeds: [card(title, description, { guild: interaction.guild })],
    flags: MessageFlags.Ephemeral
  }).catch(() => null);
}

async function handleButton(interaction) {
  const parsed = parseId(interaction.customId);
  if (!parsed) return false;
  if (interaction.user?.id !== parsed.invokerId) {
    await ephemeral(interaction, "Not Yours", "Only the person who ran this can use these buttons.");
    return true;
  }
  if (!canView(interaction.member)) {
    await ephemeral(interaction, "Access Denied", "Gods and people with view audit log can use this.");
    return true;
  }
  if (!botCanRead(interaction.guild)) {
    await ephemeral(interaction, "Bot Missing Permission", "I need View Audit Log to read this.");
    return true;
  }
  if (typeof interaction.deferUpdate === "function" && !interaction.deferred) {
    await interaction.deferUpdate().catch(() => null);
  }
  const loaded = await loadView(interaction.guild, parsed.targetId, parsed.view);
  const body = loaded.failed
    ? {
      embeds: [new EmbedBuilder().setColor(ACCENT).setTitle("Audit Log").setDescription(`<@${parsed.targetId}>\n**${VIEWS[parsed.view]}**\n\nI couldn't read the audit log. I need View Audit Log.`)],
      components: buttons(parsed.view, parsed.targetId, parsed.invokerId, 0, 1),
      allowedMentions: { parse: [] }
    }
    : payload(parsed.targetId, parsed.invokerId, parsed.view, loaded.events, parsed.page);
  if (interaction.deferred || interaction.replied) await interaction.editReply(body);
  else if (typeof interaction.update === "function") await interaction.update(body);
  else await interaction.reply(body);
  return true;
}

module.exports = { handleCommand, handleButton };
