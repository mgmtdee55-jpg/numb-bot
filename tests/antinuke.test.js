const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AuditLogEvent, ChannelType } = require("discord.js");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spanter-antinuke-"));
process.env.DB_PATH = path.join(scratch, "vc.sqlite");
process.env.PREFIX = "-";
process.env.npm_lifecycle_event = "test";
process.env.NODE_TEST_CONTEXT = "1";

const { handleCommand } = require("../commands");
const antinuke = require("../antinuke");
const store = antinuke.store;
const engine = antinuke.engine;

const OWNER = "311000000000000001";
const MEMBER = "311000000000000002";
const ROGUE = "311000000000000003";
const BOT = "311000000000000004";

let serial = 0;

function textOf(message) {
  return message.replies.at(-1).embeds[0].data.description;
}

function titleOf(message) {
  const data = message.replies.at(-1).embeds[0].data;
  if (data.title) return data.title;
  const match = String(data.description || "").match(/\*\*([^*]+)\*\*/);
  return match ? match[1] : "";
}

function makeMember(guild, id, name) {
  const member = {
    id,
    guild,
    displayName: name,
    user: { id, bot: false, username: name },
    permissions: { has: () => false },
    roles: { cache: new Map([[guild.id, { id: guild.id, managed: false, permissions: 0n }]]) }
  };
  guild.members.cache.set(id, member);
  return member;
}

function makeGuild() {
  serial += 1;
  const id = `anuke-${serial}`;
  const kicks = [];
  const created = [];
  const guild = {
    id,
    name: "Spanter",
    ownerId: OWNER,
    verificationLevel: 1,
    kicks,
    created,
    client: { user: { id: BOT } },
    members: {
      cache: new Map(),
      me: { id: BOT, permissions: { has: () => true } },
      async fetch(userId) { return this.cache.get(String(userId)) || null; },
      async kick(userId) {
        kicks.push(String(userId));
      }
    },
    roles: { cache: new Map([[id, { id, name: "@everyone", permissions: 0n }]]) },
    channels: {
      cache: new Map(),
      async create(options) {
        const channel = { id: `${id}-new-${created.length + 1}`, name: options.name, type: options.type, parentId: options.parent || null };
        created.push(channel);
        this.cache.set(channel.id, channel);
        return channel;
      }
    },
    async setVerificationLevel(level) {
      this.verificationLevel = level;
    },
    async setName(name) {
      this.name = name;
    }
  };
  return guild;
}

function activate(guild) {
  const config = store.defaults();
  config.active = 1;
  config.logChannelId = null;
  return store.save(guild.id, config);
}

function message(guild, member, content) {
  return {
    guild,
    author: member.user,
    member,
    content,
    mentions: { members: { first: () => null }, roles: { first: () => null } },
    replies: [],
    async reply(payload) {
      this.replies.push(payload);
      return payload;
    }
  };
}

async function run(guild, member, content) {
  const sent = message(guild, member, content);
  await handleCommand(sent, guild.client, "-");
  return sent;
}

function buttonId(payload, label) {
  for (const row of payload.components || []) {
    for (const component of row.components || []) {
      if (component.data?.label === label) return component.data.custom_id;
    }
  }
  return "";
}

