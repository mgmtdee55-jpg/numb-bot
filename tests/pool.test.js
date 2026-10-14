const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ChannelType, AuditLogEvent } = require("discord.js");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spanter-pool-"));
process.env.DB_PATH = path.join(scratch, "vc.sqlite");

const db = require("../db");
const voice = require("../voice");
const pool = require("../pool");
const { createVoiceStateHandler } = require("../voice-events");

voice.renderVoiceChannelInterface = async () => {
  voice.interfaceCalls = (voice.interfaceCalls || 0) + 1;
};
pool.configurePace({ limit: 100, windowMs: 0 });

let seq = 0;
function nextId() {
  seq += 1;
  return String(800000000000000000n + BigInt(seq));
}

function makeGuild(guildId = nextId()) {
  const channels = new Map();
  const guild = {
    id: guildId,
    ownerId: "owner-1",
    maximumBitrate: 96000,
    roles: { everyone: { id: guildId }, cache: new Map() },
    members: { cache: new Map() },
    voiceStates: { cache: new Map() },
    channels: {
      cache: channels,
      async create(options) {
        if (guild.createError) {
          const error = guild.createError;
          guild.createError = guild.createErrorOnce ? null : guild.createError;
          throw error;
        }
        if (guild.createGate) await guild.createGate;
        const channel = makeVoice(guild, nextId(), options);
        channels.set(channel.id, channel);
        return channel;
      },
      async fetch(id) {
        if (guild.fetchError) throw guild.fetchError;
        return channels.get(id) || null;
      }
    },
    client: { user: { id: "bot-1" } }
  };
  return guild;
}

function makeVoice(guild, channelId, options = {}) {
  const channel = {
    id: channelId,
    guild,
    type: options.type || ChannelType.GuildVoice,
    parentId: options.parent || null,
    name: options.name || "pool",
    members: new Map(),
    deleted: false,
    edits: [],
    permissionOverwrites: {
      async edit() {},
      async set() {}
    },
    async edit(payload) {
      channel.edits.push(payload);
      if (payload.name) channel.name = payload.name;
      if (payload.userLimit != null) channel.userLimit = payload.userLimit;
      if (payload.bitrate != null) channel.bitrate = payload.bitrate;
      return channel;
    },
    async delete() {
      channel.deleted = true;
      guild.channels.cache.delete(channel.id);
      return channel;
    },
    messages: { async fetch() { throw Object.assign(new Error("missing"), { code: 10008 }); } },
    async send() {
      return { id: nextId() };
    }
  };
  return channel;
}

function makeMember(guild, channelId = null) {
  const id = nextId();
  const member = {
    id,
    displayName: `Member ${id.slice(-4)}`,
    user: { id, username: `member${id.slice(-4)}`, bot: false },
    voice: {
      channelId,
      async setChannel(next) {
        member.voice.channelId = next;
        member.voice.moves = (member.voice.moves || 0) + 1;
      }
    }
  };
  guild.members.cache.set(id, member);
  return member;
}

function category(guild) {
  const channel = makeVoice(guild, nextId(), { type: ChannelType.GuildCategory, name: "Pools" });
  guild.channels.cache.set(channel.id, channel);
  return channel;
}

function savePool(guild, cat, overrides = {}) {
  db.savePoolConfig({
    guild_id: guild.id,
    category_id: cat.id,
    name_template: "{nickname}'s Channel",
    initial_count: 15,
    refill_after: 5,
    refill_batch: 10,
    max_empty: 30,
    cleanup_seconds: 0,
    generation_stopped: 0,
    cycle_claims: 0,
    refill_open: 0,
    ...overrides
  });
}

function messageFor(guild, authorId = guild.ownerId) {
  const message = {
    guild,
    author: { id: authorId },
    replies: [],
    async reply(payload) {
      message.replies.push(payload);
      return payload;
    }
  };
  return message;
}

function description(reply) {
  return reply.embeds[0].data.description;
}

