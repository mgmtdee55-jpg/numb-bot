const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3");
const { PermissionFlagsBits } = require("discord.js");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spanter-vouch-"));
process.env.DB_PATH = path.join(scratch, "vc.sqlite");
process.env.PREFIX = "-";

const vouch = require("../vouch");
const rolesApi = require("../vouch/roles");
const staffStore = require("../systems/store");
const { handleCommand } = require("../commands");

const BOT = "900000000000000099";
const OWNER = "111000000000000001";
const OS = "111000000000000002";
const ADMIN = "111000000000000003";
const GIVER = "111000000000000004";
const TARGET = "111000000000000005";
const OTHER = "111000000000000006";
const THIRD = "111000000000000007";
const PLAIN = "111000000000000008";
const VOUCH_ROLE = "222000000000000001";
const STAFF_ROLE = "222000000000000002";
const MEMBER_ROLE = "222000000000000003";
const LIMITED_ROLE = "222000000000000004";
const REWARD_ROLE = "222000000000000005";
const LEGACY_ROLE = "222000000000000006";

let guildSerial = 0;

function nextGuild() {
  guildSerial += 1;
  return `vouch-guild-${guildSerial}`;
}

function makeRole(id, name, flags = [], position = 5) {
  const allowed = new Set(flags);
  return {
    id,
    name,
    position,
    managed: false,
    permissions: { has: (flag) => allowed.has(flag) }
  };
}

function makeGuild() {
  const members = new Map();
  const roleCache = new Map();
  const channels = new Map();
  const guildId = nextGuild();
  const everyone = makeRole(guildId, "@everyone", [], 0);
  roleCache.set(everyone.id, everyone);
  const guild = {
    id: guildId,
    ownerId: OWNER,
    memberCount: 10,
    client: { user: { id: BOT } },
    roles: {
      cache: roleCache,
      async fetch(roleId) { return roleCache.get(roleId) || null; }
    },
    channels: {
      cache: channels,
      async fetch(channelId) { return channels.get(channelId) || null; }
    },
    members: {
      cache: members,
      me: {
        id: BOT,
        permissions: {
          has: (flag) => flag === PermissionFlagsBits.ManageRoles || flag === PermissionFlagsBits.Administrator
        },
        roles: { highest: { position: 100 } }
      },
      async fetch(userId) {
        if (!userId || typeof userId !== "string") return members;
        const member = members.get(userId);
        if (!member) {
          const error = new Error("Unknown Member");
          error.code = 10007;
          throw error;
        }
        return member;
      }
    },
    async fetchAuditLogs() {
      return { entries: new Map() };
    }
  };
  return guild;
}

function bindRoles(member) {
  member.roles.added = [];
  member.roles.removed = [];
  member.roles.add = async (role) => {
    const id = typeof role === "string" ? role : role.id;
    member.roles.cache.set(id, member.guild.roles.cache.get(id) || { id });
    member.roles.added.push(id);
  };
  member.roles.remove = async (roleOrRoles) => {
    const list = Array.isArray(roleOrRoles) ? roleOrRoles : [roleOrRoles];
    for (const role of list) {
      const id = typeof role === "string" ? role : role.id;
      member.roles.cache.delete(id);
      member.roles.removed.push(id);
    }
  };
}

function makeMember(guild, userId, options = {}) {
  const cache = new Map();
  for (const role of options.roles || []) {
    guild.roles.cache.set(role.id, role);
    cache.set(role.id, role);
  }
  const member = {
    id: userId,
    guild,
    nickname: options.nickname ?? null,
    displayName: options.username || `user-${userId}`,
    user: {
      id: userId,
      bot: options.bot === true,
      username: options.username || `user-${userId}`
    },
    roles: { cache, highest: { position: options.position || 1 } },
    async setNickname(nickname) {
      member.nickname = nickname;
      member.nicknames = member.nicknames || [];
      member.nicknames.push(nickname);
    }
  };
  bindRoles(member);
  guild.members.cache.set(userId, member);
  if (options.owner) guild.ownerId = userId;
  return member;
}

function setRoleIds(member, roleIds) {
  member.roles.cache = new Map();
  for (const roleId of roleIds) {
    const role = member.guild.roles.cache.get(roleId);
    if (role) member.roles.cache.set(roleId, role);
  }
}

