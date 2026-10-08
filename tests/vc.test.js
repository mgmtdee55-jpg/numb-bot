const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
function embedTitle(embed) {
  const data = embed?.data || {};
  if (data.title) return data.title;
  const match = String(data.description || "").match(/\*\*([^*]+)\*\*/);
  return match ? match[1] : "";
}

const BetterSqlite3 = require("better-sqlite3");
const { ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits } = require("discord.js");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spanter-vc-test-"));
const databasePath = path.join(scratch, "vc.sqlite");
const legacy = new BetterSqlite3(databasePath);
legacy.exec(`
  CREATE TABLE guild_config (
    guild_id TEXT PRIMARY KEY, j2c_channel_id TEXT NOT NULL, category_id TEXT NOT NULL,
    server_interface_channel_id TEXT NOT NULL, server_interface_message_id TEXT
  );
  CREATE TABLE temp_channels (
    channel_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, owner_id TEXT,
    interface_message_id TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE vc_bans (channel_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY(channel_id,user_id));
  CREATE TABLE vc_permits (channel_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY(channel_id,user_id));
  INSERT INTO guild_config VALUES ('legacy-guild','j2c-old','category-old','server-old','message-old');
  INSERT INTO temp_channels VALUES ('temp-old','legacy-guild','owner-old','panel-old',123);
  INSERT INTO vc_bans VALUES ('temp-old','banned-old');
  INSERT INTO vc_permits VALUES ('temp-old','permitted-old');
`);
legacy.close();
process.env.DB_PATH = databasePath;

let db = require("../db");
const voice = require("../voice");
const controls = require("../interface");
const setupWizard = require("../setup-wizard");
const { handleCommand } = require("../commands");
const { createVoiceStateHandler } = require("../voice-events");
const { withChannelLock } = require("../channel-lock");
const { consumeActionCooldown, clearActionCooldowns, ACTION_COOLDOWNS_MS } = require("../action-cooldowns");

let nextId = 100000000000000000n;
function id() {
  nextId += 1n;
  return String(nextId);
}

function discordError(code) {
  return Object.assign(new Error(`Discord API error ${code}`), { code });
}

function makeMessageChannel(guild, channelId, type, options = {}) {
  const messages = new Map();
  const channel = {
    id: channelId,
    guild,
    type,
    client: guild.client,
    parentId: options.parent || null,
    name: options.name || "test-channel",
    topic: options.topic || null,
    members: new Map(),
    sent: [],
    deleted: false,
    permissionOverwrites: {
      edits: [],
      deletes: [],
      async edit(target, permissions) {
        this.edits.push({ target, permissions });
      },
      async delete(target) {
        this.deletes.push(target);
      }
    },
    messages: {
      async fetch(messageId) {
        if (messageId && typeof messageId === "object") return [...messages.values()];
        const message = messages.get(messageId);
        if (!message) throw discordError(10008);
        return message;
      }
    },
    async send(payload) {
      const sent = {
        id: id(),
        payload,
        author: { id: guild.client.user.id },
        embeds: (payload.embeds || []).map((embed) =>
          typeof embed.toJSON === "function" ? embed.toJSON() : embed
        ),
        async edit(newPayload) {
          this.payload = newPayload;
          this.embeds = (newPayload.embeds || []).map((embed) =>
            typeof embed.toJSON === "function" ? embed.toJSON() : embed
          );
          return this;
        }
      };
      messages.set(sent.id, sent);
      this.sent.push(sent);
      return sent;
    },
    async setUserLimit(limit) {
      this.userLimit = limit;
    },
    async delete() {
      this.deleted = true;
      guild.channels.cache.delete(this.id);
      return this;
    }
  };
  return channel;
}

function makeGuild(guildId = id()) {
  const members = new Map();
  const channels = new Map();
  const guild = {
    id: guildId,
    client: { user: { id: "voice-master-bot" } },
    ownerId: "111111111111111111",
    memberCount: 2681,
    maximumBitrate: 128000,
    iconURL: () => `https://cdn.example/${guildId}-icon.png`,
    emojis: {
      cache: new Map(),
      async fetch(emojiId) {
        if (emojiId) {
          const emoji = this.cache.get(emojiId);
          if (!emoji) throw discordError(10014);
          return emoji;
        }
        return this.cache;
      }
    },
    roles: { everyone: { id: `everyone-${guildId}` } },
    voiceStates: { cache: new Map() },
    channels: {
      cache: channels,
      async fetch(channelId) {
        const channel = channels.get(channelId);
        if (!channel) throw discordError(10003);
        return channel;
      },
      async create(options) {
        const channel = makeMessageChannel(
          guild,
          id(),
          options.type,
          { name: options.name, parent: options.parent, topic: options.topic }
        );
        channel.createOptions = options;
        channels.set(channel.id, channel);
        return channel;
      }
    },
    members: {
      cache: members,
      async fetch(userId) {
        const member = members.get(userId);
        if (!member) throw discordError(10007);
        return member;
      }
    },
    _members: members
  };
  for (const [action, emojiId] of Object.entries(voice.VC_INTERFACE_ICONS)) {
    guild.emojis.cache.set(emojiId, {
      id: emojiId,
      toString: () => `<:guildEmoji_${action}:${emojiId}>`
    });
  }
  return guild;
}

function makeMember(guild, userId, options = {}) {
  const member = {
    id: userId,
    guild,
    user: { id: userId, username: options.username || "member" },
    displayName: options.displayName || "Member",
    displayAvatarURL: () => {
      throw new Error("Temporary VC owner avatar must not be used in the interface embed.");
    },
    voice: {
      channel: options.channel || null,
      channelId: options.channel?.id || options.channelId || null,
      async setChannel(channelId) {
        const previousChannel = this.channel;
        previousChannel?.members.delete(userId);
        this.channelId = channelId;
        this.channel = guild.channels.cache.get(channelId) || null;
        this.channel?.members?.set(userId, member);
      },
      async disconnect() {
        this.channel = null;
        this.channelId = null;
      }
    }
  };
  guild._members.set(userId, member);
  if (options.channel) options.channel.members.set(userId, member);
  return member;
}

function makeVoiceChannel(guild, channelId = id(), members = []) {
  const channel = makeMessageChannel(guild, channelId, ChannelType.GuildVoice);
  for (const member of members) {
    channel.members.set(member.id, member);
    member.voice.channel = channel;
    member.voice.channelId = channel.id;
  }
  guild.channels.cache.set(channel.id, channel);
  return channel;
}

function makeCategory(guild, channelId = id()) {
  const channel = makeMessageChannel(guild, channelId, ChannelType.GuildCategory);
  guild.channels.cache.set(channel.id, channel);
  return channel;
}

