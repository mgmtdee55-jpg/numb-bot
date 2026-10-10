const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AuditLogEvent, ButtonStyle, PermissionFlagsBits } = require("discord.js");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spanter-auditlog-"));
process.env.DB_PATH = path.join(scratch, "vc.sqlite");
process.env.PREFIX = "-";
process.env.npm_lifecycle_event = "test";

const db = require("../db");
const { handleCommand } = require("../commands");
const extras = require("../extras");

const OWNER = "111000000000000031";
const MEMBER = "111000000000000035";
const USER = "111000000000000032";
const MOD = "111000000000000033";
const OTHER = "111000000000000034";
const ROLE = "222000000000000031";

let guildSerial = 40;

function nextGuild() {
  guildSerial += 1;
  return `4440000000000000${guildSerial}`;
}

function owner(guild) {
  return {
    id: OWNER,
    guild,
    user: { id: OWNER, bot: false, username: "owner" },
    roles: { cache: new Map() },
    permissions: { has: () => false }
  };
}

function makeGuild(entries, options = {}) {
  const calls = [];
  const guild = {
    id: options.id || nextGuild(),
    ownerId: OWNER,
    calls,
    members: {
      me: options.me,
      cache: new Map(),
      async fetch() { return null; }
    },
    async fetchAuditLogs(query) {
      calls.push(query);
      if (options.fail) throw new Error("missing access");
      if (query.before) return { entries: new Map() };
      const list = entries.filter((entry) => (
        entry.action === query.type && (!query.user || String(entry.executorId) === String(query.user))
      ));
      return { entries: new Map(list.map((entry) => [entry.id, entry])) };
    }
  };
  return guild;
}

function message(guild, content, member = owner(guild)) {
  const replies = [];
  return {
    content,
    guild,
    author: { id: member.id, bot: false, username: member.user?.username || "user" },
    member,
    client: { users: { async fetch() { return null; } } },
    mentions: {
      users: { first: () => null },
      members: { first: () => null }
    },
    replies,
    async reply(payload) {
      replies.push(payload);
      return payload;
    }
  };
}

function entry(id, action, fields) {
  return { id, action, createdTimestamp: Date.now(), changes: [], ...fields };
}

function sampleEntries(now) {
  return [
    entry("mute-deaf", AuditLogEvent.MemberUpdate, {
      executorId: MOD,
      targetId: USER,
      createdTimestamp: now,
      reason: "loud",
      changes: [
        { key: "mute", old: false, new: true },
        { key: "deaf", old: false, new: true }
      ]
    }),
    entry("unmute", AuditLogEvent.MemberUpdate, {
      executorId: USER,
      targetId: OTHER,
      createdTimestamp: now - 10000,
      changes: [{ key: "mute", old: true, new: false }]
    }),
    entry("nick", AuditLogEvent.MemberUpdate, {
      executorId: MOD,
      targetId: USER,
      createdTimestamp: now - 15000,
      changes: [{ key: "nick", old: "a", new: "b" }]
    }),
    entry("disconnect-target", AuditLogEvent.MemberDisconnect, {
      executorId: MOD,
      targetId: USER,
      createdTimestamp: now - 5000
    }),
    entry("disconnect-count", AuditLogEvent.MemberDisconnect, {
      executorId: USER,
      targetId: null,
      createdTimestamp: now - 20000,
      extra: { count: "3" }
    }),
    entry("timeout", AuditLogEvent.MemberUpdate, {
      executorId: USER,
      targetId: OTHER,
      createdTimestamp: now - 3000,
      reason: "spam",
      changes: [{ key: "communication_disabled_until", new: new Date(now + 3600000).toISOString() }]
    }),
    entry("timeout-clear", AuditLogEvent.MemberUpdate, {
      executorId: MOD,
      targetId: USER,
      createdTimestamp: now - 4000,
      changes: [{ key: "communication_disabled_until", old: new Date(now).toISOString(), new: null }]
    }),
    entry("automod", AuditLogEvent.AutoModerationUserCommunicationDisabled, {
      executorId: null,
      targetId: USER,
      createdTimestamp: now - 6000,
      extra: { autoModerationRuleName: "links" }
    }),
    entry("ban", AuditLogEvent.MemberBanAdd, {
      executorId: USER,
      targetId: OTHER,
      createdTimestamp: now - 7000,
      reason: "raid"
    }),
    entry("unban", AuditLogEvent.MemberBanRemove, {
      executorId: MOD,
      targetId: USER,
      createdTimestamp: now - 8000
    })
  ];
}

