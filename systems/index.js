const logs = require("./logs");
const voice = require("./voice");
const punishments = require("./punishments");

function bindClient(client) {
  client.on("voiceStateUpdate", (before, after) => {
    voice.enforceVoice(before, after).catch((error) => console.error("[voice guard]", error));
    const guild = after.guild || before.guild;
    const member = after.member || before.member;
    if (!guild || !member) return;
    const summary = voice.describeVoice(before, after);
    if (summary) {
      logs.sendLog(guild, "voice", `<@${member.id}> ${summary}`).catch((error) => console.error("[voice log]", error));
    }
  });

  client.on("messageDelete", (message) => {
    if (!message.guild || !message.author) return;
    logs.sendLog(message.guild, "message", `Message by <@${message.author.id}> deleted in <#${message.channelId}>.`).catch(() => null);
  });

  client.on("messageUpdate", (before, after) => {
    if (!after.guild || after.author?.bot) return;
    if (before.content === after.content) return;
    logs.sendLog(after.guild, "message", `Message by <@${after.author?.id}> edited in <#${after.channelId}>.`).catch(() => null);
  });

  client.on("channelCreate", (channel) => {
    if (!channel.guild) return;
    logs.sendLog(channel.guild, "channel", `Channel created: **${channel.name || channel.id}**.`).catch(() => null);
  });
  client.on("channelDelete", (channel) => {
    if (!channel.guild) return;
    logs.sendLog(channel.guild, "channel", `Channel deleted: **${channel.name || channel.id}**.`).catch(() => null);
  });
  client.on("channelUpdate", (before, after) => {
    if (!after.guild || before.name === after.name) return;
    logs.sendLog(after.guild, "channel", `Channel renamed: **${before.name}** → **${after.name}**.`).catch(() => null);
  });

  client.on("roleCreate", (role) => logs.sendLog(role.guild, "role", `Role created: <@&${role.id}>.`).catch(() => null));
  client.on("roleDelete", (role) => logs.sendLog(role.guild, "role", `Role deleted: **${role.name}**.`).catch(() => null));
  client.on("roleUpdate", (before, after) => {
    if (before.name === after.name) return;
    logs.sendLog(after.guild, "role", `Role renamed: **${before.name}** → **${after.name}**.`).catch(() => null);
  });

  client.on("guildUpdate", (before, after) => {
    if (before.name === after.name) return;
    logs.sendLog(after, "server", `Server renamed: **${before.name}** → **${after.name}**.`).catch(() => null);
  });

  client.on("guildMemberAdd", (member) => {
    logs.sendLog(member.guild, "member", `<@${member.id}> joined.`).catch(() => null);
  });
  client.on("guildMemberRemove", (member) => {
    logs.sendLog(member.guild, "member", `<@${member.id}> left.`).catch(() => null);
    punishments.logKick(member.guild, member.id).catch((error) => console.error("[punishment log]", error));
  });
  client.on("guildMemberUpdate", (before, after) => {
    if (before.nickname !== after.nickname) {
      logs.sendLog(after.guild, "member", `<@${after.id}> nickname changed.`).catch(() => null);
    }
    const beforeUntil = before.communicationDisabledUntilTimestamp || 0;
    const afterUntil = after.communicationDisabledUntilTimestamp || 0;
    if (beforeUntil === afterUntil) return;
    const cleared = afterUntil <= Date.now();
    punishments.logTimeout(after.guild, after.id, afterUntil, cleared).catch((error) => console.error("[punishment log]", error));
  });
  client.on("guildBanAdd", (ban) => {
    logs.sendLog(ban.guild, "member", `<@${ban.user.id}> was banned.`).catch(() => null);
    punishments.logBan(ban.guild, ban.user.id).catch((error) => console.error("[punishment log]", error));
  });
  client.on("guildBanRemove", (ban) => logs.sendLog(ban.guild, "member", `<@${ban.user.id}> was unbanned.`).catch(() => null));
}

module.exports = {
  handleCommand: require("./commands").handleCommand,
  handleInteraction: require("./modsetup").handleInteraction,
  bindClient
};
