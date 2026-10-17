const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AuditLogEvent, PermissionFlagsBits } = require("discord.js");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spanter-seller-"));
process.env.DB_PATH = path.join(scratch, "vc.sqlite");
process.env.PREFIX = "-";
process.env.npm_lifecycle_event = "test";
process.env.NODE_TEST_CONTEXT = "1";

const { handleCommand } = require("../commands");
const store = require("../systems/store");
const access = require("../systems/access");
const sellers = require("../verified-seller");

const OWNER = "111000000000000071";
const GOD = "111000000000000072";
const FOUNDER = "111000000000000073";
const SELLER = "111000000000000074";
const MEMBER = "111000000000000075";
const TARGET = "111000000000000076";
const ROGUE = "111000000000000077";
const ADMIN = "111000000000000078";
const BOT = "111000000000000079";
const ROLE = "222000000000000071";
const PLUS = "222000000000000072";

let guildSerial = 0;

function textOf(message) {
  return message.replies.at(-1).embeds[0].data.description;
}

function titleOf(message) {
  const data = message.replies.at(-1).embeds[0].data;
  if (data.title) return data.title;
  const match = String(data.description || "").match(/\*\*([^*]+)\*\*/);
  return match ? match[1] : "";
}

function makeMember(guild, id, options = {}) {
  const dms = [];
  const member = {
    id,
    guild,
    displayName: options.name || id,
    user: {
      id,
      bot: !!options.bot,
      username: options.name || id,
      dms,
      async send(payload) {
        dms.push(payload.content);
        return payload;
      }
    },
    roles: {
      cache: new Map([[guild.id, { id: guild.id }]]),
      async add(roleId) {
        this.cache.set(String(roleId), { id: String(roleId) });
      },
      async remove(roleId) {
        this.cache.delete(String(roleId));
        this.removed = String(roleId);
      }
    },
    permissions: { has: (flag) => flag === PermissionFlagsBits.Administrator && !!options.admin },
    async send(payload) {
      dms.push(payload.content);
      return payload;
    }
  };
  member.roles.cache.has = Map.prototype.has.bind(member.roles.cache);
  guild.members.cache.set(id, member);
  return member;
}

function makeGuild() {
  guildSerial += 1;
  const id = `seller-${guildSerial}`;
  const guild = {
    id,
    name: "Spanter",
    ownerId: OWNER,
    kicks: [],
    client: { user: { id: BOT } },
    members: {
      cache: new Map(),
      me: { id: BOT },
      async fetch(userId) {
        if (userId && typeof userId === "object") return this.cache;
        return this.cache.get(String(userId)) || null;
      },
      async kick(userId) {
        this.kicks = guild.kicks;
        guild.kicks.push(String(userId));
      }
    },
    roles: {
      cache: new Map([[id, { id, name: "@everyone", managed: false }]]),
      async fetch(roleId) {
        if (roleId && typeof roleId === "object") return this.cache;
        return this.cache.get(String(roleId)) || null;
      },
      async create(options) {
        const role = { id: ROLE, name: options.name, managed: false, permissions: options.permissions };
        this.cache.set(role.id, role);
        return role;
      }
    }
  };
  guild.members.kick = guild.members.kick.bind(guild);
  return guild;
}

function makeMessage(guild, content, member) {
  return {
    guild,
    author: member.user,
    member,
    content,
    mentions: { members: { first: () => null }, roles: { first: () => null }, channels: { first: () => null } },
    replies: [],
    async reply(payload) {
      this.replies.push(payload);
      return payload;
    }
  };
}

async function run(guild, member, content) {
  const message = makeMessage(guild, content, member);
  await handleCommand(message, guild.client, "-");
  return message;
}

function entry(executor, target, roleId, key = "$add") {
  return {
    id: `${executor}-${target}-${key}-${Math.random()}`,
    action: AuditLogEvent.MemberRoleUpdate,
    executorId: executor,
    targetId: target,
    createdTimestamp: Date.now(),
    changes: [{ key, new: [{ id: roleId }] }]
  };
}

