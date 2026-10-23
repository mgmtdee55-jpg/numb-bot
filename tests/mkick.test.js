const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PermissionFlagsBits } = require("discord.js");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spanter-mkick-"));
process.env.DB_PATH = path.join(scratch, "vc.sqlite");

const { handleCommand } = require("../commands");
const mkick = require("../mkick");
const extras = require("../extras");
const cooldowns = require("../systems/cooldowns");

const OWNER = "100000000000000001";
const BOT = "100000000000000002";
const TAGGED = "100000000000000003";
const PLAIN = "100000000000000004";
const HIDDEN = "100000000000000005";
const OTHER = "100000000000000006";
const HIGH = "100000000000000007";
const GUILD = "200000000000000001";
function textOf(payload) {
  return String(payload?.embeds?.[0]?.data?.description || "");
}

function customId(component) {
  return component?.toJSON?.().custom_id || component?.data?.custom_id || "";
}

function baseGuild(rows, { vanity = "yrs", kick } = {}) {
  const roles = new Map([
    ["low", { id: "low", position: 1 }],
    ["high", { id: "high", position: 100 }]
  ]);
  const cache = new Map();
  const dms = [];
  const kicks = [];
  const guild = {
    id: GUILD,
    name: "yrs",
    ownerId: OWNER,
    vanityURLCode: vanity,
    roles: { cache: roles, async fetch() { return roles; } },
    members: {
      cache,
      me: {
        id: BOT,
        permissions: { has: (flag) => flag === PermissionFlagsBits.KickMembers },
        roles: { highest: { position: 20 } }
      },
      async fetch() { return cache; },
      async kick(id, reason) {
        kicks.push({ id, reason });
        if (kick) await kick(id, reason, kicks);
      }
    },
    async fetchVanityData() {
      return vanity ? { code: vanity } : null;
    },
    client: {
      user: { id: BOT },
      users: { cache: new Map() },
      rest: {
        async get() { return rows; },
        async post(route, options) {
          if (options?.body?.recipient_id) {
            dms.push({ id: options.body.recipient_id, description: options.body?.embeds ? null : null, body: options.body });
            return { id: `dm-${options.body.recipient_id}` };
          }
          const description = options?.body?.embeds?.[0]?.description || "";
          dms.push({ route, description });
          return { id: "message" };
        }
      }
    }
  };
  guild.client.rest.guild = guild;
  return { guild, cache, dms, kicks, roles };
}

function row(id, { bot = false, tag = null, enabled = true, roles = ["low"] } = {}) {
  return {
    user: {
      id,
      bot,
      primary_guild: tag === undefined ? undefined : tag
    },
    roles
  };
}

function tagRow(id, guildId, enabled = true) {
  return row(id, {
    tag: { identity_guild_id: guildId, identity_enabled: enabled, tag: "YRS" }
  });
}

function messageFor(guild, member) {
  const replies = [];
  return {
    content: "-mkick",
    guild,
    author: { id: member.id },
    member,
    replies,
    async reply(payload) {
      replies.push(payload);
      return payload;
    }
  };
}

function panel(guild) {
  const edits = [];
  const message = {
    edits,
    async edit(payload) {
      edits.push(payload);
      return payload;
    }
  };
  return {
    message,
    interaction(customId, extra = {}) {
      return {
        customId,
        guild,
        user: { id: extra.userId || OWNER },
        values: extra.values,
        message,
        async deferUpdate() { this.deferred = true; },
        async update(payload) { edits.push(payload); },
        async reply(payload) { this.repliedWith = payload; },
        async followUp(payload) { this.repliedWith = payload; }
      };
    }
  };
}

test("retry waits use Discord's retry_after", () => {
  assert.equal(mkick.retryMs({ retryAfter: 2 }), 2250);
  assert.equal(mkick.retryMs({ retryAfter: 1500 }), 1750);
  assert.equal(mkick.retryMs({ rawError: { retry_after: 0.5 } }), 750);
  assert.equal(mkick.retryMs({ status: 429 }), 2000);
  assert.equal(mkick.retryMs({ code: 50013 }), 0);
});

test("only the server owner can open -mkick", async () => {
  cooldowns.clear();
  const { guild } = baseGuild([]);
  const stranger = messageFor(guild, { id: "100000000000000099" });
  await handleCommand(stranger, null, "-");
  assert.match(textOf(stranger.replies[0]), /Only the server owner can use `-mkick`/);

  const owner = messageFor(guild, { id: OWNER });
  await handleCommand(owner, null, "-");
  const menu = owner.replies[0].components[0].components[0].toJSON();
  assert.deepEqual(menu.options.map((option) => option.value), ["tag", "all", "vanity"]);
  assert.equal(menu.custom_id, `spanter:mkick:pick:${OWNER}`);
});

