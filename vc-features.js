const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  PermissionFlagsBits
} = require("discord.js");
const db = require("./db");
const { embed } = require("./vouch/ui");

const DISCONNECT_MS = 20_000;
const timers = new Map();

db.connection.exec(`
CREATE TABLE IF NOT EXISTS vc_features (
  guild_id TEXT PRIMARY KEY,
  auto_unmute_channel_id TEXT,
  random_join_channel_id TEXT
);
`);

const statements = {
  get: db.connection.prepare("SELECT * FROM vc_features WHERE guild_id=?"),
  save: db.connection.prepare(`
    INSERT INTO vc_features(guild_id, auto_unmute_channel_id, random_join_channel_id)
    VALUES(@guild_id,@auto_unmute_channel_id,@random_join_channel_id)
    ON CONFLICT(guild_id) DO UPDATE SET
      auto_unmute_channel_id=excluded.auto_unmute_channel_id,
      random_join_channel_id=excluded.random_join_channel_id
  `)
};

function featuresOf(guildId) {
  return statements.get.get(guildId) || {
    guild_id: guildId,
    auto_unmute_channel_id: null,
    random_join_channel_id: null
  };
}

function saveFeatures(row) {
  statements.save.run(row);
}

function isProtectedChannel(guildId, channelId) {
  const row = statements.get.get(guildId);
  if (!row || !channelId) return false;
  return row.auto_unmute_channel_id === channelId || row.random_join_channel_id === channelId;
}

function denied(channel, userId, flag) {
  const overwrite = channel.permissionOverwrites?.cache?.get?.(userId);
  return !!overwrite?.deny?.has?.(flag);
}

function occupantCount(channel) {
  if (typeof channel.members?.size === "number") return channel.members.size;
  return 0;
}

function openCall(channel, guild, userId, blocked) {
  if (!channel || channel.type !== ChannelType.GuildVoice) return false;
  if (blocked.has(channel.id)) return false;
  const everyoneId = guild.roles?.everyone?.id || guild.id;
  if (denied(channel, everyoneId, PermissionFlagsBits.Connect)) return false;
  if (denied(channel, everyoneId, PermissionFlagsBits.ViewChannel)) return false;
  if (denied(channel, userId, PermissionFlagsBits.Connect)) return false;
  if (db.isBanned(channel.id, userId)) return false;
  const limit = Number(channel.userLimit) || 0;
  if (limit > 0 && occupantCount(channel) >= limit) return false;
  return true;
}

function chooseOpenChannel(guild, userId, features = featuresOf(guild.id)) {
  const config = db.getConfig(guild.id);
  const blocked = new Set([
    config?.j2c_channel_id,
    features.auto_unmute_channel_id,
    features.random_join_channel_id
  ].filter(Boolean));
  const open = db.getTempChannels(guild.id)
    .map((row) => guild.channels.cache.get(row.channel_id))
    .filter((channel) => openCall(channel, guild, userId, blocked));
  if (!open.length) return null;
  return open[Math.floor(Math.random() * open.length)];
}

function cancelTimer(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const timer = timers.get(key);
  if (timer) clearTimeout(timer);
  timers.delete(key);
}

function armDisconnect(guild, userId, channelId) {
  cancelTimer(guild.id, userId);
  const timer = setTimeout(() => {
    timers.delete(`${guild.id}:${userId}`);
    const member = guild.members?.cache?.get(userId);
    if (member?.voice?.channelId !== channelId || typeof member.voice.disconnect !== "function") return;
    member.voice.disconnect("Auto unmute limit").catch(() => null);
  }, DISCONNECT_MS);
  timer.unref?.();
  timers.set(`${guild.id}:${userId}`, timer);
}

async function handleAuto(state) {
  const member = state.member;
  if (member?.voice?.serverMute && typeof member.voice.setMute === "function") {
    await member.voice.setMute(false, "Auto unmute").catch(() => null);
  }
  if (member?.voice?.serverDeaf && typeof member.voice.setDeaf === "function") {
    await member.voice.setDeaf(false, "Auto unmute").catch(() => null);
  }
  armDisconnect(state.guild, state.id, state.channelId);
}

async function handleRandom(state) {
  const member = state.member;
  if (typeof member?.voice?.setChannel !== "function") return;
  const channel = chooseOpenChannel(state.guild, state.id);
  if (!channel) {
    if (typeof member.voice.disconnect === "function") {
      await member.voice.disconnect("No open public call").catch(() => null);
    }
    return;
  }
  await member.voice.setChannel(channel.id, "Random join").catch(() => null);
}

async function observe(before, after) {
  if (!after?.guild || after.member?.user?.bot) return;
  const features = statements.get.get(after.guild.id);
  if (!features) return;
  if (before?.channelId && before.channelId !== after.channelId && before.channelId === features.auto_unmute_channel_id) {
    cancelTimer(after.guild.id, after.id);
  }
  if (!after.channelId || after.channelId === before?.channelId) return;
  if (after.channelId === features.auto_unmute_channel_id) await handleAuto(after);
  if (after.channelId === features.random_join_channel_id) await handleRandom(after);
}

