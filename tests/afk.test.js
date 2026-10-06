const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spanter-afk-"));
process.env.DB_PATH = path.join(scratch, "vc.sqlite");

const { connection } = require("../db");
const { handleCommand } = require("../commands");
const afk = require("../afk");
const { CONFIRM_ID, ERROR_ID, present } = require("../feedback");

function message(content, authorId = "111000000000000012") {
  const guild = {
    id: "afk-guild",
    emojis: { cache: { get: () => null } }
  };
  const record = {
    guild,
    content,
    author: { id: authorId, bot: false },
    mentions: { users: new Map(), members: new Map(), repliedUser: null },
    replies: [],
    async reply(payload) {
      const sent = {
        ...payload,
        deleted: false,
        async delete() {
          this.deleted = true;
        }
      };
      this.replies.push(sent);
      return sent;
    }
  };
  return record;
}

test("confirmations and errors use the configured emoji ids", () => {
  assert.match(present("Rank Assigned", "done"), new RegExp(CONFIRM_ID));
  assert.match(present("Access Denied", "nope"), new RegExp(ERROR_ID));
  assert.match(present("Usage", "`-afk [status]`"), new RegExp(ERROR_ID));
  assert.equal(present("User Info", "plain text").includes(CONFIRM_ID), false);
  assert.equal(present("User Info", "plain text").includes(ERROR_ID), false);
});

test("afk announces a status, answers mentions, and welcomes the member back", async () => {
  const member = { user: { id: "111000000000000012", bot: false }, id: "111000000000000012" };
  const guild = { id: "afk-guild", client: {} };
  const set = message("-afk grabbing food", member.id);
  set.guild = guild;
  set.author = member.user;
  set.member = member;
  await handleCommand(set, guild.client, "-");
  assert.match(set.replies[0].content, new RegExp(CONFIRM_ID));
  assert.match(set.replies[0].content, /Away with the status: grabbing food/);

  connection.prepare("UPDATE afk_status SET since=? WHERE guild_id=? AND user_id=?").run(Date.now() - 8000, guild.id, member.id);

  const asker = message("hello", "111000000000000013");
  asker.guild = guild;
  asker.mentions.users.set(member.id, { id: member.id });
  await afk.observe(asker, "-");
  assert.match(asker.replies[0].content, /grabbing food/);
  assert.match(asker.replies[0].content, /8 seconds/);
  assert.match(asker.replies[0].content, new RegExp(CONFIRM_ID));

  const reply = message("reply", "111000000000000013");
  reply.guild = guild;
  reply.mentions.repliedUser = { id: member.id };
  await afk.observe(reply, "-");
  assert.match(reply.replies[0].content, /grabbing food/);

  const back = message("k", member.id);
  back.guild = guild;
  await afk.observe(back, "-");
  assert.match(back.replies[0].content, /👋 Welcome back <@111000000000000012>/);
  assert.match(back.replies[0].content, /Away for: 8 seconds/);
  assert.equal(afk.WELCOME_DELETE_MS, 30000);

  const again = message("still here", member.id);
  again.guild = guild;
  await afk.observe(again, "-");
  assert.equal(again.replies.length, 0);
});
