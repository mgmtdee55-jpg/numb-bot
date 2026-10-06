require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  MessageFlags
} = require("discord.js");
const db = require("./db");
const { handleCommand } = require("./commands");
const {
  createTempChannel,
  renderVoiceChannelInterface,
  reserveTempCategory,
  cleanupEmptyTempChannels,
  cleanupTempChannel,
  createServerInterface,
  reconcileGuild
} = require("./voice");
const { handleSetupInteraction } = require("./setup-wizard");
const { handleButton, handleSelect, handleModal } = require("./interface");
const { createVoiceStateHandler } = require("./voice-events");
const { logThrottledError } = require("./log-throttle");
const { startTempbanScheduler, enforceHardban, enforceForeverban, restoreForeverban } = require("./moderation");
const vouch = require("./vouch");
const systems = require("./systems");
const afk = require("./afk");
const { card } = require("./feedback");
let cleanupRunning = false;
let recoveryRunning = false;
const recoveryCursors = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration
  ],
  partials: [Partials.Channel, Partials.Message]
});

systems.bindClient(client);

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    startTempbanScheduler(client);
    await vouch.reconcileAll(client);
    for (const guild of client.guilds.cache.values()) {
      try {
        await reconcileGuild(guild);
        await cleanupEmptyTempChannels(guild);
      } catch (error) {
        console.error(`[startup recovery] ${guild.id}`, error);
      }
    }
  } catch (error) {
    console.error("[startup]", error);
  }
});

client.on("error", (error) => console.error("[discord]", error));
client.on("shardError", (error) => console.error("[discord shard]", error));

client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;
  const prefix = vouch.getPrefix(message.guild.id);
  try {
    await afk.observe(message, prefix);
  } catch (error) {
    console.error("[afk]", error);
  }
  if (!message.content.startsWith(prefix)) return;
  try {
    await handleCommand(message, client, prefix);
  } catch (error) {
    console.error("[command]", error);
    await message.reply({
      embeds: [
        card("Unable to complete", "The command could not be completed. Please check the bot's channel permissions.", { guild: message.guild })
      ]
    }).catch((replyError) => console.error("[command error reply]", replyError));
  }
});

client.on("voiceStateUpdate", createVoiceStateHandler({
  db,
  createTempChannel,
  renderVoiceChannelInterface,
  reserveTempCategory,
  cleanupEmptyTempChannels,
  cleanupTempChannel
}));

client.on("messageDelete", async (message) => {
  try {
    if (!message.guild) return;
    const temp = db.getTempChannel(message.channelId);
    if (temp?.interface_message_id === message.id) {
      const channel = await message.guild.channels.fetch(message.channelId);
      await renderVoiceChannelInterface(channel, temp.owner_id, temp.interface_message_id, true);
      return;
    }
    const config = db.getConfig(message.guild.id);
    if (config?.server_interface_enabled && config.server_interface_message_id === message.id) {
      const serverInterface = await createServerInterface(message.guild, config, config);
      db.updateServerInterface(message.guild.id, serverInterface.text.id, serverInterface.message.id);
    }
  } catch (error) {
    console.error("[interface recovery after deletion]", error);
  }
});

client.on("channelDelete", async (channel) => {
  try {
    const temp = db.getTempChannel(channel.id);
    if (temp) db.markTempDeleted(channel.id);
    await vouch.handleChannelDelete(channel);
    const config = db.getConfig(channel.guild?.id);
    if (config && config.server_interface_enabled &&
        (config.server_interface_channel_id === channel.id ||
         config.j2c_channel_id === channel.id ||
         config.category_id === channel.id)) {
      await reconcileGuild(channel.guild);
    }
  } catch (error) {
    console.error(`[channel recovery] ${channel.id}`, error);
  }
});