test("validation rejects a starting size above the cap and a missing category", () => {
  assert.match(pool.validateValues({
    initial_count: 40,
    refill_after: 5,
    refill_batch: 10,
    max_empty: 30,
    name_template: "{nickname}'s Channel",
    cleanup_seconds: 0,
    category_id: "cat"
  }), /cannot be higher/);
  assert.match(pool.validateValues({
    initial_count: 15,
    refill_after: 5,
    refill_batch: 10,
    max_empty: 30,
    name_template: "   ",
    cleanup_seconds: 0,
    category_id: "cat"
  }), /name/i);
  assert.equal(pool.validateValues({
    initial_count: 15,
    refill_after: 5,
    refill_batch: 10,
    max_empty: 30,
    name_template: "{nickname}'s Channel",
    cleanup_seconds: 0,
    category_id: "cat"
  }), null);
});

test("initial generation creates 15 tracked empty pools", async () => {
  const guild = makeGuild();
  const cat = category(guild);
  savePool(guild, cat);
  pool.requestCreates(guild, 15);
  await pool.whenIdle(guild.id);
  const rows = db.listPoolChannels(guild.id, "empty");
  assert.equal(rows.length, 15);
  assert.equal(new Set(rows.map((row) => row.channel_id)).size, 15);
  for (const row of rows) {
    const channel = guild.channels.cache.get(row.channel_id);
    assert.equal(channel.parentId, cat.id);
    assert.equal(channel.type, ChannelType.GuildVoice);
    assert.equal(db.getTempChannel(row.channel_id), undefined);
  }
});

test("claiming 5 pools refills 10 without passing the cap or repeating the batch", async () => {
  const guild = makeGuild();
  const cat = category(guild);
  savePool(guild, cat, { max_empty: 30, refill_batch: 10, refill_after: 5 });
  pool.requestCreates(guild, 15);
  await pool.whenIdle(guild.id);
  let release;
  guild.createGate = new Promise((resolve) => {
    release = resolve;
  });
  const waiting = db.listPoolChannels(guild.id, "empty");
  for (const row of waiting.slice(0, 5)) {
    const member = makeMember(guild, row.channel_id);
    guild.channels.cache.get(row.channel_id).members.set(member.id, member);
    await pool.claimJoin(guild, member, row.channel_id);
  }
  assert.equal(db.getPoolConfig(guild.id).refill_open, 1);
  for (const row of db.listPoolChannels(guild.id, "empty").slice(0, 3)) {
    const member = makeMember(guild, row.channel_id);
    await pool.claimJoin(guild, member, row.channel_id);
  }
  const beforeRefill = [...guild.channels.cache.values()].filter((channel) => channel.parentId === cat.id && channel.type === ChannelType.GuildVoice).length;
  release();
  guild.createGate = null;
  await pool.whenIdle(guild.id);
  const afterRefill = [...guild.channels.cache.values()].filter((channel) => channel.parentId === cat.id && channel.type === ChannelType.GuildVoice).length;
  assert.equal(afterRefill - beforeRefill, 10);
  assert.equal(db.countPoolChannels(guild.id, "claimed"), 8);
  assert.equal(db.countPoolChannels(guild.id, "empty"), 17);
  assert.equal(db.getPoolConfig(guild.id).refill_open, 0);
});

test("a refill creates only the room left under the cap", async () => {
  const guild = makeGuild();
  const cat = category(guild);
  savePool(guild, cat, { initial_count: 15, max_empty: 18, refill_batch: 10, refill_after: 5 });
  pool.requestCreates(guild, 15);
  await pool.whenIdle(guild.id);
  const waiting = db.listPoolChannels(guild.id, "empty");
  for (const row of waiting.slice(0, 5)) {
    const member = makeMember(guild, row.channel_id);
    await pool.claimJoin(guild, member, row.channel_id);
  }
  await pool.whenIdle(guild.id);
  assert.equal(db.countPoolChannels(guild.id, "empty"), 18);
});

