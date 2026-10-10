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

const { ChannelType, PermissionFlagsBits } = require("discord.js");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spanter-systems-"));
process.env.DB_PATH = path.join(scratch, "vc.sqlite");
process.env.PREFIX = "-";
process.env.BOT_OWNER = "111000000000000099";

const db = require("../db");
const { handleCommand } = require("../commands");
const store = require("../systems/store");
const vouchStore = require("../vouch/store");

const BOT = "900000000000000099";
const OWNER = "111000000000000001";
const BOT_OWNER = "111000000000000099";
const ADMIN = "111000000000000010";
const MANAGER = "111000000000000011";
const MEMBER = "111000000000000012";
const TARGET = "111000000000000013";
const ROLE = "222000000000000010";

let guildSerial = 0;

function nextGuild() {
  guildSerial += 1;
  return `sys-guild-${guildSerial}`;
}

function makeMember(guild, id, options = {}) {
  const voice = {
    id,
    channelId: options.channelId || null,
    channel: options.channel || null,
    serverMute: false,
    serverDeaf: false,
    async setChannel(channel) {
      this.channel = channel;
      this.channelId = channel?.id || channel;
      return this;
    },
    async setMute(muted) {
      this.serverMute = muted;
    },
    async setDeaf(deaf) {
      this.serverDeaf = deaf;
    },
    async disconnect() {
      this.channelId = null;
      this.channel = null;
    }
  };
  const member = {
    id,
    guild,
    displayName: options.name || id,
    user: { id, bot: false, username: options.name || id, displayAvatarURL: () => "https://cdn.example/a.png" },
    voice,
    roles: { cache: new Map([[guild.id, { id: guild.id }]]) },
    permissions: { has: () => false }
  };
  voice.member = member;
  guild.members.cache.set(id, member);
  guild.voiceStates.cache.set(id, voice);
  return member;
}

function makeGuild() {
  const id = nextGuild();
  const members = new Map();
  const channels = new Map();
  const roles = new Map();
  roles.set(ROLE, { id: ROLE, name: "VIP", position: 2, managed: false });
  roles.set(id, { id, name: "@everyone", position: 0, managed: false });
  const guild = {
    id,
    name: "Spanter",
    ownerId: OWNER,
    memberCount: 4,
    client: { user: { id: BOT } },
    members: {
      cache: members,
      me: {
        id: BOT,
        permissions: { has: (flag) => flag === PermissionFlagsBits.ManageChannels || flag === PermissionFlagsBits.ManageRoles },
        roles: { highest: { position: 50 } }
      },
      async fetch(userId) { return members.get(userId) || null; }
    },
    roles: {
      cache: roles,
      everyone: roles.get(id),
      async fetch(roleId) { return roles.get(roleId) || null; }
    },
    channels: {
      cache: channels,
      async fetch(channelId) { return channels.get(channelId) || null; }
    },
    voiceStates: { cache: new Map() }
  };
  return guild;
}