function snapshot(member, roleIds) {
  const cache = new Map();
  for (const roleId of roleIds) {
    const role = member.guild.roles.cache.get(roleId);
    if (role) cache.set(roleId, role);
  }
  return {
    id: member.id,
    guild: member.guild,
    user: member.user,
    nickname: member.nickname ?? null,
    roles: {
      cache,
      add: (...args) => member.roles.add(...args),
      remove: (...args) => member.roles.remove(...args)
    },
    setNickname: (...args) => member.setNickname(...args)
  };
}

function makeMessage(guild, content, member) {
  const replies = [];
  return {
    content,
    guild,
    client: guild.client,
    author: { id: member.id, bot: member.user.bot },
    member,
    mentions: {
      members: { first: () => null },
      users: { first: () => null },
      roles: { first: () => null },
      channels: { first: () => null }
    },
    replies,
    async reply(payload) {
      replies.push(payload);
      return { payload };
    }
  };
}

function titleOf(message) {
  const data = message.replies.at(-1).embeds[0].data;
  if (data.title) return data.title;
  const match = String(data.description || "").match(/\*\*([^*]+)\*\*/);
  return match ? match[1] : "";
}

function textOf(message) {
  return message.replies.at(-1).embeds[0].data.description;
}

async function run(guild, member, content) {
  const message = makeMessage(guild, content, member);
  await handleCommand(message, guild.client, "-");
  return message;
}

function staffRole() {
  return makeRole(STAFF_ROLE, "Staff", [PermissionFlagsBits.KickMembers], 8);
}

function vouchRole() {
  return makeRole(VOUCH_ROLE, "Vouched", [], 4);
}

function memberRole() {
  return makeRole(MEMBER_ROLE, "Member", [], 2);
}

function cast() {
  const guild = makeGuild();
  const owner = makeMember(guild, OWNER, { owner: true, username: "owner", roles: [memberRole()] });
  const os = makeMember(guild, OS, { username: "os", roles: [staffRole(), memberRole()] });
  const admin = makeMember(guild, ADMIN, { username: "admin", roles: [memberRole()] });
  const giver = makeMember(guild, GIVER, { username: "giver", roles: [memberRole()] });
  const target = makeMember(guild, TARGET, { username: "target", roles: [memberRole()] });
  const other = makeMember(guild, OTHER, { username: "other", roles: [memberRole()] });
  const third = makeMember(guild, THIRD, { username: "third", roles: [memberRole()] });
  const plain = makeMember(guild, PLAIN, { username: "plain", roles: [memberRole()] });
  guild.roles.cache.set(VOUCH_ROLE, vouchRole());
  return { guild, owner, os, admin, giver, target, other, third, plain };
}

async function authorize(group) {
  const added = await run(group.guild, group.owner, `-ceo add ${OS}`);
  assert.equal(titleOf(added), "God Added");
  const admined = await run(group.guild, group.os, `-vouch admin allow ${ADMIN}`);
  assert.equal(titleOf(admined), "Vouch Admin Added");
  const giver = await run(group.guild, group.admin, `-vouch add giver ${GIVER}`);
  assert.equal(titleOf(giver), "Giver Added");
  const role = await run(group.guild, group.owner, "-vouch setrole Vouched");
  assert.equal(titleOf(role), "Vouch Role Set");
}

async function emit(member, beforeIds, afterIds, audit) {
  setRoleIds(member, afterIds);
  if (audit) {
    member.guild.fetchAuditLogs = async () => ({
      entries: new Map([[
        "1",
        {
          targetId: member.id,
          executor: audit.executor,
          createdTimestamp: Date.now(),
          changes: [{ key: audit.key || "$add", new: [{ id: audit.roleId }] }]
        }
      ]])
    });
  }
  await vouch.handleGuildMemberUpdate(snapshot(member, beforeIds), snapshot(member, afterIds));
}