test("server tag category kicks only people not repping and does not dm them", async () => {
  const rows = [
    tagRow(OWNER, GUILD),
    row(BOT, { bot: true, tag: null }),
    tagRow(TAGGED, GUILD),
    row(PLAIN, { tag: null }),
    tagRow(HIDDEN, GUILD, false),
    tagRow(OTHER, "999000000000000001"),
    row(HIGH, { tag: null, roles: ["high"] })
  ];
  const { guild, dms, kicks } = baseGuild(rows);
  const view = panel(guild);
  const pick = view.interaction(`spanter:mkick:pick:${OWNER}`, { values: ["tag"] });
  assert.equal(await mkick.handleInteraction(pick), true);
  const preview = view.message.edits.at(-1);
  assert.match(textOf(preview), /\*\*3\*\*/);
  assert.match(textOf(preview), /Nobody is sent a direct message or an invite/);
  assert.doesNotMatch(textOf(preview), /discord\.gg/);
  const startId = customId(preview.components[0].components[0]);
  assert.equal(startId, `spanter:mkick:start:${OWNER}:tag`);

  const start = view.interaction(startId);
  assert.equal(await mkick.handleInteraction(start), true);
  assert.deepEqual(kicks.map((entry) => entry.id).sort(), [HIDDEN, OTHER, PLAIN].sort());
  assert.match(kicks[0].reason, /Not repping server tag/);
  assert.equal(dms.length, 0);
  assert.match(textOf(view.message.edits.at(-1)), /Mass Kick Finished/);
  assert.match(textOf(view.message.edits.at(-1)), /Nobody was sent a direct message/);
  assert.match(textOf(view.message.edits.at(-1)), /Kicked \*\*3\*\*/);
});

test("abort stops after the current member", async () => {
  const rows = [row(PLAIN, { tag: null }), row(OTHER, { tag: null }), row(HIDDEN, { tag: null })];
  const { guild, kicks } = baseGuild(rows, {
    kick: async (id, reason, list) => {
      if (list.length !== 1) return;
      await mkick.handleInteraction({
        customId: `spanter:mkick:stop:${OWNER}`,
        guild,
        user: { id: OWNER },
        async reply(payload) { this.repliedWith = payload; }
      });
    }
  });
  const view = panel(guild);
  const start = view.interaction(`spanter:mkick:start:${OWNER}:all`);
  assert.equal(await mkick.handleInteraction(start), true);
  assert.deepEqual(kicks.map((entry) => entry.id), [PLAIN]);
  assert.match(textOf(view.message.edits.at(-1)), /Mass Kick Aborted/);
  assert.match(textOf(view.message.edits.at(-1)), /Kicked \*\*1\*\*/);
});

test("a rate limit is waited out and the same member is retried once", async () => {
  let attempts = 0;
  const { guild, kicks } = baseGuild([row(PLAIN, { tag: null })], {
    kick: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("rate limited");
        error.status = 429;
        error.retryAfter = 1;
        throw error;
      }
    }
  });
  const view = panel(guild);
  assert.equal(await mkick.handleInteraction(view.interaction(`spanter:mkick:start:${OWNER}:all`)), true);
  assert.equal(attempts, 2);
  assert.match(textOf(view.message.edits.at(-1)), /Kicked \*\*1\*\*/);
});

test("missing kick permission stops the run instead of continuing", async () => {
  const { guild, kicks } = baseGuild([row(PLAIN, { tag: null }), row(OTHER, { tag: null })], {
    kick: async () => {
      const error = new Error("missing");
      error.code = 50013;
      throw error;
    }
  });
  const view = panel(guild);
  assert.equal(await mkick.handleInteraction(view.interaction(`spanter:mkick:start:${OWNER}:all`)), true);
  assert.equal(kicks.length, 1);
  assert.match(textOf(view.message.edits.at(-1)), /lost permission to kick/);
});

test("vanity category leaves people repping the guild vanity", async () => {
  const rows = [row(PLAIN, { tag: null }), row(OTHER, { tag: null }), row(HIDDEN, { tag: null })];
  const { guild, cache, kicks } = baseGuild(rows);
  cache.set(PLAIN, { id: PLAIN, presence: { status: "online", activities: [{ type: 4, state: "discord.gg/yrs" }] } });
  cache.set(OTHER, { id: OTHER, presence: { status: "online", activities: [{ type: 4, state: "hello" }] } });
  cache.set(HIDDEN, { id: HIDDEN, presence: { status: "offline", activities: [] } });
  const view = panel(guild);
  const pick = view.interaction(`spanter:mkick:pick:${OWNER}`, { values: ["vanity"] });
  assert.equal(await mkick.handleInteraction(pick), true);
  assert.match(textOf(view.message.edits.at(-1)), /\*\*2\*\*/);
  assert.equal(await mkick.handleInteraction(view.interaction(`spanter:mkick:start:${OWNER}:vanity`)), true);
  assert.deepEqual(kicks.map((entry) => entry.id).sort(), [HIDDEN, OTHER].sort());
  assert.match(kicks[0].reason, /guild vanity/i);
});

test("vanity category does nothing when the server has no vanity", async () => {
  const { guild } = baseGuild([row(PLAIN, { tag: null })], { vanity: null });
  const view = panel(guild);
  assert.equal(await mkick.handleInteraction(view.interaction(`spanter:mkick:pick:${OWNER}`, { values: ["vanity"] })), true);
  assert.match(textOf(view.message.edits.at(-1)), /no vanity URL/i);
  assert.equal(view.message.edits.at(-1).components.length, 0);
});

test("cancel and other people cannot drive the menu", async () => {
  const { guild, kicks } = baseGuild([row(PLAIN, { tag: null })]);
  const view = panel(guild);
  const stranger = view.interaction(`spanter:mkick:start:${OWNER}:all`, { userId: "100000000000000099" });
  assert.equal(await extras.handleInteraction(stranger), true);
  assert.match(textOf(stranger.repliedWith), /Only the server owner/);
  assert.equal(kicks.length, 0);

  const cancel = view.interaction(`spanter:mkick:cancel:${OWNER}`);
  assert.equal(await mkick.handleInteraction(cancel), true);
  assert.match(textOf(view.message.edits.at(-1)), /Nobody was kicked/);
});
