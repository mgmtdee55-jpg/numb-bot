const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
function embedTitle(embed) {
  const data = embed?.data || {};
  if (data.title) return data.title;
  const match = String(data.description || "").match(/\*\*([^*]+)\*\*/);
  return match ? match[1] : "";
}

const { PermissionFlagsBits } = require("discord.js");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spanter-moderation-"));
process.env.DB_PATH = path.join(scratch, "vc.sqlite");

const db = require("../db");
const staffStore = require("../systems/store");
const { handleCommand } = require("../commands");

function asGod(member) {
  staffStore.setStaff(member.guild.id, member.id, "god", member.guild.ownerId);
  return member;
}
const { enforceHardban, enforceForeverban, restoreForeverban } = require("../moderation");

function makeGuild(guildId = "mod-guild") {
  const members = new Map();
  const roles = new Map();
  const bans = new Map();
  const everyone = { id: `everyone-${guildId}`, name: "@everyone", position: 0 };
  roles.set(everyone.id, everyone);
  const guild = {
    id: guildId,
    ownerId: "owner-1",
    client: { user: { id: "bot-1" }, guilds: { cache: new Map(), async fetch() { return null; } } },
    roles: {
      cache: roles,
      async fetch(roleId) { return roles.get(roleId) || null; }
    },
    members: {
      cache: members,
      me: {
        permissions: { has: (flag) => [PermissionFlagsBits.BanMembers, PermissionFlagsBits.ManageRoles].includes(flag) },
        roles: { highest: { position: 100 } }
      },
      async fetch(userId) {
        const member = members.get(userId);
        if (!member) throw Object.assign(new Error("Unknown Member"), { code: 10007 });
        return member;
      },
      async ban(userId, options = {}) {
        bans.set(userId, { user: { id: userId, username: `user-${userId}`, tag: `user-${userId}#0001` }, reason: options.reason });
        members.delete(userId);
        guild.banCalls.push({ userId, options });
      },
      async unban(userId) {
        if (!bans.has(userId)) throw new Error("Unknown Ban");
        bans.delete(userId);
        guild.unbanCalls.push(userId);
      }
    },
    bans: {
      async fetch(userId) {
        if (userId && typeof userId === "string") {
          const ban = bans.get(userId);
          if (!ban) throw new Error("Unknown Ban");
          return ban;
        }
        return bans;
      }
    },
    banCalls: [],
    unbanCalls: []
  };
  guild.client.guilds.cache.set(guild.id, guild);
  return guild;
}

function makeMember(guild, userId, options = {}) {
  const owner = options.owner === true;
  const roleList = options.roles || [];
  const cache = new Map();
  for (const role of roleList) {
    guild.roles.cache.set(role.id, role);
    cache.set(role.id, role);
  }
  const highest = [...cache.values()].sort((a, b) => b.position - a.position)[0] || { position: 0 };
  const member = {
    id: userId,
    guild,
    user: { id: userId, username: options.username || `user-${userId}`, globalName: options.globalName || null, createdTimestamp: options.createdTimestamp || Date.now() },
    displayName: `user-${userId}`,
    roles: {
      cache,
      highest,
      added: [],
      async add(role) {
        this.cache.set(role.id, role);
        this.added.push(role.id);
        this.highest = [...this.cache.values()].sort((a, b) => b.position - a.position)[0] || this.highest;
      }
    }
  };
  guild.members.cache.set(userId, member);
  if (owner) guild.ownerId = userId;
  return member;
}

function makeMessage(guild, content, member) {
  const replies = [];
  const roleMentions = [...guild.roles.cache.values()];
  return {
    content,
    guild,
    client: guild.client,
    author: { id: member.id },
    member,
    mentions: {
      members: { first: () => null },
      users: { first: () => null },
      roles: { first: () => (content.includes("<@&") ? roleMentions.find((role) => content.includes(role.id)) : null) }
    },
    replies,
    async reply(payload) {
      replies.push(payload);
      return { payload };
    }
  };
}

