const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ChannelType, PermissionFlagsBits } = require("discord.js");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spanter-punish-"));
process.env.DB_PATH = path.join(scratch, "vc.sqlite");
process.env.PREFIX = "-";
process.env.npm_lifecycle_event = "test";

const db = require("../db");
const punish = require("../punish");
const vcFeatures = require("../vc-features");
const voice = require("../voice");
const rankVoice = require("../systems/voice");
const store = require("../systems/store");
const { handleCommand } = require("../commands");

const GUILD_ID = "444000000000000099";
const OWNER = "111000000000000031";
const MEMBER = "111000000000000032";
const JAIL_ROLE = "222000000000000031";
const MEMBER_ROLE = "222000000000000032";
const IMAGE_ROLE = "222000000000000033";
const IMUTE_ROLE = "222000000000000034";
const JAIL_CHANNEL = "333000000000000031";

function role(id, name, flags = [], position = 1) {
  return {
    id,
    name,
    managed: false,
    position,
    permissions: { has: (flag) => flags.includes(flag) }
  };
}

function makeGuild() {
  const channels = new Map();
  const roles = new Map();
  const guild = {
    id: GUILD_ID,
    ownerId: OWNER,
    channels: {
      cache: channels,
      async fetch(id) { return channels.get(id) || null; },
      async create(data) {
        const channel = { id: `created-${channels.size}`, ...data, permissionOverwrites: { cache: new Map(), async edit() {} } };
        channels.set(channel.id, channel);
        return channel;
      }
    },
    roles: {
      cache: roles,
      async create(data) {
        const created = role(`role-${roles.size}`, data.name, [], 10);
        roles.set(created.id, created);
        return created;
      },
      async fetch(id) { return roles.get(id) || null; }
    },
    members: {
      cache: new Map(),
      me: {
        permissions: { has: () => true },
        roles: { highest: { position: 50 } }
      }
    },
    voiceStates: { cache: new Map() }
  };
  guild.roles.everyone = { id: guild.id, name: "@everyone", position: 0, managed: false, permissions: { has: () => false } };
  roles.set(guild.id, guild.roles.everyone);
  return guild;
}

function makeMember(guild, id, roleList = []) {
  const cache = new Map(roleList.map((item) => [item.id, item]));
  const member = {
    id,
    guild,
    user: { id, bot: false, username: "member" },
    displayName: "member",
    voice: { channelId: null, serverMute: false, async setMute(value) { this.serverMute = value; } },
    roles: {
      cache,
      async add(input) {
        const ids = Array.isArray(input) ? input : [input];
        for (const item of ids) {
          const roleId = typeof item === "string" ? item : item.id;
          cache.set(roleId, guild.roles.cache.get(roleId) || item);
        }
      },
      async remove(input) {
        const ids = Array.isArray(input) ? input : [input];
        for (const item of ids) cache.delete(typeof item === "string" ? item : item.id);
      }
    }
  };
  guild.members.cache.set(id, member);
  return member;
}

function messageFor(guild, member, content) {
  const replies = [];
  return {
    content,
    guild,
    author: member.user,
    member,
    mentions: {
      users: { first: () => null },
      members: { first: () => null },
      roles: { first: () => null },
      channels: { first: () => null }
    },
    replies,
    async reply(payload) {
      replies.push(payload);
      return payload;
    }
  };
}

test("jail removes roles, pings the jail channel, and unjail gives the roles back", async () => {
  const guild = makeGuild();
  const jailRole = role(JAIL_ROLE, "Jailed", [], 4);
  const memberRole = role(MEMBER_ROLE, "Member", [], 2);
  guild.roles.cache.set(jailRole.id, jailRole);
  guild.roles.cache.set(memberRole.id, memberRole);
  const sent = [];
  guild.channels.cache.set(JAIL_CHANNEL, {
    id: JAIL_CHANNEL,
    type: ChannelType.GuildText,
    async send(payload) { sent.push(payload); return payload; }
  });
  punish.saveConfig({
    ...punish.getConfig(guild.id),
    jail_role_id: jailRole.id,
    jail_channel_id: JAIL_CHANNEL
  });
  const owner = makeMember(guild, OWNER);
  const member = makeMember(guild, MEMBER, [memberRole]);
  const message = messageFor(guild, owner, `-jail ${MEMBER} spam`);
  await punish.handleCommand(message, "jail", ["-jail", MEMBER, "spam"]);
  assert.equal(member.roles.cache.has(MEMBER_ROLE), false);
  assert.equal(member.roles.cache.has(JAIL_ROLE), true);
  assert.equal(sent[0].content, `<@${MEMBER}>`);
  assert.match(sent[0].embeds[0].data.description, /spam/);
  assert.deepEqual(sent[0].allowedMentions.users, [MEMBER]);

  await punish.handleCommand(message, "unjail", ["-unjail", MEMBER]);
  assert.equal(member.roles.cache.has(MEMBER_ROLE), true);
  assert.equal(member.roles.cache.has(JAIL_ROLE), false);
});