test("only the owner or an anti-nuke admin can open setup, and vouch still owns antinuke vouch", async () => {
  const guild = makeGuild();
  const owner = makeMember(guild, OWNER, "owner");
  const member = makeMember(guild, MEMBER, "member");
  const denied = await run(guild, member, "-antinuke setup");
  assert.equal(titleOf(denied), "Access Denied");
  assert.equal(store.lastIncident(guild.id).action, "unauthorized");
  assert.equal(await antinuke.handleCommand(message(guild, owner, "-antinuke vouch"), ["-antinuke", "vouch"], "-"), false);
  const wizard = await run(guild, owner, "-antinuke setup");
  assert.equal(wizard.replies[0].embeds[0].data.title, "Anti-Nuke · Modules");
  let payload = wizard.replies[0];
  const actor = {
    user: { id: owner.id },
    member: owner,
    guild,
    async update(next) { payload = next; this.updated = next; }
  };
  for (let step = 0; step < 8; step += 1) {
    actor.customId = buttonId(payload, "Next");
    assert.equal(await antinuke.handleInteraction(actor), true);
  }
  actor.customId = buttonId(payload, "Confirm & Activate");
  assert.equal(await antinuke.handleInteraction(actor), true);
  assert.equal(store.get(guild.id).active, 1);
  const again = store.saved(guild.id);
  assert.equal(again.thresholds.banWarning.count, 3);
  assert.equal(again.thresholds.banWarning.seconds, 5);
  assert.equal(again.modules.channelDelete, true);
});

test("mass bans lock down once, duplicates and late audits do not punish again", async () => {
  const guild = makeGuild();
  makeMember(guild, OWNER, "owner");
  makeMember(guild, ROGUE, "rogue");
  activate(guild);
  for (let index = 0; index < 5; index += 1) {
    await engine.handleAudit(guild, {
      id: `ban-${index}`,
      action: AuditLogEvent.MemberBanAdd,
      executorId: ROGUE,
      targetId: `user-${index}`,
      createdTimestamp: Date.now(),
      instant: true
    }, true);
  }
  assert.deepEqual(guild.kicks, [ROGUE]);
  await engine.handleAudit(guild, {
    id: "ban-1",
    action: AuditLogEvent.MemberBanAdd,
    executorId: ROGUE,
    targetId: "user-1",
    createdTimestamp: Date.now(),
    instant: true
  }, true);
  assert.deepEqual(guild.kicks, [ROGUE]);
  await engine.handleAudit(guild, {
    id: "late",
    action: AuditLogEvent.MemberBanAdd,
    executorId: ROGUE,
    targetId: "late-user",
    createdTimestamp: Date.now() - 30000,
    instant: true
  }, true);
  assert.deepEqual(guild.kicks, [ROGUE]);
  assert.equal(store.lastIncident(guild.id).result, "ignored late audit");
});

test("a trusted account is logged without punishment unless lockdown bypass is explicit", async () => {
  const guild = makeGuild();
  makeMember(guild, OWNER, "owner");
  const rogue = makeMember(guild, ROGUE, "rogue");
  activate(guild);
  store.addWhitelist(guild.id, ROGUE, "user", "rogue", OWNER);
  for (let index = 0; index < 5; index += 1) {
    await engine.handleAudit(guild, {
      id: `trusted-${index}`,
      action: AuditLogEvent.MemberBanAdd,
      executorId: ROGUE,
      targetId: `user-${index}`,
      createdTimestamp: Date.now(),
      instant: true
    }, true);
  }
  assert.deepEqual(guild.kicks, []);
  assert.equal(store.get(guild.id).lockdownActive, 1);
  assert.equal(store.lastIncident(guild.id).whitelisted, 1);
  assert.match(rogue.displayName, /rogue/);
});

