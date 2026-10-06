const store = require("./store");
const commands = require("./commands");
const events = require("./events");
const help = require("./help");
const protection = require("./protection");

module.exports = {
  getPrefix: (guildId) => store.getPrefix(guildId),
  expandArgs: commands.expandArgs,
  handleCommand: commands.handleCommand,
  handleInteraction: help.handleInteraction,
  handleGuildMemberUpdate: events.handleGuildMemberUpdate,
  handleGuildMemberAdd: events.handleGuildMemberAdd,
  handleGuildMemberRemove: events.handleGuildMemberRemove,
  handleRoleDelete: events.handleRoleDelete,
  handleChannelDelete: events.handleChannelDelete,
  reconcileGuild: events.reconcileGuild,
  reconcileAll: events.reconcileAll,
  store,
  protection,
  authority: require("./authority"),
  service: require("./service")
};