function title(message) {
  const data = message.replies[0].embeds[0].data;
  if (data.title) return data.title;
  const match = String(data.description || "").match(/\*\*([^*]+)\*\*/);
  return match ? match[1] : "";
}

function description(message) {
  return message.replies[0].embeds[0].data.description;
}

test("ban commands require ban_members or administrator fake permission", async () => {
  const guild = makeGuild("perm-guild");
  const owner = makeMember(guild, "111000000000000099", { owner: true });
  const modRole = { id: "role-mod", name: "Mods", position: 5 };
  const staff = makeMember(guild, "111000000000000001", { roles: [modRole] });
  const target = makeMember(guild, "111000000000000002", { roles: [{ id: "role-member", name: "Member", position: 1 }] });
  const denied = makeMessage(guild, `-ban ${target.id} spam`, staff);
  await handleCommand(denied, null, "-");
  assert.equal(title(denied), "Access Denied");
  asGod(staff);

  const ownerBan = makeMessage(guild, `-ban ${target.id} owner-ban`, owner);
  await handleCommand(ownerBan, null, "-");
  assert.equal(title(ownerBan), "Member Banned");

  const restored = makeMember(guild, target.id, { roles: [{ id: "role-member", name: "Member", position: 1 }] });
  db.addFakePermission(guild.id, modRole.id, "ban_members");
  const allowed = makeMessage(guild, `-ban ${restored.id} spam`, staff);
  await handleCommand(allowed, null, "-");
  assert.equal(title(allowed), "Member Banned");
  assert.equal(guild.banCalls.length, 2);
  assert.equal(db.getRecentBanHistory(guild.id, 1)[0].action, "ban");
});

test("hardban requires administrator fake permission and blocks unban", async () => {
  const guild = makeGuild("hardban-guild");
  const modRole = { id: "role-mod2", name: "Mods", position: 5 };
  const adminRole = { id: "role-admin", name: "Admins", position: 8 };
  const mod = asGod(makeMember(guild, "222000000000000001", { roles: [modRole] }));
  const admin = asGod(makeMember(guild, "222000000000000002", { roles: [adminRole] }));
  const target = makeMember(guild, "222000000000000003", { roles: [{ id: "role-member2", name: "Member", position: 1 }] });
  db.addFakePermission(guild.id, modRole.id, "ban_members");
  db.addFakePermission(guild.id, adminRole.id, "administrator");

  const denied = makeMessage(guild, `-hardban ${target.id} raid`, mod);
  await handleCommand(denied, null, "-");
  assert.equal(title(denied), "Missing Fake Permission");
  assert.match(description(denied), /administrator/);

  const allowed = makeMessage(guild, `-hardban ${target.id} raid`, admin);
  await handleCommand(allowed, null, "-");
  assert.equal(title(allowed), "Member Hardbanned");
  assert.equal(db.isHardbanned(guild.id, target.id), true);

  const unban = makeMessage(guild, `-unban ${target.id}`, mod);
  await handleCommand(unban, null, "-");
  assert.equal(title(unban), "Hardbanned");

  await enforceHardban({
    id: target.id,
    guild,
    async ban(options) { guild.banCalls.push({ userId: target.id, options }); }
  });
  assert.equal(guild.banCalls.at(-1).options.reason.includes("Hardbanned"), true);
});