test("empty voice deletes are ignored and occupied voice deletes kick the executor", async () => {
  const guild = makeGuild();
  makeMember(guild, OWNER, "owner");
  makeMember(guild, ROGUE, "rogue");
  activate(guild);
  const empty = {
    id: "voice-empty",
    guild,
    name: "Empty",
    type: ChannelType.GuildVoice,
    members: { size: 0 },
    permissionOverwrites: { cache: new Map() }
  };
  const emptyResult = await engine.handleChannelDelete(empty, true);
  assert.equal(emptyResult.reason, "empty voice");
  await engine.handleAudit(guild, {
    id: "empty-audit",
    action: AuditLogEvent.ChannelDelete,
    executorId: ROGUE,
    targetId: empty.id,
    createdTimestamp: Date.now(),
    instant: true
  }, true);
  assert.deepEqual(guild.kicks, []);

  const full = {
    id: "voice-full",
    guild,
    name: "Full",
    type: ChannelType.GuildVoice,
    parentId: null,
    members: { size: 3 },
    permissionOverwrites: { cache: new Map() }
  };
  guild.fetchAuditLogs = async () => ({
    entries: new Map([["full", { id: "full-audit", executorId: ROGUE, targetId: full.id, createdTimestamp: Date.now() }]])
  });
  const punished = await engine.handleChannelDelete(full, true);
  assert.equal(punished.punishment.startsWith("kicked"), true);
  assert.deepEqual(guild.kicks, [ROGUE]);
  assert.equal(guild.created.length, 1);
  assert.equal(guild.created[0].name, "Full");

  store.addWhitelist(guild.id, ROGUE, "bot", "voicebot", OWNER);
  guild.kicks.length = 0;
  guild.fetchAuditLogs = async () => ({
    entries: new Map([["trusted-full", { id: "trusted-full", executorId: ROGUE, targetId: "voice-trusted", createdTimestamp: Date.now() }]])
  });
  await engine.handleChannelDelete({
    id: "voice-trusted",
    guild,
    name: "Trusted Call",
    type: ChannelType.GuildVoice,
    members: { size: 4 },
    permissionOverwrites: { cache: new Map() }
  }, true);
  assert.deepEqual(guild.kicks, [ROGUE]);

  for (let index = 0; index < 3; index += 1) {
    await engine.handleAudit(guild, {
      id: `empty-voice-audit-${index}`,
      action: AuditLogEvent.ChannelDelete,
      executorId: ROGUE,
      targetId: `gone-voice-${index}`,
      createdTimestamp: Date.now(),
      instant: true,
      changes: [{ key: "type", old: ChannelType.GuildVoice }]
    }, true);
  }
  assert.deepEqual(guild.kicks, [ROGUE]);

  guild.kicks.length = 0;
  guild.fetchAuditLogs = async () => ({
    entries: new Map([["owner", { id: "owner-audit", executorId: OWNER, targetId: "voice-owner", createdTimestamp: Date.now() }]])
  });
  await engine.handleChannelDelete({
    id: "voice-owner",
    guild,
    name: "Owner Call",
    type: ChannelType.GuildVoice,
    members: { size: 2 },
    permissionOverwrites: { cache: new Map() }
  }, true);
  assert.deepEqual(guild.kicks, []);
});

test("unknown executors, join bursts, rate limits, unlock, and recovery stay safe", async () => {
  const guild = makeGuild();
  makeMember(guild, OWNER, "owner");
  activate(guild);
  await engine.handleChannelDelete({
    id: "voice-unknown",
    guild,
    name: "Unknown",
    type: ChannelType.GuildVoice,
    members: { size: 2 },
    permissionOverwrites: { cache: new Map() }
  }, true);
  assert.deepEqual(guild.kicks, []);
  assert.equal(store.lastIncident(guild.id).result, "executor unknown");

  for (let index = 0; index < 12; index += 1) await engine.handleMemberAdd({ guild, id: `join-${index}` }, true);
  assert.deepEqual(guild.kicks, []);

  let attempts = 0;
  guild.members.kick = async (userId) => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("slow");
      error.status = 429;
      error.retryAfter = 40;
      throw error;
    }
    guild.kicks.push(String(userId));
  };
  engine.resetForTests();
  guild.fetchAuditLogs = async () => ({
    entries: new Map([["retry", { id: "retry-audit", executorId: ROGUE, targetId: "voice-retry", createdTimestamp: Date.now() }]])
  });
  await engine.handleChannelDelete({
    id: "voice-retry",
    guild,
    name: "Retry",
    type: ChannelType.GuildVoice,
    members: { size: 1 },
    permissionOverwrites: { cache: new Map() }
  }, true);
  assert.equal(attempts, 2);
  assert.deepEqual(guild.kicks, [ROGUE]);

  const locked = store.get(guild.id);
  locked.lockdownActive = 1;
  locked.lockState = { verification: 1, roles: {}, at: Date.now() };
  guild.verificationLevel = 2;
  store.save(guild.id, locked);
  const unlocked = await engine.unlock(guild, true);
  assert.equal(unlocked.ok, true);
  assert.equal(guild.verificationLevel, 1);
  assert.equal(store.get(guild.id).lockdownActive, 0);

  const shot = engine.capture(guild);
  assert.equal(JSON.stringify(shot).includes("token"), false);
  assert.equal(JSON.stringify(shot).includes("password"), false);
  guild.channels.cache.set("keep", { id: "keep", name: "keep", type: ChannelType.GuildText, parentId: null });
  store.addSnapshot(guild.id, {
    channels: [
      { name: "keep", type: ChannelType.GuildText, parentId: null },
      { name: "missing", type: ChannelType.GuildText, parentId: null }
    ],
    roles: []
  }, 5);
  const saved = store.snapshots(guild.id, 1)[0];
  const recovered = await engine.recover(guild, saved.id, true);
  assert.deepEqual(recovered.created, ["missing"]);
  assert.equal(guild.channels.cache.has("keep"), true);
  assert.equal(guild.created.filter((channel) => channel.name === "keep").length, 0);
});

