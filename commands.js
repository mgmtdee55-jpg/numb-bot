const { ChannelType, EmbedBuilder } = require("discord.js");
const db = require("./db");
const setupWizard = require("./setup-wizard");
const controls = require("./interface");
const { buildVoiceChannelInterfacePayload, renderVoiceChannelInterface } = require("./voice");
const { consumeActionCooldown } = require("./action-cooldowns");
const { logThrottledError } = require("./log-throttle");
const moderation = require("./moderation");
const vouch = require("./vouch");
const { card } = require("./feedback");
const cooldowns = require("./systems/cooldowns");

function embed(title, description, guild) {
  return card(title, description, { guild });
}

function ownerOnly(message) {
  return message.author.id === message.guild.ownerId;
}

async function resolveMember(message, argument) {
  const mentioned = message.mentions.members.first();
  if (mentioned) return mentioned;
  const id = (argument || "").replace(/[<@!>]/g, "");
  if (!/^\d{17,20}$/.test(id)) return null;
  return message.guild.members.fetch(id).catch((error) => {
    if (error.code === 10007) return null;
    throw error;
  });
}

const systems = require("./systems");

function commandName(args, prefix) {
  const head = String(args[0] || "").toLowerCase();
  const normalized = String(prefix || "").toLowerCase();
  return head.startsWith(normalized) ? head.slice(prefix.length) : head;
}

function editedCommandContent(before, after, prefix) {
  if (!after?.guild || after.author?.bot) return "";
  const content = String(after.content || "");
  const normalized = String(prefix || "");
  if (!content.startsWith(normalized)) return "";
  if (before && before.content === content) return "";
  return content;
}

