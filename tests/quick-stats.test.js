const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createCanvas, loadImage } = require("@napi-rs/canvas");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spanter-quick-"));
process.env.DB_PATH = path.join(scratch, "vc.sqlite");
process.env.PREFIX = "-";
process.env.NODE_TEST_CONTEXT = "1";

const quick = require("../quick-stats");
const stats = require("../stats");
const catalog = require("../vouch/catalog");

const GUILD = "quick-guild";
const ME = "111000000000000021";
const OTHER = "111000000000000022";
const CHANNEL = "333000000000000021";

function person(id, name) {
  return {
    id,
    joinedTimestamp: Date.UTC(2024, 9, 1),
    displayName: name,
    user: {
      id,
      username: name,
      bot: false,
      displayAvatarURL: () => null
    }
  };
}

function guild() {
  const me = person(ME, "kutt");
  const other = person(OTHER, "nv2i");
  const members = new Map([[me.id, me], [other.id, other]]);
  return {
    id: GUILD,
    name: "post",
    channels: { cache: new Map([[CHANNEL, { id: CHANNEL, name: "general" }]]) },
    members: {
      cache: members,
      async fetch(id) { return members.get(id) || null; }
    },
    me,
    other
  };
}

async function lightPixels(buffer, x, y, width, height) {
  const image = await loadImage(buffer);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const sample = ctx.getImageData(x, y, width, height).data;
  let light = 0;
  for (let index = 0; index < sample.length; index += 4) {
    if (sample[index] > 200 && sample[index + 1] > 200 && sample[index + 2] > 200) light += 1;
  }
  return light;
}

function command(group, content, author) {
  return {
    content,
    guild: group,
    author: author.user,
    member: author,
    client: { users: { async fetch() { return null; } } },
    replies: [],
    async reply(payload) {
      this.replies.push(payload);
      return payload;
    }
  };
}

test("s-u builds the activity card for the mentioned member", async () => {
  const group = guild();
  stats.noteMessage({ guild: group, channelId: CHANNEL, author: { id: ME, bot: false } });
  stats.noteMessage({ guild: group, channelId: CHANNEL, author: { id: OTHER, bot: false } });
  stats.noteMessage({ guild: group, channelId: CHANNEL, author: { id: OTHER, bot: false } });
  stats.noteMessage({ guild: group, channelId: CHANNEL, author: { id: OTHER, bot: false } });

  const mine = quick.buildModel(group, group.me, group.me.user, "overview", "7d");
  const theirs = quick.buildModel(group, group.other, group.other.user, "overview", "7d");
  assert.equal(mine.messages, 1);
  assert.equal(theirs.messages, 3);
  assert.equal(theirs.username, "nv2i");
  assert.equal(theirs.overallRank, 1);
  assert.equal(mine.overallRank, 2);
  assert.equal(theirs.channels[0].name, "#general");
  assert.equal(theirs.channels[0].count, "3");
  assert.match(theirs.joined, /Joined Oct 2024/);

  const shown = command(group, `s-u <@${OTHER}>`, group.me);
  await quick.handleMessage(shown);
  const reply = shown.replies[0];
  assert.equal(reply.files[0].name, "quick-stats.png");
  assert.equal(reply.files[0].attachment[0], 0x89);
  assert.ok(await lightPixels(reply.files[0].attachment, 40, 120, 900, 80) > 80);
  assert.equal(reply.components[0].components[0].data.placeholder, "Change view");
  const labels = reply.components[1].components.map((button) => button.data.label);
  assert.deepEqual(labels, ["7 days", "Refresh", "Disable Quick Stats"]);
  assert.equal(reply.components[1].components[2].data.style, 4);

  const range = reply.components[1].components[0];
  let updated;
  let deferred = false;
  await quick.handleInteraction({
    customId: range.data.custom_id,
    user: group.me.user,
    guild: group,
    async deferUpdate() { deferred = true; this.deferred = true; },
    async editReply(payload) { this.edited = payload; },
    async update(payload) { updated = payload; }
  });
  assert.equal(deferred, false);
  assert.equal(updated.components[1].components[0].data.label, "24 hours");
  assert.equal(updated.files.length, 1);
  assert.deepEqual(updated.attachments, []);
  assert.deepEqual(updated.embeds, []);
  assert.ok(await lightPixels(updated.files[0].attachment, 40, 120, 900, 80) > 80);

  const stranger = {
    customId: range.data.custom_id,
    user: { id: OTHER },
    async reply(payload) { this.replied = payload; }
  };
  assert.equal(await quick.handleInteraction(stranger), true);
  assert.match(stranger.replied.content, /Only the person who opened this/);

  const prefixed = command(group, `-u ${OTHER}`, group.me);
  await quick.handleCommand(prefixed, ["-u", OTHER]);
  assert.equal(prefixed.replies[0].files[0].name, "quick-stats.png");

  const pages = catalog.commandPages("-").map((page) => page.description).join("\n");
  assert.match(pages, /`-u` activity card · Everyone/);
  assert.match(pages, /`-viewstats` voice time and messages · Everyone/);
});
