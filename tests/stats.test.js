const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spanter-stats-"));
process.env.DB_PATH = path.join(scratch, "vc.sqlite");
process.env.PREFIX = "-";
process.env.npm_lifecycle_event = "test";

const db = require("../db");
const stats = require("../stats");
const { handleCommand } = require("../commands");

const GUILD = "444000000000000010";
const MOD = "111000000000000021";
const TARGET = "111000000000000022";
const GENERAL = "333000000000000021";
const LOUNGE = "333000000000000022";
const DAY = 24 * 60 * 60 * 1000;

function message(content, authorId = MOD) {
  const replies = [];
  return {
    content,
    guild: {
      id: GUILD,
      members: {
        cache: new Map(),
        async fetch() { return null; }
      }
    },
    author: {
      id: authorId,
      bot: false,
      username: "mod",
      displayAvatarURL: () => "https://cdn.example/mod.png"
    },
    member: { id: authorId },
    client: { users: { async fetch() { return null; } } },
    mentions: {
      users: { first: () => null },
      members: { first: () => null },
      roles: { first: () => null },
      channels: { first: () => null }
    },
    replies,
    async reply(payload) {
      replies.push(payload);
      return payload;
    }
  };
}

function voice(channelId) {
  return {
    id: MOD,
    channelId,
    guild: { id: GUILD },
    member: { user: { bot: false } }
  };
}

test("modstats shows issued actions and opens the matching list", async () => {
  db.addBanHistory({
    guild_id: GUILD,
    user_id: TARGET,
    action: "ban",
    reason: "spam",
    moderator_id: MOD,
    created_at: Date.now()
  });
  db.addBanHistory({
    guild_id: GUILD,
    user_id: TARGET,
    action: "unban",
    reason: "appeal",
    moderator_id: MOD,
    created_at: Date.now()
  });
  stats.recordAction(GUILD, MOD, TARGET, "kick", "broke the rules");
  const shown = message("-modstats");
  await handleCommand(shown, null, "-");
  const description = shown.replies[0].embeds[0].data.description;
  assert.equal(shown.replies[0].embeds[0].data.title, "Moderation Stats");
  assert.equal(shown.replies[0].embeds[0].data.thumbnail.url, "https://cdn.example/mod.png");
  assert.match(description, new RegExp(`<@${MOD}>`));
  assert.match(description, /\*\*Warns issued:\*\* 0/);
  assert.match(description, /\*\*Kicks issued:\*\* 1/);
  assert.match(description, /\*\*Bans issued:\*\* 1/);
  assert.match(description, /\*\*Mutes issued:\*\* 0/);
  assert.match(description, /\*\*Total actions:\*\* 2/);
  const labels = shown.replies[0].components[0].components.map((button) => button.data.label);
  assert.deepEqual(labels, ["Warns", "Kicks", "Bans", "Mutes", "All"]);

  const bans = shown.replies[0].components[0].components.find((button) => button.data.label === "Bans");
  const interaction = {
    customId: bans.data.custom_id,
    guild: shown.guild,
    client: shown.client,
    async update(payload) { this.updated = payload; }
  };
  assert.equal(await stats.handleButton(interaction), true);
  assert.match(interaction.updated.embeds[0].data.description, /spam/);
  assert.match(interaction.updated.embeds[0].data.description, new RegExp(`<@${TARGET}>`));
  assert.doesNotMatch(interaction.updated.embeds[0].data.description, /appeal/);
});

test("viewstats shows all time, 24 hour, and 7 day activity for the caller", async () => {
  stats.noteMessage({ guild: { id: GUILD }, channelId: GENERAL, author: { id: MOD, bot: false } });
  stats.noteMessage({ guild: { id: GUILD }, channelId: GENERAL, author: { id: MOD, bot: false } });
  stats.noteMessage({ guild: { id: GUILD }, channelId: LOUNGE, author: { id: MOD, bot: false } });
  const older = Date.now() - (3 * DAY);
  stats.trackVoice(voice(null), voice(LOUNGE), older);
  stats.trackVoice(voice(LOUNGE), voice(null), older + (2 * 60 * 60 * 1000));
  stats.trackVoice(voice(null), voice(GENERAL), Date.now() - (30 * 60 * 1000));
  stats.trackVoice(voice(GENERAL), voice(null), Date.now());

  const shown = message("-viewstats");
  await handleCommand(shown, null, "-");
  const description = shown.replies[0].embeds[0].data.description;
  assert.equal(shown.replies[0].embeds[0].data.title, "Activity");
  assert.match(description, /\*\*All time\*\*/);
  assert.match(description, /Voice: 2 hours 30 minutes/);
  assert.match(description, /Messages: 3/);
  assert.match(description, new RegExp(`Most messages: <#${GENERAL}> · 2`));
  assert.match(description, /\*\*Last 24 hours\*\*/);
  assert.match(description, /Voice: 30 minutes/);
  assert.match(description, /\*\*Last 7 days\*\*/);
  assert.match(description, new RegExp(`Most voice: <#${LOUNGE}> · 2 hours`));
});