function makeMessage(guild, content, member) {
  const message = {
    guild,
    author: member.user,
    member,
    content,
    mentions: { members: { first: () => null }, roles: { first: () => null }, channels: { first: () => null } },
    channel: { id: "333000000000000001", type: ChannelType.GuildText, send: async (payload) => payload },
    replies: [],
    async reply(payload) {
      this.replies.push(payload);
      return payload;
    }
  };
  const id = content.match(/\d{17,20}/);
  if (id && guild.members.cache.has(id[0]) && content.includes(`<@${id[0]}>`) || content.includes(id?.[0] || "___")) {
    const mentioned = guild.members.cache.get(id[0]);
    if (mentioned && content.includes(mentioned.id)) {
      message.mentions.members.first = () => mentioned;
    }
  }
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

async function run(guild, member, content) {
  const message = makeMessage(guild, content, member);
  await handleCommand(message, guild.client, "-");
  return message;
}

test("vc ranks, godmode, and management follow the access rules", async () => {
  const guild = makeGuild();
  const owner = makeMember(guild, OWNER, { name: "owner" });
  const manager = makeMember(guild, MANAGER, { name: "manager" });
  const member = makeMember(guild, MEMBER, { name: "member" });
  const target = makeMember(guild, TARGET, { name: "target" });
  makeMember(guild, BOT_OWNER, { name: "botowner" });

  const plus = { id: "222000000000000099", name: "Plus", position: 4, managed: false };
  guild.roles.cache.set(plus.id, plus);
  const denied = await run(guild, member, `-vc rank assign ${target.id} plus`);
  assert.equal(titleOf(denied), "Access Denied");

  const bound = await run(guild, owner, `-voice plus ${plus.id}`);
  assert.equal(titleOf(bound), "Voice Rank Role Set");
  const ranked = await run(guild, owner, `-vc rank assign ${target.id} plus`);
  assert.equal(titleOf(ranked), "Rank Assigned");
  assert.match(textOf(ranked), /Voice Plus/);
  assert.equal(store.getRank(guild.id, target.id).rank_key, "plus");
  assert.equal(store.getRank(guild.id, target.id).set_by, owner.id);

  const listed = await run(guild, member, "-vc rank");
  assert.match(textOf(listed), /Voice Plus/);
  assert.match(textOf(listed), new RegExp(target.id));

  const info = await run(guild, member, `-vc rankinfo ${target.id}`);
  assert.match(textOf(info), /Voice Plus/);
  assert.match(textOf(info), new RegExp(owner.id));

  const admin = makeMember(guild, ADMIN, { name: "admin" });
  await run(guild, owner, `-antinuke admin add ${ADMIN}`);
  const unranked = await run(guild, admin, `-vc unrank ${target.id}`);
  assert.equal(titleOf(unranked), "Access Denied");
  assert.equal(titleOf(await run(guild, owner, `-vc unrank ${target.id}`)), "Rank Removed");

  const managerDenied = await run(guild, manager, `-m add ${member.id}`);
  assert.match(textOf(managerDenied), /cannot grant or remove Management/);

  const added = await run(guild, owner, `-m add ${manager.id}`);
  assert.equal(titleOf(added), "Management Granted");
  const managerGod = await run(guild, manager, `-god add ${member.id}`);
  assert.equal(titleOf(managerGod), "Access Denied");
  const god = await run(guild, owner, `-god add ${member.id}`);
  assert.equal(titleOf(god), "Godmode Granted");
  assert.equal(store.isGodmode(guild.id, member.id), true);
  const taken = await run(guild, owner, `-god take ${member.id}`);
  assert.equal(titleOf(taken), "Godmode Removed");

  const restartDenied = await run(guild, manager, "-restart");
  assert.equal(titleOf(restartDenied), "Access Denied");
  const restart = await run(guild, owner, "-restart");
  assert.equal(titleOf(restart), "Restarting");
});

test("franchise can force ownership and a lower rank cannot", async () => {
  const guild = makeGuild();
  const owner = makeMember(guild, OWNER);
  const member = makeMember(guild, MEMBER);
  const channel = {
    id: "444000000000000001",
    type: ChannelType.GuildVoice,
    permissionOverwrites: { edit: async () => true },
    members: new Map()
  };
  guild.channels.cache.set(channel.id, channel);
  member.voice.channel = channel;
  member.voice.channelId = channel.id;
  db.addTemp({
    channel_id: channel.id,
    guild_id: guild.id,
    owner_id: OWNER,
    interface_message_id: null,
    created_at: Date.now()
  });

  const blocked = await run(guild, member, "-forceownership");
  assert.equal(titleOf(blocked), "Rank Required");

  store.setStaff(guild.id, member.id, "founder", owner.id);
  const forced = await run(guild, member, "-forceownership");
  assert.equal(titleOf(forced), "Ownership Forced");
  assert.equal(db.getTempChannel(channel.id).owner_id, member.id);

  store.clearStaff(guild.id, member.id);
  const premium = { id: "222000000000000077", name: "Premium Plus", position: 6, managed: false };
  guild.roles.cache.set(premium.id, premium);
  store.setVoiceRole(guild.id, "premiumplus", premium.id);
  member.roles.cache.set(premium.id, premium);
  store.setRank(guild.id, member.id, "premiumplus", owner.id);
  const override = await run(guild, member, "-voiceoverride");
  assert.equal(titleOf(override), "Voice Override");
  const drag = await run(guild, member, "-dragall");
  assert.equal(titleOf(drag), "Rank Required");

  db.forceOwner(channel.id, owner.id);
  owner.voice.channel = channel;
  owner.voice.channelId = channel.id;
  const claimed = await run(guild, member, "-forceclaim");
  assert.equal(titleOf(claimed), "Channel Force Claimed");
  assert.equal(db.getTempChannel(channel.id).owner_id, member.id);
  assert.equal(owner.voice.channelId, channel.id);
});

test("dragall moves only the named channel and muteall stays in the current call", async () => {
  const guild = makeGuild();
  const founder = makeMember(guild, "111000000000000020", { name: "founder" });
  store.setStaff(guild.id, founder.id, "founder", OWNER);
  const destination = { id: "444000000000000101", type: ChannelType.GuildVoice, guild, members: new Map() };
  const source = { id: "444000000000000102", type: ChannelType.GuildVoice, guild, members: new Map() };
  const other = { id: "444000000000000103", type: ChannelType.GuildVoice, guild, members: new Map() };
  for (const channel of [destination, source, other]) guild.channels.cache.set(channel.id, channel);

  function place(member, channel) {
    member.voice.channel = channel;
    member.voice.channelId = channel.id;
    channel.members.set(member.id, member);
  }
  place(founder, destination);
  const pulledA = makeMember(guild, "111000000000000021");
  const pulledB = makeMember(guild, "111000000000000022");
  const bystander = makeMember(guild, "111000000000000023");
  const shielded = makeMember(guild, "111000000000000024");
  place(pulledA, source);
  place(pulledB, source);
  place(shielded, source);
  place(bystander, other);
  store.saveGuard(guild.id, shielded.id, { shield: true });

  const missing = await run(guild, founder, "-dragall");
  assert.equal(titleOf(missing), "Usage");
  const unnamed = await run(guild, founder, "-dragall lobby");
  assert.equal(titleOf(unnamed), "Missing Channel");
  assert.equal(pulledA.voice.channelId, source.id);
  assert.equal(bystander.voice.channelId, other.id);

  const drag = await run(guild, founder, `-dragall ${source.id}`);
  assert.equal(titleOf(drag), "Drag All");
  assert.match(textOf(drag), new RegExp(source.id));
  assert.equal(pulledA.voice.channelId, destination.id);
  assert.equal(pulledB.voice.channelId, destination.id);
  assert.equal(bystander.voice.channelId, other.id);
  assert.equal(shielded.voice.channelId, source.id);

  const god = makeMember(guild, "111000000000000025", { name: "god" });
  store.setStaff(guild.id, god.id, "god", OWNER);
  place(god, destination);
  const muted = [];
  for (const member of [founder, god, pulledA, pulledB, bystander, shielded]) {
    member.voice.setMute = async (value) => {
      muted.push([member.id, value]);
    };
  }
  const founderMute = await run(guild, founder, "-muteall");
  assert.equal(titleOf(founderMute), "Rank Required");
  const mute = await run(guild, god, "-muteall");
  assert.equal(titleOf(mute), "Channel Muted");
  assert.deepEqual(muted.map((entry) => entry[0]).sort(), [founder.id, pulledA.id, pulledB.id].sort());
});

test("role limits and vouch caps use the new command names", async () => {
  const guild = makeGuild();
  const owner = makeMember(guild, OWNER);
  guild.roles.cache.get(ROLE).id = ROLE;

  const set = await run(guild, owner, `-role limit set ${ROLE} 3`);
  assert.equal(titleOf(set), "Role Limit Set");
  assert.equal(vouchStore.getLimitedRole(guild.id, ROLE).max_members, 3);

  const view = await run(guild, owner, "-role limit view");
  assert.match(textOf(view), /3/);

  const removed = await run(guild, owner, `-role limit remove ${ROLE}`);
  assert.equal(titleOf(removed), "Role Limit Removed");

  const global = await run(guild, owner, "-antinuke vouch limit global 4");
  assert.equal(titleOf(global), "Vouch Limit Updated");
  const giver = await run(guild, owner, "-antinuke vouch limit giver 6");
  assert.equal(vouchStore.getCaps(guild.id).giverMax, 6);
  makeMember(guild, MEMBER);
  const override = await run(guild, owner, `-antinuke vouch limit user ${MEMBER} 1`);
  assert.equal(vouchStore.allowance(guild.id, MEMBER).max, 1);
  assert.equal(vouchStore.allowance(guild.id, OWNER).max, 4);

  const shown = await run(guild, owner, "-antinuke vouch limit view");
  assert.match(textOf(shown), /Global cap:\*\* 4/);
});

test("antinuke vouch commands use the existing vouch behavior", async () => {
  const guild = makeGuild();
  const owner = makeMember(guild, OWNER, { name: "owner" });
  const member = makeMember(guild, MEMBER, { name: "member" });
  const reward = { id: ROLE, name: "Vouched", position: 2, managed: false };
  const founder = { id: "222000000000000011", name: "Founder", position: 3, managed: false };
  guild.roles.cache.set(reward.id, reward);
  guild.roles.cache.set(founder.id, founder);

  const panel = await run(guild, member, "-vouch");
  assert.equal(embedTitle(panel.replies[0].embeds[0]), "Vouch");
  assert.equal(panel.replies[0].components[0].toJSON().components[0].custom_id, "spanter:vouch");

  const set = await run(guild, owner, `-antinuke vouch set ${reward.id}`);
  assert.equal(titleOf(set), "Reward Role Set");
  assert.equal(vouchStore.getConfig(guild.id).vouch_role_id, reward.id);

  const founded = await run(guild, owner, `-antinuke vouch founder ${founder.id}`);
  assert.equal(titleOf(founded), "Founder Role Set");
  assert.equal(vouchStore.isOsRole(guild.id, founder.id), true);

  const giver = await run(guild, owner, `-antinuke vouch addgiver ${member.id}`);
  assert.equal(titleOf(giver), "Giver Added");
  vouchStore.reserveVouch({ guildId: guild.id, giverId: member.id, targetId: TARGET, reason: "gone" });
  const listed = await run(guild, member, "-antinuke vouch list");
  assert.equal(titleOf(listed), "Active Vouches");
  assert.match(textOf(listed), new RegExp(TARGET));

  const cleaned = await run(guild, owner, "-antinuke vouch cleanup");
  assert.equal(titleOf(cleaned), "Registry Cleaned");
  assert.match(textOf(cleaned), /Closed \*\*1\*\*/);
  assert.equal(vouchStore.getActiveVouch(guild.id, TARGET), null);

  const removed = await run(guild, owner, `-antinuke vouch removegiver ${member.id}`);
  assert.equal(titleOf(removed), "Giver Removed");

  const cleared = await run(guild, owner, "-antinuke vouch unset");
  assert.equal(titleOf(cleared), "Roles Disconnected");
  assert.equal(vouchStore.getConfig(guild.id).vouch_role_id, null);
  assert.equal(vouchStore.getConfig(guild.id).founder_role_id, null);
});

test("staff tiers gate commands and only the server owner can grant God", async () => {
  const guild = makeGuild();
  const owner = makeMember(guild, OWNER, { name: "owner" });
  const god = makeMember(guild, "111000000000000021", { name: "god" });
  const founder = makeMember(guild, "111000000000000022", { name: "founder" });
  const boss = makeMember(guild, "111000000000000023", { name: "boss" });
  const member = makeMember(guild, MEMBER, { name: "member" });

  assert.equal(titleOf(await run(guild, god, `-ceo add ${member.id}`)), "Access Denied");
  assert.equal(titleOf(await run(guild, owner, `-ceo add ${god.id}`)), "God Added");
  assert.equal(titleOf(await run(guild, god, `-ceo add ${member.id}`)), "Access Denied");
  assert.equal(titleOf(await run(guild, founder, `-boss add ${member.id}`)), "Access Denied");
  assert.equal(titleOf(await run(guild, god, `-founder add ${founder.id}`)), "Founder Added");
  assert.equal(titleOf(await run(guild, god, `-boss add ${boss.id}`)), "Boss Added");

  const registry = await run(guild, member, "-antinuke admins");
  assert.equal(titleOf(registry), "Staff Registry");
  assert.match(textOf(registry), /God • Root Owner/);
  assert.match(textOf(registry), /Founder • Super Admin/);
  assert.match(textOf(registry), /Boss • Admin/);
  assert.match(textOf(registry), new RegExp(god.id));
  assert.match(textOf(registry), new RegExp(founder.id));
  assert.match(textOf(registry), new RegExp(boss.id));

  assert.equal(titleOf(await run(guild, member, "-logging set message")), "Access Denied");
  assert.equal(titleOf(await run(guild, boss, "-logging set message")), "Access Denied");
  assert.equal(titleOf(await run(guild, god, "-logging set message")), "Logs Updated");
  assert.equal(titleOf(await run(guild, founder, `-vc rank assign ${member.id} plus`)), "Access Denied");
  assert.equal(titleOf(await run(guild, founder, `-boss add ${member.id}`)), "Boss Added");

  assert.equal(titleOf(await run(guild, owner, `-ceo remove ${god.id}`)), "God Removed");
  assert.equal(titleOf(await run(guild, god, `-founder remove ${founder.id}`)), "Access Denied");
  assert.equal(store.getStaff(guild.id, god.id), null);
  assert.equal(store.getStaff(guild.id, founder.id).tier, "founder");
});

test("channel controls lock, hide, lock every text channel, and nuke", async () => {
  const guild = makeGuild();
  const owner = makeMember(guild, OWNER, { name: "owner" });
  const member = makeMember(guild, MEMBER, { name: "member" });
  const edits = [];
  function track(id, name, type) {
    const channel = {
      id,
      name,
      type,
      position: 1,
      permissionOverwrites: {
        async edit(target, data) {
          edits.push({ id, target, data });
        }
      }
    };
    guild.channels.cache.set(id, channel);
    return channel;
  }
  const general = track("555000000000000010", "general", ChannelType.GuildText);
  const news = track("555000000000000011", "news", ChannelType.GuildAnnouncement);
  track("555000000000000012", "lounge", ChannelType.GuildVoice);
  general.clone = async () => {
    const copy = {
      id: "555000000000000099",
      sent: [],
      async send(payload) {
        this.sent.push(payload);
        return payload;
      },
      async setPosition() { return this; }
    };
    general.copy = copy;
    return copy;
  };
  general.delete = async () => {
    general.deleted = true;
  };

  assert.equal(titleOf(await run(guild, member, "-lock")), "Access Denied");
  assert.equal(titleOf(await run(guild, owner, `-lock ${general.id}`)), "Channel Locked");
  assert.deepEqual(edits.at(-1).data, { SendMessages: false });
  assert.equal(titleOf(await run(guild, owner, "-unlock #general")), "Channel Unlocked");
  assert.deepEqual(edits.at(-1).data, { SendMessages: null });
  assert.equal(titleOf(await run(guild, owner, `-hide ${news.id}`)), "Channel Hidden");
  assert.deepEqual(edits.at(-1).data, { ViewChannel: false });
  assert.equal(titleOf(await run(guild, owner, "-unhide news")), "Channel Visible");
  assert.deepEqual(edits.at(-1).data, { ViewChannel: null });

  const voice = guild.channels.cache.get("555000000000000012");
  assert.equal(titleOf(await run(guild, owner, `-lock ${voice.id}`)), "Channel Locked");
  assert.deepEqual(edits.at(-1).data, { Connect: false });

  edits.length = 0;
  assert.equal(titleOf(await run(guild, owner, "-lockall")), "Text Channels Locked");
  assert.equal(edits.length, 2);
  assert.ok(edits.every((edit) => edit.data.SendMessages === false));
  assert.equal(titleOf(await run(guild, owner, "-unlockall")), "Text Channels Unlocked");

  const declined = makeMessage(guild, "-nuke", owner);
  declined.channel = general;
  await handleCommand(declined, guild.client, "-");
  assert.equal(general.deleted, undefined);
  assert.match(declined.replies[0].embeds[0].data.description, /are you sure you want to nuke this channel/);
  const declineId = declined.replies[0].components[0].components.find((button) => button.data.label === "Decline").data.custom_id;
  const decline = {
    customId: declineId,
    user: { id: owner.id },
    member: owner,
    guild,
    channel: general,
    channelId: general.id,
    async update(payload) { this.updated = payload; },
    async reply(payload) { this.repliedWith = payload; }
  };
  assert.equal(await require("../systems/channels").handleInteraction(decline), true);
  assert.match(decline.updated.embeds[0].data.description, /not nuked/);
  assert.equal(general.deleted, undefined);

  const message = makeMessage(guild, "-nuke", owner);
  message.channel = general;
  await handleCommand(message, guild.client, "-");
  const confirmId = message.replies[0].components[0].components.find((button) => button.data.label === "Confirm").data.custom_id;
  const confirm = {
    customId: confirmId,
    user: { id: owner.id },
    member: owner,
    guild,
    channel: general,
    channelId: general.id,
    async update(payload) { this.updated = payload; },
    async reply(payload) { this.repliedWith = payload; }
  };
  assert.equal(await require("../systems/channels").handleInteraction(confirm), true);
  assert.equal(general.deleted, true);
  assert.equal(embedTitle(general.copy.sent[0].embeds[0]), "Channel Nuked");
  assert.match(general.copy.sent[0].embeds[0].data.description, /#general/);
});

test("vc reset asks before it answers", async () => {
  const guild = makeGuild();
  const owner = makeMember(guild, OWNER, { name: "owner" });
  const member = makeMember(guild, MEMBER, { name: "member" });
  assert.equal(titleOf(await run(guild, member, "-vc reset")), "Owner Only");
  const message = await run(guild, owner, "-vc reset");
  assert.match(message.replies[0].embeds[0].data.description, /are you sure you want to reset voice setup/);
  const confirmId = message.replies[0].components[0].components.find((button) => button.data.label === "Confirm").data.custom_id;
  const confirm = {
    customId: confirmId,
    user: { id: owner.id },
    member: owner,
    guild,
    async update(payload) { this.updated = payload; }
  };
  assert.equal(await require("../commands").handleVcReset(confirm), true);
  assert.match(confirm.updated.embeds[0].data.description, /no longer deletes channel history/);
});

test("showallcommands pages one category at a time", async () => {
  const guild = makeGuild();
  const member = makeMember(guild, MEMBER, { name: "member" });
  const shown = await run(guild, member, "-showallcommands");
  const first = shown.replies[0].embeds[0].data;
  assert.match(first.title, /^Moderation/);
  assert.ok(first.description.split("\n").length <= 12);
  assert.match(first.description, /`-ban`/);
  const menu = shown.replies[0].components[0].toJSON().components[0];
  assert.equal(menu.custom_id, "spanter:commands:cat");
  assert.equal(menu.options[0].label, "Moderation");
  assert.equal(menu.options[0].default, true);
  const buttons = shown.replies[0].components[1].components;
  assert.equal(buttons[0].data.label, "Back");
  assert.equal(buttons[0].data.disabled, true);
  assert.equal(buttons[1].data.label, "Next");
  const catalog = require("../vouch/catalog");
  const pages = catalog.commandPages("-");
  const names = [...new Set(pages.map((page) => page.name))];
  assert.deepEqual(names, [
    "Moderation", "Info", "Channels", "Logging", "Role Limits", "Voice",
    "VC Ranks", "Vouch", "Staff", "Godmode", "Force", "Social", "Vanity", "Protection", "Giveaways", "Bot"
  ]);
  const text = pages.map((page) => page.description).join("\n");
  for (const command of ["-ban", "-pban", "-antinuke vouch limit view", "-role limit set", "-nuke", "-ceo add", "-showallcommands", "-instagram", "-giveaways start", "-embedcreate", "-modlogreset", "-voiceshield", "-snipe", "-clearsnipe", "-modstats", "-viewstats", "-jail", "-vc edit"]) {
    assert.ok(text.includes(`\`${command}\``), command);
  }
  assert.doesNotMatch(text, /vouch check|vouch wipeall|limitedroles|setvouchlogs/);
  for (const page of pages) assert.ok(page.description.split("\n").length <= 12, page.title);
});

test("event logs can be set, tested, and removed", async () => {
  const guild = makeGuild();
  const owner = makeMember(guild, OWNER);
  const sent = [];
  const logChannel = {
    id: "555000000000000001",
    name: "logs",
    type: ChannelType.GuildText,
    send: async (payload) => {
      sent.push(payload);
      return payload;
    }
  };
  guild.channels.cache.set(logChannel.id, logChannel);
  const message = {
    guild,
    author: owner.user,
    member: owner,
    content: `-logging set message ${logChannel.id}`,
    mentions: { members: { first: () => null }, roles: { first: () => null }, channels: { first: () => null } },
    channel: logChannel,
    replies: [],
    async reply(payload) {
      this.replies.push(payload);
      return payload;
    }
  };
  await handleCommand(message, guild.client, "-");
  assert.equal(embedTitle(message.replies[0].embeds[0]), "Logs Updated");
  assert.equal(store.getLog(guild.id, "message"), logChannel.id);

  const tested = await run(guild, owner, "-logs test message");
  assert.equal(titleOf(tested), "Test Sent");
  assert.equal(sent.length, 1);

  const antinuke = await run(guild, owner, `-logging set antinuke ${logChannel.id}`);
  assert.equal(titleOf(antinuke), "Logs Updated");
  assert.equal(store.getLog(guild.id, "antinuke"), logChannel.id);

  const punishments = await run(guild, owner, `-logging set punishments ${logChannel.id}`);
  assert.equal(titleOf(punishments), "Logs Updated");
  assert.equal(store.getLog(guild.id, "punishments"), logChannel.id);

  const all = await run(guild, owner, `-logging set all ${logChannel.id}`);
  assert.match(textOf(all), /punishment logs were left alone/);
  assert.equal(store.getLog(guild.id, "antinuke"), logChannel.id);
  assert.equal(store.getLog(guild.id, "punishments"), logChannel.id);

  const cleared = await run(guild, owner, "-logging remove all");
  assert.equal(titleOf(cleared), "Logs Cleared");
  assert.equal(store.getLog(guild.id, "message"), null);
  assert.equal(store.getLog(guild.id, "antinuke"), logChannel.id);
  assert.equal(store.getLog(guild.id, "punishments"), logChannel.id);
});

test("punishment log records who acted, the reason, and when", async () => {
  const guild = makeGuild();
  const owner = makeMember(guild, OWNER);
  const sent = [];
  const logChannel = {
    id: "555000000000000077",
    type: ChannelType.GuildText,
    send: async (payload) => {
      sent.push(payload);
      return payload;
    }
  };
  guild.channels.cache.set(logChannel.id, logChannel);
  store.setLog(guild.id, "punishments", logChannel.id);
  const when = Date.now();
  db.addBanHistory({
    guild_id: guild.id,
    user_id: TARGET,
    action: "ban",
    reason: "spam links",
    moderator_id: owner.id,
    created_at: when
  });
  guild.fetchAuditLogs = async () => ({
    entries: new Map([["1", { targetId: TARGET, executorId: BOT, reason: "bot reason", createdTimestamp: when }]])
  });
  const { logBan, logKick, logTimeout } = require("../systems/punishments");
  await logBan(guild, TARGET, { wait: 0 });
  assert.equal(sent[0].embeds[0].data.title, "Ban");
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
  assert.match(sent[0].embeds[0].data.description, new RegExp(owner.id));
  assert.match(sent[0].embeds[0].data.description, /spam links/);
  assert.match(sent[0].embeds[0].data.description, /<t:\d+:F>/);

  sent.length = 0;
  guild.fetchAuditLogs = async () => ({ entries: new Map() });
  await logKick(guild, TARGET, { wait: 0 });
  assert.equal(sent.length, 0);

  guild.fetchAuditLogs = async () => ({
    entries: new Map([["2", {
      targetId: TARGET,
      executorId: owner.id,
      reason: "arguing",
      createdTimestamp: when,
      changes: [{ key: "communication_disabled_until" }]
    }]])
  });
  await logTimeout(guild, TARGET, when + 3600000, false, { wait: 0 });
  assert.equal(sent[0].embeds[0].data.title, "Timeout");
  assert.match(sent[0].embeds[0].data.description, /arguing/);
  assert.match(sent[0].embeds[0].data.description, new RegExp(owner.id));
  assert.match(sent[0].embeds[0].data.description, /\*\*Until:\*\*/);
});

test("mod setup creates numb bot logs once and asks which role to ping", async () => {
  const modsetup = require("../systems/modsetup");
  const guild = makeGuild();
  const owner = makeMember(guild, OWNER);
  const created = [];
  guild.channels.create = async (data) => {
    const channel = {
      id: `56100000000000010${created.length}`,
      name: data.name,
      type: data.type,
      parentId: data.parent || null
    };
    guild.channels.cache.set(channel.id, channel);
    created.push(channel);
    return channel;
  };
  const interaction = {
    customId: "spanter:modsetup:create:logs",
    member: owner,
    user: owner.user,
    guild,
    replied: false,
    deferred: false,
    async update(payload) {
      this.updated = payload;
    },
    async reply(payload) {
      this.repliedPayload = payload;
    }
  };
  assert.equal(await modsetup.handleInteraction(interaction), true);
  const categories = created.filter((channel) => channel.name === "numb bot");
  assert.equal(categories.length, 1);
  assert.equal(store.getLog(guild.id, "punishments"), created.find((channel) => channel.name === "punishments").id);
  assert.equal(store.getLog(guild.id, "antinuke"), created.find((channel) => channel.name === "antinuke").id);
  assert.equal(store.getLog(guild.id, "role"), created.find((channel) => channel.name === "roles").id);
  assert.equal(store.getLog(guild.id, "voice"), null);
  assert.equal(store.getLog(guild.id, "channel"), null);
  assert.match(embedTitle(interaction.updated.embeds[0]), /Mod Setup/);
  assert.match(interaction.updated.embeds[0].data.description, /Anti-Nuke ping role/);

  const again = { ...interaction, updated: null };
  again.update = async (payload) => {
    again.updated = payload;
  };
  assert.equal(await modsetup.handleInteraction(again), true);
  assert.equal(created.filter((channel) => channel.name === "numb bot").length, 1);
  assert.equal(created.length, 7);

  const ping = guild.roles.cache.values().next().value;
  const picked = {
    customId: "spanter:modsetup:pick:ping",
    values: [ping.id],
    member: owner,
    user: owner.user,
    guild,
    replied: false,
    deferred: false,
    async update(payload) {
      this.updated = payload;
    }
  };
  assert.equal(await modsetup.handleInteraction(picked), true);
  assert.equal(store.getAntinukePing(guild.id), ping.id);
  assert.equal(embedTitle(picked.updated.embeds[0]), "Mod Setup Complete");

  const reset = await run(guild, owner, "-modlogreset");
  assert.equal(titleOf(reset), "Mod Logs Reset");
  assert.equal(store.getLog(guild.id, "punishments"), null);
  assert.equal(store.getAntinukePing(guild.id), null);
  assert.equal(created.filter((channel) => channel.name === "numb bot").length, 1);
});

test("muteall is god-only and a grant whitelists one command", async () => {
  const guild = makeGuild();
  const owner = makeMember(guild, OWNER, { name: "owner" });
  const founder = makeMember(guild, "111000000000000030", { name: "founder" });
  const member = makeMember(guild, MEMBER, { name: "member" });
  const target = makeMember(guild, TARGET, { name: "target" });
  store.setStaff(guild.id, founder.id, "founder", OWNER);
  const premium = { id: "222000000000000088", name: "Premium Plus", position: 6, managed: false };
  guild.roles.cache.set(premium.id, premium);
  store.setVoiceRole(guild.id, "premiumplus", premium.id);
  member.roles.cache.set(premium.id, premium);
  store.setRank(guild.id, member.id, "premiumplus", owner.id);

  const channel = { id: "444000000000000201", type: ChannelType.GuildVoice, guild, members: new Map() };
  guild.channels.cache.set(channel.id, channel);
  for (const person of [owner, member, target]) {
    person.voice.channel = channel;
    person.voice.channelId = channel.id;
    channel.members.set(person.id, person);
    person.voice.setMute = async (value) => {
      person.voice.serverMute = value;
    };
  }

  assert.equal(titleOf(await run(guild, member, "-muteall")), "Rank Required");
  assert.equal(titleOf(await run(guild, founder, "-grant muteall " + member.id)), "Access Denied");
  assert.equal(titleOf(await run(guild, owner, "-muteall")), "Channel Muted");
  assert.equal(target.voice.serverMute, true);

  const granted = await run(guild, owner, `-grant muteall ${member.id}`);
  assert.equal(titleOf(granted), "Command Granted");
  target.voice.serverMute = false;
  assert.equal(titleOf(await run(guild, member, "-muteall")), "Channel Muted");
  assert.equal(target.voice.serverMute, true);
  assert.equal(titleOf(await run(guild, member, "-unmuteall")), "Rank Required");
  assert.equal(titleOf(await run(guild, member, "-dragall")), "Rank Required");

  const listed = await run(guild, owner, `-grant list ${member.id}`);
  assert.match(textOf(listed), /muteall/);
  assert.equal(titleOf(await run(guild, owner, `-revoke muteall ${member.id}`)), "Command Revoked");
  assert.equal(titleOf(await run(guild, member, "-muteall")), "Rank Required");

  target.setNickname = async () => {};
  assert.equal(titleOf(await run(guild, owner, `-grant forcenickname ${member.id}`)), "Command Granted");
  assert.equal(titleOf(await run(guild, member, `-forcenickname ${target.id} Dee`)), "Forced Nickname");
  assert.equal(titleOf(await run(guild, member, `-rolestrip ${ROLE}`)), "Not Allowed");
  assert.equal(store.hasCommandGrant(guild.id, member.id, "forcenickname"), true);
  assert.equal(store.hasCommandGrant(guild.id, member.id, "rolestrip"), false);
});

test("updates keep saved vc rows, history, and command grants", async () => {
  const guild = makeGuild();
  const owner = makeMember(guild, OWNER);
  const member = makeMember(guild, MEMBER);
  const channelId = "444000000000000301";
  db.addTemp({
    channel_id: channelId,
    guild_id: guild.id,
    owner_id: owner.id,
    interface_message_id: null,
    created_at: Date.now()
  });
  store.addHistory(guild.id, member.id, "joined the saved vc");
  assert.equal(titleOf(await run(guild, owner, `-grant unmuteall ${member.id}`)), "Command Granted");

  db.connection.exec(`
    CREATE TABLE IF NOT EXISTS command_grants (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      command TEXT NOT NULL,
      granted_by TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id, command)
    );
  `);
  db.connection.pragma("wal_checkpoint(FULL)");
  const Database = require("better-sqlite3");
  const saved = new Database(process.env.DB_PATH, { readonly: true });
  const grant = saved.prepare("SELECT command FROM command_grants WHERE guild_id=? AND user_id=?").get(guild.id, member.id);
  const temp = saved.prepare("SELECT owner_id FROM temp_channels WHERE channel_id=? AND deleted_at IS NULL").get(channelId);
  const history = saved.prepare("SELECT summary FROM voice_history WHERE guild_id=? AND user_id=?").get(guild.id, member.id);
  saved.close();
  assert.equal(grant.command, "unmuteall");
  assert.equal(temp.owner_id, owner.id);
  assert.equal(history.summary, "joined the saved vc");
});
