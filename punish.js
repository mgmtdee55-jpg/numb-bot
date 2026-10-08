const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  PermissionFlagsBits,
  StringSelectMenuBuilder
} = require("discord.js");
const { connection } = require("./db");
const access = require("./systems/access");
const stats = require("./stats");
const { resolveMember, resolveRole } = require("./vouch/resolve");
const roles = require("./vouch/roles");
const { embed, reply } = require("./vouch/ui");

const GAP_MS = 400;
const CONFIRM_MS = 60_000;
const busy = new Set();

connection.exec(`
CREATE TABLE IF NOT EXISTS punishment_config (
  guild_id TEXT PRIMARY KEY,
  jail_role_id TEXT,
  jail_channel_id TEXT,
  cmute_role_id TEXT,
  imute_role_id TEXT,
  rmute_role_id TEXT,
  cam_role_id TEXT,
  cam_blacklist_role_id TEXT
);
CREATE TABLE IF NOT EXISTS jailed_users (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role_ids TEXT NOT NULL,
  reason TEXT,
  moderator_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE IF NOT EXISTS stripped_roles (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  role_ids TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id, kind)
);
`);

const statements = {
  getConfig: connection.prepare("SELECT * FROM punishment_config WHERE guild_id=?"),
  saveConfig: connection.prepare(`
    INSERT INTO punishment_config(
      guild_id, jail_role_id, jail_channel_id, cmute_role_id, imute_role_id, rmute_role_id, cam_role_id, cam_blacklist_role_id
    ) VALUES(@guild_id,@jail_role_id,@jail_channel_id,@cmute_role_id,@imute_role_id,@rmute_role_id,@cam_role_id,@cam_blacklist_role_id)
    ON CONFLICT(guild_id) DO UPDATE SET
      jail_role_id=excluded.jail_role_id,
      jail_channel_id=excluded.jail_channel_id,
      cmute_role_id=excluded.cmute_role_id,
      imute_role_id=excluded.imute_role_id,
      rmute_role_id=excluded.rmute_role_id,
      cam_role_id=excluded.cam_role_id,
      cam_blacklist_role_id=excluded.cam_blacklist_role_id
  `),
  getJail: connection.prepare("SELECT * FROM jailed_users WHERE guild_id=? AND user_id=?"),
  saveJail: connection.prepare(`
    INSERT INTO jailed_users(guild_id, user_id, role_ids, reason, moderator_id, created_at)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      role_ids=excluded.role_ids, reason=excluded.reason, moderator_id=excluded.moderator_id, created_at=excluded.created_at
  `),
  clearJail: connection.prepare("DELETE FROM jailed_users WHERE guild_id=? AND user_id=?"),
  getStripped: connection.prepare("SELECT role_ids FROM stripped_roles WHERE guild_id=? AND user_id=? AND kind=?"),
  saveStripped: connection.prepare(`
    INSERT INTO stripped_roles(guild_id, user_id, kind, role_ids) VALUES(?,?,?,?)
    ON CONFLICT(guild_id, user_id, kind) DO UPDATE SET role_ids=excluded.role_ids
  `),
  clearStripped: connection.prepare("DELETE FROM stripped_roles WHERE guild_id=? AND user_id=? AND kind=?")
};

let paceChain = Promise.resolve();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pace(work) {
  const run = paceChain.then(async () => {
    await roles.withRateLimit(work);
    await sleep(GAP_MS);
  });
  paceChain = run.catch(() => null);
  return run;
}

function blankConfig(guildId) {
  return {
    guild_id: guildId,
    jail_role_id: null,
    jail_channel_id: null,
    cmute_role_id: null,
    imute_role_id: null,
    rmute_role_id: null,
    cam_role_id: null,
    cam_blacklist_role_id: null
  };
}

function getConfig(guildId) {
  return statements.getConfig.get(guildId) || blankConfig(guildId);
}

function saveConfig(config) {
  statements.saveConfig.run(config);
}

