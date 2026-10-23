const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spanter-compliance-"));
process.env.DB_PATH = path.join(scratch, "vc.sqlite");
process.env.PREFIX = "-";

const { connection } = require("../db");
const systems = require("../systems");
const security = require("../security");
const logs = require("../systems/logs");
const store = require("../systems/store");
const voice = require("../voice");
const giveaways = require("../giveaways");
const mkick = require("../mkick");

function mockClient() {
  const counts = new Map();
  const handlers = new Map();
  return {
    counts,
    handlers,
    guilds: { cache: new Map() },
    on(event, handler) {
      counts.set(event, (counts.get(event) || 0) + 1);
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    }
  };
}

test("listener registration is idempotent for one client", () => {
  const client = mockClient();
  systems.bindClient(client);
  const first = new Map(client.counts);
  systems.bindClient(client);
  security.bind(client);
  assert.deepEqual(client.counts, first);
  assert.equal(first.get("guildAuditLogEntryCreate"), 3);
  assert.equal(first.get("voiceStateUpdate"), 1);
  assert.equal(first.get("messageDelete"), 1);
});

test("bot-authored deletes do not send a log, and a member delete still does", async () => {
  const client = mockClient();
  systems.bindClient(client);
  const guild = {
    id: "510000000000000001",
    channels: {
      cache: new Map(),
      async fetch() { return null; }
    }
  };
  let sends = 0;
  const channel = {
    id: "510000000000000002",
    async send() {
      sends += 1;
      return { id: "logged" };
    }
  };
  guild.channels.cache.set(channel.id, channel);
  store.setLog(guild.id, "message", channel.id);
  const handler = client.handlers.get("messageDelete")[0];
  await handler({ guild, author: { id: "9", bot: true }, channelId: channel.id, content: "bot" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 0);
  await handler({ guild, author: { id: "8", bot: false }, channelId: channel.id, content: "person" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 1);
});

test("event log retries a rate limit once and does not retry a permission error", async () => {
  const guild = {
    id: "510000000000000011",
    channels: { cache: new Map(), async fetch() { return null; } }
  };
  const limited = {
    id: "510000000000000012",
    attempts: 0,
    async send() {
      this.attempts += 1;
      if (this.attempts === 1) {
        const error = new Error("rate");
        error.status = 429;
        error.retryAfter = 0.01;
        throw error;
      }
      return { id: "ok" };
    }
  };
  const denied = {
    id: "510000000000000013",
    attempts: 0,
    async send() {
      this.attempts += 1;
      const error = new Error("missing");
      error.status = 403;
      error.code = 50013;
      throw error;
    }
  };
  guild.channels.cache.set(limited.id, limited);
  guild.channels.cache.set(denied.id, denied);
  store.setLog(guild.id, "message", limited.id);
  assert.equal(await logs.sendLog(guild, "message", "hello"), true);
  assert.equal(limited.attempts, 2);
  store.setLog(guild.id, "role", denied.id);
  assert.equal(await logs.sendLog(guild, "role", "nope"), false);
  assert.equal(denied.attempts, 1);
});

test("security log channels are created once when two requests overlap", async () => {
  let creates = 0;
  const guild = {
    id: "510000000000000021",
    channels: {
      cache: new Map(),
      async create() {
        creates += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        const channel = { id: `51000000000000003${creates}` };
        this.cache.set(channel.id, channel);
        return channel;
      }
    }
  };
  const [first, second] = await Promise.all([
    security.ensureChannel(guild, "events"),
    security.ensureChannel(guild, "events")
  ]);
  assert.equal(creates, 1);
  assert.equal(first.id, second.id);
});

test("a deleted interface is not posted again inside the resend gap", async () => {
  const db = require("../db");
  const channel = {
    id: "510000000000000031",
    guild: {
      id: "510000000000000032",
      iconURL() { return null; },
      emojis: { cache: new Map(), async fetch() { return this.cache; } }
    },
    sends: 0,
    messages: {
      async fetch() {
        const error = new Error("unknown message");
        error.code = 10008;
        throw error;
      }
    },
    async send() {
      this.sends += 1;
      return { id: `51000000000000004${this.sends}` };
    }
  };
  db.addTemp({
    channel_id: channel.id,
    guild_id: channel.guild.id,
    owner_id: "510000000000000033",
    interface_message_id: null,
    created_at: Date.now()
  });
  const first = await voice.ensureTempInterface(channel, "510000000000000033");
  const second = await voice.ensureTempInterface(channel, "510000000000000033");
  assert.equal(channel.sends, 1);
  assert.equal(first.id, "510000000000000041");
  assert.equal(second, null);
});

test("closing one giveaway twice announces once, and resume does not schedule a second close", async () => {
  const guildId = "510000000000000041";
  const channelId = "510000000000000042";
  const sends = [];
  const channel = {
    id: channelId,
    async send(payload) {
      sends.push(payload);
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { id: "announced" };
    }
  };
  const client = {
    guilds: {
      cache: new Map([[guildId, { id: guildId, channels: { cache: new Map([[channelId, channel]]) } }]])
    }
  };
  const inserted = connection.prepare(`
    INSERT INTO giveaways(guild_id, channel_id, message_id, host_id, prize, winner_count, ends_at, ended, entrants, winners, created_at)
    VALUES(?,?,?,?,?,?,?,0,'[]','[]',?)
  `).run(guildId, channelId, null, "510000000000000043", "Prize", 1, Date.now() + 60000, Date.now());
  await Promise.all([
    giveaways.closeGiveaway(client, inserted.lastInsertRowid),
    giveaways.closeGiveaway(client, inserted.lastInsertRowid)
  ]);
  assert.equal(sends.length, 1);

  sends.length = 0;
  connection.prepare(`
    INSERT INTO giveaways(guild_id, channel_id, message_id, host_id, prize, winner_count, ends_at, ended, entrants, winners, created_at)
    VALUES(?,?,?,?,?,?,?,0,'["510000000000000044"]','[]',?)
  `).run(guildId, channelId, null, "510000000000000043", "Later", 1, Date.now() - 1000, Date.now());
  giveaways.resume(client);
  giveaways.resume(client);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].allowedMentions.users, ["510000000000000044", "510000000000000043"]);
});

test("mass kick text does not build an invite dm", () => {
  assert.doesNotMatch(mkick.dmText("tag", { name: "yrs" }), /discord\.gg/);
  assert.doesNotMatch(mkick.dmText("all", { name: "yrs" }), /discord\.gg/);
  assert.match(mkick.dmText("vanity", { name: "yrs" }), /No direct message is sent/);
});