test("fakepermissions add/list/remove and template round-trip", async () => {
  const guild = makeGuild("fp-guild");
  const owner = makeMember(guild, "owner-1", { owner: true });
  const role = { id: "role-fp", name: "Trusted", position: 3 };
  guild.roles.cache.set(role.id, role);
  const add = makeMessage(guild, `-fp add <@&${role.id}> ban_members`, owner);
  await handleCommand(add, null, "-");
  assert.equal(title(add), "Fake Permission Added");

  const adminRole = { id: "role-fp-admin", name: "Admins", position: 8 };
  const modRole = { id: "role-fp-mod", name: "Mods", position: 5 };
  const admin = asGod(makeMember(guild, "444000000000000002", { roles: [adminRole] }));
  const mod = asGod(makeMember(guild, "444000000000000003", { roles: [modRole] }));
  const outsider = makeMember(guild, "444000000000000001", { roles: [{ id: "role-plain", name: "Member", position: 1 }] });
  db.addFakePermission(guild.id, adminRole.id, "administrator");
  db.addFakePermission(guild.id, modRole.id, "ban_members");
  db.addFakePermission(guild.id, modRole.id, "manage_roles");

  const adminAdd = makeMessage(guild, `-fp add ${outsider.id} ban_members`, admin);
  await handleCommand(adminAdd, null, "-");
  assert.equal(title(adminAdd), "Fake Permission Added");

  const modAdd = makeMessage(guild, `-fp add <@&${role.id}> kick_members`, mod);
  await handleCommand(modAdd, null, "-");
  assert.equal(title(modAdd), "Missing Fake Permission");
  assert.match(description(modAdd), /administrator/);

  const list = makeMessage(guild, "-fakepermissions list", owner);
  await handleCommand(list, null, "-");
  assert.match(description(list), /ban_members/);

  const save = makeMessage(guild, "-fakepermissions template save staff", owner);
  await handleCommand(save, null, "-");
  assert.equal(title(save), "Template Saved");

  db.resetFakePermissions(guild.id);
  const load = makeMessage(guild, "-fakepermissions template load staff", owner);
  await handleCommand(load, null, "-");
  assert.match(description(load), /Applied \*\*\d+\*\*/);
  assert.equal(db.roleHasFakePermission(guild.id, role.id, "ban_members"), true);

  const remove = makeMessage(guild, `-fakepermissions remove <@&${role.id}> ban_members`, owner);
  await handleCommand(remove, null, "-");
  assert.equal(title(remove), "Fake Permission Removed");
});

test("ban check, list, purge, recent, softban, and unbanall skip hardbans", async () => {
  const guild = makeGuild("ban-suite-guild");
  const adminRole = { id: "role-admin3", name: "Admins", position: 9 };
  const admin = asGod(makeMember(guild, "333000000000000001", { roles: [adminRole] }));
  const target = makeMember(guild, "333000000000000002", { roles: [{ id: "role-m3", name: "Member", position: 1 }] });
  const extra = makeMember(guild, "333000000000000003", { roles: [{ id: "role-m4", name: "Member", position: 1 }] });
  db.addFakePermission(guild.id, adminRole.id, "administrator");

  const purge = makeMessage(guild, "-ban purge 1", admin);
  await handleCommand(purge, null, "-");
  assert.equal(db.getBanPurgeDays(guild.id), 1);

  await handleCommand(makeMessage(guild, `-ban ${target.id} ads`, admin), null, "-");
  await handleCommand(makeMessage(guild, `-softban ${extra.id} cleanup`, admin), null, "-");
  assert.equal(guild.unbanCalls.includes(extra.id), true);

  const check = makeMessage(guild, `-banned ${target.id}`, admin);
  await handleCommand(check, null, "-");
  assert.equal(title(check), "Ban Check");

  const list = makeMessage(guild, "-ban list", admin);
  await handleCommand(list, null, "-");
  assert.equal(title(list), "Banned Users");

  const recent = makeMessage(guild, "-ban recent", admin);
  await handleCommand(recent, null, "-");
  assert.equal(title(recent), "Recent Bans");

  await handleCommand(makeMessage(guild, `-hardban ${target.id} stay out`, admin), null, "-");
  const other = makeMember(guild, "333000000000000005", { roles: [{ id: "role-m5", name: "Member", position: 1 }] });
  await handleCommand(makeMessage(guild, `-ban ${other.id} extra`, admin), null, "-");

  const mass = makeMessage(guild, "-unbanall", admin);
  await handleCommand(mass, null, "-");
  assert.equal(title(mass), "Mass Unban Started");
  assert.equal(embedTitle(mass.replies.at(-1).embeds[0]), "Mass Unban Finished");
  assert.equal(db.isHardbanned(guild.id, target.id), true);
  assert.equal(guild.unbanCalls.includes(other.id), true);
});