function parseIds(text) {
  try {
    const parsed = JSON.parse(text || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function canRun(member) {
  return access.canModerate(member);
}

function deny(message) {
  return reply(message, "Not Allowed", "Only Gods and the server owner can use this.");
}

function roleIds(member) {
  return [...(member?.roles?.cache?.keys?.() || [])].map(String);
}

function hasRole(member, roleId) {
  return !!roleId && member?.roles?.cache?.has?.(roleId);
}

function grants(role, flags) {
  if (!role?.permissions?.has || role.permissions.has(PermissionFlagsBits.Administrator)) return false;
  return flags.some((flag) => role.permissions.has(flag));
}

function textChannel(channel) {
  return [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.GuildForum,
    ChannelType.GuildMedia
  ].includes(channel?.type);
}

function editableChannels(guild) {
  return [...(guild.channels?.cache?.values?.() || [])].filter((channel) => (
    channel && typeof channel.permissionOverwrites?.edit === "function" && channel.type !== ChannelType.PublicThread && channel.type !== ChannelType.PrivateThread
  ));
}

async function editOverwrite(channel, id, data) {
  if (!channel || !id || typeof channel.permissionOverwrites?.edit !== "function") return;
  await pace(() => channel.permissionOverwrites.edit(id, data, { reason: "Punishment setup" }));
}

function overwriteFor(config, channel) {
  const jobs = [];
  if (config.jail_role_id && channel.id !== config.jail_channel_id) {
    jobs.push([config.jail_role_id, { ViewChannel: false }]);
  }
  if (config.jail_role_id && channel.id === config.jail_channel_id) {
    jobs.push([config.jail_role_id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    }]);
  }
  if (textChannel(channel) || channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) {
    if (config.cmute_role_id && textChannel(channel)) {
      jobs.push([config.cmute_role_id, { SendMessages: false, SendMessagesInThreads: false }]);
    }
    if (config.imute_role_id && textChannel(channel)) {
      jobs.push([config.imute_role_id, { AttachFiles: false, EmbedLinks: false }]);
    }
    if (config.rmute_role_id && textChannel(channel)) {
      jobs.push([config.rmute_role_id, { AddReactions: false }]);
    }
  }
  return jobs;
}

async function applyChannel(channel) {
  if (!channel?.guild) return;
  const config = getConfig(channel.guild.id);
  for (const [roleId, data] of overwriteFor(config, channel)) {
    await editOverwrite(channel, roleId, data);
  }
}

async function applyAll(guild, onProgress) {
  const channels = editableChannels(guild);
  let done = 0;
  for (const channel of channels) {
    await applyChannel(channel);
    done += 1;
    if (onProgress && done % 4 === 0) await onProgress(done, channels.length);
  }
  if (onProgress) await onProgress(channels.length, channels.length);
  return channels.length;
}

async function createRole(guild, name) {
  const role = await guild.roles.create({ name, permissions: [], reason: "Server setup" });
  const position = (guild.members?.me?.roles?.highest?.position || 1) - 1;
  if (position > 0 && typeof role.setPosition === "function") {
    await role.setPosition(position).catch(() => null);
  }
  return role;
}

async function prepareJailChannel(guild, channel, jailRoleId) {
  await editOverwrite(channel, guild.id, { ViewChannel: false });
  if (jailRoleId) {
    await editOverwrite(channel, jailRoleId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
  }
  for (const role of guild.roles?.cache?.values?.() || []) {
    if (role.permissions?.has?.(PermissionFlagsBits.Administrator) && role.id !== guild.id) {
      await editOverwrite(channel, role.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
    }
  }
}

const STEPS = [
  { key: "jail_role", column: "jail_role_id", label: "Jail role", createName: "Jailed" },
  { key: "jail_channel", column: "jail_channel_id", label: "Jail channel", channel: true },
  { key: "cmute", column: "cmute_role_id", label: "Chat mute role", createName: "Chat muted" },
  { key: "imute", column: "imute_role_id", label: "Image mute role", createName: "Image muted" },
  { key: "rmute", column: "rmute_role_id", label: "Reaction mute role", createName: "Reaction muted" },
  { key: "cam", column: "cam_role_id", label: "Camera role", createName: "Camera" },
  { key: "cam_blacklist", column: "cam_blacklist_role_id", label: "Camera blacklist role", createName: "Camera blacklisted" },
  { key: "apply", label: "Channel overrides" }
];

const sessions = new Map();

function roleOptions(guild) {
  return [...(guild.roles?.cache?.values?.() || [])]
    .filter((role) => role.id !== guild.id && !role.managed)
    .sort((left, right) => (right.position || 0) - (left.position || 0))
    .slice(0, 24)
    .map((role) => ({ label: String(role.name || "role").slice(0, 100), value: role.id }));
}

function setupMessage(guild, userId, stepIndex) {
  const step = STEPS[stepIndex];
  const config = getConfig(guild.id);
  const current = step.column ? config[step.column] : null;
  const rows = [];
  if (step.channel) {
    rows.push(new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(`spanter:serversetup:channel:${userId}`)
        .setPlaceholder("Use an existing text channel")
        .setChannelTypes(ChannelType.GuildText)
    ));
  } else if (step.key !== "apply") {
    const options = roleOptions(guild);
    if (options.length) {
      rows.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`spanter:serversetup:pick:${userId}`)
          .setPlaceholder(`Select the ${step.label}`)
          .addOptions(options)
      ));
    }
  }
  const buttons = [];
  if (step.key === "apply") {
    buttons.push(new ButtonBuilder().setCustomId(`spanter:serversetup:apply:${userId}`).setLabel("Apply overrides").setStyle(ButtonStyle.Primary));
  } else if (step.channel) {
    buttons.push(new ButtonBuilder().setCustomId(`spanter:serversetup:create:${userId}`).setLabel("Create jail channel").setStyle(ButtonStyle.Primary));
  } else {
    buttons.push(new ButtonBuilder().setCustomId(`spanter:serversetup:create:${userId}`).setLabel("Create role").setStyle(ButtonStyle.Primary));
  }
  buttons.push(new ButtonBuilder().setCustomId(`spanter:serversetup:skip:${userId}`).setLabel(step.key === "apply" ? "Finish" : "Skip").setStyle(ButtonStyle.Secondary));
  rows.push(new ActionRowBuilder().addComponents(buttons));
  const saved = current ? (step.channel ? `<#${current}>` : `<@&${current}>`) : "not set";
  const description = step.key === "apply"
    ? "This adds the mute and jail overrides on the channels that already exist. It goes one channel at a time so Discord does not rate limit the bot."
    : `Should I create the **${step.label}**, or do you want to use one that already exists?\n\nCurrent: ${saved}`;
  return {
    embeds: [embed("Server Setup", `Step ${stepIndex + 1} / ${STEPS.length}\n**${step.label}**\n\n${description}`)],
    components: rows
  };
}