test("-mvc reports only compact server voice statistics", async () => {
  const guild = makeGuild("mvc-stats-guild");
  const firstVoice = makeVoiceChannel(guild, "mvc-voice-1", [
    makeMember(guild, "171717171717171717"),
    makeMember(guild, "181818181818181818")
  ]);
  makeVoiceChannel(guild, "mvc-voice-2", [makeMember(guild, "191919191919191919")]);
  const stage = makeMessageChannel(guild, "mvc-stage", ChannelType.GuildStageVoice);
  const text = makeMessageChannel(guild, "mvc-text", ChannelType.GuildText);
  makeCategory(guild, "mvc-category");
  guild.channels.cache.set(stage.id, stage);
  guild.channels.cache.set(text.id, text);
  guild.voiceStates.cache.set("state-1", { channelId: firstVoice.id });
  guild.voiceStates.cache.set("state-2", { channelId: firstVoice.id });
  guild.voiceStates.cache.set("state-3", { channelId: "mvc-stage" });
  guild.voiceStates.cache.set("state-4", { channelId: null });

  const message = makeMessage(
    guild,
    "-mvc",
    { id: "mvc-user" },
    makeMember(guild, "mvc-user")
  );
  await handleCommand(message, null, "-");

  assert.equal(message.replies.length, 1);
  const payload = message.replies[0];
  assert.equal(payload.embeds.length, 1);
  assert.deepEqual(payload.components || [], []);
  const stats = payload.embeds[0].toJSON();
  assert.equal(embedTitle(payload.embeds[0]), "Voice Chat Stats");
  assert.match(stats.description, /\*\*Member Count:\*\* `2681`/);
  assert.match(stats.description, /\*\*In Call:\*\* `2`/);
  assert.match(stats.description, /\*\*Total VC's:\*\* `2`/);
  assert.deepEqual(Object.keys(stats).filter((key) => ["fields", "image", "thumbnail", "footer"].includes(key)), []);
});

test("-vc shows the shared personal interface only for the current managed VC", async () => {
  const guild = makeGuild("vc-personal-interface-guild");
  const outside = makeMember(guild, guild.ownerId);
  const outsideMessage = makeMessage(guild, "-vc", outside, outside);
  await handleCommand(outsideMessage, null, "-");
  assert.match(outsideMessage.replies[0].embeds[0].data.description, /<:error:1511840844276039811> \*\*Not In VC\*\*\nyour not in a vc channel created by spanter buddy/);

  const owner = makeMember(guild, "212121212121212121");
  const channel = makeVoiceChannel(guild, "vc-personal-interface-channel", [owner]);
  db.addTemp({
    channel_id: channel.id,
    guild_id: guild.id,
    owner_id: owner.id,
    interface_message_id: null,
    created_at: Date.now()
  });
  const insideMessage = makeMessage(guild, "-vc", owner, owner);
  await handleCommand(insideMessage, null, "-");

  const payload = insideMessage.replies[0];
  assert.equal(embedTitle(payload.embeds[0]), "VoiceMaster Interface");
  assert.match(payload.embeds[0].data.description, new RegExp(`<@${owner.id}>`));
  assert.equal(payload.embeds[0].data.thumbnail.url, `https://cdn.example/${guild.id}-icon.png`);
  assert.deepEqual(
    payload.components.flatMap((row) => row.components).map((button) => button.data.custom_id),
    voice.panelRows().flatMap((row) => row.components.map((button) => button.data.custom_id))
  );
});

function makeMessage(guild, content, author, member, target = null) {
  const replies = [];
  return {
    content,
    guild,
    author,
    member,
    mentions: { members: { first: () => target } },
    replies,
    async reply(payload) {
      replies.push(payload);
      return { payload };
    }
  };
}

function makeInteraction(guild, customId, {
  userId = guild.ownerId,
  type = "button",
  values = [],
  message = null,
  fields = null
} = {}) {
  const replies = [];
  const updates = [];
  const responseMessage = message || {
    id: id(),
    payload: null,
    edits: [],
    async edit(payload) {
      this.payload = payload;
      this.edits.push(payload);
      return this;
    }
  };
  return {
    customId,
    guild,
    guildId: guild.id,
    message: responseMessage,
    user: { id: userId },
    values,
    fields: fields || { getTextInputValue: () => "" },
    responseMessage,
    replies,
    updates,
    replied: false,
    deferred: false,
    isButton: () => type === "button",
    isChannelSelectMenu: () => type === "channel",
    isStringSelectMenu: () => type === "string",
    isUserSelectMenu: () => type === "user",
    isModalSubmit: () => type === "modal",
    async reply(payload) {
      this.replied = true;
      replies.push(payload);
      responseMessage.payload = payload;
    },
    async update(payload) {
      this.replied = true;
      updates.push(payload);
      responseMessage.payload = payload;
    },
    async deferUpdate() {
      this.deferred = true;
    },
    async deferReply(payload) {
      this.deferred = true;
      this.deferPayload = payload;
    },
    async editReply(payload) {
      updates.push(payload);
      responseMessage.payload = payload;
    },
    async fetchReply() {
      return responseMessage;
    },
    async showModal(modal) {
      this.modal = modal;
    }
  };
}

function componentId(row, index = 0) {
  return row.components[index].data.custom_id;
}

test("legacy SQLite data and history are preserved during schema migration", () => {
  const config = db.getConfig("legacy-guild");
  assert.equal(config.j2c_channel_id, "j2c-old");
  assert.equal(config.name_template, "{nickname}'s Channel");
  assert.equal(config.user_limit, 0);
  assert.equal(config.cleanup_seconds, 0);
  assert.equal(db.getTempChannel("temp-old").owner_id, "owner-old");
  assert.equal(db.isBanned("temp-old", "banned-old"), true);
  assert.equal(db.isPermitted("temp-old", "permitted-old"), true);

});

test("temp VCs use configured fields and contain exactly the ten requested buttons", async () => {
  const guild = makeGuild("temp-create-guild");
  const category = makeCategory(guild);
  const j2c = makeVoiceChannel(guild);
  const member = makeMember(guild, "222222222222222222", {
    displayName: "Nicky",
    username: "nick"
  });
  const config = {
    guild_id: guild.id,
    j2c_channel_id: j2c.id,
    category_id: category.id,
    server_interface_channel_id: "disabled",
    server_interface_message_id: null,
    name_template: "{nickname} / {username} / {user.mention}",
    user_limit: 13,
    bitrate: 96000,
    cleanup_seconds: 0,
    server_interface_enabled: 0
  };
  db.setConfig(config);

  const channel = await voice.createTempChannel(guild, member, config);
  assert.equal(channel.createOptions.name, "Nicky / nick / <@222222222222222222>");
  assert.equal(channel.createOptions.parent, category.id);
  assert.equal(channel.createOptions.userLimit, 13);
  assert.equal(channel.createOptions.bitrate, 96000);
  assert.equal(db.getTempChannel(channel.id).owner_id, member.id);
  assert.equal(channel.sent.length, 0);
  await voice.ensureTempInterface(channel, member.id);
  assert.equal(channel.sent.length, 1);
  assert.equal(db.getTempChannel(channel.id).interface_message_id, channel.sent[0].id);

  const buttons = voice.panelRows().flatMap((row) => row.components.map((button) => button.data.custom_id));
  assert.deepEqual(buttons, [
    "vc_lock", "vc_unlock", "vc_ghost", "vc_unghost", "vc_kick",
    "vc_ban", "vc_unban", "vc_permit", "vc_claim", "vc_limit"
  ]);
  assert.equal(voice.panelRows().reduce((count, row) => count + row.components.length, 0), 10);
  const emojiStrings = await voice.getInterfaceEmojiStrings(guild);
  const panel = voice.panelEmbed(member.id, null, emojiStrings).toJSON();
  assert.equal(panel.title, "VoiceMaster Interface");
  assert.equal(panel.thumbnail, undefined);
  assert.equal(panel.image, undefined);
  const channelPanel = channel.sent[0].payload.embeds[0].toJSON();
  assert.equal(channelPanel.thumbnail.url, `https://cdn.example/${guild.id}-icon.png`);
  assert.equal(channelPanel.image, undefined);
  assert.equal(voice.panelEmbed(member.id, null).toJSON().thumbnail, undefined);
  assert.match(panel.description, /Use the controls below to manage\nyour voice channel with ease\./);
  assert.equal(panel.fields, undefined);
  assert.equal(
    panel.description,
    "<@222222222222222222>\n\n" +
    "Use the controls below to manage\nyour voice channel with ease.\n\n" +
    Object.entries(voice.VC_INTERFACE_ICONS)
      .map(([action, emojiId]) => {
        const command = {
          lock: "`vc lock` — Lock your voice channel",
          unlock: "`vc unlock` — Unlock your voice channel",
          ghost: "`vc ghost` — Hide your voice channel",
          unghost: "`vc unghost` — Show your voice channel",
          kick: "`vc kick` @user — Kick a user",
          ban: "`vc ban` @user — Prevent a user from joining",
          unban: "`vc unban` @user — Allow a banned user to join",
          permit: "`vc permit` @user — Permit a user to join",
          claim: "`vc claim` — Take ownership of an empty channel",
          limit: "`vc limit` `<number>` — Set user limit"
        }[action];
        return `<:guildEmoji_${action}:${emojiId}> ${command}`;
      })
      .join("\n") +
    "\n`vc transfer` @user — Give ownership to someone in the channel"
  );
  assert.deepEqual(voice.VC_INTERFACE_ICONS, {
    lock: "1472443164995358872",
    unlock: "1472443249745723402",
    ghost: "1496366812340686958",
    unghost: "1496366791092342885",
    kick: "1473734317518618767",
    ban: "1473734312720466124",
    unban: "1473734330109919360",
    permit: "1473734325882192130",
    claim: "1473734314989584451",
    limit: "1473734316331765857"
  });
  const emojiByAction = Object.fromEntries(
    voice.panelRows()
      .flatMap((row) => row.components)
      .map((button) => [button.data.custom_id.slice("vc_".length), button.toJSON().emoji.id])
  );
  assert.deepEqual(emojiByAction, voice.VC_INTERFACE_ICONS);
  assert.ok(voice.panelRows().flatMap((row) => row.components).every((button) =>
    button.toJSON().label === undefined
  ));
  assert.ok(Object.keys(voice.VC_INTERFACE_ICONS).every((action) =>
    panel.description.includes(`<:guildEmoji_${action}:${voice.VC_INTERFACE_ICONS[action]}>`)
  ));
  assert.ok(Object.keys(voice.VC_INTERFACE_ICONS).every((action) =>
    !panel.description.includes(`:${action}:`)
  ));
  assert.doesNotMatch(panel.description, /:unghost:|:kick:|:ban:|:unban:|:permit:|:claim:|:limit:/);
  assert.doesNotMatch(panel.description, /🔒|🔓|👻|👁️|❌|🚫|👤|➕|👑|👥/u);
});

test("unavailable guide emoji IDs are omitted rather than rendered as literal pseudo-emojis", async (t) => {
  const guild = makeGuild("missing-guide-emoji-guild");
  t.mock.method(console, "error", () => {});
  const [action] = Object.keys(voice.VC_INTERFACE_ICONS);
  guild.emojis.cache.delete(voice.VC_INTERFACE_ICONS[action]);
  guild.emojis.fetch = async () => {
    throw discordError(10014);
  };

  const icons = await voice.getInterfaceEmojiStrings(guild);
  const panel = voice.panelEmbed("owner-id", null, icons).toJSON();

  assert.equal(icons[action], "");
  assert.ok(!panel.description.includes(`<:${action}:${voice.VC_INTERFACE_ICONS[action]}>`));
  assert.doesNotMatch(panel.description, /:unghost:|:kick:|:ban:|:unban:|:permit:|:claim:|:limit:/);
  assert.ok(Object.entries(voice.VC_INTERFACE_ICONS)
    .filter(([name]) => name !== action)
    .every(([name, emojiId]) => panel.description.includes(`<:guildEmoji_${name}:${emojiId}>`)));
});

test("actual J2C path creates and saves VC, moves member, then isolates interface failure", async (t) => {
  t.mock.method(console, "error", () => {});
  const guild = makeGuild("j2c-interface-failure-guild");
  const category = makeCategory(guild);
  const j2c = makeVoiceChannel(guild);
  const member = makeMember(guild, "232323232323232323", { channelId: j2c.id });
  const config = {
    guild_id: guild.id,
    j2c_channel_id: j2c.id,
    category_id: category.id,
    server_interface_channel_id: "disabled",
    server_interface_message_id: null,
    name_template: "Test {nickname}",
    user_limit: 12,
    bitrate: 64000,
    cleanup_seconds: 300,
    server_interface_enabled: 0
  };
  db.setConfig(config);
  const handler = createVoiceStateHandler({
    db,
    createTempChannel: voice.createTempChannel,
    renderVoiceChannelInterface: async (channel, ownerId) => {
      assert.equal(member.voice.channelId, channel.id);
      assert.equal(db.getTempChannel(channel.id).owner_id, ownerId);
      throw new Error("simulated interface emoji/API failure");
    },
    cleanupEmptyTempChannels: voice.cleanupEmptyTempChannels,
    cleanupTempChannel: voice.cleanupTempChannel
  });

  await handler(
    { channelId: null },
    { guild, id: member.id, member, channelId: j2c.id }
  );

  const created = [...guild.channels.cache.values()].find((channel) => channel.id !== j2c.id && channel.type === ChannelType.GuildVoice);
  assert.ok(created);
  assert.equal(created.createOptions.parent, category.id);
  assert.equal(created.createOptions.userLimit, config.user_limit);
  assert.equal(created.createOptions.bitrate, config.bitrate);
  assert.equal(created.createOptions.name, "Test Member");
  assert.equal(member.voice.channelId, created.id);
  assert.equal(db.getTempChannel(created.id).owner_id, member.id);
  assert.equal(db.getTempChannel(created.id).deleted_at, null);
  assert.equal(created.deleted, false);
});

test("actual J2C path posts the interface inside the VC after the member moves", async () => {
  const guild = makeGuild("j2c-interface-success-guild");
  const category = makeCategory(guild);
  const j2c = makeVoiceChannel(guild);
  const member = makeMember(guild, "242424242424242424", { channelId: j2c.id });
  const config = {
    guild_id: guild.id,
    j2c_channel_id: j2c.id,
    category_id: category.id,
    server_interface_channel_id: "disabled",
    server_interface_message_id: null,
    name_template: "{nickname}'s VC",
    user_limit: 0,
    bitrate: 64000,
    cleanup_seconds: 300,
    server_interface_enabled: 0
  };
  db.setConfig(config);
  const handler = createVoiceStateHandler({
    db,
    createTempChannel: voice.createTempChannel,
    renderVoiceChannelInterface: async (channel, ownerId) => {
      assert.equal(member.voice.channelId, channel.id);
      return voice.renderVoiceChannelInterface(channel, ownerId);
    },
    cleanupEmptyTempChannels: voice.cleanupEmptyTempChannels,
    cleanupTempChannel: voice.cleanupTempChannel
  });

  await handler(
    { channelId: null },
    { guild, id: member.id, member, channelId: j2c.id }
  );

  const created = guild.channels.cache.get(member.voice.channelId);
  assert.ok(created);
  assert.equal(created.sent.length, 1);
  assert.equal(db.getTempChannel(created.id).interface_message_id, created.sent[0].id);
  assert.match(
    created.sent[0].embeds[0].description,
    new RegExp(`<:guildEmoji_lock:${voice.VC_INTERFACE_ICONS.lock}>`)
  );
});

test("cleanup preserves occupied and delayed empty VCs and records deleted history", async () => {
  const guild = makeGuild("cleanup-guild");
  const category = makeCategory(guild);
  db.setConfig({
    guild_id: guild.id,
    j2c_channel_id: "cleanup-j2c",
    category_id: category.id,
    server_interface_channel_id: "persistent-interface",
    server_interface_message_id: "persistent-message",
    name_template: "{nickname}'s Channel",
    user_limit: 0,
    bitrate: 64000,
    cleanup_seconds: 60,
    server_interface_enabled: 0
  });
  const persistentInterface = makeMessageChannel(guild, "persistent-interface", ChannelType.GuildText);
  guild.channels.cache.set(persistentInterface.id, persistentInterface);

  const member = makeMember(guild, "333333333333333333");
  const occupied = makeVoiceChannel(guild, "occupied-channel", [member]);
  db.addTemp({
    channel_id: occupied.id, guild_id: guild.id, owner_id: member.id,
    interface_message_id: null, created_at: Date.now()
  });
  db.setEmptySince(occupied.id, Date.now() - 60000);

  const delayed = makeVoiceChannel(guild, "delayed-channel");
  db.addTemp({
    channel_id: delayed.id, guild_id: guild.id, owner_id: null,
    interface_message_id: null, created_at: Date.now()
  });
  db.setEmptySince(delayed.id, Date.now() - 10000);

  const instant = makeVoiceChannel(guild, "instant-channel");
  db.addTemp({
    channel_id: instant.id, guild_id: guild.id, owner_id: null,
    interface_message_id: null, created_at: Date.now()
  });
  db.setEmptySince(instant.id, Date.now() - 60000);

  await voice.cleanupEmptyTempChannels(guild);
  assert.equal(occupied.deleted, false);
  assert.equal(delayed.deleted, false);
  assert.equal(instant.deleted, true);
  assert.equal(persistentInterface.deleted, false);

  const uncachedGuild = makeGuild("uncached-occupant-guild");
  db.setConfig({
    guild_id: uncachedGuild.id,
    j2c_channel_id: "uncached-j2c",
    category_id: "uncached-category",
    server_interface_channel_id: "uncached-interface",
    server_interface_message_id: "uncached-message",
    name_template: "{nickname}'s Channel",
    user_limit: 0,
    bitrate: 64000,
    cleanup_seconds: 0,
    server_interface_enabled: 0
  });
  const uncached = makeVoiceChannel(uncachedGuild, "uncached-occupied-channel");
  uncachedGuild.voiceStates.cache.set("voice-state-uncached", {
    id: "999999999999999999",
    channelId: uncached.id,
    member: null
  });
  db.addTemp({
    channel_id: uncached.id,
    guild_id: uncachedGuild.id,
    owner_id: "999999999999999999",
    interface_message_id: null,
    created_at: Date.now()
  });
  db.setEmptySince(uncached.id, Date.now() - 120000);
  await voice.cleanupEmptyTempChannels(uncachedGuild);
  assert.equal(uncached.deleted, false);
  assert.equal(db.getTempChannel(uncached.id).owner_id, "999999999999999999");
  assert.equal(db.getTempChannel(instant.id), undefined);
  const history = new BetterSqlite3(databasePath, { readonly: true });
  assert.ok(history.prepare("SELECT deleted_at FROM temp_channels WHERE channel_id = ?").get(instant.id).deleted_at);
  history.close();
});

test("every interface button enforces ownership and performs its action", async () => {
  clearActionCooldowns();
  const guild = makeGuild("controls-guild");
  const owner = makeMember(guild, guild.ownerId);
  const other = makeMember(guild, "444444444444444444");
  const target = makeMember(guild, "555555555555555555");
  const channel = makeVoiceChannel(guild, "controls-channel", [owner, other]);
  db.addTemp({
    channel_id: channel.id, guild_id: guild.id, owner_id: owner.id,
    interface_message_id: "controls-panel", created_at: Date.now()
  });

  const denied = makeInteraction(guild, "vc_lock", { userId: other.id });
  await controls.handleButton(denied);
  assert.equal(denied.deferred, true);
  assert.equal(denied.deferPayload.flags, MessageFlags.Ephemeral);
  assert.match(embedTitle(denied.updates[0].embeds[0]), /Owner Only/);
  assert.equal(channel.permissionOverwrites.edits.length, 0);

  for (const [action, key, expected] of [
    ["lock", "Connect", false],
    ["unlock", "Connect", true],
    ["ghost", "ViewChannel", false],
    ["unghost", "ViewChannel", true]
  ]) {
    const interaction = makeInteraction(guild, `vc_${action}`);
    await controls.handleButton(interaction);
    assert.equal(interaction.deferred, true);
    assert.equal(interaction.updates.length, 1);
    assert.equal(channel.permissionOverwrites.edits.at(-1).permissions[key], expected);
  }

  for (const action of ["kick", "ban", "unban", "permit"]) {
    const interaction = makeInteraction(guild, `vc_${action}`);
    await controls.handleButton(interaction);
    assert.equal(interaction.deferred, true);
    assert.equal(interaction.updates[0].components[0].components[0].data.custom_id, `vc_select_${action}`);
  }

  target.voice.channel = channel;
  target.voice.channelId = channel.id;
  channel.members.set(target.id, target);
  const kick = makeInteraction(guild, "vc_select_kick", { type: "user", values: [target.id] });
  await controls.handleSelect(kick);
  assert.equal(kick.deferred, true);
  assert.match(embedTitle(kick.updates[0].embeds[0]), /Kicked/);
  assert.equal(target.voice.channelId, null);

  target.voice.channel = channel;
  target.voice.channelId = channel.id;
  channel.members.set(target.id, target);
  const ban = makeInteraction(guild, "vc_select_ban", { type: "user", values: [target.id] });
  await controls.handleSelect(ban);
  assert.equal(db.isBanned(channel.id, target.id), true);

  const unban = makeInteraction(guild, "vc_select_unban", { type: "user", values: [target.id] });
  await controls.handleSelect(unban);
  assert.equal(db.isBanned(channel.id, target.id), false);
  assert.ok(channel.permissionOverwrites.deletes.includes(target.id));

  const permit = makeInteraction(guild, "vc_select_permit", { type: "user", values: [target.id] });
  await controls.handleSelect(permit);
  assert.equal(db.isPermitted(channel.id, target.id), true);
  assert.equal(channel.permissionOverwrites.edits.at(-1).permissions.Connect, true);

  const limitButton = makeInteraction(guild, "vc_limit");
  await controls.handleButton(limitButton);
  assert.equal(limitButton.modal.data.custom_id, "vc_limit_modal");
  const limitModal = makeInteraction(guild, "vc_limit_modal", {
    type: "modal",
    fields: { getTextInputValue: () => "42" }
  });
  await controls.handleModal(limitModal);
  assert.equal(channel.userLimit, 42);

  const claimChannel = makeVoiceChannel(guild, "claim-channel", [other]);
  db.addTemp({
    channel_id: claimChannel.id, guild_id: guild.id, owner_id: null,
    interface_message_id: null, created_at: Date.now()
  });
  const claim = makeInteraction(guild, "vc_claim", { userId: other.id });
  await controls.handleButton(claim);
  assert.equal(claim.deferred, true);
  assert.equal(db.getTempChannel(claimChannel.id).owner_id, other.id);
});

test("rapid lock clicks are cooled down per user and channel", async () => {
  clearActionCooldowns();
  const guild = makeGuild("lock-cooldown-guild");
  const owner = makeMember(guild, guild.ownerId);
  const channel = makeVoiceChannel(guild, "lock-cooldown-channel", [owner]);
  db.addTemp({
    channel_id: channel.id, guild_id: guild.id, owner_id: owner.id,
    interface_message_id: null, created_at: Date.now()
  });

  const first = makeInteraction(guild, "vc_lock");
  await controls.handleButton(first);
  const second = makeInteraction(guild, "vc_lock");
  await controls.handleButton(second);

  assert.equal(channel.permissionOverwrites.edits.length, 1);
  assert.match(embedTitle(second.updates[0].embeds[0]), /Please Wait/);

  const independentOwner = makeMember(guild, "454545454545454545");
  const otherChannel = makeVoiceChannel(guild, "other-lock-cooldown-channel", [independentOwner]);
  db.addTemp({
    channel_id: otherChannel.id, guild_id: guild.id, owner_id: independentOwner.id,
    interface_message_id: null, created_at: Date.now()
  });
  await controls.handleButton(makeInteraction(guild, "vc_lock", { userId: independentOwner.id }));
  assert.equal(otherChannel.permissionOverwrites.edits.length, 1);
});

test("simultaneous claim clicks assign ownership once and refresh the existing panel", async () => {
  clearActionCooldowns();
  const guild = makeGuild("simultaneous-claim-cooldown-guild");
  const firstMember = makeMember(guild, "464646464646464646");
  const secondMember = makeMember(guild, "474747474747474747");
  const channel = makeVoiceChannel(guild, "simultaneous-claim-channel", [firstMember, secondMember]);
  db.addTemp({
    channel_id: channel.id, guild_id: guild.id, owner_id: null,
    interface_message_id: null, created_at: Date.now()
  });
  await Promise.all([
    controls.handleButton(makeInteraction(guild, "vc_claim", { userId: firstMember.id })),
    controls.handleButton(makeInteraction(guild, "vc_claim", { userId: secondMember.id }))
  ]);
  const ownerId = db.getTempChannel(channel.id).owner_id;

  assert.ok([firstMember.id, secondMember.id].includes(ownerId));
  assert.equal(channel.sent.length, 1);
  assert.equal(db.getTempChannel(channel.id).interface_message_id, channel.sent[0].id);
  const repeat = makeInteraction(guild, "vc_claim", { userId: ownerId });
  await controls.handleButton(repeat);
  assert.match(embedTitle(repeat.updates[0].embeds[0]), /Please Wait/);
  assert.equal(channel.sent.length, 1);
});

test("Discord rate-limit failures return a temporary response and release the VC lock", async (t) => {
  t.mock.method(console, "error", () => {});
  clearActionCooldowns();
  const guild = makeGuild("action-rate-limit-guild");
  const owner = makeMember(guild, "484848484848484848");
  const channel = makeVoiceChannel(guild, "action-rate-limit-channel", [owner]);
  db.addTemp({
    channel_id: channel.id, guild_id: guild.id, owner_id: owner.id,
    interface_message_id: null, created_at: Date.now()
  });
  channel.permissionOverwrites.edit = async () => {
    throw Object.assign(new Error("too many requests"), { status: 429, retryAfter: 1250 });
  };

  const limited = makeInteraction(guild, "vc_lock", { userId: owner.id });
  await controls.handleButton(limited);
  assert.match(embedTitle(limited.updates[0].embeds[0]), /Temporarily Rate Limited/);

  channel.permissionOverwrites.edit = async () => {};
  const recovered = makeInteraction(guild, "vc_ghost", { userId: owner.id });
  await controls.handleButton(recovered);
  assert.match(embedTitle(recovered.updates[0].embeds[0]), /Hidden/);

  channel.permissionOverwrites.edit = async () => {
    throw new Error("simulated Discord API failure");
  };
  const failed = makeInteraction(guild, "vc_unlock", { userId: owner.id });
  await controls.handleButton(failed);
  assert.match(embedTitle(failed.updates[0].embeds[0]), /Unable to Complete/);
  channel.permissionOverwrites.edit = async () => {};
  const afterFailure = makeInteraction(guild, "vc_unghost", { userId: owner.id });
  await controls.handleButton(afterFailure);
  assert.match(embedTitle(afterFailure.updates[0].embeds[0]), /Visible/);
});

test("cooldown expiry is deterministic and per action, channel, and user", () => {
  clearActionCooldowns();
  assert.equal(consumeActionCooldown("u1", "ch1", "lock", 1000), 0);
  assert.equal(consumeActionCooldown("u1", "ch1", "lock", 1500), 500);
  assert.equal(consumeActionCooldown("u2", "ch1", "lock", 1500), 0);
  assert.equal(consumeActionCooldown("u1", "ch2", "lock", 1500), 0);
  assert.equal(consumeActionCooldown("u1", "ch1", "lock", 2000), 0);
  assert.equal(ACTION_COOLDOWNS_MS.interfaceRefresh, 3000);
  clearActionCooldowns();
});

test("all text commands work for the owner and reject other members", async () => {
  clearActionCooldowns();
  const guild = makeGuild("commands-guild");
  const owner = makeMember(guild, guild.ownerId);
  const other = makeMember(guild, "666666666666666666");
  const target = makeMember(guild, "777777777777777777");
  const channel = makeVoiceChannel(guild, "commands-channel", [owner, other]);
  db.addTemp({
    channel_id: channel.id, guild_id: guild.id, owner_id: owner.id,
    interface_message_id: null, created_at: Date.now()
  });

  for (const sub of ["lock", "unlock", "ghost", "unghost"]) {
    const message = makeMessage(guild, `-vc ${sub}`, owner, owner);
    await handleCommand(message, null, "-");
    assert.equal(message.replies.length, 1);
  }
  const limit = makeMessage(guild, "-vc limit 7", owner, owner);
  await handleCommand(limit, null, "-");
  assert.equal(channel.userLimit, 7);
  const invalidLimit = makeMessage(guild, "-vc limit 100", owner, owner);
  await handleCommand(invalidLimit, null, "-");
  assert.match(embedTitle(invalidLimit.replies[0].embeds[0]), /Invalid Limit/);

  for (const sub of ["kick", "ban", "unban", "permit"]) {
    target.voice.channel = channel;
    target.voice.channelId = channel.id;
    channel.members.set(target.id, target);
    const message = makeMessage(guild, `-vc ${sub} ${target.id}`, owner, owner);
    await handleCommand(message, null, "-");
    assert.equal(message.replies.length, 1);
  }

  const unauthorized = makeMessage(guild, "-vc lock", other, other);
  await handleCommand(unauthorized, null, "-");
  assert.match(embedTitle(unauthorized.replies[0].embeds[0]), /Owner Only/);

  const claimChannel = makeVoiceChannel(guild, "text-claim-channel", [other]);
  db.addTemp({
    channel_id: claimChannel.id, guild_id: guild.id, owner_id: null,
    interface_message_id: null, created_at: Date.now()
  });
  await handleCommand(makeMessage(guild, "-vc claim", other, other), null, "-");
  assert.equal(db.getTempChannel(claimChannel.id).owner_id, other.id);

  target.voice.channel = channel;
  target.voice.channelId = channel.id;
  channel.members.set(target.id, target);
  clearActionCooldowns();
  const mentionedKick = makeMessage(guild, `-vc kick <@${target.id}>`, owner, owner, target);
  await handleCommand(mentionedKick, null, "-");
  assert.equal(target.voice.channelId, null);

  const recipient = makeMember(guild, "888888888888888888");
  const absent = makeMessage(guild, `-vc transfer ${recipient.id}`, owner, owner, recipient);
  await handleCommand(absent, null, "-");
  assert.match(embedTitle(absent.replies[0].embeds[0]), /Not In Channel/);
  assert.equal(db.getTempChannel(channel.id).owner_id, owner.id);
  recipient.voice.channel = channel;
  recipient.voice.channelId = channel.id;
  channel.members.set(recipient.id, recipient);
  const transfer = makeMessage(guild, `-vc transfer ${recipient.id}`, owner, owner, recipient);
  await handleCommand(transfer, null, "-");
  assert.match(embedTitle(transfer.replies[0].embeds[0]), /Ownership Transferred/);
  assert.equal(db.getTempChannel(channel.id).owner_id, recipient.id);
  const denied = makeMessage(guild, `-vc transfer ${owner.id}`, owner, owner, owner);
  await handleCommand(denied, null, "-");
  assert.match(embedTitle(denied.replies[0].embeds[0]), /Owner Only/);
  assert.equal(db.getTempChannel(channel.id).owner_id, recipient.id);
});

test("manual interface recovery uses the canonical renderer without duplicating the panel", async () => {
  const guild = makeGuild("manual-interface-recovery-guild");
  const owner = makeMember(guild, guild.ownerId);
  const channel = makeVoiceChannel(guild, "manual-interface-channel", [owner]);
  db.addTemp({
    channel_id: channel.id,
    guild_id: guild.id,
    owner_id: owner.id,
    interface_message_id: null,
    created_at: Date.now()
  });

  const firstRecovery = makeMessage(guild, "-send interface", owner, owner);
  await handleCommand(firstRecovery, null, "-");
  assert.equal(channel.sent.length, 1);
  assert.equal(db.getTempChannel(channel.id).interface_message_id, channel.sent[0].id);

  const secondRecovery = makeMessage(guild, "-send interface", owner, owner);
  await handleCommand(secondRecovery, null, "-");
  assert.equal(channel.sent.length, 1);
  assert.match(embedTitle(secondRecovery.replies[0].embeds[0]), /Please Wait/);
  assert.equal(db.getTempChannel(channel.id).interface_message_id, channel.sent[0].id);
});

test("claim refreshes the existing temporary interface message instead of duplicating it", async () => {
  const guild = makeGuild("claim-refresh-interface-guild");
  const claimer = makeMember(guild, "222222222222222223");
  const channel = makeVoiceChannel(guild, "claim-refresh-channel", [claimer]);
  db.addTemp({
    channel_id: channel.id,
    guild_id: guild.id,
    owner_id: null,
    interface_message_id: null,
    created_at: Date.now()
  });
  const original = await voice.renderVoiceChannelInterface(channel, null);
  const claim = makeInteraction(guild, "vc_claim", { userId: claimer.id });

  await controls.handleButton(claim);

  const updated = db.getTempChannel(channel.id);
  assert.equal(updated.owner_id, claimer.id);
  assert.equal(updated.interface_message_id, original.id);
  assert.equal(channel.sent.length, 1);
  assert.match(original.payload.embeds[0].data.description, new RegExp(`<@${claimer.id}>`));
});

test("claim recreates a deleted interface from its stale saved message ID", async () => {
  const guild = makeGuild("claim-recover-interface-guild");
  const claimer = makeMember(guild, "232323232323232324");
  const channel = makeVoiceChannel(guild, "claim-recover-channel", [claimer]);
  db.addTemp({
    channel_id: channel.id,
    guild_id: guild.id,
    owner_id: null,
    interface_message_id: "deleted-interface-message",
    created_at: Date.now()
  });
  const claim = makeInteraction(guild, "vc_claim", { userId: claimer.id });

  await controls.handleButton(claim);

  const updated = db.getTempChannel(channel.id);
  assert.equal(updated.owner_id, claimer.id);
  assert.ok(updated.interface_message_id);
  assert.notEqual(updated.interface_message_id, "deleted-interface-message");
  assert.equal(channel.sent.length, 1);
});

test("server interface matches the shared panel without an owner mention and is public", async () => {
  const guild = makeGuild("server-interface-standard-panel-guild");
  const category = makeCategory(guild);
  const result = await voice.createServerInterface(guild, {
    j2c_channel_id: "j2c",
    category_id: category.id
  });
  const serverPayload = result.payload;
  const tempPayload = await voice.buildVoiceChannelInterfacePayload(guild, "owner-id");

  assert.equal(embedTitle(serverPayload.embeds[0]), "VoiceMaster Interface");
  assert.equal(serverPayload.embeds[0].data.description, tempPayload.embeds[0].data.description.replace("<@owner-id>\n\n", "\n\n"));
  assert.equal(serverPayload.embeds[0].data.thumbnail.url, tempPayload.embeds[0].data.thumbnail.url);
  assert.deepEqual(
    serverPayload.components.flatMap((row) => row.components).map((button) => button.toJSON()),
    tempPayload.components.flatMap((row) => row.components).map((button) => button.toJSON())
  );
  assert.ok(result.text.createOptions.permissionOverwrites[0].allow.includes(PermissionFlagsBits.ViewChannel));
  assert.ok(result.text.createOptions.permissionOverwrites[0].allow.includes(PermissionFlagsBits.ReadMessageHistory));
});

test("returning former owner does not regain ownership automatically", async () => {
  const guild = makeGuild("former-owner-return-guild");
  const formerOwner = makeMember(guild, "242424242424242425");
  const claimer = makeMember(guild, "242424242424242426");
  const channel = makeVoiceChannel(guild, "former-owner-return-channel", [formerOwner, claimer]);
  db.setConfig({
    guild_id: guild.id,
    j2c_channel_id: "former-owner-j2c",
    category_id: "former-owner-category",
    server_interface_channel_id: "disabled",
    server_interface_message_id: null,
    name_template: "{nickname}'s VC",
    user_limit: 0,
    bitrate: 64000,
    cleanup_seconds: 300,
    server_interface_enabled: 0
  });
  db.addTemp({
    channel_id: channel.id,
    guild_id: guild.id,
    owner_id: formerOwner.id,
    interface_message_id: null,
    created_at: Date.now()
  });
  const handler = createVoiceStateHandler({
    db,
    createTempChannel: async () => ({ id: "unused" }),
    renderVoiceChannelInterface: async () => {},
    cleanupEmptyTempChannels: async () => {},
    cleanupTempChannel: async () => {}
  });

  await handler(
    { channelId: channel.id, id: formerOwner.id },
    { guild, id: formerOwner.id, member: formerOwner, channelId: null }
  );
  assert.equal(db.getTempChannel(channel.id).owner_id, null);

  const claimMessage = makeMessage(guild, "-vc claim", claimer, claimer);
  await controls.runTextAction(claimMessage, "claim");
  assert.equal(db.getTempChannel(channel.id).owner_id, claimer.id);

  formerOwner.voice.channelId = channel.id;
  formerOwner.voice.channel = channel;
  channel.members.set(formerOwner.id, formerOwner);
  await handler(
    { channelId: null },
    { guild, id: formerOwner.id, member: formerOwner, channelId: channel.id }
  );
  assert.equal(db.getTempChannel(channel.id).owner_id, claimer.id);
});

test("voice-state duplicate and in-flight-leave cases are serialized", async () => {
  let creates = 0;
  let cleanups = 0;
  let resolveCreate;
  const guild = makeGuild("voice-event-guild");
  const member = makeMember(guild, "888888888888888888", { channelId: "j2c" });
  const fakeDb = {
    getConfig: () => ({ j2c_channel_id: "j2c", category_id: "category" }),
    getTempChannel: () => null,
    clearOwner: () => true
  };
  const handler = createVoiceStateHandler({
    db: fakeDb,
    createTempChannel: async () => {
      creates += 1;
      return new Promise((resolve) => { resolveCreate = resolve; });
    },
    renderVoiceChannelInterface: async () => {},
    cleanupEmptyTempChannels: async () => { cleanups += 1; }
  });
  const oldState = { channelId: null };
  const newState = { guild, id: member.id, member, channelId: "j2c" };
  const first = handler(oldState, newState);
  while (!resolveCreate) await new Promise((resolve) => setImmediate(resolve));
  const duplicate = handler(oldState, newState);
  resolveCreate({ id: "temp-created" });
  await Promise.all([first, duplicate]);
  assert.equal(creates, 1);
  assert.equal(member.voice.channelId, "temp-created");

  const leavingMember = makeMember(guild, "999999999999999999", { channelId: "j2c" });
  let resolveLeavingCreate;
  const leavingHandler = createVoiceStateHandler({
    db: fakeDb,
    createTempChannel: async () => new Promise((resolve) => { resolveLeavingCreate = resolve; }),
    renderVoiceChannelInterface: async () => {},
    cleanupEmptyTempChannels: async () => { cleanups += 1; }
  });
  const leaving = leavingHandler(oldState, {
    guild, id: leavingMember.id, member: leavingMember, channelId: "j2c"
  });
  while (!resolveLeavingCreate) await new Promise((resolve) => setImmediate(resolve));
  leavingMember.voice.channelId = "other-channel";
  resolveLeavingCreate({ id: "orphan-channel" });
  await leaving;
  assert.equal(leavingMember.voice.channelId, "other-channel");
  assert.equal(cleanups, 1);

  let ownerCleared = null;
  const ownerLeavingHandler = createVoiceStateHandler({
    db: {
      getConfig: () => ({ j2c_channel_id: "j2c", category_id: "category" }),
      getTempChannel: () => ({ owner_id: "owner-leaving" }),
      clearOwner: (channelId, ownerId) => {
        ownerCleared = { channelId, ownerId };
        return true;
      }
    },
    createTempChannel: async () => ({ id: "new-temp" }),
    renderVoiceChannelInterface: async () => {},
    cleanupEmptyTempChannels: async () => { cleanups += 1; }
  });
  const ownerMoving = makeMember(guild, "owner-leaving", { channelId: "j2c" });
  await ownerLeavingHandler(
    { channelId: "previous-temp", id: ownerMoving.id },
    { guild, id: ownerMoving.id, member: ownerMoving, channelId: "j2c" }
  );
  assert.deepEqual(ownerCleared, { channelId: "previous-temp", ownerId: ownerMoving.id });
  assert.equal(cleanups, 2);
});

test("different members joining J2C concurrently each get exactly one VC", async () => {
  const guild = makeGuild("concurrent-joins-guild");
  const members = [
    makeMember(guild, "131313131313131313", { channelId: "j2c" }),
    makeMember(guild, "141414141414141414", { channelId: "j2c" })
  ];
  const created = [];
  let nextChannel = 0;
  const handler = createVoiceStateHandler({
    db: {
      getConfig: () => ({ j2c_channel_id: "j2c", category_id: "category" }),
      getTempChannel: () => null
    },
    createTempChannel: async (_guild, member) => {
      const channel = { id: `temp-${++nextChannel}`, ownerId: member.id };
      created.push(channel);
      guild.channels.cache.set(channel.id, channel);
      return channel;
    },
    renderVoiceChannelInterface: async () => {},
    cleanupEmptyTempChannels: async () => {}
  });

  await Promise.all(members.map((member) => handler(
    { channelId: null },
    { guild, id: member.id, member, channelId: "j2c" }
  )));

  assert.equal(created.length, 2);
  assert.equal(new Set(created.map((channel) => channel.ownerId)).size, 2);
  assert.equal(members[0].voice.channelId, created.find((channel) => channel.ownerId === members[0].id).id);
  assert.equal(members[1].voice.channelId, created.find((channel) => channel.ownerId === members[1].id).id);
});

test("J2C rejoin creates a new VC and leaves the old occupied channel claimable", async () => {
  const guild = makeGuild("owner-rejoin-new-vc-guild");
  const category = makeCategory(guild);
  const j2c = makeVoiceChannel(guild);
  const returningOwner = makeMember(guild, "303030303030303030");
  const remainingMember = makeMember(guild, "313131313131313131");
  const oldChannel = makeVoiceChannel(guild, "old-owner-vc", [returningOwner, remainingMember]);
  db.setConfig({
    guild_id: guild.id,
    j2c_channel_id: j2c.id,
    category_id: category.id,
    category_ids: JSON.stringify([category.id]),
    server_interface_channel_id: "disabled",
    server_interface_message_id: null,
    name_template: "{nickname}'s VC",
    user_limit: 0,
    bitrate: 64000,
    cleanup_seconds: 300,
    server_interface_enabled: 0
  });
  db.addTemp({
    channel_id: oldChannel.id,
    guild_id: guild.id,
    owner_id: returningOwner.id,
    interface_message_id: null,
    created_at: Date.now()
  });
  returningOwner.voice.channel = j2c;
  returningOwner.voice.channelId = j2c.id;
  oldChannel.members.delete(returningOwner.id);
  j2c.members.set(returningOwner.id, returningOwner);

  const handler = createVoiceStateHandler({
    db,
    createTempChannel: voice.createTempChannel,
    renderVoiceChannelInterface: async () => {},
    cleanupEmptyTempChannels: voice.cleanupEmptyTempChannels,
    cleanupTempChannel: voice.cleanupTempChannel
  });
  await handler(
    { channelId: oldChannel.id, id: returningOwner.id },
    { guild, id: returningOwner.id, member: returningOwner, channelId: j2c.id }
  );

  const newChannel = guild.channels.cache.get(returningOwner.voice.channelId);
  assert.ok(newChannel);
  assert.notEqual(newChannel.id, oldChannel.id);
  assert.equal(db.getTempChannel(oldChannel.id).owner_id, null);
  assert.equal(db.getTempChannel(newChannel.id).owner_id, returningOwner.id);
  assert.equal(oldChannel.deleted, false);
  assert.equal(oldChannel.members.has(remainingMember.id), true);
  assert.equal(remainingMember.voice.channelId, oldChannel.id);
});

test("J2C category routing advances when each selected category reaches 99 connected members", async () => {
  const guild = makeGuild("category-overflow-routing-guild");
  const categories = [makeCategory(guild), makeCategory(guild), makeCategory(guild)];
  const j2c = makeVoiceChannel(guild);
  const seedCategoryMembers = (category, prefix) => {
    const members = Array.from({ length: 99 }, (_, index) =>
      makeMember(guild, `${prefix}${String(index).padStart(17, "0")}`)
    );
    const channel = makeVoiceChannel(guild, `${prefix}-load-channel`, members);
    channel.parentId = category.id;
  };
  seedCategoryMembers(categories[0], "cat1");
  db.setConfig({
    guild_id: guild.id,
    j2c_channel_id: j2c.id,
    category_id: categories[0].id,
    category_ids: JSON.stringify(categories.map((category) => category.id)),
    server_interface_channel_id: "disabled",
    server_interface_message_id: null,
    name_template: "{nickname}'s VC",
    user_limit: 0,
    bitrate: 64000,
    cleanup_seconds: 300,
    server_interface_enabled: 0
  });

  const members = [
    makeMember(guild, "323232323232323232", { channelId: j2c.id }),
    makeMember(guild, "333333333333333333", { channelId: j2c.id })
  ];
  const handler = createVoiceStateHandler({
    db,
    createTempChannel: voice.createTempChannel,
    renderVoiceChannelInterface: async () => {},
    cleanupEmptyTempChannels: voice.cleanupEmptyTempChannels,
    cleanupTempChannel: voice.cleanupTempChannel
  });
  for (const member of members) {
    await handler({ channelId: null }, { guild, id: member.id, member, channelId: j2c.id });
  }
  const firstCreated = guild.channels.cache.get(members[0].voice.channelId);
  const secondCreated = guild.channels.cache.get(members[1].voice.channelId);
  assert.equal(firstCreated.parentId, categories[1].id);
  assert.equal(secondCreated.parentId, categories[1].id);

  seedCategoryMembers(categories[1], "cat2");
  const fourthMember = makeMember(guild, "343434343434343434", { channelId: j2c.id });
  await handler(
    { channelId: null },
    { guild, id: fourthMember.id, member: fourthMember, channelId: j2c.id }
  );
  const thirdCreated = guild.channels.cache.get(fourthMember.voice.channelId);
  assert.equal(thirdCreated.parentId, categories[2].id);
});

test("J2C overflows to the next of 3 categories when a category hits the 50-channel cap", async () => {
  const guild = makeGuild("category-channel-cap-overflow-guild");
  const categories = [makeCategory(guild), makeCategory(guild), makeCategory(guild), makeCategory(guild)];
  const j2c = makeVoiceChannel(guild);
  const fillCategory = (category, prefix, count) => {
    for (let index = 0; index < count; index += 1) {
      const channel = makeVoiceChannel(guild, `${prefix}-${index}`);
      channel.parentId = category.id;
    }
  };
  fillCategory(categories[0], "cap1", voice.DISCORD_CATEGORY_CHANNEL_CAP);
  db.setConfig({
    guild_id: guild.id,
    j2c_channel_id: j2c.id,
    category_id: categories[0].id,
    category_ids: JSON.stringify(categories.map((category) => category.id)),
    server_interface_channel_id: "disabled",
    server_interface_message_id: null,
    name_template: "{nickname}'s VC",
    user_limit: 0,
    bitrate: 64000,
    cleanup_seconds: 300,
    server_interface_enabled: 0
  });
  assert.deepEqual(
    voice.configuredCategoryIds(db.getConfig(guild.id)),
    [categories[0].id, categories[1].id, categories[2].id]
  );

  const firstMember = makeMember(guild, "383838383838383838", { channelId: j2c.id });
  const handler = createVoiceStateHandler({
    db,
    createTempChannel: voice.createTempChannel,
    renderVoiceChannelInterface: async () => {},
    cleanupEmptyTempChannels: voice.cleanupEmptyTempChannels,
    cleanupTempChannel: voice.cleanupTempChannel
  });
  await handler({ channelId: null }, { guild, id: firstMember.id, member: firstMember, channelId: j2c.id });
  assert.equal(guild.channels.cache.get(firstMember.voice.channelId).parentId, categories[1].id);

  fillCategory(categories[1], "cap2", voice.DISCORD_CATEGORY_CHANNEL_CAP);
  const secondMember = makeMember(guild, "393939393939393939", { channelId: j2c.id });
  await handler({ channelId: null }, { guild, id: secondMember.id, member: secondMember, channelId: j2c.id });
  assert.equal(guild.channels.cache.get(secondMember.voice.channelId).parentId, categories[2].id);
});

test("category overflow threshold is configurable and reservations account for simultaneous creations", async () => {
  const originalThreshold = process.env.VC_CATEGORY_OVERFLOW_THRESHOLD;
  process.env.VC_CATEGORY_OVERFLOW_THRESHOLD = "2";
  try {
    const guild = makeGuild("configured-category-threshold-guild");
    const categories = [makeCategory(guild), makeCategory(guild)];
    const j2c = makeVoiceChannel(guild);
    const existingMembers = [makeMember(guild, "353535353535353535")];
    const existingVoice = makeVoiceChannel(guild, "threshold-category-voice", existingMembers);
    existingVoice.parentId = categories[0].id;
    db.setConfig({
      guild_id: guild.id,
      j2c_channel_id: j2c.id,
      category_id: categories[0].id,
      category_ids: JSON.stringify(categories.map((category) => category.id)),
      server_interface_channel_id: "disabled",
      server_interface_message_id: null,
      name_template: "{nickname}'s VC",
      user_limit: 0,
      bitrate: 64000,
      cleanup_seconds: 300,
      server_interface_enabled: 0
    });
    const members = [
      makeMember(guild, "363636363636363636", { channelId: j2c.id }),
      makeMember(guild, "373737373737373737", { channelId: j2c.id })
    ];
    const handler = createVoiceStateHandler({
      db,
      createTempChannel: voice.createTempChannel,
      renderVoiceChannelInterface: async () => {},
      cleanupEmptyTempChannels: voice.cleanupEmptyTempChannels,
      cleanupTempChannel: voice.cleanupTempChannel
    });

    await Promise.all(members.map((member) => handler(
      { channelId: null },
      { guild, id: member.id, member, channelId: j2c.id }
    )));
    assert.deepEqual(
      members.map((member) => guild.channels.cache.get(member.voice.channelId).parentId),
      [categories[0].id, categories[1].id]
    );
    assert.equal(voice.categoryOverflowThreshold(), 2);
  } finally {
    if (originalThreshold === undefined) delete process.env.VC_CATEGORY_OVERFLOW_THRESHOLD;
    else process.env.VC_CATEGORY_OVERFLOW_THRESHOLD = originalThreshold;
  }
});

test("500 simultaneous J2C joins are processed with bounded independent creation", async () => {
  const guild = makeGuild("500-joins-guild");
  let active = 0;
  let maxActive = 0;
  let created = 0;
  const members = Array.from({ length: 500 }, (_, index) =>
    makeMember(guild, String(BigInt(151000000000000000) + BigInt(index)), { channelId: "j2c" })
  );
  const handler = createVoiceStateHandler({
    db: {
      getConfig: () => ({ j2c_channel_id: "j2c", category_id: "category" }),
      getTempChannel: () => null
    },
    createTempChannel: async (_guild, member) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      created += 1;
      active -= 1;
      return { id: `temp-${member.id}` };
    },
    renderVoiceChannelInterface: async () => {},
    cleanupEmptyTempChannels: async () => {}
  });

  await Promise.all(members.map((member) => handler(
    { channelId: null },
    { guild, id: member.id, member, channelId: "j2c" }
  )));

  assert.equal(created, 500);
  assert.ok(maxActive > 1);
  assert.ok(maxActive <= 5);
  assert.equal(members.filter((member) => member.voice.channelId === `temp-${member.id}`).length, 500);
});