test("two members cannot both become the initial owner of one pool", async () => {
  const guild = makeGuild();
  const cat = category(guild);
  savePool(guild, cat, { refill_after: 50 });
  const channel = makeVoice(guild, nextId(), { parent: cat.id, name: "Open's Channel" });
  guild.channels.cache.set(channel.id, channel);
  db.insertPoolChannel({ channel_id: channel.id, guild_id: guild.id, status: "empty", created_at: Date.now() });
  const first = makeMember(guild, channel.id);
  const second = makeMember(guild, channel.id);
  channel.members.set(first.id, first);
  channel.members.set(second.id, second);
  const [left, right] = await Promise.all([
    pool.claimJoin(guild, first, channel.id),
    pool.claimJoin(guild, second, channel.id)
  ]);
  const winners = [left, right].filter(Boolean);
  assert.equal(winners.length, 1);
  const temp = db.getTempChannel(channel.id);
  assert.equal(temp.owner_id, winners[0].id === channel.id ? db.getPoolChannel(channel.id).owner_id : db.getPoolChannel(channel.id).owner_id);
  assert.equal([first.id, second.id].includes(temp.owner_id), true);
  assert.equal(db.getPoolChannel(channel.id).owner_id, temp.owner_id);
  assert.equal(channel.edits.length > 0, true);
  assert.equal(channel.name, `Member ${temp.owner_id.slice(-4)}'s Channel`);
  assert.ok(voice.interfaceCalls >= 1);
});

test("join to create moves into a ready pool without waiting to create a channel", async () => {
  const guild = makeGuild("j2c-pool-fallback");
  const cat = category(guild);
  savePool(guild, cat, { refill_after: 50 });
  const lobby = makeVoice(guild, "j2c-lobby");
  guild.channels.cache.set(lobby.id, lobby);
  const poolChannel = makeVoice(guild, nextId(), { parent: cat.id });
  guild.channels.cache.set(poolChannel.id, poolChannel);
  db.insertPoolChannel({ channel_id: poolChannel.id, guild_id: guild.id, status: "empty", created_at: Date.now() });
  const member = makeMember(guild, lobby.id);
  let creates = 0;
  const cleaned = [];
  const handler = createVoiceStateHandler({
    db: {
      getConfig: () => ({ j2c_channel_id: lobby.id, category_id: cat.id, bitrate: 64000, user_limit: 4, name_template: "{nickname}'s Channel" }),
      getTempChannel: (id) => db.getTempChannel(id),
      forceOwner: (id, ownerId) => db.forceOwner(id, ownerId)
    },
    createTempChannel: async () => {
      creates += 1;
      throw new Error("create failed");
    },
    renderVoiceChannelInterface: async () => {},
    cleanupTempChannel: async (_guild, channelId) => {
      cleaned.push(channelId);
    }
  });
  await handler(
    { channelId: null },
    { guild, id: member.id, member, channelId: lobby.id }
  );
  assert.equal(creates, 0);
  assert.equal(member.voice.channelId, poolChannel.id);
  assert.equal(db.getTempChannel(poolChannel.id).owner_id, member.id);
  assert.equal(db.getPoolChannel(poolChannel.id).status, "claimed");
  assert.equal(cleaned.length, 0);
});

test("a failed pool move releases the pool and still opens a new call", async () => {
  const guild = makeGuild("j2c-pool-move-fail");
  const cat = category(guild);
  savePool(guild, cat, { refill_after: 50 });
  const poolChannel = makeVoice(guild, nextId(), { parent: cat.id });
  guild.channels.cache.set(poolChannel.id, poolChannel);
  db.insertPoolChannel({ channel_id: poolChannel.id, guild_id: guild.id, status: "empty", created_at: Date.now() });
  const member = makeMember(guild, "j2c");
  let moved = 0;
  member.voice.setChannel = async (next) => {
    moved += 1;
    if (moved === 1) throw new Error("move failed");
    member.voice.channelId = next;
  };
  const cleaned = [];
  const handler = createVoiceStateHandler({
    db: {
      getConfig: () => ({ j2c_channel_id: "j2c", category_id: cat.id }),
      getTempChannel: (id) => db.getTempChannel(id),
      forceOwner: (...args) => db.forceOwner(...args)
    },
    createTempChannel: async () => ({ id: "orphan-temp" }),
    renderVoiceChannelInterface: async () => {},
    cleanupTempChannel: async (_guild, channelId) => {
      cleaned.push(channelId);
    }
  });
  await handler({ channelId: null }, { guild, id: member.id, member, channelId: "j2c" });
  assert.deepEqual(cleaned, []);
  assert.equal(member.voice.channelId, "orphan-temp");
  assert.equal(db.getPoolChannel(poolChannel.id).status, "empty");
  assert.equal(db.getTempChannel(poolChannel.id), undefined);
  assert.equal(poolChannel.deleted, false);
});

