const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ChannelType } = require("discord.js");

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
  assert.equal(shown.replies[0].components[0].components[0].data.label, "Join to create");
  assert.match(shown.replies[0].embeds[0].data.description, /Existing voice channels and categories stay in place/);

  const stranger = messageFor(member(MEMBER, server), "-vc config");
  await vcConfig.show(stranger);
  assert.equal(title(stranger), "Access Denied");
});

function trackedChannel(id, type, name, deleted) {
  return {
    id,
    type,
    name,
    delete: async () => {
      deleted.push(id);
    }
  };
}

function configInteraction(person, customId, extra = {}) {
  const message = {
    edits: [],
    async edit(payload) {
      this.edits.push(payload);
      return payload;
    }
  };
  return {
    customId,
    guild: person.guild,
    user: person.user,
    member: person,
    message,
    values: extra.values || [],
    fields: {
      getTextInputValue: (name) => extra.fields?.[name]
    },
    replied: false,
    deferred: false,
    async update(payload) {
      this.updated = payload;
      message.edits.push(payload);
    },
    async reply(payload) {
      this.replied = true;
      this.replyPayload = payload;
    },
    async showModal(modal) {
      this.modal = modal;
    }
  };
}

test("voice configuration updates every setting and leaves calls and categories in place", async () => {
  const deleted = [];
  const server = guild();
  server.maximumBitrate = 128000;
  const j2c = trackedChannel("333000000000000010", ChannelType.GuildVoice, "join", deleted);
  const nextJ2c = trackedChannel("333000000000000013", ChannelType.GuildVoice, "join-2", deleted);
  const category = trackedChannel("333000000000000011", ChannelType.GuildCategory, "calls", deleted);
  const nextCategory = trackedChannel("333000000000000012", ChannelType.GuildCategory, "calls-2", deleted);
  const temp = trackedChannel("333000000000000014", ChannelType.GuildVoice, "someone", deleted);
  for (const channel of [j2c, nextJ2c, category, nextCategory, temp]) {
    server.channels.cache.set(channel.id, channel);
  }
  db.setConfig({
    guild_id: server.id,
    j2c_channel_id: j2c.id,
    category_id: category.id,
    category_ids: JSON.stringify([category.id]),
    name_template: "{nickname}'s Channel",
    user_limit: 0,
    bitrate: 64000,
    cleanup_seconds: 0,
    server_interface_enabled: 1,
    server_interface_channel_id: "333000000000000099",
    server_interface_message_id: "333000000000000098"
  });
  db.addTemp({
    channel_id: temp.id,
    guild_id: server.id,
    owner_id: OWNER,
    interface_message_id: null,
    created_at: Date.now()
  });
  const owner = member(OWNER, server);
  const labels = (await (async () => {
    const shown = messageFor(owner, "-vc config");
    await vcConfig.show(shown);
    return shown.replies[0].components.flatMap((row) => row.components.map((component) => component.data.label));
  })());
  assert.deepEqual(labels, ["Join to create", "Categories", "Name", "User limit", "Bitrate", "Cleanup", "Interface"]);

  const rejected = configInteraction(owner, "spanter:vcconfig:set:j2c", { values: [category.id] });
  await vcConfig.handleButton(rejected);
  assert.match(rejected.updated.embeds[0].data.description, /voice channel/);
  assert.equal(db.getConfig(server.id).j2c_channel_id, j2c.id);

  const stranger = configInteraction(member(MEMBER, server), "spanter:vcconfig:set:j2c", { values: [nextJ2c.id] });
  await vcConfig.handleButton(stranger);
  assert.match(stranger.replyPayload.embeds[0].data.description, /server owner/);
  assert.equal(db.getConfig(server.id).j2c_channel_id, j2c.id);

  await vcConfig.handleButton(configInteraction(owner, "spanter:vcconfig:set:j2c", { values: [nextJ2c.id] }));
  await vcConfig.handleButton(configInteraction(owner, "spanter:vcconfig:set:categories", { values: [nextCategory.id] }));
  const namePrompt = configInteraction(owner, "spanter:vcconfig:name");
  await vcConfig.handleButton(namePrompt);
  assert.equal(namePrompt.modal.data.custom_id, "spanter:vcconfig:modal:name");
  await vcConfig.handleButton(configInteraction(owner, "spanter:vcconfig:modal:name", {
    fields: { name: "{username}'s Room" }
  }));
  await vcConfig.handleButton(configInteraction(owner, "spanter:vcconfig:modal:limit", {
    fields: { limit: "7" }
  }));
  await vcConfig.handleButton(configInteraction(owner, "spanter:vcconfig:set:bitrate", { values: ["96000"] }));
  await vcConfig.handleButton(configInteraction(owner, "spanter:vcconfig:set:cleanup", { values: ["300"] }));
  await vcConfig.handleButton(configInteraction(owner, "spanter:vcconfig:interface:off"));

  const config = db.getConfig(server.id);
  assert.equal(config.j2c_channel_id, nextJ2c.id);
  assert.equal(config.category_id, nextCategory.id);
  assert.deepEqual(JSON.parse(config.category_ids), [nextCategory.id]);
  assert.equal(config.name_template, "{username}'s Room");
  assert.equal(config.user_limit, 7);
  assert.equal(config.bitrate, 96000);
  assert.equal(config.cleanup_seconds, 300);
  assert.equal(config.server_interface_enabled, 0);
  assert.equal(config.server_interface_channel_id, "333000000000000099");
  assert.equal(config.server_interface_message_id, "333000000000000098");
  assert.ok(db.getTempChannel(temp.id));
  assert.equal(server.channels.cache.get(j2c.id), j2c);
  assert.equal(server.channels.cache.get(category.id), category);
  assert.equal(server.channels.cache.get(temp.id), temp);
  assert.deepEqual(deleted, []);
});

