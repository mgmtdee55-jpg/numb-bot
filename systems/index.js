const logs = require("./logs");
const voice = require("./voice");
const punishments = require("./punishments");
const stats = require("../stats");

function stamp() {
  return logs.whenLine(Date.now());
}

function bindClient(client) {
  client.on("voiceStateUpdate", (before, after) => {
    stats.trackVoice(before, after);
    require("../vc-features").observe(before, after).catch((error) => console.error("[vc feature]", error));
    voice.enforceVoice(before, after).catch((error) => console.error("[voice guard]", error));
  });
  client.on("channelCreate", (channel) => {
    require("../punish").applyChannel(channel).catch((error) => console.error("[punishment channel]", error));
  });

  client.on("messageDelete", (message) => {
    if (!message.guild || !message.author || message.author.bot) return;
    const text = message.content ? `\n**Text:** ${String(message.content).slice(0, 120)}` : "";
    logs.sendLog(message.guild, "message", [
      `**User:** <@${message.author.id}>`,
      `**Channel:** <#${message.channelId}>`,
      stamp()
    ].join("\n") + text, "Message deleted").catch(() => null);
  });

  client.on("messageUpdate", (before, after) => {
    if (!after.guild || after.author?.bot) return;
    if (before.content === after.content) return;
    const text = after.content ? `\n**Text:** ${String(after.content).slice(0, 120)}` : "";
    logs.sendLog(after.guild, "message", [
      `**User:** <@${after.author?.id}>`,
      `**Channel:** <#${after.channelId}>`,
      stamp()
    ].join("\n") + text, "Message edited").catch(() => null);
  });

  client.on("roleCreate", (role) => logs.logRoleCreate(role).catch(() => null));
  client.on("roleDelete", (role) => logs.logRoleDelete(role).catch(() => null));
  client.on("roleUpdate", (before, after) => logs.logRoleUpdate(before, after).catch(() => null));

  client.on("guildUpdate", async (before, after) => {
    if (before.name === after.name) return;
    const entry = typeof after.fetchAuditLogs === "function"
      ? await after.fetchAuditLogs({ type: 1, limit: 1 }).catch(() => null)
      : null;
    const audit = [...(entry?.entries?.values?.() || [])][0];
    const actor = audit?.executorId || audit?.executor?.id;
    logs.sendLog(after, "server", [
      `**Name:** **${before.name}** → **${after.name}**`,
      `**By:** ${actor ? `<@${actor}>` : "Unknown"}`,
      stamp()
    ].join("\n"), "Server updated").catch(() => null);
  });

  client.on("guildMemberAdd", (member) => {
    logs.sendLog(member.guild, "member", [
      `**User:** <@${member.id}>`,
      stamp()
    ].join("\n"), "Member joined").catch(() => null);
  });
  client.on("guildMemberRemove", (member) => {
    logs.sendLog(member.guild, "member", [
      `**User:** <@${member.id}>`,
      stamp()
    ].join("\n"), "Member left").catch(() => null);
    punishments.logKick(member.guild, member.id).catch((error) => console.error("[punishment log]", error));
  });
  client.on("guildMemberUpdate", (before, after) => {
    require("../protect").observe(before, after).catch((error) => console.error("[protect]", error));
    require("../punish").syncMember(before, after).catch((error) => console.error("[punishment sync]", error));
    if (before.nickname !== after.nickname) {
      logs.sendLog(after.guild, "member", [
        `**User:** <@${after.id}>`,
        `**Nickname:** **${before.nickname || "none"}** → **${after.nickname || "none"}**`,
        stamp()
      ].join("\n"), "Nickname updated").catch(() => null);
    }
    logs.logMemberRoles(before, after).catch(() => null);
    const beforeUntil = before.communicationDisabledUntilTimestamp || 0;
    const afterUntil = after.communicationDisabledUntilTimestamp || 0;
    if (beforeUntil === afterUntil) return;
    const cleared = afterUntil <= Date.now();
    punishments.logTimeout(after.guild, after.id, afterUntil, cleared).catch((error) => console.error("[punishment log]", error));
  });
  client.on("guildBanAdd", (ban) => {
    punishments.logBan(ban.guild, ban.user.id).catch((error) => console.error("[punishment log]", error));
  });
  client.on("guildBanRemove", (ban) => {
    punishments.logUnban(ban.guild, ban.user.id).catch((error) => console.error("[punishment log]", error));
  });
}

module.exports = {
  handleCommand: require("./commands").handleCommand,
  handleInteraction: require("./modsetup").handleInteraction,
  bindClient
};