async function handleCommand(message, client, prefix = "-", options = {}) {
  const args = vouch.expandArgs(message, prefix);
  if (!args[0]) return;
  if (!options.edited && process.env.npm_lifecycle_event !== "test" && process.env.NODE_TEST_CONTEXT !== "1") {
    const wait = cooldowns.commandPause(message.guild.id, message.author.id, commandName(args, prefix));
    if (wait) {
      return message.reply({ embeds: [embed("Please Wait", cooldowns.waitText(wait), message.guild)] });
    }
  }
  if (await systems.handleCommand(message, args, prefix)) return;
  const command = args[0].toLowerCase();
  const vcCommand = `${prefix}vc`.toLowerCase();

  if (command === `${prefix}send`.toLowerCase() && (args[1] || "").toLowerCase() === "interface") {
    const channel = message.member?.voice?.channel;
    const temp = channel && db.getTempChannel(channel.id);
    if (!channel || !temp) {
      return message.reply({
        embeds: [embed("Temporary VC Required", "Join a bot-managed temporary voice channel to recover its interface.")]
      });
    }
    if (temp.owner_id && temp.owner_id !== message.author.id) {
      return message.reply({
        embeds: [embed("Owner Only", "Only the current owner of this temporary channel can recover its interface.")]
      });
    }
    const remainingMs = consumeActionCooldown(message.author.id, channel.id, "interfaceRefresh");
    if (remainingMs) {
      const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
      return message.reply({ embeds: [embed("Please Wait", `Try interface recovery again in **${seconds} seconds**.`)] });
    }
    try {
      await renderVoiceChannelInterface(channel, temp.owner_id, temp.interface_message_id, true);
      return message.reply({ embeds: [embed("Interface Ready", "The VoiceMaster interface is available in this channel.")] });
    } catch (error) {
      logThrottledError(`manual-interface-recovery:${message.guild.id}`, `[manual temp interface recovery] ${channel.id}`, error);
      if (error.status === 429 || error.code === 429) {
        const retryAfterMs = Number(error.retryAfter) ||
          (Number(error.rawError?.retry_after) ? Number(error.rawError.retry_after) * 1000 : 0);
        const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
        return message.reply({
          embeds: [embed("Temporarily Rate Limited", `Discord is rate limiting interface recovery. Try again in **${seconds} seconds**.`)]
        });
      }
      return message.reply({
        embeds: [embed("Unable to Recover Interface", "The interface could not be restored. Check the bot's channel permissions.")]
      });
    }
  }

  if (command === `${prefix}mvc`.toLowerCase()) {
    const voiceChannels = [...message.guild.channels.cache.values()]
      .filter((channel) => channel.type === ChannelType.GuildVoice);
    const voiceChannelIds = new Set(voiceChannels.map((channel) => channel.id));
    const inCall = [...message.guild.voiceStates.cache.values()]
      .filter((state) => voiceChannelIds.has(state.channelId)).length;
    const description = [
      `**Member Count:** \`${message.guild.memberCount}\``,
      `**In Call:** \`${inCall}\``,
      `**Total VC's:** \`${voiceChannels.length}\``
    ].join("\n\n");
    return message.reply({ embeds: [embed("Voice Chat Stats", description)] });
  }

  if (command === vcCommand) {
    if (args.length === 1) {
      const channelId = message.member?.voice?.channelId;
      const channel = channelId
        ? message.guild.channels.cache.get(channelId)
        : message.member?.voice?.channel;
      const temp = channel && db.getTempChannel(channel.id);
      if (!channel || !temp) {
        return message.reply({ embeds: [embed("Not In VC", "your not in a vc channel created by spanter buddy", message.guild)] });
      }
      const remainingMs = consumeActionCooldown(message.author.id, channel.id, "interfaceRefresh");
      if (remainingMs) {
        const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
        return message.reply({ embeds: [embed("Please Wait", `Open the interface again in **${seconds} seconds**.`)] });
      }
      try {
        return message.reply(await buildVoiceChannelInterfacePayload(
          message.guild,
          temp.owner_id,
          { showOwner: true }
        ));
      } catch (error) {
        logThrottledError(`vc-interface-command:${message.guild.id}`, `[VC interface command] ${channel.id}`, error);
        if (error.status === 429 || error.code === 429) {
          return message.reply({ embeds: [embed("Temporarily Rate Limited", "Discord is rate limiting this request. Please try again shortly.")] });
        }
        throw error;
      }
    }
    const sub = args[1].toLowerCase();
    if (sub === "setup") {
      if (!ownerOnly(message)) {
        return message.reply({ embeds: [embed("Owner Only", "Only the server owner can use `-vc setup`.")] });
      }
      return setupWizard.start(message);
    }
    if (sub === "reset") {
      if (!ownerOnly(message)) {
        return message.reply({ embeds: [embed("Owner Only", "Only the server owner can use `-vc reset`.")] });
      }
      return message.reply({
        embeds: [embed("History Preserved", "Reset no longer deletes channel history or Discord resources. Use `-vc setup` to safely reconfigure this server.")]
      });
    }
    if (["lock", "unlock", "ghost", "unghost", "claim"].includes(sub)) {
      return controls.runTextAction(message, sub);
    }
    if (sub === "config" || sub === "configuration") {
      return require("./vc-config").show(message);
    }
    if (sub === "limit") {
      return controls.runLimitTextAction(message, args[2]);
    }
    if (sub === "transfer") {
      const target = await resolveMember(message, args[2]);
      if (!target) {
        return message.reply({
          embeds: [embed("Missing User", "Mention the member you want to give this channel to.")]
        });
      }
      return controls.transferOwnership(message, target);
    }
    if (["kick", "ban", "unban", "permit", "reject"].includes(sub)) {
      const target = await resolveMember(message, args[2]);
      if (!target) {
        return message.reply({
          embeds: [embed("Missing User", "Mention a server member or provide their user ID.")]
        });
      }
      return controls.runTargetTextAction(message, sub, target);
    }
    if (sub === "help") {
      return message.reply({
        embeds: [
          embed(
            "VoiceMaster",
            [
              "`-vc setup` · Open the setup wizard",
              "`-vc lock|unlock|ghost|unghost` · Manage your channel",
              "`-vc kick|reject|ban|unban|permit @user|user-id` · Manage a member",
              "`-vc claim` · Claim an unowned channel",
              "`-vc transfer @user` · Give your channel to someone in it",
              "`-vc limit <0-99>` · Set your channel limit",
              "`-ban` / `-fakepermissions` · Server bans (fake permissions required)"
            ].join("\n")
          )
        ]
      });
    }
    return message.reply({ embeds: [embed("Unknown Command", "Use `-vc help` to see VoiceMaster commands.")] });
  }

  if (await vouch.handleCommand(message, args, prefix)) return;

  if (await moderation.handleCommand(message, args, prefix)) return;

  const legacyActions = new Map([
    [`${prefix}lock`, "lock"],
    [`${prefix}unlock`, "unlock"],
    [`${prefix}ghost`, "ghost"],
    [`${prefix}unghost`, "unghost"],
    [`${prefix}claim`, "claim"]
  ]);
  if (legacyActions.has(command)) return controls.runTextAction(message, legacyActions.get(command));

  const legacyTargetActions = new Map([
    [`${prefix}kick`, "kick"],
    [`${prefix}permit`, "permit"]
  ]);
  if (legacyTargetActions.has(command)) {
    const target = await resolveMember(message, args[1]);
    if (!target) {
      return message.reply({
        embeds: [embed("Missing User", "Mention a server member or provide their user ID.")]
      });
    }
    return controls.runTargetTextAction(message, legacyTargetActions.get(command), target);
  }
}

module.exports = { handleCommand, editedCommandContent };