test("only CEOs and the owner can add a verified seller", async () => {
  const guild = makeGuild();
  const owner = makeMember(guild, OWNER, { name: "owner" });
  const founder = makeMember(guild, FOUNDER, { name: "founder" });
  const member = makeMember(guild, MEMBER, { name: "member" });
  makeMember(guild, BOT, { name: "bot", bot: true });
  store.setStaff(guild.id, founder.id, "founder", owner.id);
  guild.roles.cache.set(ROLE, { id: ROLE, name: "Verified Seller", managed: false });

  const denied = await run(guild, founder, `-verifiedseller ${ROLE}`);
  assert.equal(titleOf(denied), "Access Denied");
  const missing = await run(guild, member, `-verifiedseller add ${member.id}`);
  assert.equal(titleOf(missing), "Access Denied");

  const set = await run(guild, owner, `-verifiedseller ${ROLE}`);
  assert.equal(titleOf(set), "Verified Seller Role Set");
  assert.equal(sellers.roleId(guild.id), ROLE);

  const added = await run(guild, owner, `-verifiedseller add ${member.id}`);
  assert.equal(titleOf(added), "Verified Seller Added");
  assert.equal(sellers.isSeller(member), true);
  assert.equal(access.rankLine(member), "Your rank: Verified Seller");

  const again = await run(guild, owner, `-verifiedseller add`);
  assert.match(textOf(again), /verifiedseller add/);
});

test("adding a seller with no role offers to create one", async () => {
  const guild = makeGuild();
  const owner = makeMember(guild, OWNER, { name: "owner" });
  const member = makeMember(guild, MEMBER, { name: "member" });
  const asked = await run(guild, owner, `-verifiedseller add ${member.id}`);
  assert.equal(titleOf(asked), "Verified Seller Role");
  const button = asked.replies[0].components[0].components[0];
  assert.equal(button.data.label, "Create role");
  const interaction = {
    customId: button.data.custom_id,
    user: { id: owner.id },
    member: owner,
    guild,
    async update(payload) { this.updated = payload; }
  };
  assert.equal(await sellers.handleInteraction(interaction), true);
  assert.equal(guild.roles.cache.get(ROLE).name, "Verified Seller");
  assert.equal(sellers.isSeller(member), true);
  assert.match(interaction.updated.embeds[0].data.description, /Verified Seller Added/);

  const stranger = makeMember(guild, FOUNDER, { name: "founder" });
  const blocked = {
    customId: button.data.custom_id,
    user: { id: stranger.id },
    member: stranger,
    guild,
    async reply(payload) { this.replied = payload; }
  };
  assert.equal(await sellers.handleInteraction(blocked), true);
  assert.match(blocked.replied.embeds[0].data.description, /Not Yours/);
});

test("verified sellers can assign a VC rank and protect a role", async () => {
  const guild = makeGuild();
  const owner = makeMember(guild, OWNER, { name: "owner" });
  const seller = makeMember(guild, SELLER, { name: "seller" });
  const target = makeMember(guild, TARGET, { name: "target" });
  const plus = { id: PLUS, name: "Plus", managed: false };
  const protectedRole = { id: ROLE, name: "Guests", managed: false };
  guild.roles.cache.set(PLUS, plus);
  guild.roles.cache.set(ROLE, protectedRole);
  store.setVoiceRole(guild.id, "plus", PLUS);
  sellers.handleAudit(guild, {
    ...entry(BOT, seller.id, ROLE),
    action: AuditLogEvent.MemberRoleUpdate
  });
  statementsReady(guild, seller);

  const assigned = await run(guild, seller, `-vc rank assign ${target.id} plus`);
  assert.equal(titleOf(assigned), "Rank Assigned");
  const unrank = await run(guild, seller, `-vc unrank ${target.id}`);
  assert.equal(titleOf(unrank), "Access Denied");
  const bound = await run(guild, seller, `-voice plus ${PLUS}`);
  assert.equal(titleOf(bound), "Access Denied");

  const protectedReply = await run(guild, seller, `-protect ${ROLE}`);
  assert.notEqual(titleOf(protectedReply), "Access Denied");
  const person = await run(guild, seller, `-protect ${target.id}`);
  assert.equal(titleOf(person), "Access Denied");
  assert.match(textOf(person), /protect someone/);
});