test("permission hierarchy follows owner, OS, vouch admin, then giver", async () => {
  const group = cast();
  const deniedGiver = await run(group.guild, group.giver, `-vouch add giver ${PLAIN}`);
  assert.equal(titleOf(deniedGiver), "Not Allowed");

  await authorize(group);

  const giverDeniedAdmin = await run(group.guild, group.giver, `-vouch admin allow ${PLAIN}`);
  assert.equal(titleOf(giverDeniedAdmin), "Not Allowed");
  const adminDeniedAdmin = await run(group.guild, group.admin, `-vouch admin allow ${PLAIN}`);
  assert.equal(titleOf(adminDeniedAdmin), "Not Allowed");
  const osAddsAdmin = await run(group.guild, group.os, `-vouch admin allow ${PLAIN}`);
  assert.equal(titleOf(osAddsAdmin), "Vouch Admin Added");
  const adminDeniedStrip = await run(group.guild, group.admin, `-vouchstrip ${GIVER}`);
  assert.equal(titleOf(adminDeniedStrip), "Not Allowed");
  const ownerRemovesOs = await run(group.guild, group.owner, `-ceo remove ${OS}`);
  assert.equal(titleOf(ownerRemovesOs), "God Removed");
  assert.equal(staffStore.getStaff(group.guild.id, OS), null);
});

test("giving a vouch records the giver, spends allowance, and assigns only the vouch role", async () => {
  const group = cast();
  await authorize(group);
  group.guild.roles.cache.set(REWARD_ROLE, makeRole(REWARD_ROLE, "Reward", [], 3));
  vouch.store.setRewardRole(group.guild.id, REWARD_ROLE);

  const given = await run(group.guild, group.giver, `-vouch give ${TARGET} trusted member`);
  assert.equal(titleOf(given), "Vouch Given");
  assert.match(textOf(given), /1\/2/);
  const row = vouch.store.getActiveVouch(group.guild.id, TARGET);
  assert.equal(row.giver_id, GIVER);
  assert.equal(row.reason, "trusted member");
  assert.equal(row.active, 1);
  assert.equal(group.target.roles.added.includes(VOUCH_ROLE), true);
  assert.equal(group.target.roles.added.includes(REWARD_ROLE), false);

  const again = await run(group.guild, group.owner, `-vouch give ${TARGET} duplicate`);
  assert.equal(titleOf(again), "Already Vouched");
  assert.equal(vouch.store.countActive(group.guild.id), 1);
});

test("allowance is the configured maximum, and taking a vouch restores a slot without deleting history", async () => {
  const group = cast();
  await authorize(group);
  await run(group.guild, group.giver, `-vouch give ${TARGET} one`);
  await run(group.guild, group.giver, `-vouch give ${OTHER} two`);
  const blocked = await run(group.guild, group.giver, `-vouch give ${THIRD} three`);
  assert.equal(titleOf(blocked), "No Vouches Remaining");
  assert.equal(vouch.store.getActiveVouch(group.guild.id, THIRD), null);

  const raised = await run(group.guild, group.owner, `-antinuke vouch limit user ${GIVER} 4`);
  assert.equal(titleOf(raised), "Vouch Limit Updated");
  assert.equal(vouch.store.allowance(group.guild.id, GIVER).max, 4);
  const third = await run(group.guild, group.giver, `-vouch give ${THIRD} three`);
  assert.equal(titleOf(third), "Vouch Given");
  assert.match(textOf(third), /1\/4/);

  const reset = await run(group.guild, group.owner, `-antinuke vouch limit remove ${GIVER}`);
  assert.equal(titleOf(reset), "Override Removed");
  assert.equal(vouch.store.allowance(group.guild.id, GIVER).max, 2);
  assert.equal(vouch.store.allowance(group.guild.id, GIVER).remaining, 0);

  const taken = await run(group.guild, group.giver, `-vouch take ${TARGET} no longer needed`);
  assert.equal(titleOf(taken), "Vouch Removed");
  assert.equal(vouch.store.getActiveVouch(group.guild.id, TARGET), null);
  assert.equal(group.target.roles.cache.has(VOUCH_ROLE), false);
  const history = vouch.store.latestRemovedVouch(group.guild.id, TARGET);
  assert.equal(history.giver_id, GIVER);
  assert.equal(history.active, 0);
  assert.equal(history.remove_reason, "no longer needed");
  assert.equal(vouch.store.allowance(group.guild.id, GIVER).remaining, 0);
});

