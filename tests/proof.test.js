const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ChannelType } = require("discord.js");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spanter-proof-"));
process.env.DB_PATH = path.join(scratch, "vc.sqlite");
process.env.PREFIX = "-";
process.env.NODE_TEST_CONTEXT = process.env.NODE_TEST_CONTEXT || "1";

const proof = require("../proof");
const catalog = require("../vouch/catalog");
const help = require("../vouch/help");

const GUILD = "proof-guild";
const CHANNEL = "333000000000000010";
const OWNER = "111000000000000001";
const USER = "111000000000000003";
const QUIET = "111000000000000004";
const BOT = "111000000000000099";
const INVITER = "111000000000000008";
const OTHER = "111000000000000009";

function person(id, name, joinedTimestamp) {
  return {
    id,
    joinedTimestamp,
    displayName: name,
    user: {
      id,
      username: name,
      bot: false,
      displayAvatarURL: () => "https://cdn.example/avatar.png"
    }
  };
}

function imageMessage(id, authorId, url, createdTimestamp, extra = {}) {
  return {
    id,
    channelId: CHANNEL,
    guildId: GUILD,
    content: extra.content || "",
    createdTimestamp,
    author: { id: authorId, bot: !!extra.bot, username: extra.name || "sam" },
    attachments: extra.attachments || new Map([[url, { url, name: url.split("/").pop(), contentType: extra.type || "image/png" }]]),
    embeds: extra.embeds || []
  };
}

function makeGuild(messages) {
  const owner = person(OWNER, "Dee", 1_600_000_000_000);
  const user = person(USER, "Sam", 1_700_000_000_000);
  const quiet = person(QUIET, "Quiet", 1_800_000_000_000);
  const bot = person(BOT, "Bot", 1_700_000_000_000);
  bot.user.bot = true;
  const members = new Map([[owner.id, owner], [user.id, user], [quiet.id, quiet], [bot.id, bot]]);
  const invites = new Map([
    ["sam", { code: "sam", uses: 1, inviter: { id: INVITER } }],
    ["quiet", { code: "quiet", uses: 1, inviter: { id: OTHER } }]
  ]);
  const channel = {
    id: CHANNEL,
    type: ChannelType.GuildText,
    messages: {
      async fetch() {
        return new Map(messages.map((message) => [message.id, message]));
      }
    }
  };
  const guild = {
    id: GUILD,
    channels: { cache: new Map([[channel.id, channel]]) },
    invites: { fetch: async () => invites },
    members: {
      cache: members,
      me: { id: "proof-bot" },
      async fetch(arg) {
        if (!arg || typeof arg === "object") return members;
        return members.get(arg) || null;
      }
    }
  };
  channel.guild = guild;
  for (const member of members.values()) member.guild = guild;
  return { guild, owner, user, quiet, invites };
}

function commandMessage(guild, member, content) {
  return {
    guild,
    author: member.user,
    member,
    content,
    channel: { async sendTyping() {} },
    replies: [],
    async reply(payload) {
      this.replies.push(payload);
      return payload;
    }
  };
}