function statementsReady(guild, seller) {
  const role = { id: ROLE, name: "Verified Seller", managed: false };
  guild.roles.cache.set(ROLE, role);
  require("../db").connection.prepare("INSERT OR REPLACE INTO verified_seller_config (guild_id, role_id) VALUES (?, ?)").run(guild.id, ROLE);
  seller.roles.cache.set(ROLE, role);
}

test("an unauthorized role grant kicks the giver and tells administrators", async () => {
  const guild = makeGuild();
  const owner = makeMember(guild, OWNER, { name: "owner" });
  const god = makeMember(guild, GOD, { name: "god" });
  const rogue = makeMember(guild, ROGUE, { name: "rogue" });
  const target = makeMember(guild, TARGET, { name: "target" });
  const admin = makeMember(guild, ADMIN, { name: "admin", admin: true });
  store.setStaff(guild.id, god.id, "god", owner.id);
  statementsReady(guild, makeMember(guild, SELLER, { name: "seller" }));

  await sellers.handleAudit(guild, entry(god.id, target.id, ROLE));
  assert.deepEqual(guild.kicks, []);
  assert.equal(sellers.isSeller(target), true);

  const fresh = makeMember(guild, MEMBER, { name: "fresh" });
  fresh.roles.cache.set(ROLE, guild.roles.cache.get(ROLE));
  await sellers.handleAudit(guild, entry(rogue.id, fresh.id, ROLE));
  assert.deepEqual(guild.kicks, [rogue.id]);
  assert.equal(fresh.roles.cache.has(ROLE), false);
  assert.match(rogue.user.dms[0], /You were kicked/);
  assert.match(rogue.user.dms[0], /Only CEOs and the server owner/);
  const report = admin.user.dms[0];
  assert.match(report, new RegExp(`Who: <@${rogue.id}>`));
  assert.match(report, new RegExp(`To: <@${fresh.id}>`));
  assert.match(report, /Punishment: kicked/);
  assert.match(report, /Response time: \d+ms/);
  assert.match(owner.user.dms[0], /Who:/);
  assert.equal(sellers.isSeller(fresh), false);

  target.roles.cache.delete(ROLE);
  await sellers.handleAudit(guild, entry(god.id, target.id, ROLE, "$remove"));
  assert.deepEqual(guild.kicks, [rogue.id]);
  assert.equal(target.roles.cache.has(ROLE), false);
  assert.equal(sellers.isSeller(target), false);

  guild.kicks.length = 0;
  fresh.roles.cache.delete(ROLE);
  await sellers.handleAudit(guild, entry(rogue.id, fresh.id, ROLE, "$remove"));
  assert.deepEqual(guild.kicks, [rogue.id]);
  assert.equal(fresh.roles.cache.has(ROLE), true);
  assert.match(rogue.user.dms.at(-1), /removed/);
  assert.match(rogue.user.dms.at(-1), /Only CEOs and the server owner/);
  assert.match(admin.user.dms.at(-1), /removed without permission/);
  assert.match(admin.user.dms.at(-1), new RegExp(`Who: <@${rogue.id}>`));
  assert.match(admin.user.dms.at(-1), /Response time: \d+ms/);
  assert.equal(sellers.isSeller(fresh), true);

  fresh.roles.cache.delete(ROLE);
  await sellers.handleAudit(guild, entry(owner.id, fresh.id, ROLE, "$remove"));
  assert.deepEqual(guild.kicks, [rogue.id]);
  assert.equal(fresh.roles.cache.has(ROLE), false);
  assert.equal(sellers.isSeller(fresh), false);

  guild.kicks.length = 0;
  await sellers.handleAudit(guild, entry(BOT, MEMBER, ROLE));
  assert.deepEqual(guild.kicks, []);
});