test("a failed role assignment does not keep a vouch, and a failed removal does not close it", async () => {
  const group = cast();
  await authorize(group);
  group.target.roles.add = async () => {
    const error = new Error("missing permissions");
    error.code = 50013;
    throw error;
  };
  const failed = await run(group.guild, group.giver, `-vouch give ${TARGET} nope`);
  assert.equal(titleOf(failed), "Vouch Failed");
  assert.equal(vouch.store.getActiveVouch(group.guild.id, TARGET), null);

  group.target.roles.add = async (role) => {
    const id = typeof role === "string" ? role : role.id;
    group.target.roles.cache.set(id, group.guild.roles.cache.get(id) || { id });
  };
  const given = await run(group.guild, group.giver, `-vouch give ${TARGET} kept`);
  assert.equal(titleOf(given), "Vouch Given");
  group.target.roles.remove = async () => {
    const error = new Error("missing permissions");
    error.code = 50013;
    throw error;
  };
  const removeFailed = await run(group.guild, group.admin, `-vouch take ${TARGET} fail`);
  assert.equal(titleOf(removeFailed), "Vouch Failed");
  assert.equal(vouch.store.getActiveVouch(group.guild.id, TARGET).active, 1);
});

test("removing giver permission keeps existing vouches and blacklist blocks every vouch promotion", async () => {
  const group = cast();
  await authorize(group);
  await run(group.guild, group.giver, `-vouch give ${TARGET} stays`);
  const removed = await run(group.guild, group.admin, `-vouch giver take ${GIVER}`);
  assert.equal(titleOf(removed), "Giver Removed");
  assert.equal(vouch.store.isActiveGiver(group.guild.id, GIVER), false);
  assert.ok(vouch.store.getActiveVouch(group.guild.id, TARGET));
  assert.equal(group.target.roles.cache.has(VOUCH_ROLE), true);

  const blacklisted = await run(group.guild, group.admin, `-vouchblacklist add ${PLAIN} abuse`);
  assert.equal(titleOf(blacklisted), "User Blacklisted");
  const give = await run(group.guild, group.owner, `-vouch give ${PLAIN} no`);
  assert.equal(titleOf(give), "Vouch Blacklisted");
  const giver = await run(group.guild, group.admin, `-vouch add giver ${PLAIN}`);
  assert.equal(titleOf(giver), "Vouch Blacklisted");
  const admin = await run(group.guild, group.os, `-vouch admin allow ${PLAIN}`);
  assert.equal(titleOf(admin), "Vouch Blacklisted");
  const self = await run(group.guild, group.plain, `-vouch give ${OTHER} no`);
  assert.equal(titleOf(self), "Vouch Blacklisted");
  const listed = await run(group.guild, group.plain, "-vouchblacklist list");
  assert.match(textOf(listed), new RegExp(PLAIN));

  const ownerBlocked = await run(group.guild, group.owner, `-vouchblacklist add ${OS}`);
  assert.equal(titleOf(ownerBlocked), "Protected User");
});

test("vouch strip and wipe close active vouches without erasing logs or staff records", async () => {
  const group = cast();
  await authorize(group);
  await run(group.guild, group.giver, `-vouch give ${TARGET} a`);
  await run(group.guild, group.giver, `-vouch give ${OTHER} b`);
  const view = await run(group.guild, group.owner, "-antinuke vouch list");
  assert.match(textOf(view), new RegExp(TARGET));
  assert.match(textOf(view), new RegExp(OTHER));

  const stripped = await run(group.guild, group.os, `-vouchstrip ${GIVER}`);
  assert.equal(titleOf(stripped), "Vouch Strip");
  assert.equal(vouch.store.countActive(group.guild.id), 0);
  assert.equal(vouch.store.isActiveGiver(group.guild.id, GIVER), true);
  assert.equal(group.target.roles.cache.has(VOUCH_ROLE), false);

  assert.equal(vouch.store.isActiveAdmin(group.guild.id, ADMIN), true);
  assert.ok(vouch.store.listLogs(group.guild.id, 20).some((row) => row.action === "vouch_give"));
});

test("active vouch list is paginated and limited roles show live membership", async () => {
  const group = cast();
  await authorize(group);
  vouch.store.setAllowance(group.guild.id, GIVER, 12, OWNER);
  for (let index = 0; index < 9; index += 1) {
    const userId = `33300000000000000${index}`;
    makeMember(group.guild, userId, { username: `paged-${index}` });
    const reserved = vouch.store.reserveVouch({
      guildId: group.guild.id,
      giverId: GIVER,
      targetId: userId,
      reason: `page-${index}`
    });
    assert.equal(reserved.ok, true);
  }
  const pageTwo = await run(group.guild, group.owner, "-antinuke vouch list 2");
  assert.equal(titleOf(pageTwo), "Active Vouches");
  assert.match(textOf(pageTwo), /Page 2 of 2/);

  const limited = makeRole(LIMITED_ROLE, "Admin", [], 6);
  group.guild.roles.cache.set(limited.id, limited);
  group.target.roles.cache.set(limited.id, limited);
  group.other.roles.cache.set(limited.id, limited);
  const setLimit = await run(group.guild, group.owner, "-role limit set Admin 10");
  assert.equal(titleOf(setLimit), "Role Limit Set");
  const listed = await run(group.guild, group.owner, "-role limit view");
  assert.match(textOf(listed), new RegExp(`${LIMITED_ROLE}.+2/10`));
});

