const store = require("./store");
const access = require("../systems/access");
const logging = require("./logging");
const { reply } = require("./ui");
const { BUILTIN_COMMANDS } = require("./constants");

function normalizeCommand(text, prefix) {
  let value = String(text || "").trim();
  if (value.toLowerCase().startsWith(String(prefix).toLowerCase())) value = value.slice(prefix.length);
  return value.trim().toLowerCase();
}

async function setPrefix(message, args, prefix) {
  if (!access.canConfigureBot(message.member)) {
    return reply(message, "Not Allowed", "Founders, Gods, and the server owner can change the prefix.");
  }
  const next = args.slice(1).join(" ").trim();
  if (!/^[^\s@#<>]{1,5}$/.test(next)) {
    return reply(message, "Invalid Prefix", "Use 1 to 5 characters without spaces, @, #, or mentions.");
  }
  store.setPrefix(message.guild.id, next);
  await logging.record(message.guild, {
    action: "config_change",
    actorId: message.author.id,
    reason: `Prefix changed from ${prefix} to ${next}`
  });
  return reply(message, "Prefix Updated", `The prefix is now \`${next}\`. It will still be \`${next}\` after a restart.`);
}

async function aliasCommand(message, args, prefix) {
  if (!access.canConfigureBot(message.member)) {
    return reply(message, "Not Allowed", "Founders, Gods, and the server owner can manage aliases.");
  }
  const action = (args[1] || "").toLowerCase();
  if (action === "list") {
    const rows = store.listAliases(message.guild.id);
    if (!rows.length) return reply(message, "Aliases", "No aliases saved.");
    const lines = rows.map((row) => `\`${prefix}${row.shortcut}\` → \`${prefix}${row.command_text}\``);
    return reply(message, "Aliases", lines.join("\n"));
  }
  if (action === "remove") {
    const shortcut = (args[2] || "").toLowerCase();
    if (!shortcut) return reply(message, "Usage", `\`${prefix}alias remove <shortcut>\``);
    if (!store.removeAlias(message.guild.id, shortcut)) return reply(message, "Missing Alias", "That shortcut is not saved.");
    await logging.record(message.guild, {
      action: "alias_remove",
      actorId: message.author.id,
      reason: shortcut
    });
    return reply(message, "Alias Removed", `\`${prefix}${shortcut}\` no longer runs another command.`);
  }
  if (action === "removeall") {
    const commandText = normalizeCommand(args.slice(2).join(" "), prefix);
    if (!commandText) return reply(message, "Usage", `\`${prefix}alias removeall <command>\``);
    const removed = store.removeAliasesForCommand(message.guild.id, commandText);
    if (!removed) return reply(message, "Missing Alias", "No aliases point at that command.");
    await logging.record(message.guild, {
      action: "alias_remove",
      actorId: message.author.id,
      reason: `removed ${removed} alias(es) for ${commandText}`
    });
    return reply(message, "Aliases Removed", `Removed **${removed}** alias(es) for \`${prefix}${commandText}\`.`);
  }
  if (action === "reset") {
    const removed = store.clearAliases(message.guild.id);
    await logging.record(message.guild, {
      action: "alias_remove",
      actorId: message.author.id,
      reason: `reset ${removed} alias(es)`
    });
    return reply(message, "Aliases Reset", removed ? `Cleared **${removed}** alias(es).` : "There were no aliases to clear.");
  }
  if (action === "view") {
    const shortcut = (args[2] || "").toLowerCase();
    if (!shortcut) return reply(message, "Usage", `\`${prefix}alias view <shortcut>\``);
    const commandText = store.getAlias(message.guild.id, shortcut);
    if (!commandText) return reply(message, "Missing Alias", "That shortcut is not saved.");
    return reply(message, "Alias", `\`${prefix}${shortcut}\` runs \`${prefix}${commandText}\`.`);
  }
  if (action === "add") {
    const shortcut = (args[2] || "").toLowerCase();
    const commandText = normalizeCommand(args.slice(3).join(" "), prefix);
    if (!shortcut || !commandText) {
      return reply(message, "Usage", `\`${prefix}alias add <shortcut> <command>\``);
    }
    if (!/^[a-z0-9_-]{1,20}$/.test(shortcut)) {
      return reply(message, "Invalid Shortcut", "Use 1 to 20 letters, numbers, dashes, or underscores.");
    }
    if (BUILTIN_COMMANDS.has(shortcut)) {
      return reply(message, "Invalid Shortcut", "That name is already a bot command.");
    }
    store.setAlias(message.guild.id, shortcut, commandText, message.author.id);
    await logging.record(message.guild, {
      action: "alias_add",
      actorId: message.author.id,
      reason: `${shortcut} -> ${commandText}`
    });
    return reply(message, "Alias Added", `\`${prefix}${shortcut}\` now runs \`${prefix}${commandText}\`.`);
  }
  return reply(message, "Aliases", [
    `\`${prefix}alias add <shortcut> <command>\``,
    `\`${prefix}alias remove <shortcut>\``,
    `\`${prefix}alias removeall <command>\``,
    `\`${prefix}alias view <shortcut>\``,
    `\`${prefix}alias list\``,
    `\`${prefix}alias reset\``
  ].join("\n"));
}

function expandArgs(message, prefix) {
  let args = String(message.content || "").trim().split(/\s+/);
  if (!message.guild || !args[0]) return args;
  let guard = 0;
  while (guard++ < 3) {
    const head = args[0];
    if (!head || !head.toLowerCase().startsWith(String(prefix).toLowerCase())) break;
    const shortcut = head.slice(prefix.length).toLowerCase();
    if (!shortcut) break;
    const mapped = store.getAlias(message.guild.id, shortcut);
    if (!mapped) break;
    const parts = mapped.trim().split(/\s+/);
    const next = [`${prefix}${parts[0]}`, ...parts.slice(1), ...args.slice(1)];
    if (next.join(" ") === args.join(" ")) break;
    args = next;
  }
  return args;
}

module.exports = { setPrefix, aliasCommand, expandArgs };
