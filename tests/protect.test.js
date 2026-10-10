const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PermissionFlagsBits } = require("discord.js");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spanter-protect-"));
process.env.DB_PATH = path.join(scratch, "vc.sqlite");
process.env.PREFIX = "-";

const protect = require("../protect");
const store = require("../systems/store");
const { handleCommand } = require("../commands");
const voice = require("../systems/voice");

const GUILD = "protect-guild";
const OWNER = "111000000000000001";
const GOD = "111000000000000002";
const FOUNDER = "111000000000000004";
const USER = "111000000000000003";
const ATTACKER = "111000000000000005";
const ROLE_A = "222000000000000031";
const ROLE_B = "222000000000000032";
const STAFF_ROLE = "222000000000000033";

function titleOf(message) {
  const data = message.replies.at(-1).embeds[0].data;
  if (data.title) return data.title;
  const match = String(data.description || "").match(/\*\*([^*]+)\*\*/);
  return match ? match[1] : "";
}

function textOf(message) {
  return message.replies.at(-1).embeds[0].data.description || "";
}

function person(id, guild, options = {}) {
  const roles = options.roles || new Map();
  return {
    id,
    guild,
    user: { id, bot: !!options.bot, username: options.name || id },
    displayName: options.name || "Owner",
    permissions: { has: () => false },
    roles: {
      cache: roles,
      async add(roleId) { roles.set(roleId, { id: roleId }); },
      async remove(roleIds) {
        const ids = Array.isArray(roleIds) ? roleIds : [roleIds];
        for (const roleId of ids) roles.delete(typeof roleId === "string" ? roleId : roleId.id);
      }
    }
  };
}

function makeGuild() {
  const roles = new Map();
  const members = new Map();
  const guild = {
    id: GUILD,
    ownerId: OWNER,
    client: { user: { id: "protect-bot" } },
    roles: {
      cache: roles,
      async create(options) {
        const role = { id: `created-${roles.size}`, name: options.name, managed: false, position: 1 };
        roles.set(role.id, role);
        return role;
      }
    },
    members: {
      me: {
        id: "protect-bot",
        permissions: { has: () => true },
        roles: { highest: { position: 50 } }
      },
      cache: members,
      async fetch(id) { return members.get(id) || null; }
    }
  };
  return guild;
}

function role(guild, id, name) {
  const created = {
    id,
    name,
    managed: false,
    position: 1,
    permissions: { has: (flag) => flag === PermissionFlagsBits.Administrator }
  };
  guild.roles.cache.set(id, created);
  return created;
}

function message(guild, member, content, mentions = {}) {
  return {
    guild,
    author: member.user,
    member,
    content,
    mentions: {
      roles: mentions.roles || new Map(),
      members: mentions.members || new Map()
    },
    replies: [],
    async reply(payload) {
      this.replies.push(payload);
      return payload;
    }
  };
}

test("only a god or the server owner can protect roles, and each role has one owner", async () => {
  const guild = makeGuild();
  guild.id = "protect-roles";
  const owner = person(OWNER, guild);
  const founder = person(FOUNDER, guild);
  const god = person(GOD, guild);
  guild.members.cache.set(owner.id, owner);
  guild.members.cache.set(founder.id, founder);
  guild.members.cache.set(god.id, god);
  store.setStaff(guild.id, founder.id, "founder", owner.id);
  store.setStaff(guild.id, god.id, "god", owner.id);
  const first = role(guild, ROLE_A, "Alpha");
  const second = role(guild, ROLE_B, "Beta");

  const denied = message(guild, founder, "-protect @Alpha", { roles: new Map([[first.id, first]]) });
  await handleCommand(denied, {}, "-");
  assert.equal(titleOf(denied), "Access Denied");

  const protectedRoles = message(guild, owner, "-protect @Alpha, @Beta", {
    roles: new Map([[first.id, first], [second.id, second]])
  });
  await handleCommand(protectedRoles, {}, "-");
  assert.equal(titleOf(protectedRoles), "Protection Godmode");
  assert.equal(protect.roleRow(guild.id, first.id).owner_id, owner.id);
  assert.equal(protect.roleRow(guild.id, second.id).owner_id, owner.id);
  assert.equal(protectedRoles.replies[0].components[0].components.length, 2);

  const stolen = message(guild, god, `-protect ${first.id}`);
  await handleCommand(stolen, {}, "-");
  assert.equal(titleOf(stolen), "Already Protected");
  assert.match(textOf(stolen), new RegExp(owner.id));
  assert.equal(protect.roleRow(guild.id, first.id).owner_id, owner.id);
});