test("prefix and aliases persist in sqlite and aliases expand to vouch commands", async () => {
  const group = cast();
  await authorize(group);
  const prefix = await run(group.guild, group.owner, "-setprefix !");
  assert.equal(titleOf(prefix), "Prefix Updated");
  assert.equal(vouch.getPrefix(group.guild.id), "!");
  const aliased = await run(group.guild, group.owner, "-alias add vg antinuke vouch");
  assert.equal(titleOf(aliased), "Alias Added");

  vouch.store.checkpoint();
  const second = new Database(process.env.DB_PATH);
  const savedPrefix = second.prepare("SELECT prefix FROM bot_settings WHERE guild_id=?").get(group.guild.id);
  const savedAlias = second.prepare("SELECT command_text FROM command_aliases WHERE guild_id=? AND shortcut=?").get(group.guild.id, "vg");
  const savedGiver = second.prepare("SELECT active FROM vouch_givers WHERE guild_id=? AND user_id=?").get(group.guild.id, GIVER);
  second.close();
  assert.equal(savedPrefix.prefix, "!");
  assert.equal(savedAlias.command_text, "antinuke vouch");
  assert.equal(savedGiver.active, 1);

  const expanded = makeMessage(group.guild, "!vg", group.giver);
  await handleCommand(expanded, group.guild.client, "!");
  assert.equal(titleOf(expanded), "Vouch Config");
  const listed = makeMessage(group.guild, "!alias list", group.owner);
  await handleCommand(listed, group.guild.client, "!");
  assert.match(textOf(listed), /!vg/);
});

