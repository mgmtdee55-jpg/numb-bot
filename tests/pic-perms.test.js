const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ChannelType, PermissionFlagsBits } = require("discord.js");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spanter-pic-"));
process.env.DB_PATH = path.join(scratch, "vc.sqlite");
process.env.PREFIX = "-";
process.env.BOT_OWNER = "111000000000000099";

const { handleCommand } = require("../commands");
const store = require("../systems/store");

const OWNER = "111000000000000001";
const BOSS = "111000000000000020";
const FOUNDER = "111000000000000021";
const CEO = "111000000000000022";
const ADMIN = "111000000000000023";
const MEMBER = "111000000000000024";
const ROLE = "222000000000000077";

function makeMember(guild, id, options = {}) {
  const member = {
    id,
    guild,
    displayName: options.name || id,
    user: { id, bot: false, username: options.name || id },
    roles: { cache: new Map([[guild.id, { id: guild.id }]]) },
    permissions: { has: (flag) => options.administrator === true && flag === PermissionFlagsBits.Administrator }
  };
  guild.members.cache.set(id, member);
  return member;
}

function makeChannel() {
  const channel = {
    id: "333000000000000010",
    type: ChannelType.GuildText,
    name: "media",
    permissionOverwrites: {
      edits: [],
      async edit(target, permissions) {
        this.edits.push({ id: target.id, permissions });
      }
    },
    async send(payload) {
      return payload;
    }
  };
  return channel;
}

function makeGuild() {
  const id = "sys-pic-guild";
  const roles = new Map();
  roles.set(ROLE, { id: ROLE, name: "pic perms", position: 2, managed: false });
  roles.set(id, { id, name: "@everyone", position: 0, managed: false });
  const guild = {
    id,
    name: "Spanter",
    ownerId: OWNER,
    client: { user: { id: "900000000000000099" } },
    members: {
      cache: new Map(),
      me: {
        id: "900000000000000099",
        permissions: {
          has: (flag) => flag === PermissionFlagsBits.ManageRoles || flag === PermissionFlagsBits.ManageChannels
        }
      }
    },
    roles: {
      cache: roles,
      everyone: roles.get(id),
      async fetch(roleId) {
        if (roleId) return roles.get(roleId) || null;
        return roles;
      }
    },
    channels: { cache: new Map() }
  };
  return guild;
}

function makeMessage(guild, content, member, channel) {
  const message = {
    guild,
    author: member.user,
    member,
    content,
    channel,
    mentions: { members: { first: () => null }, roles: { first: () => null }, channels: { first: () => null } },
    replies: [],
    async reply(payload) {
      this.replies.push(payload);
      return payload;
    }
  };
  return message;
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

async function run(guild, member, content, channel) {
  const message = makeMessage(guild, content, member, channel);
  await handleCommand(message, guild.client, "-");
  return message;
}

test("picture permissions are limited to ceos, founders, bosses, and admins", async () => {
  const guild = makeGuild();
  const channel = makeChannel();
  guild.channels.cache.set(channel.id, channel);
  const owner = makeMember(guild, OWNER, { name: "owner" });
  const boss = makeMember(guild, BOSS, { name: "boss" });
  const founder = makeMember(guild, FOUNDER, { name: "founder" });
  const ceo = makeMember(guild, CEO, { name: "ceo" });
  const admin = makeMember(guild, ADMIN, { name: "admin", administrator: true });
  const member = makeMember(guild, MEMBER, { name: "member" });
  store.setStaff(guild.id, boss.id, "boss", owner.id);
  store.setStaff(guild.id, founder.id, "founder", owner.id);
  store.setStaff(guild.id, ceo.id, "god", owner.id);

  const denied = await run(guild, member, `-setpicrole ${ROLE}`, channel);
  assert.equal(titleOf(denied), "Access Denied");
  const deniedToggle = await run(guild, member, "-pic off", channel);
  assert.equal(titleOf(deniedToggle), "Access Denied");
  assert.equal(channel.permissionOverwrites.edits.length, 0);

  const missing = await run(guild, boss, "-setpicrole", channel);
  assert.equal(titleOf(missing), "Missing Role");

  const setByBoss = await run(guild, boss, `-setpicrole ${ROLE}`, channel);
  assert.equal(titleOf(setByBoss), "Pic Role Set");
  assert.equal(store.getPicRole(guild.id), ROLE);

  const setByMention = await run(guild, founder, `-setpicrole <@&${ROLE}>`, channel);
  assert.equal(titleOf(setByMention), "Pic Role Set");
  assert.equal(store.getPicRole(guild.id), ROLE);

  const unset = await run(guild, ceo, "-pic on", channel);
  assert.equal(titleOf(unset), "Pic Perms Enabled");

  const off = await run(guild, admin, "-pic off", channel);
  assert.equal(titleOf(off), "Pic Perms Disabled");
  assert.equal(textOf(off), `<@&${ROLE}>\n• Embed Links: **disabled**\n• Attach Files: **disabled**`);
  assert.equal(off.replies.at(-1).embeds[0].data.color, 0x2b2d31);
  assert.deepEqual(off.replies.at(-1).allowedMentions, { parse: [], roles: [ROLE] });
  assert.deepEqual(channel.permissionOverwrites.edits.at(-1), {
    id: ROLE,
    permissions: { EmbedLinks: false, AttachFiles: false }
  });

  const on = await run(guild, owner, "-pic on", channel);
  assert.equal(titleOf(on), "Pic Perms Enabled");
  assert.equal(textOf(on), `<@&${ROLE}>\n• Embed Links: **enabled**\n• Attach Files: **enabled**`);
  assert.deepEqual(channel.permissionOverwrites.edits.at(-1), {
    id: ROLE,
    permissions: { EmbedLinks: true, AttachFiles: true }
  });
});

test("pic on and pic off ask for a role until one is set", async () => {
  const guild = makeGuild();
  guild.id = "sys-pic-guild-empty";
  const channel = makeChannel();
  const owner = makeMember(guild, OWNER, { name: "owner" });
  const waiting = await run(guild, owner, "-pic off", channel);
  assert.equal(titleOf(waiting), "Pic Role Not Set");
  assert.equal(channel.permissionOverwrites.edits.length, 0);
});
