const { EmbedBuilder } = require("discord.js");
const store = require("./store");
const systemStore = require("../systems/store");
const { ANTINUKE_LOG } = require("../systems/access");
const { ACCENT } = require("./constants");
const { discordTime, mentionUser } = require("./util");
const { logThrottledError } = require("../log-throttle");

const LABELS = {
  vouch_give: "Vouch given",
  vouch_take: "Vouch removed",
  vouch_failed: "Vouch failed",
  giver_add: "Giver added",
  giver_remove: "Giver removed",
  admin_add: "Vouch admin added",
  admin_remove: "Vouch admin removed",
  limit_set: "Vouch allowance changed",
  limit_reset: "Vouch allowance reset",
  unauthorized_role_add: "Unauthorized role addition",
  unauthorized_role_remove: "Unauthorized role removal",
  role_restore: "Role restored",
  stripstaff: "STRIPSTAFF",
  limited_role_violation: "Limited role violation",
  blacklist_add: "Blacklist added",
  blacklist_remove: "Blacklist removed",
  blacklist_role: "Blacklisted vouch role removed",
  voice_rank_reversed: "Voice rank role reversed",
  voice_rank_restored: "Voice rank role restored",
  staff_add: "Staff rank added",
  staff_remove: "Staff rank removed",
  antinuke_admin_add: "Anti-Nuke admin added",
  antinuke_admin_remove: "Anti-Nuke admin removed",
  vouch_strip: "Vouch strip",
  vouch_wipe: "Active vouches wiped",
  config_change: "Configuration changed",
  alias_add: "Alias added",
  alias_remove: "Alias removed",
  force_nick: "Forced nickname",
  force_nick_clear: "Forced nickname removed",
  force_role_strip: "Forced role strip",
  force_role_strip_clear: "Forced role strip cleared",
  role_strip: "Role stripped",
  role_limit: "Role limit changed",
  command_grant: "Command granted",
  command_revoke: "Command revoked"
};

function canSend(channel) {
  if (!channel || typeof channel.send !== "function") return false;
  if (typeof channel.isTextBased === "function") return channel.isTextBased();
  return true;
}

function buildEmbed(entry) {
  const lines = [
    `**Mode:** ${entry.automatic ? "Automatic" : "Manual"}`,
    `**Actor:** ${mentionUser(entry.actorId)}`,
    `**Target:** ${entry.targetId ? mentionUser(entry.targetId) : "n/a"}`,
    `**Reason:** ${entry.reason || "No reason provided"}`,
    `**When:** ${discordTime(entry.createdAt)}`
  ];
  return new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(LABELS[entry.action] || entry.action)
    .setDescription(lines.join("\n"))
    .setTimestamp(entry.createdAt || Date.now());
}

async function record(guild, event) {
  if (!guild?.id || !event?.action) return;
  const entry = {
    guildId: guild.id,
    action: event.action,
    actorId: event.actorId || null,
    targetId: event.targetId || null,
    reason: event.reason || null,
    automatic: !!event.automatic,
    details: event.details ? JSON.stringify(event.details) : null,
    createdAt: Date.now()
  };
  store.addLog(entry);
  const channelId = systemStore.getLog(guild.id, ANTINUKE_LOG) || store.getConfig(guild.id).log_channel_id;
  if (!channelId) return;
  try {
    const channel = guild.channels?.cache?.get(channelId) || await guild.channels?.fetch?.(channelId);
    if (!canSend(channel)) return;
    await channel.send({ embeds: [buildEmbed(entry)] });
  } catch (error) {
    if (error?.code === 10003) store.setLogChannel(guild.id, null);
    logThrottledError(`vouch-log:${guild.id}`, `[vouch log] ${guild.id}`, error);
  }
}

module.exports = { record, buildEmbed };