function menu(userId, feature) {
  return {
    embeds: [embed("Voice Channel", feature === "auto"
      ? "Create a new auto-unmute call, or connect one that already exists? People who join are unmuted and undeafened, then disconnected after 20 seconds."
      : "Create a new random-join call, or connect one that already exists? It only moves people into public calls that are not locked, hidden, or full.")],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`spanter:vcedit:create:${feature}:${userId}`).setLabel("Create channel").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`spanter:vcedit:existing:${feature}:${userId}`).setLabel("Use existing").setStyle(ButtonStyle.Secondary)
      )
    ]
  };
}

function chooser(userId) {
  return {
    embeds: [embed("Voice Edit", "Which call should I connect? This does not change join-to-create, categories, or any channel that already has people in it.")],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`spanter:vcedit:pick:auto:${userId}`).setLabel("Auto unmute").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`spanter:vcedit:pick:random:${userId}`).setLabel("Random join").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`spanter:vcedit:cancel:${userId}`).setLabel("Done").setStyle(ButtonStyle.Secondary)
      )
    ]
  };
}

function start(message) {
  return message.reply(chooser(message.author.id));
}

async function offer(guild, userId, send) {
  if (typeof send !== "function") return;
  await send(chooser(userId));
}

function parentId(guild) {
  const config = db.getConfig(guild.id);
  if (config?.category_id && guild.channels.cache.get(config.category_id)) return config.category_id;
  const j2c = config?.j2c_channel_id && guild.channels.cache.get(config.j2c_channel_id);
  return j2c?.parentId || null;
}

function rejectMapped(guild, channelId) {
  const config = db.getConfig(guild.id);
  if (config?.j2c_channel_id === channelId) return "That is the join-to-create channel. Pick a different call.";
  const row = db.getTempChannel(channelId);
  if (row) return "That call is a temporary VC. Create a normal channel or pick one that is not temporary.";
  return null;
}

async function remember(guild, feature, channelId) {
  const row = featuresOf(guild.id);
  if (feature === "auto") row.auto_unmute_channel_id = channelId;
  if (feature === "random") row.random_join_channel_id = channelId;
  saveFeatures(row);
}

async function handleButton(interaction) {
  const id = interaction.customId || "";
  if (!id.startsWith("spanter:vcedit:")) return false;
  const [, , action, feature, userId] = id.split(":");
  if (interaction.user?.id !== userId || interaction.user?.id !== interaction.guild?.ownerId) {
    await interaction.reply({ embeds: [embed("Owner Only", "Only the server owner can connect these calls.")], flags: 64 }).catch(() => null);
    return true;
  }
  if (action === "cancel") {
    await interaction.update({ embeds: [embed("Voice Edit", "Left the current VoiceMaster setup alone.")], components: [] });
    return true;
  }
  if (action === "pick") {
    await interaction.update(menu(userId, feature));
    return true;
  }
  if (action === "existing") {
    await interaction.update({
      embeds: [embed("Voice Channel", "Which voice channel should I connect?")],
      components: [
        new ActionRowBuilder().addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId(`spanter:vcedit:channel:${feature}:${userId}`)
            .setPlaceholder("Choose a voice channel")
            .setChannelTypes(ChannelType.GuildVoice)
        )
      ]
    });
    return true;
  }
  if (action === "create") {
    const name = feature === "auto" ? "auto-unmute" : "random-join";
    const channel = await interaction.guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
      parent: parentId(interaction.guild) || undefined,
      reason: "Voice feature"
    });
    await remember(interaction.guild, feature, channel.id);
    await interaction.update({
      embeds: [embed("Voice Channel Connected", `<#${channel.id}> is the ${feature === "auto" ? "auto-unmute" : "random-join"} call. Nothing else was changed or deleted.`)],
      components: []
    });
    return true;
  }
  if (action === "channel") {
    const channelId = interaction.values?.[0];
    const problem = rejectMapped(interaction.guild, channelId);
    if (problem) {
      await interaction.reply({ embeds: [embed("Pick Another Channel", problem)], flags: 64 }).catch(() => null);
      return true;
    }
    const channel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      await interaction.reply({ embeds: [embed("Voice Channel", "Pick a voice channel.")], flags: 64 }).catch(() => null);
      return true;
    }
    await remember(interaction.guild, feature, channel.id);
    await interaction.update({
      embeds: [embed("Voice Channel Connected", `<#${channel.id}> is now connected. The channel was not deleted, and nobody was moved out.`)],
      components: []
    });
    return true;
  }
  return true;
}

module.exports = {
  DISCONNECT_MS,
  featuresOf,
  isProtectedChannel,
  chooseOpenChannel,
  observe,
  start,
  offer,
  handleButton,
  armDisconnect,
  cancelTimer
};
