const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AuditLogEvent, PermissionFlagsBits } = require("discord.js");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spanter-security-"));
process.env.DB_PATH = path.join(scratch, "vc.sqlite");
process.env.PREFIX = "-";
process.env.npm_lifecycle_event = "test";
process.env.NODE_TEST_CONTEXT = "1";

const security = require("../security");
const store = require("../systems/store");
const catalog = require("../vouch/catalog");

const OWNER = "111000000000000041";
const ATTACKER = "111000000000000042";
const BOT = "111000000000000043";
const ROLE = "222000000000000041";
const ADDED_BOT = "111000000000000044";
const VICTIM = "111000000000000045";
const ADMIN = "111000000000000046";

let guildSerial = 0;

function text(payload) {
  return payload.embeds[0].data.description;
}

function makeRole(bits = 0n) {
  return {
    id: ROLE,
    name: "Staff",
    permissions: { bitfield: bits },
    deleted: false,
    async setPermissions(next) {
      this.permissions = { bitfield: typeof next === "bigint" ? next : BigInt(next) };
      this.restored = this.permissions.bitfield;
    },
    async delete() {
      this.deleted = true;
    }
  };
}

function makeGuild() {
  guildSerial += 1;
  const bans = [];
  const patches = [];
  const guild = {
    id: `security-${guildSerial}`,
    ownerId: OWNER,
    vanityURLCode: "spanter",
    bans,
    patches,
    channels: {
      cache: new Map(),
      async create(options) {
        const channel = {
          id: `${guild.id}-ch-${this.cache.size + 1}`,
          name: options.name,
          permissionOverwrites: options.permissionOverwrites,
          sent: [],
          async send(payload) {
            this.sent.push(payload);
            return payload;
          }
        };
        this.cache.set(channel.id, channel);
        return channel;
      }
    },
    roles: {
      cache: new Map(),
      async fetch(id) {
        return this.cache.get(id) || null;
      }
    },
    members: {
      me: { id: BOT },
      cache: new Map(),
      async ban(id, options) {
        bans.push({ id: String(id), options });
      },
      async kick(id) {
        bans.push({ id: String(id), kick: true });
      },
      async fetch(id) {
        return this.cache.get(String(id)) || null;
      }
    },
    client: {
      user: { id: BOT },
      rest: {
        async patch(_route, body) {
          patches.push(body);
          guild.vanityURLCode = body.body.code;
        }
      }
    }
  };
  return guild;
}

function message(guild, content, authorId = OWNER) {
  const args = content.split(/\s+/);
  return {
    content,
    args,
    guild,
    author: { id: authorId, username: "owner" },
    member: { id: authorId, guild },
    replies: [],
    async reply(payload) {
      this.replies.push(payload);
      return payload;
    }
  };
}

async function run(guild, content, authorId = OWNER) {
  const shown = message(guild, content, authorId);
  const args = content.split(/\s+/);
  const name = args[0].slice(1).toLowerCase();
  assert.equal(await security.handleCommand(shown, name, args), true);
  return shown;
}

