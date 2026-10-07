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
