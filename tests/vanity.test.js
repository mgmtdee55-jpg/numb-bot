const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ActivityType } = require("discord.js");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spanter-vanity-"));
process.env.DB_PATH = path.join(scratch, "vc.sqlite");
process.env.PREFIX = "-";

const vanity = require("../vanity");
const { handleCommand } = require("../commands");

const GUILD = "vanity-guild";
const OWNER = "111000000000000001";
const MEMBER = "111000000000000003";
const CAM = "222000000000000020";
const VIP = "222000000000000021";

function titleOf(message) {
  const data = message.replies.at(-1).embeds[0].data;
  if (data.title) return data.title;
  const match = String(data.description || "").match(/\*\*([^*]+)\*\*/);
  return match ? match[1] : "";
}

function person(id, guild) {
  return {
    id,
    guild,
    user: { id, bot: false, username: id },
    permissions: { has: () => false },
    roles: { cache: new Map() }
  };
}

function makeGuild() {
  const roles = new Map([
    [GUILD, { id: GUILD, name: "@everyone", managed: false }],
    [CAM, { id: CAM, name: "camperms", managed: false }],
    [VIP, { id: VIP, name: "role 3", managed: false }]
  ]);
  return {
    id: GUILD,
    ownerId: OWNER,
    roles: { cache: roles },
    members: { cache: new Map() }
  };
}

function message(guild, member, content, mentions = []) {
  const roleMap = new Map(mentions.map((role) => [role.id, role]));
  return {
    guild,
    author: member.user,
    member,
    content,
    mentions: { roles: roleMap, members: { first: () => null } },
    replies: [],
    async reply(payload) {
      this.replies.push(payload);
      return payload;
    }
  };
}

test("vanity matching ignores capitals and extra numbers", () => {
  assert.equal(vanity.hasVanity("/tunes101", "tunes"), true);
  assert.equal(vanity.hasVanity("@tUnEs", "tunes"), true);
  assert.equal(vanity.hasVanity("carTUNES", "tunes"), true);
  assert.equal(vanity.hasVanity("cartunes", "tunes"), true);
  assert.equal(vanity.hasVanity("repping TUNES", "tunes"), true);
  assert.equal(vanity.hasVanity("tunes", "tunes"), true);
  assert.equal(vanity.hasVanity("tune", "tunes"), false);
  assert.equal(vanity.hasVanity("", "tunes"), false);
  assert.equal(vanity.statusText(null), null);
  assert.equal(vanity.statusText({ status: "online", activities: [] }), "");
  assert.equal(vanity.statusText({ status: "offline", activities: [] }), null);
  assert.equal(vanity.statusText({
    status: "online",
    activities: [{ type: ActivityType.Custom, state: "/tunes101" }]
  }), "/tunes101");
});

test("only gods and the server owner can set the vanity name and reward roles", async () => {
  const guild = makeGuild();
  const owner = person(OWNER, guild);
  const stranger = person(MEMBER, guild);
  const denied = message(guild, stranger, "-vanity set tunes");
  await handleCommand(denied, {}, "-");
  assert.equal(titleOf(denied), "Access Denied");

  const named = message(guild, owner, "-vanity set tunes");
  await handleCommand(named, {}, "-");
  assert.equal(titleOf(named), "Vanity Name Set");
  assert.equal(vanity.getConfig(guild.id).name, "tunes");

  const rewarded = message(guild, owner, "-vanity reward @camperms, role 3", [
    guild.roles.cache.get(CAM),
    guild.roles.cache.get(VIP)
  ]);
  await handleCommand(rewarded, {}, "-");
  assert.equal(titleOf(rewarded), "Vanity Rewards Set");
  assert.deepEqual(vanity.getConfig(guild.id).roleIds, [CAM, VIP]);

  const panel = message(guild, owner, "-vanitysetup");
  await handleCommand(panel, {}, "-");
  assert.equal(panel.replies[0].embeds[0].data.title, "Vanity Rewards");
  assert.equal(panel.replies[0].components.length, 2);
  assert.match(panel.replies[0].embeds[0].data.description, /tunes/);
});