function text(payload) {
  return payload.embeds[0].data.description;
}

function button(payload, label) {
  return payload.components[0].components.find((item) => item.data.label === label);
}

async function press(source, label, userId = OWNER) {
  const interaction = {
    customId: button(source.replies ? source.replies[0] : source, label).data.custom_id,
    user: { id: userId },
    member: source.member,
    guild: source.guild,
    async deferUpdate() { this.deferred = true; },
    async editReply(payload) { this.updated = payload; },
    async update(payload) { this.updated = payload; },
    async reply(payload) { this.repliedPayload = payload; }
  };
  assert.equal(await extras.handleInteraction(interaction), true);
  return interaction;
}

test("auditlog groups voice actions and keeps timeouts and bans on their own buttons", async () => {
  const now = Date.now();
  const guild = makeGuild(sampleEntries(now));
  const shown = message(guild, `-auditlog ${USER}`);
  await handleCommand(shown, null, "-");
  const description = text(shown.replies[0]);
  assert.equal(shown.replies[0].embeds[0].data.title, "Audit Log");
  assert.match(description, new RegExp(`<@${USER}>`));
  assert.match(description, /\*\*Voice\*\* · 5/);
  assert.match(description, /\*\*Done to them\*\* · 3/);
  assert.match(description, new RegExp(`Server muted · <@${MOD}> · loud`));
  assert.match(description, new RegExp(`Server deafened · <@${MOD}> · loud`));
  assert.match(description, new RegExp(`Disconnected · <@${MOD}>`));
  assert.match(description, /\*\*They did\*\* · 2/);
  assert.match(description, new RegExp(`Server unmuted · <@${OTHER}>`));
  assert.match(description, /Disconnected · 3 members/);
  assert.doesNotMatch(description, /Timed out|Banned|nick/);
  assert.match(shown.replies[0].embeds[0].data.footer.text, /Newest first/);
  assert.match(shown.replies[0].embeds[0].data.footer.text, /did not name some disconnected members/);
  const labels = shown.replies[0].components[0].components.map((item) => item.data.label);
  assert.deepEqual(labels, ["Voice", "Timeouts", "Bans"]);
  assert.equal(button(shown.replies[0], "Voice").data.style, ButtonStyle.Primary);
  assert.equal(button(shown.replies[0], "Timeouts").data.style, ButtonStyle.Secondary);
  assert.equal(shown.replies[0].allowedMentions.parse.length, 0);

  const timeouts = await press(shown, "Timeouts");
  const timeoutText = text(timeouts.updated);
  assert.match(timeoutText, /\*\*Timeouts\*\*/);
  assert.match(timeoutText, /\*\*They did\*\* · 1/);
  assert.match(timeoutText, new RegExp(`Timed out · <@${OTHER}> · until <t:\\d+:R> · spam`));
  assert.match(timeoutText, /\*\*Done to them\*\* · 2/);
  assert.match(timeoutText, new RegExp(`Timeout cleared · <@${MOD}>`));
  assert.match(timeoutText, /Timed out · unknown · links/);
  assert.doesNotMatch(timeoutText, /Server muted|Banned/);
  assert.equal(button(timeouts.updated, "Timeouts").data.style, ButtonStyle.Primary);
  assert.equal(button(timeouts.updated, "Voice").data.style, ButtonStyle.Secondary);

  const bans = await press(shown, "Bans");
  const banText = text(bans.updated);
  assert.match(banText, /\*\*Bans\*\* · 2/);
  assert.match(banText, new RegExp(`Banned · <@${OTHER}> · raid`));
  assert.match(banText, new RegExp(`Unbanned · <@${MOD}>`));
  assert.doesNotMatch(banText, /Server muted|Timed out/);
  assert.equal(button(bans.updated, "Bans").data.style, ButtonStyle.Primary);

  const voice = await press({ ...shown, replies: [{ ...bans.updated }] }, "Voice");
  assert.match(text(voice.updated), /\*\*Voice\*\*/);
});