async function openSetup(message) {
  if (!access.canSetup(message.member)) return reply(message, "Not Allowed", "Only Gods and the server owner can run server setup.");
  sessions.set(`${message.guild.id}:${message.author.id}`, 0);
  return message.reply(setupMessage(message.guild, message.author.id, 0));
}

function sessionStep(guildId, userId) {
  return sessions.get(`${guildId}:${userId}`) || 0;
}

async function advance(interaction, next) {
  const step = Math.max(0, Math.min(STEPS.length - 1, next));
  sessions.set(`${interaction.guild.id}:${interaction.user.id}`, step);
  await interaction.update(setupMessage(interaction.guild, interaction.user.id, step));
}

async function handleSetup(interaction) {
  const id = interaction.customId || "";
  if (!id.startsWith("spanter:serversetup:")) return false;
  const [, , action, userId] = id.split(":");
  if (interaction.user?.id !== userId) {
    await interaction.reply({ embeds: [embed("Not Yours", "Only the person who started setup can use these buttons.")], flags: 64 }).catch(() => null);
    return true;
  }
  if (!access.canSetup(interaction.member)) {
    await interaction.reply({ embeds: [embed("Not Allowed", "Only Gods and the server owner can run server setup.")], flags: 64 }).catch(() => null);
    return true;
  }
  const step = STEPS[sessionStep(interaction.guild.id, userId)];
  const config = getConfig(interaction.guild.id);
  if (action === "skip") {
    if (step.key === "apply") {
      sessions.delete(`${interaction.guild.id}:${userId}`);
      await interaction.update({ embeds: [embed("Server Setup", "Setup saved. Run `-serversetup` again any time to change a role or channel.")], components: [] });
      return true;
    }
    await advance(interaction, sessionStep(interaction.guild.id, userId) + 1);
    return true;
  }
  if (action === "create") {
    if (step.channel) {
      if (!config.jail_role_id) {
        await interaction.reply({ embeds: [embed("Jail Role First", "Create or select the jail role before the jail channel.")], flags: 64 }).catch(() => null);
        return true;
      }
      const channel = await interaction.guild.channels.create({
        name: "jail",
        type: ChannelType.GuildText,
        reason: "Jail channel"
      });
      config.jail_channel_id = channel.id;
      saveConfig(config);
      await prepareJailChannel(interaction.guild, channel, config.jail_role_id);
      await advance(interaction, sessionStep(interaction.guild.id, userId) + 1);
      return true;
    }
    const role = await createRole(interaction.guild, step.createName);
    config[step.column] = role.id;
    saveConfig(config);
    await advance(interaction, sessionStep(interaction.guild.id, userId) + 1);
    return true;
  }
  if (action === "pick") {
    const roleId = interaction.values?.[0];
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role || !roles.botCanManageRole(interaction.guild, role)) {
      await interaction.reply({ embeds: [embed("Cannot Use Role", "Pick a role below my highest role.")], flags: 64 }).catch(() => null);
      return true;
    }
    config[step.column] = role.id;
    saveConfig(config);
    await advance(interaction, sessionStep(interaction.guild.id, userId) + 1);
    return true;
  }
  if (action === "channel") {
    const channelId = interaction.values?.[0];
    const channel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) {
      await interaction.reply({ embeds: [embed("Text Channel", "Pick a text channel for jail.")], flags: 64 }).catch(() => null);
      return true;
    }
    config.jail_channel_id = channel.id;
    saveConfig(config);
    await prepareJailChannel(interaction.guild, channel, config.jail_role_id);
    await advance(interaction, sessionStep(interaction.guild.id, userId) + 1);
    return true;
  }
  if (action === "apply") {
    await interaction.update({ embeds: [embed("Server Setup", "Applying channel overrides. I'll update this when it finishes.")], components: [] });
    const count = await applyAll(interaction.guild, async (done, total) => {
      if (typeof interaction.editReply === "function" && done !== total) {
        await interaction.message?.edit?.({ embeds: [embed("Server Setup", `Applying channel overrides. **${done}** / **${total}** channels.`)] }).catch(() => null);
      }
    });
    sessions.delete(`${interaction.guild.id}:${userId}`);
    const payload = { embeds: [embed("Server Setup Complete", `Overrides are set on **${count}** channel(s). New channels get them too.`)], components: [] };
    if (typeof interaction.message?.edit === "function") await interaction.message.edit(payload).catch(() => null);
    return true;
  }
  return true;
}