test("image mute removes picture roles and puts them back when the mute comes off", async () => {
  const guild = makeGuild();
  const imute = role(IMUTE_ROLE, "Image muted", [], 8);
  const pictures = role(IMAGE_ROLE, "Pictures", [PermissionFlagsBits.AttachFiles], 2);
  guild.roles.cache.set(imute.id, imute);
  guild.roles.cache.set(pictures.id, pictures);
  punish.saveConfig({ ...punish.getConfig(guild.id), imute_role_id: imute.id });
  const owner = makeMember(guild, OWNER);
  const member = makeMember(guild, MEMBER, [pictures]);
  const message = messageFor(guild, owner, `-imute ${MEMBER}`);
  await punish.handleCommand(message, "imute", ["-imute", MEMBER]);
  assert.equal(member.roles.cache.has(IMAGE_ROLE), false);
  assert.equal(member.roles.cache.has(IMUTE_ROLE), true);

  const before = { id: member.id, guild, roles: { cache: new Map(member.roles.cache) } };
  member.roles.cache.set(pictures.id, pictures);
  await punish.syncMember(before, member);
  assert.equal(member.roles.cache.has(IMAGE_ROLE), false);

  await punish.handleCommand(message, "imute", ["-imute", MEMBER]);
  assert.equal(member.roles.cache.has(IMUTE_ROLE), false);
  assert.equal(member.roles.cache.has(IMAGE_ROLE), true);
});

test("mute asks before it server mutes, and unmuteall only clears muted people in that call", async () => {
  const guild = makeGuild();
  const owner = makeMember(guild, OWNER);
  store.setStaff(guild.id, OWNER, "god", OWNER);
  const target = makeMember(guild, MEMBER);
  const message = messageFor(guild, owner, `-mute ${MEMBER}`);
  await punish.handleCommand(message, "mute", ["-mute", MEMBER]);
  assert.match(message.replies[0].embeds[0].data.description, /server mute someone/);
  const labels = message.replies[0].components[0].components.map((button) => button.data.label);
  assert.deepEqual(labels, ["Server mute", "Chat mute"]);
  assert.equal(target.voice.serverMute, false);

  const channel = {
    id: "333000000000000088",
    type: ChannelType.GuildVoice,
    members: new Map()
  };
  guild.channels.cache.set(channel.id, channel);
  const mutedA = makeMember(guild, "111000000000000041");
  const mutedB = makeMember(guild, "111000000000000042");
  const quiet = makeMember(guild, "111000000000000043");
  mutedA.voice.serverMute = true;
  mutedB.voice.serverMute = true;
  mutedA.voice.channelId = channel.id;
  mutedB.voice.channelId = channel.id;
  quiet.voice.channelId = channel.id;
  for (const person of [mutedA, mutedB, quiet]) channel.members.set(person.id, person);
  const unmute = messageFor(guild, owner, `-unmuteall ${channel.id}`);
  await rankVoice.runRankCommand(unmute, "unmuteall", null, channel.id);
  assert.equal(mutedA.voice.serverMute, false);
  assert.equal(mutedB.voice.serverMute, false);
  assert.equal(quiet.voice.serverMute, false);
  assert.match(unmute.replies[0].embeds[0].data.description, /Unmuted \*\*2\*\*/);
});

test("random join skips locked, hidden, and full calls, and auto unmute clears a server mute", async () => {
  const guild = makeGuild();
  db.setConfig({
    guild_id: guild.id,
    j2c_channel_id: "333000000000000070",
    category_id: "333000000000000071",
    server_interface_channel_id: "disabled",
    server_interface_message_id: null,
    name_template: "{nickname}'s Channel",
    user_limit: 0,
    bitrate: 64000,
    cleanup_seconds: 0,
    server_interface_enabled: 0,
    category_ids: "[]"
  });
  function voiceChannel(id, extra = {}) {
    const channel = {
      id,
      type: ChannelType.GuildVoice,
      userLimit: extra.userLimit || 0,
      members: extra.members || new Map(),
      permissionOverwrites: { cache: extra.overwrites || new Map() },
      deleted: false,
      async delete() { this.deleted = true; }
    };
    guild.channels.cache.set(id, channel);
    db.addTemp({
      channel_id: id,
      guild_id: guild.id,
      owner_id: null,
      interface_message_id: null,
      created_at: Date.now()
    });
    return channel;
  }
  const everyoneDeny = (flag) => ({ deny: { has: (bit) => bit === flag } });
  voiceChannel("333000000000000081", { overwrites: new Map([[guild.id, everyoneDeny(PermissionFlagsBits.Connect)]]) });
  voiceChannel("333000000000000082", { overwrites: new Map([[guild.id, everyoneDeny(PermissionFlagsBits.ViewChannel)]]) });
  voiceChannel("333000000000000083", { userLimit: 1, members: new Map([["full", {}]]) });
  const open = voiceChannel("333000000000000084");
  const picked = vcFeatures.chooseOpenChannel(guild, MEMBER);
  assert.equal(picked.id, open.id);

  const auto = voiceChannel("333000000000000085");
  db.connection.prepare(`
    INSERT INTO vc_features(guild_id, auto_unmute_channel_id, random_join_channel_id)
    VALUES(?,?,?)
  `).run(guild.id, auto.id, "333000000000000086");
  const member = makeMember(guild, MEMBER);
  member.voice.serverMute = true;
  member.voice.serverDeaf = true;
  member.voice.setDeaf = async function setDeaf(value) { this.serverDeaf = value; };
  const calls = [];
  member.voice.setMute = async (value) => { calls.push(["mute", value]); member.voice.serverMute = value; };
  member.voice.setDeaf = async (value) => { calls.push(["deaf", value]); member.voice.serverDeaf = value; };
  await vcFeatures.observe(
    { id: MEMBER, channelId: null, guild, member },
    { id: MEMBER, channelId: auto.id, guild, member }
  );
  assert.deepEqual(calls, [["mute", false], ["deaf", false]]);
  vcFeatures.cancelTimer(guild.id, MEMBER);

  db.setEmptySince(auto.id, Date.now() - 120000);
  await voice.cleanupEmptyTempChannels(guild);
  assert.equal(auto.deleted, false);
});