test("voice configuration waits to save until a join channel and category exist", async () => {
  const deleted = [];
  const server = {
    id: "config-draft-guild",
    ownerId: OWNER,
    maximumBitrate: 64000,
    channels: { cache: new Map() },
    roles: { cache: new Map() },
    members: { cache: new Map() }
  };
  const j2c = trackedChannel("444000000000000010", ChannelType.GuildVoice, "join", deleted);
  const category = trackedChannel("444000000000000011", ChannelType.GuildCategory, "calls", deleted);
  const temp = trackedChannel("444000000000000012", ChannelType.GuildVoice, "live", deleted);
  for (const channel of [j2c, category, temp]) server.channels.cache.set(channel.id, channel);
  db.addTemp({
    channel_id: temp.id,
    guild_id: server.id,
    owner_id: OWNER,
    interface_message_id: null,
    created_at: Date.now()
  });
  const owner = member(OWNER, server);
  const waiting = configInteraction(owner, "spanter:vcconfig:set:j2c", { values: [j2c.id] });
  await vcConfig.handleButton(waiting);
  assert.equal(db.getConfig(server.id), undefined);
  assert.match(waiting.updated.embeds[0].data.description, /stay in place/);

  await vcConfig.handleButton(configInteraction(owner, "spanter:vcconfig:set:categories", { values: [category.id] }));
  const config = db.getConfig(server.id);
  assert.equal(config.j2c_channel_id, j2c.id);
  assert.equal(config.category_id, category.id);
  assert.deepEqual(JSON.parse(config.category_ids), [category.id]);
  assert.equal(config.server_interface_enabled, 0);
  assert.ok(db.getTempChannel(temp.id));
  assert.equal(server.channels.cache.get(category.id), category);
  assert.deepEqual(deleted, []);

  const created = [];
  server.iconURL = () => null;
  server.emojis = {
    cache: new Map(),
    fetch: async () => server.emojis.cache
  };
  server.roles.everyone = { id: server.id };
  server.channels.create = async (options) => {
    const channel = trackedChannel("444000000000000099", ChannelType.GuildText, options.name, deleted);
    channel.topic = options.topic;
    channel.parentId = options.parent;
    channel.guild = server;
    channel.send = async () => ({ id: "444000000000000098" });
    created.push(options);
    server.channels.cache.set(channel.id, channel);
    return channel;
  };
  await vcConfig.handleButton(configInteraction(owner, "spanter:vcconfig:interface:on"));
  const enabled = db.getConfig(server.id);
  assert.equal(enabled.server_interface_enabled, 1);
  assert.equal(enabled.server_interface_channel_id, "444000000000000099");
  assert.equal(enabled.server_interface_message_id, "444000000000000098");
  assert.equal(created.length, 1);
  assert.equal(created[0].type, ChannelType.GuildText);
  assert.equal(created[0].parent, category.id);
  assert.ok(db.getTempChannel(temp.id));
  assert.equal(server.channels.cache.get(j2c.id), j2c);
  assert.equal(server.channels.cache.get(category.id), category);
  assert.deepEqual(deleted, []);
});