async function rememberStripped(member, kind, roleId) {
  const current = parseIds(statements.getStripped.get(member.guild.id, member.id, kind)?.role_ids);
  if (!current.includes(roleId)) current.push(roleId);
  statements.saveStripped.run(member.guild.id, member.id, kind, JSON.stringify(current));
}

async function takeRoles(member, roleList, reason) {
  const ids = roleList.map((role) => role.id).filter(Boolean);
  if (!ids.length || typeof member.roles?.remove !== "function") return;
  await roles.withRateLimit(() => member.roles.remove(ids, reason));
}

async function stripMatching(member, kind, predicate, reason) {
  const config = getConfig(member.guild.id);
  const keep = new Set([member.guild.id, config.imute_role_id, config.rmute_role_id, config.cmute_role_id, config.jail_role_id, config.cam_blacklist_role_id].filter(Boolean));
  const removing = [];
  for (const role of member.roles?.cache?.values?.() || []) {
    if (!role || keep.has(role.id) || role.managed) continue;
    if (!roles.botCanManageRole(member.guild, role) || !predicate(role)) continue;
    removing.push(role);
  }
  for (const role of removing) await rememberStripped(member, kind, role.id);
  await takeRoles(member, removing, reason);
  return removing.length;
}

async function restoreStripped(member, kind) {
  const saved = parseIds(statements.getStripped.get(member.guild.id, member.id, kind)?.role_ids);
  statements.clearStripped.run(member.guild.id, member.id, kind);
  const give = saved.filter((roleId) => {
    const role = member.guild.roles?.cache?.get(roleId);
    return role && roles.botCanManageRole(member.guild, role) && !hasRole(member, roleId);
  });
  if (give.length && typeof member.roles?.add === "function") {
    await roles.withRateLimit(() => member.roles.add(give, "Punishment removed"));
  }
}

