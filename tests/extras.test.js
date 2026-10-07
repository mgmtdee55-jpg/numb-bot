const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spanter-extras-"));
process.env.DB_PATH = path.join(scratch, "vc.sqlite");
process.env.PREFIX = "-";

const db = require("../db");
const personalBan = require("../personal-ban");
const { aliasCommand } = require("../vouch/settings");
const vouchStore = require("../vouch/store");
const giveaways = require("../giveaways");
const { previewEmbed, panelPayload } = require("../embed-panel");
const { robloxEmbed, instagramEmbed, tiktokEmbed, parseInstagramHtml, parseTikTokHtml } = require("../profiles");
const vcConfig = require("../vc-config");
const { editedCommandContent } = require("../commands");

const GUILD = "extras-guild";
const OWNER = "111000000000000001";
const GOD = "111000000000000002";
const MEMBER = "111000000000000003";
const TARGET = "111000000000000004";

function member(id, guild) {
  return {
    id,
    guild,
    user: { id, username: id },
    permissions: { has: () => false },
    roles: { cache: new Map() }
  };
}

function guild() {
  return {
    id: GUILD,
    ownerId: OWNER,
    channels: { cache: new Map() },
    roles: { cache: new Map([[GUILD, { id: GUILD, name: "@everyone" }]]) },
    members: {
      ban: async () => null,
      cache: new Map()
    }
  };
}

function messageFor(person, content = "-alias") {
  const record = {
    guild: person.guild,
    author: person.user,
    member: person,
    content,
    replies: [],
    async reply(payload) {
      this.replies.push(payload);
      return payload;
    }
  };
  return record;
}

function title(message) {
  const data = message.replies.at(-1).embeds[0].data;
  if (data.title) return data.title;
  const match = String(data.description || "").match(/\*\*([^*]+)\*\*/);
  return match ? match[1] : "";
}

test("personal bans can only be lifted by the banner or the server owner", async () => {
  const server = guild();
  const owner = member(OWNER, server);
  const god = member(GOD, server);
  const other = member(MEMBER, server);
  db.addPersonalBan({
    guild_id: GUILD,
    user_id: TARGET,
    banner_id: GOD,
    created_at: Date.now(),
    username: "target"
  });
  const record = db.getPersonalBan(GUILD, TARGET);
  assert.equal(personalBan.canLift(god, record), true);
  assert.equal(personalBan.canLift(owner, record), true);
  assert.equal(personalBan.canLift(other, record), false);
  assert.match(personalBan.publicReason(record), /<@111000000000000002>/);

  const denied = messageFor(other, `-unban ${TARGET}`);
  const refusal = await personalBan.refusal(denied, TARGET);
  assert.equal(refusal, denied.replies[0]);
  assert.equal(title(denied), "Personal Ban");
  assert.equal(personalBan.liftIfAllowed(denied, TARGET), false);
  assert.ok(db.getPersonalBan(GUILD, TARGET));

  const allowed = messageFor(god, `-unban ${TARGET}`);
  assert.equal(await personalBan.refusal(allowed, TARGET), null);
  assert.equal(personalBan.liftIfAllowed(allowed, TARGET), true);
  assert.equal(db.getPersonalBan(GUILD, TARGET), null);

  const placed = messageFor(owner, `-pban ${TARGET}`);
  let banned = null;
  server.members.ban = async (id, options) => {
    banned = { id, options };
  };
  await personalBan.place(placed, TARGET, { username: "target" });
  assert.equal(title(placed), "Personal Ban");
  assert.equal(banned.id, TARGET);
  assert.match(banned.options.reason, /Personal ban from 111000000000000001/);
  assert.equal(db.getPersonalBan(GUILD, TARGET).banner_id, OWNER);
});

test("alias removeall, view, and reset only keep the requested command", async () => {
  const server = guild();
  const owner = member(OWNER, server);
  const stranger = member(MEMBER, server);
  vouchStore.setAlias(GUILD, "vg", "vouch give", OWNER);
  vouchStore.setAlias(GUILD, "vb", "vouch blacklist", OWNER);
  vouchStore.setAlias(GUILD, "hi", "help", OWNER);

  const denied = messageFor(stranger);
  await aliasCommand(denied, ["-alias", "reset"], "-");
  assert.equal(title(denied), "Not Allowed");
  assert.equal(vouchStore.listAliases(GUILD).length, 3);

  const viewed = messageFor(owner);
  await aliasCommand(viewed, ["-alias", "view", "vg"], "-");
  assert.match(viewed.replies[0].embeds[0].data.description, /`-vg` runs `-vouch give`/);

  const removed = messageFor(owner);
  await aliasCommand(removed, ["-alias", "removeall", "vouch"], "-");
  assert.equal(title(removed), "Aliases Removed");
  assert.deepEqual(vouchStore.listAliases(GUILD).map((row) => row.shortcut), ["hi"]);

  const reset = messageFor(owner);
  await aliasCommand(reset, ["-alias", "reset"], "-");
  assert.equal(title(reset), "Aliases Reset");
  assert.equal(vouchStore.listAliases(GUILD).length, 0);
});