test("a failed J2C creation does not block later queued members", async (t) => {
  t.mock.method(console, "error", () => {});
  const guild = makeGuild("failed-join-does-not-block-guild");
  const members = Array.from({ length: 8 }, (_, index) =>
    makeMember(guild, String(BigInt(161000000000000000) + BigInt(index)), { channelId: "j2c" })
  );
  const handler = createVoiceStateHandler({
    db: {
      getConfig: () => ({ j2c_channel_id: "j2c", category_id: "category" }),
      getTempChannel: () => null
    },
    createTempChannel: async (_guild, member) => {
      if (member.id === members[0].id) throw new Error("simulated channel creation failure");
      return { id: `temp-${member.id}` };
    },
    renderVoiceChannelInterface: async () => {},
    cleanupEmptyTempChannels: async () => {}
  });

  await Promise.all(members.map((member) => handler(
    { channelId: null },
    { guild, id: member.id, member, channelId: "j2c" }
  )));

  assert.equal(members.filter((member) => member.voice.channelId === `temp-${member.id}`).length, 7);
  assert.equal(members[0].voice.channelId, "j2c");
});

test("rate-limited J2C failures are isolated and similar logs are throttled", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const guild = makeGuild("rate-limited-join-guild");
  const members = Array.from({ length: 8 }, (_, index) =>
    makeMember(guild, String(BigInt(171000000000000000) + BigInt(index)), { channelId: "j2c" })
  );
  const handler = createVoiceStateHandler({
    db: {
      getConfig: () => ({ j2c_channel_id: "j2c", category_id: "category" }),
      getTempChannel: () => null
    },
    createTempChannel: async (_guild, member) => {
      if (member.id === members[0].id || member.id === members[1].id) {
        throw Object.assign(new Error("Discord rate limit response"), { code: 429, retryAfter: 1000 });
      }
      return { id: `temp-${member.id}` };
    },
    renderVoiceChannelInterface: async () => {},
    cleanupEmptyTempChannels: async () => {}
  });

  await Promise.all(members.map((member) => handler(
    { channelId: null },
    { guild, id: member.id, member, channelId: "j2c" }
  )));

  assert.equal(members.filter((member) => member.voice.channelId.startsWith("temp-")).length, 6);
  assert.equal(members[0].voice.channelId, "j2c");
  assert.equal(members[1].voice.channelId, "j2c");
  assert.equal(errors.length, 1);
  assert.equal(errors[0][1].code, 429);
});