test("another bot that changes the verified seller role is left alone", async () => {
  const guild = makeGuild();
  const owner = makeMember(guild, OWNER, { name: "owner" });
  const admin = makeMember(guild, ADMIN, { name: "admin", admin: true });
  const stain = makeMember(guild, "111000000000000080", { name: "stain", bot: true });
  const kisses = makeMember(guild, TARGET, { name: "kisses" });
  statementsReady(guild, makeMember(guild, SELLER, { name: "seller" }));
  kisses.roles.cache.set(ROLE, guild.roles.cache.get(ROLE));

  await sellers.handleAudit(guild, {
    ...entry(stain.id, kisses.id, ROLE),
    executor: { id: stain.id, bot: true }
  });
  assert.deepEqual(guild.kicks, []);
  assert.equal(kisses.roles.removed, undefined);
  assert.equal(kisses.roles.cache.has(ROLE), true);
  assert.equal(sellers.isSeller(kisses), true);
  assert.equal(stain.user.dms.length, 0);
  assert.match(admin.user.dms[0], /given by a bot/);
  assert.match(admin.user.dms[0], /Punishment: none/);
  assert.match(admin.user.dms[0], new RegExp(`Who: <@${stain.id}>`));
  assert.match(owner.user.dms[0], /by hand/);

  kisses.roles.cache.delete(ROLE);
  await sellers.handleAudit(guild, {
    ...entry(stain.id, kisses.id, ROLE, "$remove"),
    executor: { id: stain.id, bot: true }
  });
  assert.deepEqual(guild.kicks, []);
  assert.equal(kisses.roles.cache.has(ROLE), false);
  assert.equal(sellers.isSeller(kisses), false);
  assert.match(admin.user.dms.at(-1), /removed by a bot/);
  assert.match(admin.user.dms.at(-1), /Punishment: none/);
});

test("newcommands lists the latest commands in a few words", async () => {
  const guild = makeGuild();
  const member = makeMember(guild, MEMBER, { name: "member" });
  const shown = await run(guild, member, "-newcommands");
  const page = shown.replies[0].embeds[0].data;
  assert.equal(page.title, "New Commands");
  for (const bit of ["verifiedseller add", "addgiver", "securityconfig", "`-dpa`", "`-vp`", "watchuser", "`-u @user`", "proof", "auditlog", "unprotect"]) {
    assert.match(page.description, new RegExp(bit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("verified sellers grant only the commands a CEO opened", async () => {
  const guild = makeGuild();
  const owner = makeMember(guild, OWNER, { name: "owner" });
  const seller = makeMember(guild, SELLER, { name: "seller" });
  const member = makeMember(guild, MEMBER, { name: "member" });
  statementsReady(guild, seller);

  const closed = await run(guild, seller, `-grant forcenickname ${member.id}`);
  assert.equal(titleOf(closed), "Access Denied");
  const opened = await run(guild, owner, "-verifiedseller addgiver forcenickname");
  assert.equal(titleOf(opened), "Grant Opened");
  const granted = await run(guild, seller, `-grant forcenickname ${member.id}`);
  assert.equal(titleOf(granted), "Command Granted");
  assert.equal(store.hasCommandGrant(guild.id, member.id, "forcenickname"), true);
  const other = await run(guild, seller, `-grant muteall ${member.id}`);
  assert.equal(titleOf(other), "Access Denied");
  const revoked = await run(guild, seller, `-revoke forcenickname ${member.id}`);
  assert.equal(titleOf(revoked), "Access Denied");
  const byOwner = await run(guild, owner, `-grant muteall ${member.id}`);
  assert.equal(titleOf(byOwner), "Command Granted");

  const help = await run(guild, member, "-help");
  const menu = help.replies[0].components[0].toJSON().components[0];
  assert.deepEqual(menu.options.map((option) => option.value), ["overview", "moderation", "voice", "vouch", "roles", "seller"]);
});
