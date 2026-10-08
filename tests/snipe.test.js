const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spanter-snipe-"));
process.env.DB_PATH = path.join(scratch, "vc.sqlite");
process.env.PREFIX = "-";

const snipe = require("../snipe");

const GUILD = "snipe-guild";
const CHANNEL = "333000000000000010";
const OTHER = "333000000000000011";

function message(id, content, extra = {}) {
  return {
    id,
    guild: { id: extra.guildId || GUILD },
    channelId: extra.channelId || CHANNEL,
    content,
    author: {
      id: extra.authorId || "111000000000000010",
      username: extra.username || "dee",
      bot: !!extra.bot,
      displayAvatarURL: () => "https://cdn.example/dee.png"
    },
    attachments: extra.attachments || new Map()
  };
}

test("snipe shows deleted messages from the last 2 hours and can clear them", async () => {
  snipe.remember(message("m1", "first words"));
  snipe.remember(message("m2", "second words"));
  snipe.remember(message("bot", "ignore me", { bot: true, authorId: "900000000000000099" }));
  snipe.capture(message("m1", ""));
  snipe.capture(message("m2", "second words"));
  snipe.capture(message("bot", "ignore me", { bot: true, authorId: "900000000000000099" }));
  snipe.record({
    messageId: "old",
    guildId: GUILD,
    channelId: CHANNEL,
    authorId: "111000000000000010",
    authorName: "dee",
    content: "too old",
    deletedAt: Date.now() - snipe.TWO_HOURS_MS - 1000
  });
  snipe.record({
    messageId: "elsewhere",
    guildId: GUILD,
    channelId: OTHER,
    authorId: "111000000000000010",
    authorName: "dee",
    content: "other channel",
    deletedAt: Date.now()
  });

  const rows = snipe.list(GUILD, CHANNEL);
  assert.deepEqual(rows.map((row) => row.content), ["second words", "first words"]);

  const first = snipe.page(GUILD, CHANNEL, 0);
  assert.match(first.embeds[0].data.description, /<@111000000000000010>/);
  assert.match(first.embeds[0].data.description, /second words/);
  assert.equal(first.allowedMentions.parse.length, 0);
  assert.equal(first.embeds[0].data.footer.text, "Page 1 / 2");
  const buttons = first.components[0].components;
  assert.equal(buttons[0].data.label, "Back");
  assert.equal(buttons[0].data.disabled, true);
  assert.equal(buttons[1].data.label, "Next");
  assert.equal(buttons[1].data.disabled, false);

  const second = snipe.page(GUILD, CHANNEL, 1);
  assert.match(second.embeds[0].data.description, /first words/);
  assert.equal(second.components[0].components[1].data.disabled, true);

  const replies = [];
  const sent = {
    guild: { id: GUILD },
    channel: { id: CHANNEL },
    async reply(payload) {
      replies.push(payload);
      return payload;
    }
  };
  await snipe.handleCommand(sent, "cs");
  assert.match(replies[0].embeds[0].data.description, /Forgot \*\*2\*\*/);
  assert.equal(snipe.list(GUILD, CHANNEL).length, 0);
  assert.equal(snipe.list(GUILD, OTHER).length, 1);

  await snipe.handleCommand(sent, "s");
  assert.match(replies[1].embeds[0].data.description, /No deleted messages/);
});