test("vanity stays while the status has it, and leaves when they go offline or hide", async () => {
  const guild = makeGuild();
  vanity.getConfig(guild.id);
  const { connection } = require("../db");
  connection.prepare("INSERT INTO vanity_config(guild_id, name, role_ids) VALUES(?,?,?) ON CONFLICT(guild_id) DO UPDATE SET name=excluded.name, role_ids=excluded.role_ids")
    .run(guild.id, "tunes", JSON.stringify([VIP]));
  const member = person(MEMBER, guild);
  member.roles.cache = new Map();
  let attempts = 0;
  member.roles.add = async (roleId) => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("rate limited");
      error.retryAfter = 0.01;
      throw error;
    }
    member.roles.cache.set(roleId, { id: roleId });
  };
  member.roles.remove = async (roleId) => { member.roles.cache.delete(roleId); };
  member.presence = { status: "online", activities: [{ type: ActivityType.Custom, state: "/tunes" }] };
  await vanity.applyMember(member);
  assert.equal(member.roles.cache.has(VIP), true);
  assert.equal(attempts, 2);

  member.presence = { status: "online", activities: [] };
  await vanity.applyMember(member);
  assert.equal(member.roles.cache.has(VIP), true);

  member.presence = { status: "online", activities: [{ type: ActivityType.Custom, state: "nope" }] };
  await vanity.applyMember(member);
  assert.equal(member.roles.cache.has(VIP), false);

  member.presence = { status: "online", activities: [{ type: ActivityType.Custom, state: "tunes" }] };
  await vanity.applyMember(member);
  assert.equal(member.roles.cache.has(VIP), true);

  member.presence = { status: "offline", activities: [{ type: ActivityType.Custom, state: "tunes" }] };
  await vanity.applyMember(member);
  assert.equal(member.roles.cache.has(VIP), false);

  member.presence = { status: "online", activities: [{ type: ActivityType.Custom, state: "tunes" }] };
  await vanity.applyMember(member);
  member.presence = null;
  await vanity.applyMember(member, { missingMeansKeep: true });
  assert.equal(member.roles.cache.has(VIP), true);
  await vanity.applyMember(member);
  assert.equal(member.roles.cache.has(VIP), false);
  assert.equal(vanity.rewardDecision({ status: "dnd", activities: [{ type: 4, state: "TUNES" }] }, "tunes"), "grant");
});

test("a vanity role added by hand or another bot is left in place", async () => {
  const guild = makeGuild();
  const { connection } = require("../db");
  connection.prepare("INSERT INTO vanity_config(guild_id, name, role_ids) VALUES(?,?,?) ON CONFLICT(guild_id) DO UPDATE SET name=excluded.name, role_ids=excluded.role_ids")
    .run(guild.id, "tunes", JSON.stringify([VIP]));
  const member = person(MEMBER, guild);
  member.roles.cache = new Map([[VIP, { id: VIP }]]);
  member.roles.add = async (roleId) => { member.roles.cache.set(roleId, { id: roleId }); };
  member.roles.remove = async (roleId) => { member.roles.cache.delete(roleId); };
  const before = person(MEMBER, guild);
  before.roles.cache = new Map();
  await vanity.observe(before, member);

  member.presence = { status: "online", activities: [{ type: ActivityType.Custom, state: "nope" }] };
  await vanity.applyMember(member);
  assert.equal(member.roles.cache.has(VIP), true);

  member.presence = { status: "offline", activities: [] };
  await vanity.applyMember(member);
  assert.equal(member.roles.cache.has(VIP), true);

  member.presence = null;
  await vanity.applyMember(member);
  assert.equal(member.roles.cache.has(VIP), true);

  member.presence = { status: "online", activities: [{ type: ActivityType.Custom, state: "tunes" }] };
  await vanity.applyMember(member);
  member.presence = { status: "offline", activities: [{ type: ActivityType.Custom, state: "tunes" }] };
  await vanity.applyMember(member);
  assert.equal(member.roles.cache.has(VIP), true);

  member.roles.cache.delete(VIP);
  member.presence = { status: "online", activities: [{ type: ActivityType.Custom, state: "tunes" }] };
  await vanity.applyMember(member);
  assert.equal(member.roles.cache.has(VIP), true);
  const holding = person(MEMBER, guild);
  holding.roles.cache = new Map([[VIP, { id: VIP }]]);
  member.roles.cache.delete(VIP);
  await vanity.observe(holding, member);
  member.roles.cache.set(VIP, { id: VIP });
  const empty = person(MEMBER, guild);
  empty.roles.cache = new Map();
  await vanity.observe(empty, member);
  member.presence = { status: "offline", activities: [] };
  await vanity.applyMember(member);
  assert.equal(member.roles.cache.has(VIP), true);
});