test("help opens on overview and the vouch category lists the vouch commands", async () => {
  const group = cast();
  const help = await run(group.guild, group.plain, "-help");
  assert.equal(titleOf(help), "Categories");
  assert.match(textOf(help), /VC Ranks — Voice Plus, Premium, and Premium Plus/);
  assert.match(textOf(help), /Your rank: Member/);
  assert.match(textOf(help), /menu below/);
  const menu = help.replies[0].components[0].toJSON().components[0];
  const overview = menu.options.find((option) => option.value === "overview");
  assert.equal(overview.emoji.id, "1555789384140328960");
  assert.equal(overview.emoji.name, "YOUR_CUSTOM_EMOJI_ID");
  assert.ok(menu.options.some((option) => option.value === "vouch"));
  assert.ok(menu.options.some((option) => option.value === "force"));

  const interaction = {
    customId: "spanter:help",
    values: ["vouch"],
    guildId: group.guild.id,
    guild: group.guild,
    async update(payload) { this.updated = payload; }
  };
  assert.equal(await vouch.handleInteraction(interaction), true);
  const description = interaction.updated.embeds[0].data.description;
  for (const command of ["vouch give", "vouch take", "vouch admin allow", "vouchblacklist add", "antinuke vouch limit global", "vouchstrip", "setrole stripstaff", "antinuke vouch set"]) {
    assert.match(description, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(description, /forcenickname/);

  const forceInteraction = {
    customId: "spanter:help",
    values: ["force"],
    guildId: group.guild.id,
    guild: group.guild,
    async update(payload) { this.updated = payload; }
  };
  await vouch.handleInteraction(forceInteraction);
  assert.match(forceInteraction.updated.embeds[0].data.description, /forcenickname/);
  assert.match(forceInteraction.updated.embeds[0].data.description, /rolestrip/);
});

test("force management blocks roles and restores forced nicknames without a punishment loop", async () => {
  const group = cast();
  await authorize(group);
  const panel = await run(group.guild, group.owner, "-forcemanage");
  assert.equal(titleOf(panel), "Force Management");
  const denied = await run(group.guild, group.giver, "-forcemanage");
  assert.equal(titleOf(denied), "Not Allowed");

  const forced = await run(group.guild, group.owner, `-forcenickname ${TARGET} Alpha`);
  assert.equal(titleOf(forced), "Forced Nickname");
  assert.equal(group.target.nickname, "Alpha");
  group.target.nickname = "Hacked";
  await vouch.handleGuildMemberUpdate(
    snapshot(group.target, [MEMBER_ROLE]),
    { ...snapshot(group.target, [MEMBER_ROLE]), nickname: "Hacked" }
  );
  assert.equal(group.target.nickname, "Alpha");
  const calls = group.target.nicknames.length;
  await vouch.handleGuildMemberUpdate(
    snapshot(group.target, [MEMBER_ROLE]),
    { ...snapshot(group.target, [MEMBER_ROLE]), nickname: "Alpha" }
  );
  assert.equal(group.target.nicknames.length, calls);

  group.guild.roles.cache.set(LIMITED_ROLE, makeRole(LIMITED_ROLE, "Secret", [], 6));
  group.target.roles.cache.set(LIMITED_ROLE, group.guild.roles.cache.get(LIMITED_ROLE));
  const blocked = await run(group.guild, group.os, `-forcestrip ${TARGET} Secret`);
  assert.equal(titleOf(blocked), "Role Blocked");
  assert.equal(group.target.roles.cache.has(LIMITED_ROLE), false);
  assert.equal(vouch.store.isRoleStripped(group.guild.id, TARGET, LIMITED_ROLE), true);

  vouch.protection.resetRuntime();
  group.guild.fetchAuditLogs = async () => ({
    entries: new Map([[
      "1",
      {
        targetId: TARGET,
        executor: { id: PLAIN, bot: false },
        createdTimestamp: Date.now(),
        changes: [{ key: "$add", new: [{ id: LIMITED_ROLE }] }]
      }
    ]])
  });
  await emit(group.target, [MEMBER_ROLE], [MEMBER_ROLE, LIMITED_ROLE], {
    executor: { id: PLAIN, bot: false },
    roleId: LIMITED_ROLE
  });
  assert.equal(group.target.roles.cache.has(LIMITED_ROLE), false);

  const cleared = await run(group.guild, group.owner, `-unforcestrip ${TARGET}`);
  assert.equal(titleOf(cleared), "Role Blocks Cleared");
  const stripped = await run(group.guild, group.owner, "-rolestrip Member");
  assert.equal(titleOf(stripped), "Role Stripped");
  assert.equal(group.target.roles.cache.has(MEMBER_ROLE), false);
  assert.equal(group.other.roles.cache.has(MEMBER_ROLE), false);
});

test("unauthorized vouch role changes are reversed and only the human actor is stripstaffed", async () => {
  const group = cast();
  await authorize(group);
  group.plain.roles.cache.set(STAFF_ROLE, group.guild.roles.cache.get(STAFF_ROLE));
  vouch.protection.resetRuntime();

  await emit(group.target, [MEMBER_ROLE, STAFF_ROLE], [MEMBER_ROLE, STAFF_ROLE, VOUCH_ROLE], {
    executor: { id: PLAIN, bot: false },
    roleId: VOUCH_ROLE
  });
  assert.equal(group.target.roles.cache.has(VOUCH_ROLE), false);
  assert.equal(group.target.roles.cache.has(STAFF_ROLE), true);
  assert.equal(group.plain.roles.cache.has(STAFF_ROLE), false);
  assert.equal(group.plain.roles.cache.has(MEMBER_ROLE), true);
  assert.equal(vouch.store.listPunishments(group.guild.id).length, 1);
  const punishment = vouch.store.listPunishments(group.guild.id)[0];
  assert.equal(punishment.user_id, PLAIN);
  assert.equal(punishment.type, "STRIPSTAFF");
  assert.equal(vouch.store.listLogs(group.guild.id).some((row) => row.action === "unauthorized_role_add" && row.automatic === 1), true);

  vouch.protection.resetRuntime();
  const before = vouch.store.listPunishments(group.guild.id).length;
  await emit(group.target, [MEMBER_ROLE, STAFF_ROLE], [MEMBER_ROLE, STAFF_ROLE, VOUCH_ROLE], {
    executor: { id: PLAIN, bot: false },
    roleId: VOUCH_ROLE
  });
  await emit(group.target, [MEMBER_ROLE, STAFF_ROLE], [MEMBER_ROLE, STAFF_ROLE, VOUCH_ROLE], {
    executor: { id: PLAIN, bot: false },
    roleId: VOUCH_ROLE
  });
  assert.equal(vouch.store.listPunishments(group.guild.id).length, before + 1);
});

test("OS, the server owner, and bots are exempt from stripstaff", async () => {
  const group = cast();
  await authorize(group);
  const botMember = makeMember(group.guild, BOT, { bot: true, username: "spanter", roles: [staffRole()] });

  vouch.protection.resetRuntime();
  await emit(group.target, [MEMBER_ROLE], [MEMBER_ROLE, VOUCH_ROLE], {
    executor: { id: OS, bot: false },
    roleId: VOUCH_ROLE
  });
  assert.equal(group.target.roles.cache.has(VOUCH_ROLE), false);
  assert.equal(group.os.roles.cache.has(STAFF_ROLE), true);
  assert.equal(vouch.store.punishmentsFor(group.guild.id, OS).length, 0);

  vouch.protection.resetRuntime();
  await emit(group.other, [MEMBER_ROLE], [MEMBER_ROLE, VOUCH_ROLE], {
    executor: { id: OWNER, bot: false },
    roleId: VOUCH_ROLE
  });
  assert.equal(group.other.roles.cache.has(VOUCH_ROLE), false);
  assert.equal(vouch.store.punishmentsFor(group.guild.id, OWNER).length, 0);

  vouch.protection.resetRuntime();
  await emit(group.third, [MEMBER_ROLE], [MEMBER_ROLE, VOUCH_ROLE], {
    executor: { id: BOT, bot: true },
    roleId: VOUCH_ROLE
  });
  assert.equal(group.third.roles.cache.has(VOUCH_ROLE), false);
  assert.equal(botMember.roles.cache.has(STAFF_ROLE), true);
  assert.equal(vouch.store.punishmentsFor(group.guild.id, BOT).length, 0);
});

test("a removed vouch role is restored, and audit-log failure still reverses the role", async () => {
  const group = cast();
  await authorize(group);
  vouch.store.reserveVouch({ guildId: group.guild.id, giverId: GIVER, targetId: TARGET, reason: "kept" });
  group.plain.roles.cache.set(STAFF_ROLE, group.guild.roles.cache.get(STAFF_ROLE));
  setRoleIds(group.target, [MEMBER_ROLE, VOUCH_ROLE]);
  vouch.protection.resetRuntime();
  await emit(group.target, [MEMBER_ROLE, VOUCH_ROLE], [MEMBER_ROLE], {
    executor: { id: PLAIN, bot: false },
    key: "$remove",
    roleId: VOUCH_ROLE
  });
  assert.equal(group.target.roles.cache.has(VOUCH_ROLE), true);
  assert.equal(group.plain.roles.removed.includes(STAFF_ROLE), true);
  assert.equal(vouch.store.listLogs(group.guild.id).some((row) => row.action === "role_restore"), true);

  vouch.protection.resetRuntime();
  group.other.roles.cache.set(STAFF_ROLE, group.guild.roles.cache.get(STAFF_ROLE));
  group.guild.fetchAuditLogs = async () => {
    throw new Error("audit unavailable");
  };
  setRoleIds(group.other, [MEMBER_ROLE, STAFF_ROLE, VOUCH_ROLE]);
  await vouch.handleGuildMemberUpdate(
    snapshot(group.other, [MEMBER_ROLE, STAFF_ROLE]),
    snapshot(group.other, [MEMBER_ROLE, STAFF_ROLE, VOUCH_ROLE])
  );
  assert.equal(group.other.roles.cache.has(VOUCH_ROLE), false);
  assert.equal(group.other.roles.cache.has(STAFF_ROLE), true);
  assert.equal(vouch.store.punishmentsFor(group.guild.id, OTHER).length, 0);
});

test("the bot's own role update and a role at capacity do not create duplicate punishments", async () => {
  const group = cast();
  await authorize(group);
  vouch.protection.resetRuntime();
  await rolesApi.addRole(group.target, VOUCH_ROLE, "bot add");
  await emit(group.target, [MEMBER_ROLE], [MEMBER_ROLE, VOUCH_ROLE]);
  await emit(group.target, [MEMBER_ROLE], [MEMBER_ROLE, VOUCH_ROLE]);
  assert.equal(group.target.roles.cache.has(VOUCH_ROLE), true);
  assert.equal(vouch.store.listPunishments(group.guild.id).length, 0);

  const limited = makeRole(LIMITED_ROLE, "Capped", [], 6);
  group.guild.roles.cache.set(limited.id, limited);
  vouch.store.setLimitedRole(group.guild.id, LIMITED_ROLE, 1, OWNER);
  group.giver.roles.cache.set(limited.id, limited);
  vouch.protection.resetRuntime();
  await emit(group.target, [MEMBER_ROLE], [MEMBER_ROLE, LIMITED_ROLE], {
    executor: { id: PLAIN, bot: false },
    roleId: LIMITED_ROLE
  });
  assert.equal(group.target.roles.cache.has(LIMITED_ROLE), false);
  assert.equal(group.giver.roles.cache.has(LIMITED_ROLE), true);
  assert.equal(vouch.store.punishmentsFor(group.guild.id, PLAIN).length, 1);
});

test("leaving keeps the vouch and rejoining restores the role; deleted config fails safely", async () => {
  const group = cast();
  await authorize(group);
  await run(group.guild, group.giver, `-vouch give ${TARGET} stay`);
  setRoleIds(group.target, [MEMBER_ROLE]);
  group.guild.members.cache.delete(TARGET);
  vouch.handleGuildMemberRemove(group.target);
  assert.ok(vouch.store.getActiveVouch(group.guild.id, TARGET));
  group.guild.members.cache.set(TARGET, group.target);
  await vouch.handleGuildMemberAdd(group.target);
  assert.equal(group.target.roles.cache.has(VOUCH_ROLE), true);

  const channel = {
    id: "444000000000000001",
    guild: group.guild,
    isTextBased: () => true,
    async send() { return null; }
  };
  group.guild.channels.cache.set(channel.id, channel);
  vouch.store.setLogChannel(group.guild.id, channel.id);
  await vouch.handleChannelDelete(channel);
  assert.equal(vouch.store.getConfig(group.guild.id).log_channel_id, null);

  const role = group.guild.roles.cache.get(VOUCH_ROLE);
  role.guild = group.guild;
  await vouch.handleRoleDelete(role);
  assert.equal(vouch.store.getConfig(group.guild.id).vouch_role_id, null);
  const afterDelete = await run(group.guild, group.giver, `-vouch give ${OTHER} later`);
  assert.equal(titleOf(afterDelete), "Vouch Role Required");
});

test("legacy stripstaff role is removed and moderation commands still route", async () => {
  const group = cast();
  await authorize(group);
  const legacy = makeRole(LEGACY_ROLE, "Stripped", [], 3);
  group.guild.roles.cache.set(legacy.id, legacy);
  group.plain.roles.cache.set(STAFF_ROLE, group.guild.roles.cache.get(STAFF_ROLE));
  group.plain.roles.cache.set(legacy.id, legacy);
  group.plain.roles.cache.set(MEMBER_ROLE, group.guild.roles.cache.get(MEMBER_ROLE));
  const configured = await run(group.guild, group.owner, `-setrole stripstaff ${LEGACY_ROLE}`);
  assert.equal(titleOf(configured), "Stripstaff Role Set");
  await vouch.protection.stripStaff(group.plain, { reason: "manual test", automatic: true });
  assert.equal(group.plain.roles.cache.has(STAFF_ROLE), false);
  assert.equal(group.plain.roles.cache.has(LEGACY_ROLE), false);
  assert.equal(group.plain.roles.cache.has(MEMBER_ROLE), true);

  const banned = await run(group.guild, group.plain, `-ban ${TARGET} spam`);
  assert.equal(titleOf(banned), "Access Denied");
});

test("reconcile restores a reserved vouch after a restart window and does not duplicate it", async () => {
  const group = cast();
  await authorize(group);
  const reserved = vouch.store.reserveVouch({
    guildId: group.guild.id,
    giverId: GIVER,
    targetId: TARGET,
    reason: "crash"
  });
  assert.equal(reserved.ok, true);
  setRoleIds(group.target, [MEMBER_ROLE]);
  await vouch.reconcileGuild(group.guild);
  assert.equal(group.target.roles.cache.has(VOUCH_ROLE), true);
  const added = group.target.roles.added.length;
  await vouch.reconcileGuild(group.guild);
  assert.equal(group.target.roles.added.length, added);
  assert.equal(vouch.store.countActive(group.guild.id), 1);

  const duplicate = vouch.store.reserveVouch({
    guildId: group.guild.id,
    giverId: OWNER,
    targetId: TARGET,
    reason: "second"
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, "active");
});