async function withMember(member, work) {
  const key = `${member.guild.id}:${member.id}`;
  if (busy.has(key)) return false;
  busy.add(key);
  try {
    await work();
    return true;
  } finally {
    busy.delete(key);
  }
}

function imageRole(role) {
  return grants(role, [PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks]);
}

function reactionRole(role) {
  return grants(role, [PermissionFlagsBits.AddReactions]);
}

function cameraRole(role, camRoleId) {
  if (camRoleId && role.id === camRoleId) return true;
  return grants(role, [PermissionFlagsBits.Stream]);
}

async function syncMember(before, after) {
  if (!after?.guild || busy.has(`${after.guild.id}:${after.id}`)) return;
  const config = getConfig(after.guild.id);
  const had = (roleId) => !!roleId && before?.roles?.cache?.has?.(roleId);
  const has = (roleId) => hasRole(after, roleId);
  if (config.imute_role_id && had(config.imute_role_id) && !has(config.imute_role_id)) await restoreStripped(after, "imute");
  if (config.rmute_role_id && had(config.rmute_role_id) && !has(config.rmute_role_id)) await restoreStripped(after, "rmute");
  if (config.imute_role_id && has(config.imute_role_id)) await stripMatching(after, "imute", imageRole, "Image mute");
  if (config.rmute_role_id && has(config.rmute_role_id)) await stripMatching(after, "rmute", reactionRole, "Reaction mute");
  if (config.cam_blacklist_role_id && has(config.cam_blacklist_role_id)) {
    await stripMatching(after, "cam", (role) => cameraRole(role, config.cam_role_id), "Camera blacklist");
  }
}

async function toggleRole(message, member, column, label) {
  if (!member) return reply(message, "Missing User", "Mention a member.");
  const config = getConfig(message.guild.id);
  const roleId = config[column];
  const role = roleId && (message.guild.roles.cache.get(roleId) || await message.guild.roles.fetch(roleId).catch(() => null));
  if (!role) return { missing: true, text: `Run \`-serversetup\` and choose the ${label} first.` };
  if (!roles.botCanManageRole(message.guild, role)) return { missing: true, text: "Move my role above that role." };
  const on = hasRole(member, role.id);
  await withMember(member, async () => {
    if (on) {
      await roles.removeRole(member, role, `${label} removed by ${message.author.id}`);
      if (column === "imute_role_id") await restoreStripped(member, "imute");
      if (column === "rmute_role_id") await restoreStripped(member, "rmute");
    } else {
      await roles.addRole(member, role, `${label} by ${message.author.id}`);
      if (column === "imute_role_id") await stripMatching(member, "imute", imageRole, "Image mute");
      if (column === "rmute_role_id") await stripMatching(member, "rmute", reactionRole, "Reaction mute");
    }
  });
  return { on, text: `<@${member.id}> ${on ? "can use that again" : "has that restriction"}.` };
}

async function jail(message, member, reason) {
  const config = getConfig(message.guild.id);
  const role = config.jail_role_id && message.guild.roles.cache.get(config.jail_role_id);
  if (!role || !config.jail_channel_id) return reply(message, "Setup Needed", "Run `-serversetup` and set the jail role and jail channel.");
  if (!member) return reply(message, "Missing User", "Mention the member you want to jail.");
  if (member.id === message.guild.ownerId) return reply(message, "Unable to Jail", "The server owner cannot be jailed.");
  if (member.user?.bot) return reply(message, "Unable to Jail", "I can't jail a bot.");
  if (statements.getJail.get(message.guild.id, member.id)) return reply(message, "Already Jailed", `<@${member.id}> is already in jail. Use \`-unjail\`.`);
  if (!roles.botCanManageRole(message.guild, role)) return reply(message, "Cannot Manage Role", "Move my role above the jail role.");
  const saved = [];
  const removing = [];
  for (const held of member.roles?.cache?.values?.() || []) {
    if (!held || held.id === message.guild.id || held.id === role.id || held.managed) continue;
    if (!roles.botCanManageRole(message.guild, held)) continue;
    saved.push(held.id);
    removing.push(held);
  }
  await withMember(member, async () => {
    await takeRoles(member, removing, `Jailed by ${message.author.id}`);
    await roles.addRole(member, role, `Jailed by ${message.author.id}`);
  });
  statements.saveJail.run(message.guild.id, member.id, JSON.stringify(saved), reason || null, message.author.id, Date.now());
  const channel = message.guild.channels.cache.get(config.jail_channel_id) || await message.guild.channels.fetch(config.jail_channel_id).catch(() => null);
  if (typeof channel?.send === "function") {
    await channel.send({
      content: `<@${member.id}>`,
      embeds: [embed("Jailed", `**Reason:** ${reason || "No reason given."}\n**By:** <@${message.author.id}>`)],
      allowedMentions: { users: [member.id] }
    }).catch(() => null);
  }
  return reply(message, "Jailed", `<@${member.id}> is in <#${config.jail_channel_id}>. Their other roles were taken off until \`-unjail\`.`);
}