test("leaving join-to-create before the fallback cancels the move", async () => {
  const guild = makeGuild("j2c-pool-left");
  const cat = category(guild);
  savePool(guild, cat, { refill_after: 50 });
  const poolChannel = makeVoice(guild, nextId(), { parent: cat.id });
  guild.channels.cache.set(poolChannel.id, poolChannel);
  db.insertPoolChannel({ channel_id: poolChannel.id, guild_id: guild.id, status: "empty", created_at: Date.now() });
  const member = makeMember(guild, "somewhere-else");
  guild.voiceStates.cache.set(member.id, { id: member.id, channelId: "somewhere-else" });
  const handler = createVoiceStateHandler({
    db: {
      getConfig: () => ({ j2c_channel_id: "j2c", category_id: cat.id }),
      getTempChannel: () => null
    },
    createTempChannel: async () => {
      throw new Error("create failed");
    },
    renderVoiceChannelInterface: async () => {},
    cleanupEmptyTempChannels: async () => {}
  });
  await handler({ channelId: null }, { guild, id: member.id, member, channelId: "j2c" });
  assert.equal(member.voice.channelId, "somewhere-else");
  assert.equal(db.getPoolChannel(poolChannel.id).status, "empty");
  assert.equal(poolChannel.deleted, false);
});

test("stoppool cancels pools that have not started and leaves claimed calls", async () => {
  const guild = makeGuild();
  const cat = category(guild);
  savePool(guild, cat);
  let release;
  guild.createGate = new Promise((resolve) => {
    release = resolve;
  });
  pool.requestCreates(guild, 5);
  await new Promise((resolve) => setImmediate(resolve));
  const claimed = makeVoice(guild, nextId(), { parent: cat.id });
  guild.channels.cache.set(claimed.id, claimed);
  db.insertPoolChannel({ channel_id: claimed.id, guild_id: guild.id, status: "claimed", created_at: Date.now() });
  db.savePoolConfig({ ...db.getPoolConfig(guild.id), generation_stopped: 0 });
  const message = messageFor(guild);
  await pool.handleCommand(message, ["-stoppool"], "-");
  release();
  guild.createGate = null;
  await pool.whenIdle(guild.id);
  const empty = db.listPoolChannels(guild.id, "empty");
  assert.ok(empty.length <= 1);
  assert.equal(db.getPoolChannel(claimed.id).status, "claimed");
  assert.equal(claimed.deleted, false);
  assert.equal(db.getPoolConfig(guild.id).generation_stopped, 1);
  pool.requestCreates(guild, 4);
  await pool.whenIdle(guild.id);
  assert.equal(db.listPoolChannels(guild.id, "empty").length, empty.length);
  assert.match(description(message.replies[0]), /No new pools/);
});

test("cleanpools deletes only empty unclaimed pools", async () => {
  const guild = makeGuild();
  const cat = category(guild);
  savePool(guild, cat);
  db.setPoolGeneration(guild.id, true);
  const empty = makeVoice(guild, nextId(), { parent: cat.id });
  const occupied = makeVoice(guild, nextId(), { parent: cat.id });
  const claimed = makeVoice(guild, nextId(), { parent: cat.id });
  const ordinary = makeVoice(guild, nextId(), { parent: cat.id, name: "friends" });
  const missingId = nextId();
  for (const channel of [empty, occupied, claimed, ordinary]) guild.channels.cache.set(channel.id, channel);
  const sitter = makeMember(guild, occupied.id);
  occupied.members.set(sitter.id, sitter);
  db.insertPoolChannel({ channel_id: empty.id, guild_id: guild.id, status: "empty", created_at: Date.now() });
  db.insertPoolChannel({ channel_id: occupied.id, guild_id: guild.id, status: "empty", created_at: Date.now() });
  db.insertPoolChannel({ channel_id: claimed.id, guild_id: guild.id, status: "claimed", created_at: Date.now() });
  db.insertPoolChannel({ channel_id: missingId, guild_id: guild.id, status: "empty", created_at: Date.now() });
  const message = messageFor(guild);
  await pool.handleCommand(message, ["-cleanpools"], "-");
  assert.equal(empty.deleted, true);
  assert.equal(occupied.deleted, false);
  assert.equal(claimed.deleted, false);
  assert.equal(ordinary.deleted, false);
  assert.equal(db.getPoolChannel(empty.id), null);
  assert.equal(db.getPoolChannel(occupied.id).status, "empty");
  assert.equal(db.getPoolChannel(claimed.id).status, "claimed");
  assert.equal(db.getPoolChannel(missingId), null);
  assert.match(description(message.replies[0]), /Deleted: \*\*1\*\*/);
  assert.match(description(message.replies[0]), /Skipped: \*\*2\*\*/);
});

