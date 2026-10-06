const service = require("./service");
const settings = require("./settings");
const help = require("./help");
const force = require("./force");
const panel = require("./panel");
const { reply } = require("./ui");

function commandName(args, prefix) {
  const head = String(args[0] || "").toLowerCase();
  const normalized = String(prefix || "").toLowerCase();
  return head.startsWith(normalized) ? head.slice(prefix.length) : head;
}

async function handleVouch(message, args, prefix) {
  const sub = (args[1] || "").toLowerCase();
  if (!sub) return panel.openPanel(message, prefix);
  if (sub === "add" && (args[2] || "").toLowerCase() === "giver") return service.addGiver(message, args[3]);
  if (sub === "giver" && (args[2] || "").toLowerCase() === "take") {
    return service.removeGiver(message, args[3], args.slice(4).join(" "));
  }
  if (sub === "give") return service.giveVouch(message, args[2], args.slice(3).join(" "));
  if (sub === "take") return service.takeVouch(message, args[2], args.slice(3).join(" "));
  if (sub === "admin") {
    const action = (args[2] || "").toLowerCase();
    if (action === "allow") return service.allowAdmin(message, args[3]);
    if (action === "remove" || action === "take") return service.removeAdmin(message, args[3], args.slice(4).join(" "));
    return reply(message, "Vouch Admin", `\`${prefix}vouch admin allow @user\`\n\`${prefix}vouch admin remove @user\`\n\`${prefix}vouch admin take @user [reason]\``);
  }
  if (sub === "setrole" || (sub === "role" && (args[2] || "").toLowerCase() === "add")) {
    const roleArg = sub === "setrole" ? args.slice(2).join(" ") : args.slice(3).join(" ");
    return service.setVouchRole(message, roleArg);
  }
  if (sub === "unsetrole" || (sub === "role" && (args[2] || "").toLowerCase() === "remove")) {
    return service.clearVouchRole(message);
  }
  return reply(message, "Unknown Vouch Command", `Open \`${prefix}help\` and choose Vouch.`);
}

async function handleSetrole(message, args, prefix) {
  const second = (args[1] || "").toLowerCase();
  if (second === "stripstaff") return service.setStripstaffRole(message, args.slice(2).join(" "));
  return reply(message, "Setrole", `\`${prefix}setrole stripstaff @role\`\n\`${prefix}setrole stripstaff remove\``);
}

async function handleAntinukeVouch(message, args, prefix) {
  const action = (args[2] || "").toLowerCase();
  if (!action) return service.showVouchConfig(message);
  if (action === "set") return service.bindRewardRole(message, args.slice(3).join(" "));
  if (action === "founder") return service.setFounderRole(message, args.slice(3).join(" "));
  if (action === "unset") return service.unsetLinkedRoles(message);
  if (action === "addgiver") return service.addGiver(message, args[3]);
  if (action === "removegiver") return service.removeGiver(message, args[3], args.slice(4).join(" "));
  if (action === "list") return service.listVouches(message, args[3]);
  if (action === "cleanup") return service.cleanupRegistry(message);
  return reply(message, "Vouch", [
    `\`${prefix}antinuke vouch\` — view vouch config`,
    `\`${prefix}antinuke vouch set <role>\``,
    `\`${prefix}antinuke vouch founder <role>\``,
    `\`${prefix}antinuke vouch unset\``,
    `\`${prefix}antinuke vouch addgiver <user>\``,
    `\`${prefix}antinuke vouch removegiver <user>\``,
    `\`${prefix}antinuke vouch list\``,
    `\`${prefix}antinuke vouch cleanup\``,
    `\`${prefix}antinuke vouch limit global <#>\``
  ].join("\n"));
}

async function handleCommand(message, args, prefix) {
  const name = commandName(args, prefix);
  if (name === "help" || name === "bothelp") {
    await help.sendHelp(message, prefix);
    return true;
  }
  if (name === "setprefix") {
    await settings.setPrefix(message, args, prefix);
    return true;
  }
  if (name === "alias") {
    await settings.aliasCommand(message, args, prefix);
    return true;
  }
  if (name === "vouch") {
    await handleVouch(message, args, prefix);
    return true;
  }
  if (name === "antinuke" && (args[1] || "").toLowerCase() === "vouch") {
    await handleAntinukeVouch(message, args, prefix);
    return true;
  }
  if (name === "vouchblacklist") {
    const action = (args[1] || "").toLowerCase();
    if (action === "add") await service.addBlacklist(message, args[2], args.slice(3).join(" "));
    else if (action === "remove") await service.removeBlacklist(message, args[2]);
    else if (action === "list") await service.listBlacklist(message, args[2]);
    else {
      await reply(message, "Vouch Blacklist", `\`${prefix}vouchblacklist add @user [reason]\`\n\`${prefix}vouchblacklist remove @user\`\n\`${prefix}vouchblacklist list [page]\``);
    }
    return true;
  }
  if (name === "vouchstrip") {
    await service.stripGiver(message, args[1]);
    return true;
  }
  if (name === "setrole") {
    await handleSetrole(message, args, prefix);
    return true;
  }
  if (name === "forcemanage") {
    await force.openPanel(message, prefix);
    return true;
  }
  if (name === "forcenickname") {
    await force.forceNickname(message, args[1], args.slice(2).join(" "));
    return true;
  }
  if (name === "unforcenickname") {
    await force.unforceNickname(message, args[1]);
    return true;
  }
  if (name === "forcerolestrip") {
    await force.forceRoleStrip(message, args[1], args.slice(2).join(" "));
    return true;
  }
  if (name === "unforcerolestrip" || name === "unforcestrip") {
    await force.unforceRoleStrip(message, args[1]);
    return true;
  }
  if (name === "rolestrip") {
    await force.stripRoleFromEveryone(message, args.slice(1).join(" "));
    return true;
  }
  if (name === "forcestrip") {
    await force.dispatchForceStrip(message, args[1], args.slice(2).join(" ") || null);
    return true;
  }
  return false;
}

module.exports = { handleCommand, expandArgs: settings.expandArgs };