async function unjail(message, member) {
  const row = member && statements.getJail.get(message.guild.id, member.id);
  if (!row) return reply(message, "Not Jailed", "That member is not jailed.");
  const config = getConfig(message.guild.id);
  const give = parseIds(row.role_ids).filter((roleId) => {
    const role = message.guild.roles.cache.get(roleId);
    return role && roles.botCanManageRole(message.guild, role);
  });
  await withMember(member, async () => {
    if (config.jail_role_id && hasRole(member, config.jail_role_id)) {
      await roles.removeRole(member, config.jail_role_id, `Unjailed by ${message.author.id}`);
    }
    if (give.length && typeof member.roles?.add === "function") {
      await roles.withRateLimit(() => member.roles.add(give, `Unjailed by ${message.author.id}`));
    }
  });
  statements.clearJail.run(message.guild.id, member.id);
  return reply(message, "Unjailed", `<@${member.id}> got their roles back.`);
}

async function serverMute(message, member) {
  if (!member) return reply(message, "Missing User", "Mention someone who is in a voice channel.");
  if (!member.voice?.channelId || typeof member.voice.setMute !== "function") {
    return reply(message, "Not In Voice", "They have to be in a voice channel. A normal unmute still works after this.");
  }
  await member.voice.setMute(true, `Server mute by ${message.author.id}`);
  stats.recordAction(message.guild.id, message.author.id, member.id, "mute", "Server mute");
  return reply(message, "Server Muted", `<@${member.id}> is server muted. Someone can unmute them normally.`);
}

