const embedPanel = require("./embed-panel");
const personalBan = require("./personal-ban");
const profiles = require("./profiles");
const giveaways = require("./giveaways");
const vcConfig = require("./vc-config");
const vanity = require("./vanity");
const catalog = require("./vouch/catalog");
const vouch = require("./vouch");
const snipe = require("./snipe");

function commandName(args, prefix) {
  const head = String(args[0] || "").toLowerCase();
  const normalized = String(prefix || "").toLowerCase();
  return head.startsWith(normalized) ? head.slice(prefix.length) : head;
}

async function resolveUser(message, argument) {
  const mentioned = message.mentions?.members?.first?.() || message.mentions?.users?.first?.();
  if (mentioned) return mentioned.id || mentioned.user?.id;
  const id = String(argument || "").replace(/[<@!>]/g, "");
  return /^\d{17,20}$/.test(id) ? id : null;
}

async function handleCommand(message, args, prefix) {
  const name = commandName(args, prefix);
  if (name === "embedcreate") {
    await embedPanel.open(message);
    return true;
  }
  if (name === "pban" || name === "personalban") {
    const userId = await resolveUser(message, args[1]);
    const user = message.mentions?.users?.first?.() || message.mentions?.members?.first?.()?.user;
    await personalBan.place(message, userId, user);
    return true;
  }
  if (name === "instagram" || name === "ig" || name === "insta") {
    await profiles.instagram(message, args.slice(1).join(" "));
    return true;
  }
  if (name === "tiktok") {
    await profiles.tiktok(message, args.slice(1).join(" "));
    return true;
  }
  if (name === "roblox") {
    await profiles.roblox(message, args.slice(1).join(" "));
    return true;
  }
  if (name === "giveaways" || name === "gw") {
    await giveaways.handleCommand(message, args.slice(1), prefix);
    return true;
  }
  if (name === "voicemaster" && ["configuration", "config"].includes((args[1] || "").toLowerCase())) {
    await vcConfig.show(message);
    return true;
  }
  if (name === "set" && (args[1] || "").toLowerCase() === "gw" && (args[2] || "").toLowerCase() === "host") {
    await giveaways.setHost(message, args.slice(3), prefix);
    return true;
  }
  if (name === "vanity") {
    await vanity.handleCommand(message, args.slice(1), prefix);
    return true;
  }
  if (name === "vanitysetup") {
    await vanity.open(message);
    return true;
  }
  if (name === "showallcommands") {
    await message.reply(catalog.pageMessage(prefix, 0, message.member));
    return true;
  }
  if (name === "snipe" || name === "s" || name === "clearsnipe" || name === "cs") {
    await snipe.handleCommand(message, name);
    return true;
  }
  return false;
}

async function handleInteraction(interaction) {
  const id = interaction.customId || "";
  if (id === "spanter:commands:cat") {
    const index = Number(interaction.values?.[0] || 0);
    const prefix = vouch.getPrefix(interaction.guild.id);
    await interaction.update(catalog.pageMessage(prefix, index, interaction.member));
    return true;
  }
  if (id.startsWith("spanter:commands:")) {
    const index = Number(id.slice("spanter:commands:".length));
    const prefix = vouch.getPrefix(interaction.guild.id);
    await interaction.update(catalog.pageMessage(prefix, index, interaction.member));
    return true;
  }
  if (id.startsWith("spanter:embed:")) return embedPanel.handleInteraction(interaction);
  if (id.startsWith("spanter:gw:")) return giveaways.handleButton(interaction);
  if (id === "spanter:vcconfig:setup") return vcConfig.handleButton(interaction);
  if (id.startsWith("spanter:vanity:")) return vanity.handleInteraction(interaction);
  if (id.startsWith("spanter:snipe:")) return snipe.handleButton(interaction);
  if (id.startsWith("spanter:confirm:nuke:")) return require("./systems/channels").handleInteraction(interaction);
  if (id.startsWith("spanter:confirm:vcreset:")) return require("./commands").handleVcReset(interaction);
  return false;
}

module.exports = {
  handleCommand,
  handleInteraction,
  resumeGiveaways: giveaways.resume,
  enforceHostRole: giveaways.enforceHostRole,
  syncVanity: vanity.syncAll,
  handleVanityPresence: vanity.handlePresence
};