test("proof pages images sent after joining and the lists show who did and did not upload", async () => {
  const messages = [
    imageMessage("444000000000000001", USER, "https://cdn.example/old.png", 1_600_000_000_000),
    imageMessage("444000000000000002", USER, "https://cdn.example/first.png", 1_700_000_000_100),
    imageMessage("444000000000000003", USER, "https://cdn.example/second.png", 1_700_000_000_200, { content: "finished the page" }),
    imageMessage("444000000000000004", USER, "https://cdn.example/notes.pdf", 1_700_000_000_300, {
      attachments: new Map([["pdf", { url: "https://cdn.example/notes.pdf", name: "notes.pdf", contentType: "application/pdf" }]]),
      content: "notes"
    }),
    imageMessage("444000000000000005", BOT, "https://cdn.example/bot.png", 1_700_000_000_400, { bot: true }),
    {
      id: "444000000000000006",
      channelId: CHANNEL,
      guildId: GUILD,
      content: "hello",
      createdTimestamp: 1_700_000_000_500,
      author: { id: USER, bot: false, username: "sam" },
      attachments: new Map()
    }
  ];
  const { guild, owner, user, quiet, invites } = makeGuild(messages);
  await proof.cacheInvites(guild);
  invites.get("sam").uses = 2;
  await proof.noteJoin(user);
  invites.get("quiet").uses = 2;
  await proof.noteJoin(quiet);

  const shown = commandMessage(guild, owner, `-proof ${USER}`);
  await proof.handleCommand(shown, "proof", ["-proof", USER]);
  const card = shown.replies[0].embeds[0].data;
  assert.equal(card.title, "Proof");
  assert.equal(card.image.url, "https://cdn.example/second.png");
  assert.match(card.description, new RegExp(USER));
  assert.match(card.description, /<t:1700000000:F>/);
  assert.match(card.description, new RegExp(`Invited by <@${INVITER}>`));
  assert.match(card.description, /Account created/);
  assert.match(card.description, /finished the page/);
  assert.equal(card.footer.text, "Image 1 / 2");
  assert.doesNotMatch(card.description, /old\.png/);
  const back = shown.replies[0].components[0].components[0];
  const next = shown.replies[0].components[0].components[1];
  assert.equal(back.data.disabled, true);
  assert.equal(next.data.label, "Next");

  let updated;
  const stranger = {
    customId: next.data.custom_id,
    user: { id: QUIET },
    guild,
    async reply(payload) { this.replied = payload; },
    async update(payload) { updated = payload; }
  };
  assert.equal(await proof.handleButton(stranger), true);
  assert.equal(updated, undefined);
  assert.equal(stranger.replied.embeds[0].data.title, "Not Yours");

  await proof.handleButton({
    customId: next.data.custom_id,
    user: owner.user,
    guild,
    members: guild.members,
    async update(payload) { updated = payload; }
  });
  assert.equal(updated.embeds[0].data.image.url, "https://cdn.example/first.png");
  assert.equal(updated.embeds[0].data.footer.text, "Image 2 / 2");

  const listed = commandMessage(guild, owner, "-prooflist");
  await proof.handleCommand(listed, "prooflist", ["-prooflist"]);
  const list = listed.replies[0].embeds[0].data;
  assert.equal(list.title, "Proof List");
  assert.match(list.description, /1\*\* person has uploaded/);
  assert.match(list.description, new RegExp(USER));
  assert.match(list.description, new RegExp(INVITER));
  assert.match(list.description, /2 images/);
  assert.doesNotMatch(list.description, new RegExp(QUIET));
  assert.doesNotMatch(list.description, new RegExp(BOT));

  const missing = commandMessage(guild, owner, "-noproof");
  await proof.handleCommand(missing, "noproof", ["-noproof"]);
  const none = missing.replies[0].embeds[0].data;
  assert.equal(none.title, "No Proof");
  assert.match(none.description, new RegExp(QUIET));
  assert.match(none.description, /<t:1800000000:F>/);
  assert.match(none.description, new RegExp(`Invited by <@${OTHER}>`));
  assert.doesNotMatch(none.description, new RegExp(USER));
  assert.doesNotMatch(none.description, new RegExp(BOT));

  const usage = commandMessage(guild, owner, "-proof");
  await proof.handleCommand(usage, "proof", ["-proof"]);
  assert.match(usage.replies[0].embeds[0].data.description, /\*\*Command:\*\* proof/);
  assert.match(usage.replies[0].embeds[0].data.description, /Everyone/);

  const pages = catalog.commandPages("-").map((page) => page.description).join("\n");
  assert.match(pages, /`-proof` images a member sent since joining · Everyone/);
  assert.match(pages, /`-prooflist` who has uploaded an image · Everyone/);
  assert.match(pages, /`-noproof` who has not uploaded an image · Everyone/);
  assert.match(pages, /`-snipe` deleted messages from the last 2 hours · Everyone/);
  const info = help.renderHelp("info", "-", null);
  assert.match(info.data.description, /`-avatar \[@user\]`/);
  assert.match(info.data.description, /`-proof @user`/);
  assert.match(info.data.description, /`-prooflist`/);
  assert.match(info.data.description, /`-noproof`/);
});