async function askMute(message, member) {
  if (!member) return reply(message, "Missing User", "Mention the member you want to mute.");
  const expires = Date.now() + CONFIRM_MS;
  const tail = `${member.id}:${message.author.id}:${expires}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`spanter:mute:server:${tail}`).setLabel("Server mute").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`spanter:mute:chat:${tail}`).setLabel("Chat mute").setStyle(ButtonStyle.Secondary)
  );
  return message.reply({
    embeds: [embed("Mute", `are you trying to server mute someone ? or chat mute someone ?\n<@${member.id}>`)],
    components: [row],
    allowedMentions: { parse: [] }
  });
}

async function handleMuteButton(interaction) {
  const id = interaction.customId || "";
  if (!id.startsWith("spanter:mute:")) return false;
  const [, , kind, targetId, actorId, expires] = id.split(":");
  if (interaction.user?.id !== actorId) {
    await interaction.reply({ embeds: [embed("Not Yours", "Only the person who ran this can choose.")], flags: 64 }).catch(() => null);
    return true;
  }
  if (!Number(expires) || Date.now() > Number(expires)) {
    await interaction.update({ embeds: [embed("Expired", "Run `-mute` again.")], components: [] });
    return true;
  }
  const member = interaction.guild.members.cache.get(targetId) || await interaction.guild.members.fetch(targetId).catch(() => null);
  const message = {
    guild: interaction.guild,
    author: { id: actorId },
    member: interaction.member
  };
  if (kind === "server") {
    if (!member?.voice?.channelId || typeof member.voice.setMute !== "function") {
      await interaction.update({ embeds: [embed("Not In Voice", "They have to be in a voice channel for a server mute.")], components: [] });
      return true;
    }
    await member.voice.setMute(true, `Server mute by ${actorId}`);
    stats.recordAction(interaction.guild.id, actorId, targetId, "mute", "Server mute");
    await interaction.update({ embeds: [embed("Server Muted", `<@${targetId}> is server muted. Someone can unmute them normally.`)], components: [] });
    return true;
  }
  const result = await toggleRole(message, member, "cmute_role_id", "Chat mute");
  await interaction.update({
    embeds: [embed(result.missing ? "Setup Needed" : "Chat mute", result.text)],
    components: []
  });
  return true;
}

async function camBlacklist(message, member) {
  if (!member) return reply(message, "Missing User", "Mention the member.");
  const config = getConfig(message.guild.id);
  const removed = await stripMatching(member, "cam", (role) => cameraRole(role, config.cam_role_id), "Camera blacklist");
  if (config.cam_blacklist_role_id) {
    const role = message.guild.roles.cache.get(config.cam_blacklist_role_id);
    if (role && roles.botCanManageRole(message.guild, role)) {
      if (hasRole(member, role.id)) {
        await roles.removeRole(member, role, `Camera blacklist removed by ${message.author.id}`);
        return reply(message, "Camera Blacklist Removed", `<@${member.id}> is no longer camera blacklisted. Their camera role stays off until someone gives it back.`);
      }
      await roles.addRole(member, role, `Camera blacklist by ${message.author.id}`);
    }
  }
  return reply(message, "Camera Blacklisted", `Removed **${removed}** camera role(s) from <@${member.id}>.`);
}

async function setConfiguredRole(message, argument, column, label) {
  const role = await resolveRole(message, argument);
  if (!role || role.id === message.guild.id) return reply(message, "Missing Role", "Mention a role.");
  if (!roles.botCanManageRole(message.guild, role)) return reply(message, "Cannot Manage Role", "Move my role above that role.");
  const config = getConfig(message.guild.id);
  config[column] = role.id;
  saveConfig(config);
  return reply(message, "Saved", `${label} is <@&${role.id}>.`);
}

async function handleCommand(message, name, args) {
  if (name === "serversetup") {
    await openSetup(message);
    return true;
  }
  const moderated = ["jail", "unjail", "cmute", "chatmute", "imute", "imagemute", "rmute", "reactionmute", "mute", "servermute", "cam", "camblacklist"];
  if (!moderated.includes(name)) return false;
  if (!canRun(message.member)) {
    await deny(message);
    return true;
  }
  if (name === "cam" && (args[1] || "").toLowerCase() === "set") {
    await setConfiguredRole(message, args.slice(2).join(" "), "cam_role_id", "The camera role");
    return true;
  }
  if (name === "camblacklist" && (args[1] || "").toLowerCase() === "set") {
    await setConfiguredRole(message, args.slice(2).join(" "), "cam_blacklist_role_id", "The camera blacklist role");
    return true;
  }
  const member = await resolveMember(message, name === "camblacklist" ? args[1] : args[1]);
  if (name === "jail") {
    await jail(message, member, args.slice(2).join(" ").trim());
    return true;
  }
  if (name === "unjail") {
    await unjail(message, member);
    return true;
  }
  if (name === "cmute" || name === "chatmute" || name === "imute" || name === "imagemute" || name === "rmute" || name === "reactionmute") {
    const column = name === "imute" || name === "imagemute" ? "imute_role_id" : name === "rmute" || name === "reactionmute" ? "rmute_role_id" : "cmute_role_id";
    const label = column === "imute_role_id" ? "Image mute" : column === "rmute_role_id" ? "Reaction mute" : "Chat mute";
    const result = await toggleRole(message, member, column, label);
    await reply(message, result.missing ? "Setup Needed" : (result.on ? `${label} Removed` : label), result.text);
    return true;
  }
  if (name === "servermute") {
    await serverMute(message, member);
    return true;
  }
  if (name === "mute") {
    await askMute(message, member);
    return true;
  }
  if (name === "camblacklist") {
    await camBlacklist(message, member);
    return true;
  }
  return false;
}

module.exports = {
  getConfig,
  saveConfig,
  handleCommand,
  handleSetup,
  handleMuteButton,
  applyChannel,
  syncMember,
  jail,
  unjail,
  imageRole,
  cameraRole
};