test("channel locks serialize one VC without blocking actions on other VCs", async () => {
  let releaseFirst;
  let secondStarted = false;
  let independentStarted = false;
  const first = withChannelLock("same-vc", () => new Promise((resolve) => {
    releaseFirst = resolve;
  }));
  const second = withChannelLock("same-vc", async () => {
    secondStarted = true;
  });
  const independent = withChannelLock("other-vc", async () => {
    independentStarted = true;
  });

  await Promise.resolve();
  assert.equal(secondStarted, false);
  assert.equal(independentStarted, true);
  releaseFirst();
  await Promise.all([first, second, independent]);
  assert.equal(secondStarted, true);
});

test("setup is owner-only, button-driven, cancellable, configurable, and reconfigurable without duplicates", async () => {
  const guild = makeGuild("wizard-guild");
  const category = makeCategory(guild);
  const category2 = makeCategory(guild);
  const j2c = makeVoiceChannel(guild);
  const owner = makeMember(guild, guild.ownerId);
  const other = makeMember(guild, "101010101010101010");
  const nonOwnerCommand = makeMessage(guild, "-vc setup", other, other);
  await handleCommand(nonOwnerCommand, null, "-");
  assert.match(embedTitle(nonOwnerCommand.replies[0].embeds[0]), /Owner Only/);

  const setupCommand = makeMessage(guild, "-vc setup", owner, owner);
  await handleCommand(setupCommand, null, "-");
  assert.equal(setupCommand.replies.length, 1);
  const openId = componentId(setupCommand.replies[0].components[0]);
  assert.match(openId, /^setup-open:/);

  const unauthorizedOpen = makeInteraction(guild, openId, { userId: other.id });
  await setupWizard.handleSetupInteraction(unauthorizedOpen);
  assert.equal(unauthorizedOpen.replies[0].flags, MessageFlags.Ephemeral);
  assert.match(embedTitle(unauthorizedOpen.replies[0].embeds[0]), /Owner Only/);
  const unauthorizedReconfigure = makeInteraction(guild, `setup:${owner.id}:reconfigure`, { userId: other.id });
  await setupWizard.handleSetupInteraction(unauthorizedReconfigure);
  assert.match(embedTitle(unauthorizedReconfigure.replies[0].embeds[0]), /Owner Only/);

  const open = makeInteraction(guild, openId);
  await setupWizard.handleSetupInteraction(open);
  assert.equal(open.responseMessage.payload.flags, MessageFlags.Ephemeral);
  assert.match(componentId(open.responseMessage.payload.components[0]), /:j2c$/);

  const chooseJ2c = makeInteraction(guild, `setup:${owner.id}:j2c`, {
    type: "channel", values: [j2c.id], message: open.responseMessage
  });
  await setupWizard.handleSetupInteraction(chooseJ2c);
  assert.match(componentId(chooseJ2c.responseMessage.payload.components[1], 1), /:next$/);
  assert.match(embedTitle(chooseJ2c.responseMessage.payload.embeds[0]), /Join to Create/);

  const resumed = makeInteraction(guild, openId);
  await setupWizard.handleSetupInteraction(resumed);
  assert.match(embedTitle(resumed.responseMessage.payload.embeds[0]), /Join to Create/);
  assert.match(componentId(resumed.responseMessage.payload.components[1], 1), /:next$/);

  const back = makeInteraction(guild, `setup:${owner.id}:back`, {
    message: chooseJ2c.responseMessage
  });
  await setupWizard.handleSetupInteraction(back);
  assert.match(back.replies[0].content, /no longer active/);

  const goCategory = makeInteraction(guild, `setup:${owner.id}:next`, {
    message: resumed.responseMessage
  });
  await setupWizard.handleSetupInteraction(goCategory);
  assert.match(embedTitle(goCategory.responseMessage.payload.embeds[0]), /Category/);
  assert.match(goCategory.responseMessage.payload.embeds[0].data.description, /up to 3 overflow categories/);
  assert.equal(goCategory.responseMessage.payload.components[0].components[0].data.max_values, 3);

  const backToJ2c = makeInteraction(guild, `setup:${owner.id}:back`, {
    message: goCategory.responseMessage
  });
  await setupWizard.handleSetupInteraction(backToJ2c);
  assert.match(embedTitle(backToJ2c.responseMessage.payload.embeds[0]), /Join to Create/);
  const cancel = makeInteraction(guild, `setup:${owner.id}:cancel`, {
    message: backToJ2c.responseMessage
  });
  await setupWizard.handleSetupInteraction(cancel);
  assert.equal(db.getConfig(guild.id), undefined);
  assert.match(embedTitle(cancel.responseMessage.payload.embeds[0]), /Cancelled/);

  const reopen = makeInteraction(guild, openId);
  await setupWizard.handleSetupInteraction(reopen);
  const wizardMessage = reopen.responseMessage;
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:j2c`, {
    type: "channel", values: [j2c.id], message: wizardMessage
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:next`, {
    message: wizardMessage
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:categories`, {
    type: "channel", values: [category.id, category2.id], message: wizardMessage
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:next`, {
    message: wizardMessage
  }));
  const nameButton = makeInteraction(guild, `setup:${owner.id}:name`, { message: wizardMessage });
  await setupWizard.handleSetupInteraction(nameButton);
  assert.equal(nameButton.modal.data.custom_id, `setup-name:${owner.id}`);
  const nameSubmit = makeInteraction(guild, `setup-name:${owner.id}`, {
    type: "modal",
    message: wizardMessage,
    fields: { getTextInputValue: () => "Hangout for {nickname} ({username}) {user.mention}" }
  });
  await setupWizard.handleSetupInteraction(nameSubmit);
  assert.match(embedTitle(wizardMessage.payload.embeds[0]), /Temporary VC Name/);
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:next`, {
    message: wizardMessage
  }));
  assert.match(embedTitle(wizardMessage.payload.embeds[0]), /User Limit/);

  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:limit_tens`, {
    type: "string", values: ["2"], message: wizardMessage
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:limit_ones`, {
    type: "string", values: ["3"], message: wizardMessage
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:next`, {
    message: wizardMessage
  }));
  assert.match(embedTitle(wizardMessage.payload.embeds[0]), /Bitrate/);
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:bitrate`, {
    type: "string", values: ["96000"], message: wizardMessage
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:next`, {
    message: wizardMessage
  }));
  const cleanupSelection = makeInteraction(guild, `setup:${owner.id}:cleanup`, {
    type: "string", values: ["300"], message: wizardMessage
  });
  await setupWizard.handleSetupInteraction(cleanupSelection);
  assert.equal(wizardMessage.payload.components[0].components[0].toJSON().options[3].default, true);
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:next`, {
    message: wizardMessage
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:server-interface`, {
    type: "string", values: ["yes"], message: wizardMessage
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:next`, {
    message: wizardMessage
  }));
  assert.match(embedTitle(wizardMessage.payload.embeds[0]), /Review/);

  const createCount = guild.channels.cache.size;
  const confirm = makeInteraction(guild, `setup:${owner.id}:confirm`, { message: wizardMessage });
  await setupWizard.handleSetupInteraction(confirm);
  assert.equal(confirm.deferred, true);
  assert.match(embedTitle(wizardMessage.payload.embeds[0]), /Setup Complete/);
  const config = db.getConfig(guild.id);
  assert.equal(config.j2c_channel_id, j2c.id);
  assert.equal(config.category_id, category.id);
  assert.deepEqual(JSON.parse(config.category_ids), [category.id, category2.id]);
  assert.equal(config.name_template, "Hangout for {nickname} ({username}) {user.mention}");
  assert.equal(config.user_limit, 23);
  assert.equal(config.bitrate, 96000);
  assert.equal(config.cleanup_seconds, 300);
  assert.equal(config.server_interface_enabled, 1);
  assert.equal([...guild.channels.cache.values()].filter((channel) => channel.name === "server-interface").length, 1);

  const reopenExisting = makeInteraction(guild, openId);
  await setupWizard.handleSetupInteraction(reopenExisting);
  assert.match(embedTitle(reopenExisting.responseMessage.payload.embeds[0]), /Already Configured/);
  const cancelExisting = makeInteraction(guild, `setup:${owner.id}:cancel-existing`, {
    message: reopenExisting.responseMessage
  });
  await setupWizard.handleSetupInteraction(cancelExisting);
  assert.equal(db.getConfig(guild.id).name_template, config.name_template);
  assert.equal(guild.channels.cache.size, createCount + 1);

  const reconfigurePrompt = makeInteraction(guild, openId);
  await setupWizard.handleSetupInteraction(reconfigurePrompt);
  const reconfigure = makeInteraction(guild, `setup:${owner.id}:reconfigure`, {
    message: reconfigurePrompt.responseMessage
  });
  await setupWizard.handleSetupInteraction(reconfigure);
  const reconfigureMessage = reconfigure.responseMessage;
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:j2c`, {
    type: "channel", values: [j2c.id], message: reconfigureMessage
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:next`, {
    message: reconfigureMessage
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:category`, {
    type: "channel", values: [category.id], message: reconfigureMessage
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:next`, {
    message: reconfigureMessage
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:next`, {
    message: reconfigureMessage
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:limit_tens`, {
    type: "string", values: ["2"], message: reconfigureMessage
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:limit_ones`, {
    type: "string", values: ["3"], message: reconfigureMessage
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:next`, {
    message: reconfigureMessage
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:bitrate`, {
    type: "string", values: ["96000"], message: reconfigureMessage
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:next`, {
    message: reconfigureMessage
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:cleanup`, {
    type: "string", values: ["300"], message: reconfigureMessage
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:next`, {
    message: reconfigureMessage
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:server-interface`, {
    type: "string", values: ["yes"], message: reconfigureMessage
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:next`, {
    message: reconfigureMessage
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${owner.id}:confirm`, {
    message: reconfigureMessage
  }));
  assert.match(embedTitle(reconfigureMessage.payload.embeds[0]), /Setup Complete/);
  assert.equal([...guild.channels.cache.values()].filter((channel) => channel.name === "server-interface").length, 1);
});

test("deleted interfaces are recreated without deleting persistent records", async () => {
  const guild = makeGuild("interface-recovery-guild");
  const category = makeCategory(guild);
  const j2c = makeVoiceChannel(guild);
  const serverInterface = makeMessageChannel(guild, "server-interface-id", ChannelType.GuildText);
  const orphanServerMessage = await serverInterface.send({
    embeds: [new EmbedBuilder().setTitle("VoiceMaster")]
  });
  guild.channels.cache.set(serverInterface.id, serverInterface);
  db.setConfig({
    guild_id: guild.id,
    j2c_channel_id: j2c.id,
    category_id: category.id,
    server_interface_channel_id: serverInterface.id,
    server_interface_message_id: "deleted-server-message",
    name_template: "{nickname}'s Channel",
    user_limit: 0,
    bitrate: 64000,
    cleanup_seconds: 600,
    server_interface_enabled: 1
  });

  const owner = makeMember(guild, "121212121212121212");
  const temp = makeVoiceChannel(guild, "recovery-temp", [owner]);
  const orphanTempMessage = await temp.send({
    embeds: [new EmbedBuilder().setTitle("VoiceMaster Interface")]
  });
  db.addTemp({
    channel_id: temp.id, guild_id: guild.id, owner_id: owner.id,
    interface_message_id: "deleted-temp-message", created_at: Date.now()
  });
  assert.equal(db.getConfig(guild.id).server_interface_enabled, 1);

  await Promise.all([voice.reconcileGuild(guild), voice.reconcileGuild(guild)]);
  assert.equal(serverInterface.sent.length, 1);
  assert.equal(temp.sent.length, 1);
  assert.equal(db.getConfig(guild.id).server_interface_channel_id, serverInterface.id);
  assert.equal(db.getConfig(guild.id).server_interface_message_id, orphanServerMessage.id);
  assert.equal(db.getTempChannel(temp.id).interface_message_id, orphanTempMessage.id);
  assert.equal(db.getTempChannel(temp.id).owner_id, owner.id);

  await serverInterface.delete();
  await voice.reconcileGuild(guild);
  assert.notEqual(db.getConfig(guild.id).server_interface_channel_id, serverInterface.id);
  assert.equal([...guild.channels.cache.values()].filter((channel) => channel.name === "server-interface").length, 1);
});

test("restart reconciliation keeps existing interfaces and ownership without editing or duplicating them", async () => {
  const guild = makeGuild("restart-reconciliation-existing-panel-guild");
  const category = makeCategory(guild);
  const j2c = makeVoiceChannel(guild);
  db.setConfig({
    guild_id: guild.id,
    j2c_channel_id: j2c.id,
    category_id: category.id,
    category_ids: JSON.stringify([category.id]),
    server_interface_channel_id: "disabled",
    server_interface_message_id: null,
    name_template: "{nickname}'s VC",
    user_limit: 0,
    bitrate: 64000,
    cleanup_seconds: 300,
    server_interface_enabled: 0
  });
  const owner = makeMember(guild, "383838383838383838");
  const channel = makeVoiceChannel(guild, "restart-existing-temp", [owner]);
  const message = await channel.send({
    embeds: [voice.panelEmbed(owner.id)]
  });
  let edits = 0;
  const originalEdit = message.edit.bind(message);
  message.edit = async (...args) => {
    edits += 1;
    return originalEdit(...args);
  };
  db.addTemp({
    channel_id: channel.id,
    guild_id: guild.id,
    owner_id: owner.id,
    interface_message_id: message.id,
    created_at: Date.now()
  });

  await voice.reconcileGuild(guild);
  await voice.reconcileGuild(guild);

  assert.equal(channel.sent.length, 1);
  assert.equal(edits, 0);
  assert.equal(db.getTempChannel(channel.id).owner_id, owner.id);
  assert.equal(channel.deleted, false);
});

test("server interface creation recovers a channel created before configuration was saved", async () => {
  const guild = makeGuild("server-interface-crash-recovery-guild");
  const category = makeCategory(guild);
  const j2c = makeVoiceChannel(guild);
  const channel = makeMessageChannel(guild, "orphan-server-interface", ChannelType.GuildText, {
    name: "server-interface",
    parent: category.id,
    topic: "Persistent VoiceMaster server interface"
  });
  const orphanMessage = await channel.send({
    embeds: [new EmbedBuilder().setTitle("VoiceMaster")]
  });
  guild.channels.cache.set(channel.id, channel);

  const result = await voice.createServerInterface(guild, {
    j2c_channel_id: j2c.id,
    category_id: category.id
  });

  assert.equal(result.text.id, channel.id);
  assert.equal(result.message.id, orphanMessage.id);
  assert.equal(channel.sent.length, 1);
  assert.equal([...guild.channels.cache.values()].filter((candidate) => candidate.name === "server-interface").length, 1);
});

test("setup can save without creating a server interface", async () => {
  const guild = makeGuild("no-interface-guild");
  const category = makeCategory(guild);
  const j2c = makeVoiceChannel(guild);
  const button = (action) => `setup:${guild.ownerId}:${action}`;
  const open = makeInteraction(guild, `setup-open:${guild.ownerId}`);
  await setupWizard.handleSetupInteraction(open);
  const message = open.responseMessage;
  await setupWizard.handleSetupInteraction(makeInteraction(guild, button("j2c"), {
    type: "channel", values: [j2c.id], message
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, button("next"), { message }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, button("category"), {
    type: "channel", values: [category.id], message
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, button("next"), { message }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, button("next"), { message }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, button("limit_tens"), {
    type: "string", values: ["0"], message
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, button("limit_ones"), {
    type: "string", values: ["0"], message
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, button("next"), { message }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, button("bitrate"), {
    type: "string", values: ["64000"], message
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, button("next"), { message }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, button("cleanup"), {
    type: "string", values: ["0"], message
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, button("next"), { message }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, button("server-interface"), {
    type: "string", values: ["no"], message
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, button("next"), { message }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, button("confirm"), { message }));
  assert.equal(db.getConfig(guild.id).server_interface_enabled, 0);
  assert.equal(db.getConfig(guild.id).server_interface_channel_id, "disabled");
  assert.equal([...guild.channels.cache.values()].some((channel) => channel.name === "server-interface"), false);
});

test("optional setup values can be skipped and the wizard can be cancelled", async () => {
  const guild = makeGuild("wizard-skip-guild");
  const category = makeCategory(guild);
  const j2c = makeVoiceChannel(guild);
  const actionId = (action) => `setup:${guild.ownerId}:${action}`;
  const open = makeInteraction(guild, `setup-open:${guild.ownerId}`);
  await setupWizard.handleSetupInteraction(open);
  const message = open.responseMessage;

  await setupWizard.handleSetupInteraction(makeInteraction(guild, actionId("j2c"), {
    type: "channel", values: [j2c.id], message
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, actionId("next"), { message }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, actionId("category"), {
    type: "channel", values: [category.id], message
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, actionId("next"), { message }));
  assert.match(componentId(message.payload.components[1], 2), /:skip$/);
  await setupWizard.handleSetupInteraction(makeInteraction(guild, actionId("skip"), { message }));
  assert.match(embedTitle(message.payload.embeds[0]), /User Limit/);

  await setupWizard.handleSetupInteraction(makeInteraction(guild, actionId("limit_tens"), {
    type: "string", values: ["0"], message
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, actionId("limit_ones"), {
    type: "string", values: ["0"], message
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, actionId("next"), { message }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, actionId("bitrate"), {
    type: "string", values: ["64000"], message
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, actionId("next"), { message }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, actionId("cleanup"), {
    type: "string", values: ["0"], message
  }));
  await setupWizard.handleSetupInteraction(makeInteraction(guild, actionId("next"), { message }));
  assert.match(componentId(message.payload.components[1], 2), /:skip$/);
  await setupWizard.handleSetupInteraction(makeInteraction(guild, actionId("skip"), { message }));
  assert.match(embedTitle(message.payload.embeds[0]), /Review/);
  assert.match(message.payload.embeds[0].data.description, /Server interface: Yes/);

  await setupWizard.handleSetupInteraction(makeInteraction(guild, actionId("cancel"), { message }));
  assert.equal(db.getConfig(guild.id), undefined);
});

test("setup expiration edits the private wizard and does not create a configuration", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const guild = makeGuild("expiration-guild");
  const interaction = makeInteraction(guild, `setup-open:${guild.ownerId}`);
  await setupWizard.handleSetupInteraction(interaction);
  t.mock.timers.tick(10 * 60 * 1000 + 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(embedTitle(interaction.responseMessage.payload.embeds[0]), /Expired/);
  assert.equal(db.getConfig(guild.id), undefined);

  const reopen = makeInteraction(guild, `setup-open:${guild.ownerId}`);
  await setupWizard.handleSetupInteraction(reopen);
  assert.match(embedTitle(reopen.responseMessage.payload.embeds[0]), /Join to Create/);
  await setupWizard.handleSetupInteraction(makeInteraction(guild, `setup:${guild.ownerId}:cancel`, {
    message: reopen.responseMessage
  }));
  assert.equal(db.getConfig(guild.id), undefined);
});

test("voice shield blocks kicks, bans, and rejects", async () => {
  clearActionCooldowns();
  const store = require("../systems/store");
  const access = require("../systems/access");
  const guild = makeGuild("voice-shield-guild");
  const vcOwner = makeMember(guild, "121212121212121212");
  const plus = makeMember(guild, "131313131313131313");
  const premiumPlus = makeMember(guild, "141414141414141414");
  const granted = makeMember(guild, "151515151515151515");
  const ceo = makeMember(guild, "161616161616161616");
  const guildOwner = makeMember(guild, guild.ownerId);
  const channel = makeVoiceChannel(guild, "voice-shield-channel", [vcOwner, plus, premiumPlus, granted, ceo, guildOwner]);
  db.addTemp({
    channel_id: channel.id,
    guild_id: guild.id,
    owner_id: vcOwner.id,
    interface_message_id: null,
    created_at: Date.now()
  });
  store.setRank(guild.id, plus.id, "plus", vcOwner.id);
  store.setRank(guild.id, premiumPlus.id, "premiumplus", vcOwner.id);
  store.addVoiceShield(guild.id, granted.id, vcOwner.id);
  store.setStaff(guild.id, ceo.id, "god", guild.ownerId);

  const open = makeMessage(guild, `-vc kick ${plus.id}`, vcOwner, vcOwner);
  await handleCommand(open, null, "-");
  assert.equal(plus.voice.channelId, null);

  for (const [member, phrase] of [
    [premiumPlus, /paid protection/],
    [granted, /paid protection/],
    [ceo, /cant kick the owner/],
    [guildOwner, /cant kick the owner/]
  ]) {
    for (const sub of ["kick", "ban", "reject"]) {
      clearActionCooldowns();
      const message = makeMessage(guild, `-vc ${sub} ${member.id}`, vcOwner, vcOwner);
      await handleCommand(message, null, "-");
      assert.match(message.replies[0].embeds[0].data.description, phrase);
      assert.equal(member.voice.channelId, channel.id);
      assert.equal(db.isBanned(channel.id, member.id), false);
    }
  }

  const banSelect = makeInteraction(guild, "vc_select_ban", {
    type: "user",
    values: [premiumPlus.id],
    userId: vcOwner.id
  });
  await controls.handleSelect(banSelect);
  assert.match(banSelect.updates[0].embeds[0].data.description, /paid protection/);
  assert.equal(db.isBanned(channel.id, premiumPlus.id), false);
  assert.ok(access.commandsForRank("premiumplus").includes("inspect"));
  assert.ok(access.commandsForRank("premiumplus").includes("follow"));
  assert.ok(access.commandsForRank("premiumplus").includes("voiceoverride"));
  assert.equal(access.commandsForRank("plus").includes("follow"), false);
});

test("saved configuration and ownership survive reopening SQLite", () => {
  db.setConfig({
    guild_id: "persistent-guild",
    j2c_channel_id: "j2c-persist",
    category_id: "category-persist",
    server_interface_channel_id: "disabled",
    server_interface_message_id: null,
    name_template: "{username} / {nickname} / {user.mention}",
    user_limit: 23,
    bitrate: 96000,
    cleanup_seconds: 300,
    server_interface_enabled: 0
  });
  db.addTemp({
    channel_id: "temp-persist",
    guild_id: "persistent-guild",
    owner_id: "owner-persist",
    interface_message_id: "panel-persist",
    created_at: Date.now()
  });
  db.close();
  delete require.cache[require.resolve("../db")];
  db = require("../db");
  assert.equal(db.getConfig("persistent-guild").name_template, "{username} / {nickname} / {user.mention}");
  assert.equal(db.getConfig("persistent-guild").bitrate, 96000);
  assert.equal(db.getTempChannel("temp-persist").owner_id, "owner-persist");
  assert.equal(db.getTempChannel("temp-old").owner_id, "owner-old");
});

test.after(() => {
  try {
    db.close();
  } catch {
    // The restart test intentionally closes and reloads the SQLite connection.
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});