test("giveaway draws skip the host and previous winners and ping the new winner", () => {
  const picked = giveaways.draw(["1", "2", "3"], 2, new Set(["2"]));
  assert.equal(picked.length, 2);
  assert.ok(!picked.includes("2"));
  assert.match(giveaways.announceText(["4"], "nitro", "9"), /<@4> won \*\*nitro\*\*! You have 3 minutes to DM <@9>\./);
  const embed = giveaways.giveawayEmbed({
    prize: "nitro",
    host_id: "9",
    winner_count: 1,
    ends_at: Date.now() + 60000,
    entrants: "[]"
  });
  assert.equal(embed.data.title, "nitro");
  assert.match(embed.data.description, /Host: <@9>/);
});

test("an edited message is a command only when the prefix text changed", () => {
  const author = { id: "1", bot: false };
  const guild = { id: "g" };
  const before = { guild, author, content: "-vocuch give <@2>" };
  const after = { guild, author, content: "-vouch give <@2>" };
  assert.equal(editedCommandContent(before, after, "-"), "-vouch give <@2>");
  assert.equal(editedCommandContent(after, after, "-"), "");
  assert.equal(editedCommandContent(before, { ...after, content: "hello" }, "-"), "");
  assert.equal(editedCommandContent(before, { ...after, author: { id: "1", bot: true } }, "-"), "");
});

test("embed preview keeps emoji text and profile embeds include a profile button", () => {
  const draft = { author: "Dee", description: "hello <:wave:123> 🎉", footer: "footer" };
  const preview = previewEmbed(draft).data;
  assert.equal(preview.author.name, "Dee");
  assert.match(preview.description, /<:wave:123>/);
  assert.equal(preview.footer.text, "footer");
  const panel = panelPayload(draft);
  assert.equal(panel.embeds.length, 2);
  assert.equal(panel.components[0].components.length, 5);

  const roblox = robloxEmbed({
    id: "3133917297",
    display: "act",
    username: "MyActivist",
    createdLabel: "December 12, 2021",
    ago: "5 years ago",
    status: "Offline",
    friends: 39,
    followers: 0,
    following: 0,
    groups: 23,
    avatar: "https://cdn.example/roblox.png"
  });
  const robloxText = roblox.embeds[0].data.description;
  assert.match(roblox.embeds[0].data.title, /act \(@MyActivist\)/);
  assert.match(robloxText, /Created December 12, 2021 \(5 years ago\) · Offline/);
  assert.match(robloxText, /Friends 39 · Followers 0 · Following 0 · Groups 23/);
  assert.match(robloxText, /ID 3133917297/);
  assert.equal(roblox.components[0].components[0].data.label, "View Profile");
  assert.match(roblox.components[0].components[0].data.url, /3133917297/);

  const instagram = instagramEmbed({
    username: "spanter",
    name: "Spanter",
    followers: 12,
    following: 3,
    posts: 4,
    bio: "hi",
    avatar: "https://cdn.example/ig.png",
    private: true
  });
  assert.match(instagram.embeds[0].data.description, /@spanter · Private/);
  assert.match(instagram.embeds[0].data.description, /12 followers · 3 following · 4 posts/);
  assert.equal(instagram.components[0].components[0].data.label, "View Profile");

  const parsed = parseInstagramHtml(`{"xig_user_by_igid_v2":{"full_name":"slimeballa","username":"igotblue100s","biography":"hello","is_verified":false,"follower_count":921,"following_count":152,"profile_pic_url":"https://cdn.example/ig.jpg","is_private":true}}`, "igotblue100s");
  assert.equal(parsed.private, true);
  assert.equal(parsed.followers, 921);
  assert.equal(parsed.name, "slimeballa");

  const tiktok = tiktokEmbed({
    username: "tiktok",
    name: "TikTok",
    followers: 10,
    following: 1,
    likes: 20,
    videos: 2,
    bio: "next",
    avatar: "https://cdn.example/tt.png"
  });
  assert.match(tiktok.embeds[0].data.description, /10 followers · 1 following · 20 likes · 2 videos/);
  assert.match(tiktok.components[0].components[0].data.url, /tiktok\.com\/@tiktok/);
  const tiktokParsed = parseTikTokHtml(`{"userInfo":{"user":{"uniqueId":"tiktok","nickname":"TikTok","signature":"hi","avatarLarger":"https://cdn.example/tt.png","verified":true,"privateAccount":true},"stats":{"followerCount":5,"followingCount":1,"heartCount":9,"videoCount":2}}}`);
  assert.equal(tiktokParsed.private, true);
  assert.equal(tiktokParsed.followers, 5);
  assert.equal(tiktokParsed.name, "TikTok");
});

test("voice configuration is visible to gods and owners and hidden from everyone else", async () => {
  const server = guild();
  server.channels.cache.set("333000000000000010", { id: "333000000000000010", name: "join" });
  db.setConfig({
    guild_id: server.id,
    j2c_channel_id: "333000000000000010",
    category_id: "333000000000000011"
  });
  const owner = member(OWNER, server);
  const shown = messageFor(owner, "-vc config");
  await vcConfig.show(shown);
  assert.equal(title(shown), "VoiceMaster Configuration");
  assert.match(shown.replies[0].embeds[0].data.description, /333000000000000010/);
  assert.equal(shown.replies[0].components[0].components[0].data.label, "Configure");

  const stranger = messageFor(member(MEMBER, server), "-vc config");
  await vcConfig.show(stranger);
  assert.equal(title(stranger), "Access Denied");
});