test("role add requires manage_roles or administrator fake permission", async () => {
  const guild = makeGuild("role-add-guild");
  const staffRole = { id: "role-staff", name: "Staff", position: 5 };
  const assignRole = { id: "555000000000000099", name: "VIP", position: 3 };
  guild.roles.cache.set(assignRole.id, assignRole);
  const staff = asGod(makeMember(guild, "555000000000000001", { roles: [staffRole] }));
  const target = makeMember(guild, "555000000000000002", { roles: [{ id: "role-plain2", name: "Member", position: 1 }] });

  const denied = makeMessage(guild, `-role add ${target.id} ${assignRole.id}`, staff);
  await handleCommand(denied, null, "-");
  assert.equal(title(denied), "Missing Fake Permission");
  assert.match(description(denied), /manage_roles/);

  db.addFakePermission(guild.id, staffRole.id, "manage_roles");
  const allowed = makeMessage(guild, `-role add ${target.id} ${assignRole.id}`, staff);
  await handleCommand(allowed, null, "-");
  assert.equal(title(allowed), "Role Added");
  assert.equal(target.roles.cache.has(assignRole.id), true);

  const again = makeMessage(guild, `-role add ${target.id} ${assignRole.id}`, staff);
  await handleCommand(again, null, "-");
  assert.equal(title(again), "Already Has Role");
});

test("foreverban is owner-tier and cannot be lifted with unban", async () => {
  const guild = makeGuild("foreverban-guild");
  const owner = makeMember(guild, "666000000000000001", { owner: true });
  const adminRole = { id: "role-admin-fb", name: "Admins", position: 8 };
  const trustedRole = { id: "role-fb", name: "Punishers", position: 6 };
  const admin = asGod(makeMember(guild, "666000000000000002", { roles: [adminRole] }));
  const trusted = asGod(makeMember(guild, "666000000000000003", { roles: [trustedRole] }));
  const target = makeMember(guild, "666000000000000004", {
    roles: [{ id: "role-plain-fb", name: "Member", position: 1 }],
    username: "evader"
  });
  db.addFakePermission(guild.id, adminRole.id, "administrator");

  const deniedAdmin = makeMessage(guild, `-fb ${target.id} raid`, admin);
  await handleCommand(deniedAdmin, null, "-");
  assert.equal(title(deniedAdmin), "Missing Fake Permission");

  const ownerGrant = makeMessage(guild, `-fp add <@&${trustedRole.id}> foreverban_members`, owner);
  guild.roles.cache.set(trustedRole.id, trustedRole);
  await handleCommand(ownerGrant, null, "-");
  assert.equal(title(ownerGrant), "Fake Permission Added");

  const adminGrant = makeMessage(guild, `-fp add <@&${adminRole.id}> foreverban_members`, admin);
  await handleCommand(adminGrant, null, "-");
  assert.equal(title(adminGrant), "Owner Only");

  const banned = makeMessage(guild, `-fb ${target.id} raid`, trusted);
  await handleCommand(banned, null, "-");
  assert.equal(title(banned), "Member Foreverbanned");
  assert.equal(db.isForeverbanned(guild.id, target.id), true);
  assert.equal(guild.banCalls.at(-1).options.deleteMessageSeconds, 7 * 86400);
  assert.match(guild.banCalls.at(-1).options.reason, /FOREVERBAN/);

  const unban = makeMessage(guild, `-unban ${target.id}`, admin);
  await handleCommand(unban, null, "-");
  assert.equal(title(unban), "Foreverbanned");

  await restoreForeverban({ guild, user: { id: target.id } });
  assert.equal(guild.banCalls.at(-1).options.reason.includes("FOREVERBAN"), true);

  const alt = makeMember(guild, "666000000000000005", {
    username: "evader",
    createdTimestamp: Date.now() - 1000
  });
  await enforceForeverban(alt);
  assert.equal(db.isForeverbanned(guild.id, alt.id), true);

  const lifted = makeMessage(guild, `-fub ${target.id}`, owner);
  await handleCommand(lifted, null, "-");
  assert.equal(title(lifted), "Foreverban Lifted");
  assert.equal(db.isForeverbanned(guild.id, target.id), false);
});