test("auditlog pages each side without dropping the other direction", async () => {
  const now = Date.now();
  const entries = Array.from({ length: 7 }, (_, index) => entry(`m${index}`, AuditLogEvent.MemberUpdate, {
    executorId: MOD,
    targetId: USER,
    createdTimestamp: now - (index * 1000),
    changes: [{ key: "mute", new: true }]
  }));
  const guild = makeGuild(entries);
  const shown = message(guild, `-auditlog ${USER}`);
  await handleCommand(shown, null, "-");
  const description = text(shown.replies[0]);
  assert.match(description, /\*\*Done to them\*\* · 6 of 7/);
  assert.match(description, /\*\*They did\*\* · none/);
  assert.match(shown.replies[0].embeds[0].data.footer.text, /Page 1\/2/);
  assert.equal(button(shown.replies[0], "Back").data.disabled, true);
  assert.equal(button(shown.replies[0], "Next").data.disabled, false);

  const next = await press(shown, "Next");
  assert.match(text(next.updated), /\*\*Done to them\*\* · 1 of 7/);
  assert.match(next.updated.embeds[0].data.footer.text, /Page 2\/2/);
  assert.equal(button(next.updated, "Next").data.disabled, true);
  assert.equal(button(next.updated, "Voice").data.style, ButtonStyle.Primary);
});

test("auditlog is limited to gods and view audit log, and the bot must be able to read it", async () => {
  const guild = makeGuild([]);
  const member = {
    id: MEMBER,
    guild,
    user: { id: MEMBER, bot: false, username: "member" },
    roles: { cache: new Map([[ROLE, { id: ROLE }]]) },
    permissions: { has: () => false }
  };
  const denied = message(guild, `-auditlog ${USER}`, member);
  await handleCommand(denied, null, "-");
  assert.match(denied.replies[0].embeds[0].data.description, /Access Denied/);
  assert.equal(guild.calls.length, 0);

  db.addFakePermission(guild.id, ROLE, "view_audit_log");
  const allowed = message(guild, `-auditlog ${USER}`, member);
  await handleCommand(allowed, null, "-");
  assert.equal(allowed.replies[0].embeds[0].data.title, "Audit Log");
  assert.match(text(allowed.replies[0]), /No recent server mutes, deafens, or disconnects/);

  const blocked = makeGuild([], {
    me: { permissions: { has: (bit) => bit !== PermissionFlagsBits.ViewAuditLog } }
  });
  const missing = message(blocked, `-auditlog ${USER}`);
  await handleCommand(missing, null, "-");
  assert.match(missing.replies[0].embeds[0].data.description, /View Audit Log/);
  assert.equal(blocked.calls.length, 0);

  const broken = makeGuild([], { fail: true });
  const failed = message(broken, `-auditlog ${USER}`);
  await handleCommand(failed, null, "-");
  assert.match(failed.replies[0].embeds[0].data.description, /couldn't read the audit log/i);

  const usage = message(makeGuild([]), "-auditlog");
  await handleCommand(usage, null, "-");
  assert.match(usage.replies[0].embeds[0].data.description, /Missing User/);

  const stranger = await press(allowed, "Timeouts", OWNER);
  assert.match(stranger.repliedPayload.embeds[0].data.description, /Not Yours/);
  assert.equal(stranger.updated, undefined);
});