function entry(action, fields) {
  return { action, createdTimestamp: Date.now(), changes: [], ...fields };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("securityconfig lists every module and a member cannot change it", async () => {
  const guild = makeGuild();
  const shown = await run(guild, "-securityconfig");
  const description = text(shown.replies[0]);
  assert.match(description, /\*\*Vanity Protection\*\* · Off/);
  assert.match(description, /\*\*Dangerous Permissions Add\*\* · Off/);
  assert.match(description, /\*\*Dangerous Permissions Update\*\* · Off/);
  assert.match(description, /\*\*Deny Bot Joins\*\* · Off/);
  assert.match(description, /\*\*Mass Member Kick\*\* · Off/);
  assert.match(description, /Threshold 3 in 8 seconds · punishment ban/);
  assert.match(description, /\*\*Mass Member Ban\*\* · Off/);
  assert.match(description, /Whitelist: the server owner, this bot, and Anti-Nuke admins/);

  const member = await run(guild, "-dpa on", ATTACKER);
  assert.match(text(member.replies[0]), /Access Denied/);
  assert.equal(await security.handleCommand(message(guild, "-antinuke"), "antinuke", ["-antinuke"]), false);
  assert.equal(await security.handleCommand(message(guild, "-vanity"), "vanity", ["-vanity"]), false);
});

test("dangerous permission modules reverse the role and ban the member", async () => {
  const guild = makeGuild();
  const role = makeRole(0n);
  guild.roles.cache.set(ROLE, role);
  const enabled = await run(guild, "-dpa on");
  assert.match(text(enabled.replies[0]), /Dangerous Permissions Add\*\* is on/);
  const channel = [...guild.channels.cache.values()][0];
  assert.equal(channel.name, "security-events");
  assert.equal(channel.permissionOverwrites[0].id, guild.id);
  assert.ok(channel.permissionOverwrites[0].deny.includes(PermissionFlagsBits.ViewChannel));

  await security.handleAudit(guild, entry(AuditLogEvent.RoleUpdate, {
    executorId: ATTACKER,
    targetId: ROLE,
    changes: [{ key: "permissions", old: "0", new: PermissionFlagsBits.Administrator.toString() }]
  }));
  assert.equal(role.restored, 0n);
  assert.deepEqual(guild.bans.map((ban) => ban.id), [ATTACKER]);

  guild.bans.length = 0;
  role.restored = undefined;
  await security.handleAudit(guild, entry(AuditLogEvent.RoleUpdate, {
    executorId: OWNER,
    targetId: ROLE,
    changes: [{ key: "permissions", old: "0", new: PermissionFlagsBits.Administrator.toString() }]
  }));
  assert.equal(role.restored, undefined);
  assert.equal(guild.bans.length, 0);

  const update = makeGuild();
  const updated = makeRole(0n);
  update.roles.cache.set(ROLE, updated);
  await run(update, "-dpu on");
  await security.handleAudit(update, entry(AuditLogEvent.RoleUpdate, {
    executorId: ATTACKER,
    targetId: ROLE,
    changes: [{ key: "permissions", old: "0", new: PermissionFlagsBits.BanMembers.toString() }]
  }));
  assert.equal(updated.restored, 0n);
  assert.equal(update.bans[0].id, ATTACKER);

  const created = makeGuild();
  const fresh = makeRole(PermissionFlagsBits.Administrator);
  created.roles.cache.set(ROLE, fresh);
  await run(created, "-dangerouspermissionsadd on");
  await security.handleAudit(created, entry(AuditLogEvent.RoleCreate, {
    executorId: ATTACKER,
    targetId: ROLE,
    changes: [{ key: "permissions", new: PermissionFlagsBits.Administrator.toString() }]
  }));
  assert.equal(fresh.deleted, true);
  assert.equal(created.bans[0].id, ATTACKER);

  const quiet = makeGuild();
  const untouched = makeRole(0n);
  quiet.roles.cache.set(ROLE, untouched);
  await security.handleAudit(quiet, entry(AuditLogEvent.RoleUpdate, {
    executorId: ATTACKER,
    targetId: ROLE,
    changes: [{ key: "permissions", old: "0", new: PermissionFlagsBits.Administrator.toString() }]
  }));
  assert.equal(quiet.bans.length, 0);
});

test("vanity protection restores the saved code and bans a stranger", async () => {
  const guild = makeGuild();
  const enabled = await run(guild, "-vp on");
  assert.match(text(enabled.replies[0]), /Saved vanity: `spanter`/);
  await security.handleAudit(guild, entry(AuditLogEvent.GuildUpdate, {
    executorId: ATTACKER,
    targetId: guild.id,
    changes: [{ key: "vanity_url_code", old: "spanter", new: "hacked" }]
  }));
  assert.equal(guild.patches[0].body.code, "spanter");
  assert.equal(guild.bans[0].id, ATTACKER);

  const trusted = makeGuild();
  await run(trusted, "-vanityprotection on");
  store.addAntinukeAdmin(trusted.id, ADMIN, OWNER);
  await security.handleAudit(trusted, entry(AuditLogEvent.GuildUpdate, {
    executorId: ADMIN,
    targetId: trusted.id,
    changes: [{ key: "vanity_url_code", old: "spanter", new: "official" }]
  }));
  assert.equal(trusted.patches.length, 0);
  assert.equal(trusted.bans.length, 0);
  assert.equal(security.load(trusted.id).vanity_code, "official");
});

test("deny bot joins bans the bot and the member who added it", async () => {
  const guild = makeGuild();
  await run(guild, "-dbj on");
  await security.handleAudit(guild, entry(AuditLogEvent.BotAdd, {
    executorId: ATTACKER,
    targetId: ADDED_BOT
  }));
  assert.deepEqual(guild.bans.map((ban) => ban.id).sort(), [ADDED_BOT, ATTACKER].sort());

  const owner = makeGuild();
  await run(owner, "-denybotjoins on");
  await security.handleMemberAdd({
    id: ADDED_BOT,
    bot: true,
    guild: owner,
    user: { id: ADDED_BOT, bot: true }
  });
  owner.fetchAuditLogs = async () => ({
    entries: [{ executorId: OWNER, targetId: ADDED_BOT, action: AuditLogEvent.BotAdd }]
  });
  await security.handleMemberAdd({
    id: ADDED_BOT,
    bot: true,
    guild: owner,
    user: { id: ADDED_BOT, bot: true }
  });
  assert.equal(owner.bans.length, 0);
});

test("mass kick waits for the threshold, then punishes once", async () => {
  const guild = makeGuild();
  await run(guild, "-mmk threshold 2");
  await run(guild, "-massmemberkick on");
  const kick = (id) => entry(AuditLogEvent.MemberKick, { executorId: ATTACKER, targetId: id });
  await security.handleAudit(guild, kick(VICTIM));
  assert.equal(guild.bans.length, 0);
  await security.handleAudit(guild, kick("111000000000000099"));
  assert.equal(guild.bans.length, 1);
  assert.equal(guild.bans[0].id, ATTACKER);
  await security.handleAudit(guild, kick("111000000000000098"));
  assert.equal(guild.bans.length, 1);
});

test("watch role and watched member logs stay in the private watch channel", async () => {
  const guild = makeGuild();
  guild.roles.cache.set(ROLE, { id: ROLE, name: "Staff" });
  const watched = await run(guild, `-setwatchrole ${ROLE}`);
  assert.match(text(watched.replies[0]), /Watching <@&222000000000000041>/);
  const channel = [...guild.channels.cache.values()].find((item) => item.name === "watchlist");
  assert.ok(channel.permissionOverwrites[0].deny.includes(PermissionFlagsBits.ViewChannel));

  const when = Date.now();
  await security.handleAudit(guild, entry(AuditLogEvent.MemberRoleUpdate, {
    executorId: ATTACKER,
    targetId: VICTIM,
    createdTimestamp: when,
    changes: [{ key: "$add", new: [{ id: ROLE, name: "Staff" }] }]
  }));
  await flush();
  assert.match(channel.sent[0].embeds[0].data.description, new RegExp(`<@${ATTACKER}> gave <@&${ROLE}> to <@${VICTIM}> at ${security.stamp(when)}`));

  guild.members.cache.set(ATTACKER, { id: ATTACKER, user: { id: ATTACKER, username: "attacker", bot: false } });
  await run(guild, `-watchuser ${ATTACKER}`);
  await security.handleAudit(guild, entry(AuditLogEvent.MemberBanAdd, {
    executorId: ATTACKER,
    targetId: VICTIM,
    createdTimestamp: when
  }));
  await flush();
  assert.match(channel.sent.map((item) => item.embeds[0].data.description).join("\n"), new RegExp(`<@${ATTACKER}> banned <@${VICTIM}> at ${security.stamp(when)}`));

  const pages = catalog.commandPages("-").map((page) => page.description).join("\n");
  assert.match(pages, /`-securityconfig` view modules and thresholds · Owner and Anti-Nuke admins/);
  assert.match(pages, /`-antinuke vouch` view vouch config/);
  assert.equal(security.stamp(Date.parse("2026-09-08T21:32:00-04:00")), "9:32pm est 9/8/26");
});