client.on("guildMemberAdd", (member) => {
  enforceForeverban(member).catch((error) => {
    console.error(`[foreverban join] ${member.guild.id}:${member.id}`, error);
  }).then(() => enforceHardban(member)).catch((error) => {
    console.error(`[hardban join] ${member.guild.id}:${member.id}`, error);
  }).then(() => vouch.handleGuildMemberAdd(member)).catch((error) => {
    console.error(`[vouch join] ${member.guild.id}:${member.id}`, error);
  });
});

client.on("guildMemberRemove", (member) => {
  vouch.handleGuildMemberRemove(member);
});

client.on("guildMemberUpdate", (oldMember, newMember) => {
  vouch.handleGuildMemberUpdate(oldMember, newMember).catch((error) => {
    logThrottledError(`vouch-role:${newMember?.guild?.id}`, "[vouch roles]", error);
  });
});

client.on("roleDelete", (role) => {
  vouch.handleRoleDelete(role).catch((error) => {
    console.error(`[vouch role delete] ${role?.id}`, error);
  });
});

client.on("guildBanRemove", (ban) => {
  restoreForeverban(ban).catch((error) => {
    console.error(`[foreverban restore] ${ban.guild.id}:${ban.user.id}`, error);
  });
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (await handleSetupInteraction(interaction)) return;
    if (await systems.handleInteraction(interaction)) return;
    if (interaction.isStringSelectMenu?.() && await vouch.handleInteraction(interaction)) return;
    if (interaction.isButton()) {
      await handleButton(interaction);
    } else if (interaction.isUserSelectMenu()) {
      await handleSelect(interaction);
    } else if (interaction.isModalSubmit()) {
      await handleModal(interaction);
    } else if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({
        embeds: [
          card("Unavailable", "This interaction is not supported.", { guild: interaction.guild })
        ],
        flags: MessageFlags.Ephemeral
      });
    }
  } catch (error) {
    console.error("[interaction]", error);
    const payload = {
      embeds: [
        card("Unable to complete", "That action could not be completed. Check that the bot has the required channel permissions.", { guild: interaction.guild })
      ],
      flags: MessageFlags.Ephemeral
    };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch((replyError) => console.error("[interaction error follow-up]", replyError));
    } else {
      await interaction.reply(payload).catch((replyError) => console.error("[interaction error reply]", replyError));
    }
  }
});

const cleanupTimer = setInterval(async () => {
  if (cleanupRunning || !client.isReady()) return;
  cleanupRunning = true;
  try {
    for (const guild of client.guilds.cache.values()) {
      try {
        await cleanupEmptyTempChannels(guild);
      } catch (error) {
        console.error(`[periodic cleanup] ${guild.id}`, error);
      }
    }
  } catch (error) {
    console.error("[periodic cleanup]", error);
  } finally {
    cleanupRunning = false;
  }
}, 15000);
cleanupTimer.unref?.();

const recoveryTimer = setInterval(async () => {
  if (recoveryRunning || !client.isReady()) return;
  recoveryRunning = true;
  try {
    for (const guild of client.guilds.cache.values()) {
      try {
        const cursor = recoveryCursors.get(guild.id) || 0;
        const nextCursor = await reconcileGuild(guild, { tempBatchSize: 25, cursor });
        recoveryCursors.set(guild.id, nextCursor);
      } catch (error) {
        logThrottledError(`periodic-vc-recovery:${guild.id}`, `[periodic VC recovery] ${guild.id}`, error);
      }
    }
  } finally {
    recoveryRunning = false;
  }
}, 60000);
recoveryTimer.unref?.();

process.on("unhandledRejection", (error) => {
  console.error("[unhandled]", error);
});

if (!process.env.DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN is required. Set it in the environment before starting the bot.");
  process.exit(1);
} else {
  client.login(process.env.DISCORD_TOKEN).catch((error) => {
    console.error("[login]", error);
    const message = String(error?.message || error);
    if (/disallowed intents/i.test(message)) {
      console.error("Enable Message Content Intent and Server Members Intent in the Discord Developer Portal.");
    }
    process.exit(1);
  });
}
