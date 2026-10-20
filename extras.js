const embedPanel = require("./embed-panel");
const personalBan = require("./personal-ban");
const profiles = require("./profiles");
const giveaways = require("./giveaways");
const vcConfig = require("./vc-config");
const vanity = require("./vanity");
const catalog = require("./vouch/catalog");
const vouch = require("./vouch");
const snipe = require("./snipe");
const proof = require("./proof");
const stats = require("./stats");
const quickStats = require("./quick-stats");
const auditlog = require("./auditlog");
const { resolveUserId } = require("./vouch/resolve");
const { embed } = require("./vouch/ui");

function commandName(args, prefix) {
  const head = String(args[0] || "").toLowerCase();
  const normalized = String(prefix || "").toLowerCase();
  return head.startsWith(normalized) ? head.slice(prefix.length) : head;
}

async function resolveUser(message, argument) {
  return resolveUserId(message, argument);
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
  if (name === "newcommands") {
    await message.reply(catalog.newCommandsMessage(prefix, message.member));
    return true;
  }
  if (name === "snipe" || name === "s" || name === "clearsnipe" || name === "cs") {
    await snipe.handleCommand(message, name);
    return true;
  }
  if (name === "proof" || name === "prooflist" || name === "noproof") {
    await proof.handleCommand(message, name, args);
    return true;
  }
  if (name === "modstats" || name === "viewstats") {
    await stats.handleCommand(message, name, args);
    return true;
  }
  if (name === "u") {
    await quickStats.handleCommand(message, args);
    return true;
  }
  if (await auditlog.handleCommand(message, name, args)) return true;
  return false;
}

async function refuseMenu(interaction) {
  await interaction.reply({
    embeds: [embed("Not Yours", "Only the person who opened this can change it.")],
    flags: 64
  }).catch(() => null);
}

async function handleInteraction(interaction) {
  const id = interaction.customId || "";
  if (id.startsWith("spanter:mkick:")) return require("./mkick").handleInteraction(interaction);
  if (id.startsWith("spanter:usage:")) return require("./usage").handleInteraction(interaction);
  if (id.startsWith("spanter:roles:")) return require("./role-list").handleInteraction(interaction);
  if (id.startsWith("spanter:rolestrip:")) return require("./vouch/force").handleStripInteraction(interaction);
  if (id.startsWith("spanter:commands:cat:")) {
    const ownerId = id.slice("spanter:commands:cat:".length);
    if (ownerId && interaction.user?.id && ownerId !== interaction.user.id) {
      await refuseMenu(interaction);
      return true;
    }
    const index = Number(interaction.values?.[0] || 0);
    const prefix = vouch.getPrefix(interaction.guild.id);
    await interaction.update(catalog.pageMessage(prefix, index, interaction.member));
    return true;
  }
  if (id.startsWith("spanter:commands:")) {
    const [ownerId, indexText] = id.slice("spanter:commands:".length).split(":");
    if (indexText == null) return false;
    if (ownerId && interaction.user?.id && ownerId !== interaction.user.id) {
      await refuseMenu(interaction);
      return true;
    }
    const index = Number(indexText);
    const prefix = vouch.getPrefix(interaction.guild.id);
    await interaction.update(catalog.pageMessage(prefix, index, interaction.member));
    return true;
  }
  if (id.startsWith("spanter:embed:")) return embedPanel.handleInteraction(interaction);
  if (id.startsWith("spanter:gw:")) return giveaways.handleButton(interaction);
  if (id.startsWith("spanter:vcconfig:")) return vcConfig.handleButton(interaction);
  if (id.startsWith("spanter:vanity:")) return vanity.handleInteraction(interaction);
  if (id.startsWith("spanter:protect:")) return require("./protect").handleInteraction(interaction);
  if (id.startsWith("spanter:snipe:")) return snipe.handleButton(interaction);
  if (id.startsWith("spanter:proof:")) return proof.handleButton(interaction);
  if (id.startsWith("spanter:modstats:")) return stats.handleButton(interaction);
  if (id.startsWith("spanter:quick:")) return quickStats.handleInteraction(interaction);
  if (id.startsWith("spanter:auditlog:")) return auditlog.handleButton(interaction);
  if (id.startsWith("spanter:serversetup:")) return require("./punish").handleSetup(interaction);
  if (id.startsWith("spanter:mute:")) return require("./punish").handleMuteButton(interaction);
  if (id.startsWith("spanter:vcedit:")) return require("./vc-features").handleButton(interaction);
  if (id.startsWith("spanter:confirm:nuke:")) return require("./systems/channels").handleInteraction(interaction);
  if (id.startsWith("spanter:breakthru:")) return require("./breakthru").handleInteraction(interaction);
  if (id.startsWith("spanter:confirm:vcreset:")) return require("./commands").handleVcReset(interaction);
  if (id.startsWith("spanter:seller:")) return require("./verified-seller").handleInteraction(interaction);
  if (id.startsWith("spanter:anuke:")) return require("./antinuke").handleInteraction(interaction);
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