test("a claimed pool follows normal empty cleanup and an occupied one stays", async () => {
  const guild = makeGuild();
  const cat = category(guild);
  savePool(guild, cat, { cleanup_seconds: 0 });
  const emptyClaimed = makeVoice(guild, nextId(), { parent: cat.id });
  const busy = makeVoice(guild, nextId(), { parent: cat.id });
  guild.channels.cache.set(emptyClaimed.id, emptyClaimed);
  guild.channels.cache.set(busy.id, busy);
  const owner = makeMember(guild, busy.id);
  busy.members.set(owner.id, owner);
  guild.voiceStates.cache.set(owner.id, { id: owner.id, channelId: busy.id });
  for (const channel of [emptyClaimed, busy]) {
    db.insertPoolChannel({
      channel_id: channel.id,
      guild_id: guild.id,
      status: "claimed",
      created_at: Date.now()
    });
    db.addTemp({
      channel_id: channel.id,
      guild_id: guild.id,
      owner_id: owner.id,
      interface_message_id: null,
      created_at: Date.now()
    });
  }
  await voice.cleanupEmptyTempChannels(guild);
  assert.equal(emptyClaimed.deleted, true);
  assert.equal(db.getPoolChannel(emptyClaimed.id), null);
  assert.equal(db.getTempChannel(emptyClaimed.id), undefined);
  assert.equal(busy.deleted, false);
  assert.equal(db.getPoolChannel(busy.id).status, "claimed");
});

test("restart reconciliation keeps pools and does not create another batch", async () => {
  const guild = makeGuild();
  const cat = category(guild);
  savePool(guild, cat);
  db.setPoolGeneration(guild.id, true);
  pool.requestCreates(guild, 4);
  await pool.whenIdle(guild.id);
  assert.equal(db.listPoolChannels(guild.id).length, 0);
  db.setPoolGeneration(guild.id, false);
  pool.requestCreates(guild, 4);
  await pool.whenIdle(guild.id);
  const before = db.listPoolChannels(guild.id).map((row) => row.channel_id);
  assert.equal(before.length, 4);
  const gone = before[0];
  guild.channels.cache.delete(gone);
  const orphan = makeVoice(guild, nextId(), { parent: cat.id });
  guild.channels.cache.set(orphan.id, orphan);
  guild.fetchAuditLogs = async () => ({
    entries: new Map([["1", {
      executorId: "bot-1",
      targetId: orphan.id,
      createdTimestamp: Date.now(),
      action: AuditLogEvent.ChannelCreate
    }]])
  });
  const createdBefore = guild.channels.cache.size;
  await pool.reconcileGuild(guild);
  await pool.whenIdle(guild.id);
  assert.equal(db.getPoolChannel(gone), null);
  assert.equal(db.getPoolChannel(orphan.id).status, "empty");
  assert.equal(db.getPoolConfig(guild.id).generation_stopped, 0);
  const after = db.listPoolChannels(guild.id);
  assert.equal(after.length, 4);
  assert.equal(guild.channels.cache.size, createdBefore);
  db.setPoolGeneration(guild.id, true);
  await pool.reconcileGuild(guild);
  assert.equal(db.getPoolConfig(guild.id).generation_stopped, 1);
  assert.equal(db.listPoolChannels(guild.id).length, 4);
});