test("protecting a user needs your role, and godmode blocks mute and deafen", async () => {
  const guild = makeGuild();
  guild.id = "protect-users";
  const owner = person(OWNER, guild, { name: "Dee" });
  const user = person(USER, guild, { name: "Sam" });
  guild.members.cache.set(owner.id, owner);
  guild.members.cache.set(user.id, user);
  store.setRank(guild.id, user.id, "premium", owner.id);

  const needsRole = message(guild, owner, `-protect ${user.id}`);
  await handleCommand(needsRole, {}, "-");
  assert.equal(titleOf(needsRole), "Protection Role");
  assert.equal(needsRole.replies[0].components[0].components.length, 2);

  const created = role(guild, ROLE_A, "Alpha");
  const other = role(guild, ROLE_B, "Beta");
  await handleCommand(message(guild, owner, "-protect @Alpha, @Beta", {
    roles: new Map([[created.id, created], [other.id, other]])
  }), {}, "-");

  const choose = message(guild, owner, `-protect <@${user.id}>`, {
    members: new Map([[user.id, user]])
  });
  await handleCommand(choose, {}, "-");
  assert.equal(titleOf(choose), "Choose a Protection Role");
  const pick = choose.replies[0].components[0].components.find((button) => button.data.label === "Alpha");
  assert.ok(pick);
  let updated;
  await protect.handleInteraction({
    customId: pick.data.custom_id,
    isButton: () => true,
    isRoleSelectMenu: () => false,
    user: owner.user,
    member: owner,
    guild,
    async update(payload) { updated = payload; }
  });
  assert.equal(updated.embeds[0].data.title, "Protection Godmode");
  assert.equal(user.roles.cache.has(created.id), true);

  const yes = updated.components[0].components.find((button) => button.data.label === "Yes");
  await protect.handleInteraction({
    customId: yes.data.custom_id,
    isButton: () => true,
    isRoleSelectMenu: () => false,
    user: owner.user,
    member: owner,
    guild,
    async update(payload) { updated = payload; }
  });
  assert.equal(updated.embeds[0].data.title, "Godmode On");
  assert.equal(protect.memberHasGodmode(user), true);

  const mine = message(guild, owner, "-protected");
  await handleCommand(mine, {}, "-");
  assert.match(textOf(mine), new RegExp(user.id));
  assert.match(textOf(mine), /Voice Premium/);
  const everyone = message(guild, owner, "-plist");
  await handleCommand(everyone, {}, "-");
  assert.match(textOf(everyone), new RegExp(owner.id));
  assert.match(textOf(everyone), /godmode/);

  let muted = true;
  let deafened = true;
  user.voice = {
    serverMute: true,
    serverDeaf: true,
    async setMute(value) { muted = value; this.serverMute = value; },
    async setDeaf(value) { deafened = value; this.serverDeaf = value; }
  };
  const state = { guild, member: user, channelId: "call", serverMute: true, serverDeaf: true };
  await voice.enforceVoice({ ...state, serverMute: false, serverDeaf: false }, state);
  assert.equal(muted, false);
  assert.equal(deafened, false);
});

test("removing a protected role strips a human and only restores a bot", async () => {
  const guild = makeGuild();
  guild.id = "protect-tamper";
  const owner = person(OWNER, guild);
  const user = person(USER, guild);
  const staffRole = role(guild, STAFF_ROLE, "Staff");
  const protectedRole = role(guild, ROLE_A, "Alpha");
  const attacker = person(ATTACKER, guild, { roles: new Map([[staffRole.id, staffRole]]) });
  guild.members.cache.set(owner.id, owner);
  guild.members.cache.set(user.id, user);
  guild.members.cache.set(attacker.id, attacker);
  store.setStaff(guild.id, attacker.id, "boss", owner.id);
  await protect.handleCommand(message(guild, owner, `-protect ${protectedRole.id}`), "protect", ["-protect", protectedRole.id]);
  user.roles.cache.set(protectedRole.id, protectedRole);
  const { connection } = require("../db");
  connection.prepare("INSERT OR IGNORE INTO protected_users(guild_id, user_id, role_id, owner_id, created_at) VALUES(?,?,?,?,?)")
    .run(guild.id, user.id, protectedRole.id, owner.id, Date.now());

  user.roles.cache.delete(protectedRole.id);
  guild.fetchAuditLogs = async () => ({
    entries: [{
      targetId: user.id,
      createdTimestamp: Date.now(),
      executorId: attacker.id,
      executor: { id: attacker.id, bot: false },
      changes: [{ new: [{ id: protectedRole.id }] }]
    }]
  });
  await protect.observe(
    { roles: { cache: new Map([[protectedRole.id, protectedRole]]) }, guild },
    user
  );
  assert.equal(user.roles.cache.has(protectedRole.id), true);
  assert.equal(attacker.roles.cache.has(staffRole.id), false);
  assert.equal(store.getStaff(guild.id, attacker.id), null);

  user.roles.cache.delete(protectedRole.id);
  const bot = person("333000000000000099", guild, { bot: true });
  guild.members.cache.set(bot.id, bot);
  guild.fetchAuditLogs = async () => ({
    entries: [{
      targetId: user.id,
      createdTimestamp: Date.now(),
      executorId: bot.id,
      executor: { id: bot.id, bot: true },
      changes: [{ new: [{ id: protectedRole.id }] }]
    }]
  });
  await protect.observe(
    { roles: { cache: new Map([[protectedRole.id, protectedRole]]) }, guild },
    user
  );
  assert.equal(user.roles.cache.has(protectedRole.id), true);
  assert.equal(bot.roles.cache.size, 0);
});