test("server name and vanity are restored once, and antinukealloff stops every action", async () => {
  const guild = makeGuild();
  const owner = makeMember(guild, OWNER, "owner");
  makeMember(guild, ROGUE, "rogue");
  activate(guild);
  const names = [];
  const vanities = [];
  guild.setName = async (name) => {
    names.push(name);
    guild.name = name;
  };
  guild.client.rest = {
    patch: async (_route, options) => {
      vanities.push(options.body.code);
      guild.vanityURLCode = options.body.code;
    }
  };
  guild.fetchAuditLogs = async () => ({
    entries: new Map([["owner", { id: "owner-edit", executorId: OWNER, createdTimestamp: Date.now() }]])
  });
  guild.name = "New Name";
  guild.vanityURLCode = "newcode";
  await engine.handleGuildUpdate({ id: guild.id, name: "Old Name", vanityURLCode: "oldcode" }, guild, true);
  assert.deepEqual(names, []);
  assert.deepEqual(vanities, []);

  guild.fetchAuditLogs = async () => ({
    entries: new Map([["rogue", { id: "rogue-edit", executorId: ROGUE, createdTimestamp: Date.now() }]])
  });
  guild.name = "Hacked";
  guild.vanityURLCode = "hacked";
  await engine.handleGuildUpdate({ id: guild.id, name: "New Name", vanityURLCode: "newcode" }, guild, true);
  assert.deepEqual(names, ["New Name"]);
  assert.deepEqual(vanities, ["newcode"]);

  guild.name = "New Name";
  guild.vanityURLCode = "newcode";
  await engine.handleGuildUpdate({ id: guild.id, name: "Hacked", vanityURLCode: "hacked" }, guild, true);
  await engine.handleGuildUpdate({ id: guild.id, name: "Hacked", vanityURLCode: "hacked" }, guild, true);
  assert.deepEqual(names, ["New Name"]);
  assert.deepEqual(vanities, ["newcode"]);

  const off = await run(guild, owner, "-antinukealloff");
  assert.equal(titleOf(off), "Anti-Nuke Off");
  assert.equal(store.get(guild.id).policy.halted, true);
  assert.equal(store.get(guild.id).active, 0);
  guild.name = "Changed Again";
  await engine.handleGuildUpdate({ id: guild.id, name: "New Name", vanityURLCode: "newcode" }, guild, true);
  assert.deepEqual(names, ["New Name"]);
  const locked = await run(guild, owner, "-antinukelockdown");
  assert.equal(titleOf(locked), "Anti-Nuke Off");
});