test("rate limits wait, permission errors stop, and a missing category creates nothing", async () => {
  const guild = makeGuild();
  const cat = category(guild);
  savePool(guild, cat, { refill_after: 50 });
  let calls = 0;
  const original = guild.channels.create;
  guild.channels.create = async (options) => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("rate"), { status: 429, retryAfter: 20 });
    return original(options);
  };
  pool.requestCreates(guild, 1);
  await pool.whenIdle(guild.id);
  assert.equal(calls, 2);
  assert.equal(db.countPoolChannels(guild.id, "empty"), 1);

  const blocked = makeGuild();
  const blockedCategory = category(blocked);
  savePool(blocked, blockedCategory);
  let denied = 0;
  blocked.channels.create = async () => {
    denied += 1;
    throw Object.assign(new Error("missing permission"), { code: 50013 });
  };
  pool.requestCreates(blocked, 6);
  await pool.whenIdle(blocked.id);
  assert.equal(denied, 1);
  assert.equal(db.countPoolChannels(blocked.id, "empty"), 0);

  const missing = makeGuild();
  savePool(missing, { id: "missing-category" });
  let attempted = 0;
  missing.channels.create = async () => {
    attempted += 1;
    return null;
  };
  pool.requestCreates(missing, 3);
  await pool.whenIdle(missing.id);
  assert.equal(attempted, 0);
  assert.equal(db.countPoolChannels(missing.id, "empty"), 0);
});

test("pool commands stay with the server owner and status ignores claimed calls as empty", async () => {
  const guild = makeGuild();
  const cat = category(guild);
  savePool(guild, cat, { refill_after: 5, refill_batch: 10, max_empty: 30 });
  const stranger = messageFor(guild, "stranger");
  await pool.handleCommand(stranger, ["-poolstatus"], "-");
  assert.match(description(stranger.replies[0]), /server owner/);
  const empty = makeVoice(guild, nextId(), { parent: cat.id });
  const claimed = makeVoice(guild, nextId(), { parent: cat.id });
  guild.channels.cache.set(empty.id, empty);
  guild.channels.cache.set(claimed.id, claimed);
  const owner = makeMember(guild, claimed.id);
  claimed.members.set(owner.id, owner);
  db.insertPoolChannel({ channel_id: empty.id, guild_id: guild.id, status: "empty", created_at: Date.now() });
  db.insertPoolChannel({ channel_id: claimed.id, guild_id: guild.id, status: "claimed", created_at: Date.now() });
  const message = messageFor(guild);
  await pool.handleCommand(message, ["-poolstatus"], "-");
  const text = description(message.replies[0]);
  assert.match(text, /Empty pools: \*\*1\*\*/);
  assert.match(text, /Claimed and occupied: \*\*1\*\*/);
  assert.match(text, /Generation: running/);
});

test("a second pool setup cannot open while one is already in progress", async () => {
  const guild = makeGuild();
  guild.ownerId = "owner-1";
  const interaction = {
    customId: "pool-open:owner-1",
    user: { id: "owner-1" },
    guild,
    guildId: guild.id,
    async reply() {},
    async fetchReply() {
      return { id: "wizard-1", async edit() {} };
    }
  };
  assert.equal(await pool.handleInteraction(interaction), true);
  const message = messageFor(guild);
  await pool.handleCommand(message, ["-poolsetup"], "-");
  assert.match(description(message.replies[0]), /already open/);
});

test("wizard buttons keep the owner in setup after the first screen fails to save", async () => {
  const guild = makeGuild();
  guild.ownerId = "owner-1";
  const screen = { id: "wizard-screen", async edit() {} };
  const next = {
    customId: "pool:owner-1:next",
    user: { id: "owner-1" },
    guild,
    guildId: guild.id,
    message: screen,
    async update(payload) {
      next.payload = payload;
    },
    async reply(payload) {
      next.replied = payload;
    }
  };
  assert.equal(await pool.handleInteraction(next), true);
  assert.equal(next.replied, undefined);
  assert.match(next.payload.embeds[0].data.description, /Category/);
});

test("a failed screen update still shows the next setup step", async () => {
  const guild = makeGuild();
  guild.ownerId = "owner-1";
  const next = {
    customId: "pool:owner-1:next",
    user: { id: "owner-1" },
    guild,
    guildId: guild.id,
    message: { id: "wizard-screen" },
    replied: false,
    deferred: false,
    async update() {
      throw Object.assign(new Error("Invalid Form Body"), { code: 50035 });
    },
    async reply(payload) {
      next.replied = true;
      next.payload = payload;
    },
    async followUp(payload) {
      next.payload = payload;
    }
  };
  assert.equal(await pool.handleInteraction(next), true);
  assert.match(next.payload.embeds[0].data.description, /Category/);
  assert.doesNotMatch(next.payload.embeds[0].data.description, /Owner Only/);
});
