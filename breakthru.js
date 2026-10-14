const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  RoleSelectMenuBuilder
} = require("discord.js");
const db = require("./db");
const store = require("./systems/store");
const access = require("./systems/access");
const roleChanges = require("./vouch/roles");
const { reply } = require("./vouch/ui");
const { replyUsage } = require("./usage");
const { card } = require("./feedback");

const PROMPT_MS = 120_000;
const roleIds = new Map();

try {
  for (const row of store.listBreakthruRoles()) {
    if (row?.guild_id && row?.role_id) roleIds.set(String(row.guild_id), String(row.role_id));
  }
} catch {
  // Join-to-create still runs if this table cannot be read at startup.
}

function remember(guildId, roleId) {
  if (!guildId || !roleId) return;
  roleIds.set(String(guildId), String(roleId));
}

function save(guildId, roleId) {
  store.setBreakthruRole(guildId, roleId);
  remember(guildId, roleId);
}

function isAlias(text) {
  const value = String(text || "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return value === "break" || value === "break thru" || value === "breakthru";
}

function canAssign(member) {
  return access.canAssignRanks(member) || require("./verified-seller").isSeller(member);
}

function deny(message) {
  return reply(message, "Access Denied", "Only Verified Sellers, CEOs, and the server owner can assign Breakthru.");
}

// Applied after the channel exists, on a delay, so the extra permission edit
// cannot sit in the same Discord burst as channel create or the member move.
const ALLOW_DELAY_MS = 1000;

function allow(channel) {
  const timer = setTimeout(() => {
    try {
      const guild = channel?.guild;
      const roleId = guild?.id ? roleIds.get(String(guild.id)) : null;
      if (!roleId) return;
      const has = guild.roles?.cache?.has;
      if (typeof has === "function" && !has.call(guild.roles.cache, roleId)) return;
      const edit = channel.permissionOverwrites?.edit;
      if (typeof edit !== "function") return;
      Promise.resolve(edit.call(channel.permissionOverwrites, roleId, {
        ViewChannel: true,
        Connect: true
      })).catch(() => null);
    } catch {
      // A Breakthru overwrite must never stop a call from being created.
    }
  }, ALLOW_DELAY_MS);
  timer.unref?.();
}

async function openCalls(guild, roleId) {
  const skip = db.getConfig(guild.id)?.j2c_channel_id;
  for (const row of db.getTempChannels(guild.id)) {
    if (skip && String(row.channel_id) === String(skip)) continue;
    const channel = guild.channels?.cache?.get?.(row.channel_id)
      || await guild.channels?.fetch?.(row.channel_id).catch(() => null);
    if (typeof channel?.permissionOverwrites?.edit !== "function") continue;
    await channel.permissionOverwrites.edit(roleId, {
      ViewChannel: true,
      Connect: true
    }).catch(() => null);
  }
}

async function findRole(guild, roleId) {
  if (!roleId) return null;
  const cached = guild.roles?.cache?.get?.(roleId);
  if (cached) return cached;
  if (typeof guild.roles?.fetch !== "function") return null;
  return guild.roles.fetch(roleId).catch(() => null);
}

async function makeRole(guild) {
  return guild.roles.create({
    name: "Breakthru",
    permissions: 0n,
    reason: "Breakthru role for locked temporary voice channels"
  });
}

async function give(member, role) {
  if (typeof member.roles?.add === "function") {
    await roleChanges.addRole(member, role.id, "Breakthru assigned");
    return;
  }
  member.roles?.cache?.set(role.id, role);
}

function promptId(action, actorId, targetId) {
  return `spanter:breakthru:${action}:${actorId}:${targetId}:${Date.now() + PROMPT_MS}`;
}

function prompt(message, member) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(promptId("pick", message.author.id, member.id))
      .setLabel("Connect existing role")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(promptId("make", message.author.id, member.id))
      .setLabel("Make a role")
      .setStyle(ButtonStyle.Primary)
  );
  return message.reply({
    embeds: [card(
      "Breakthru",
      `Breakthru is not set up in this server yet.\n\nConnect an existing role, or I can make one. People with it can join locked temporary voice channels, even when @everyone cannot connect.\n\nThis will be given to <@${member.id}>.`,
      { guild: message.guild }
    )],
    components: [row]
  });
}

async function finish(source, member, role, { recreated = false, connected = false } = {}) {
  const already = member.roles?.cache?.has?.(role.id) === true;
  if (!already) await give(member, role);
  const title = already ? "Already Has Breakthru" : recreated ? "Breakthru Role Made" : connected ? "Breakthru Connected" : "Breakthru Assigned";
  const line = already
    ? `<@${member.id}> already has <@&${role.id}>.`
    : recreated
      ? `The Breakthru role was missing, so I made <@&${role.id}> and gave it to <@${member.id}>.`
      : `<@${member.id}> now has <@&${role.id}>.`;
  const description = `${line}\nThey can join locked temporary voice channels.`;
  if (typeof source.editReply === "function" && (source.deferred || source.replied)) {
    return source.editReply({ embeds: [card(title, description, { guild: source.guild })], components: [] });
  }
  if (typeof source.update === "function" && source.customId) {
    return source.update({ embeds: [card(title, description, { guild: source.guild })], components: [] });
  }
  return reply(source, title, description);
}

async function assign(message, member) {
  if (!canAssign(message.member)) return deny(message);
  if (!member) return replyUsage(message, "vcrankassign");
  if (member.user?.bot) return reply(message, "Invalid Target", "Bots cannot hold Breakthru.");
  const savedId = store.getBreakthruRole(message.guild.id);
  if (!savedId) return prompt(message, member);
  let role = await findRole(message.guild, savedId);
  let recreated = false;
  if (!role) {
    try {
      role = await makeRole(message.guild);
    } catch {
      return reply(message, "Cannot Make Role", "I could not make the Breakthru role. I need Manage Roles, and the role has to sit below mine.");
    }
    save(message.guild.id, role.id);
    recreated = true;
    await openCalls(message.guild, role.id);
  }
  remember(message.guild.id, role.id);
  try {
    return await finish(message, member, role, { recreated });
  } catch {
    return reply(message, "Cannot Assign Role", "I could not give that role. It needs to be below my highest role.");
  }
}

function parseId(customId) {
  const match = /^spanter:breakthru:(make|pick|role):(\d{17,20}):(\d{17,20}):(\d+)$/.exec(String(customId || ""));
  if (!match) return null;
  return { action: match[1], actorId: match[2], targetId: match[3], expires: Number(match[4]) };
}

async function refuse(interaction, title, description) {
  const payload = { embeds: [card(title, description, { guild: interaction.guild })], flags: MessageFlags.Ephemeral };
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload).catch(() => null);
  return interaction.reply(payload).catch(() => null);
}

async function handleInteraction(interaction) {
  const parsed = parseId(interaction.customId);
  if (!parsed) return false;
  if (interaction.user?.id !== parsed.actorId) {
    await refuse(interaction, "Not Yours", "Only the person who ran this can choose.");
    return true;
  }
  if (!Number.isFinite(parsed.expires) || Date.now() > parsed.expires) {
    const expired = { embeds: [card("Expired", "That choice expired. Run `-vc rank assign` again.", { guild: interaction.guild })], components: [] };
    if (typeof interaction.update === "function") await interaction.update(expired);
    return true;
  }
  if (!canAssign(interaction.member)) {
    await refuse(interaction, "Access Denied", "Only Verified Sellers, CEOs, and the server owner can assign Breakthru.");
    return true;
  }

  if (parsed.action === "pick") {
    const menu = new RoleSelectMenuBuilder()
      .setCustomId(promptId("role", parsed.actorId, parsed.targetId))
      .setPlaceholder("Choose the Breakthru role")
      .setMinValues(1)
      .setMaxValues(1);
    await interaction.update({
      embeds: [card("Connect a Role", `Choose the role that should let <@${parsed.targetId}> join locked temporary voice channels.`, { guild: interaction.guild })],
      components: [new ActionRowBuilder().addComponents(menu)]
    });
    return true;
  }

  if (typeof interaction.deferUpdate === "function") await interaction.deferUpdate();
  interaction.deferred = true;

  if (parsed.action === "role") {
    const roleId = interaction.values?.[0] || interaction.roles?.first?.()?.id;
    const role = roleId && (interaction.guild.roles.cache.get(roleId) || await interaction.guild.roles.fetch(roleId).catch(() => null));
    if (!role || role.id === interaction.guild.id || role.managed) {
      await interaction.editReply({
        embeds: [card("Invalid Role", "Choose a normal server role.", { guild: interaction.guild })],
        components: []
      });
      return true;
    }
    save(interaction.guild.id, role.id);
    await openCalls(interaction.guild, role.id);
    const member = interaction.guild.members.cache.get(parsed.targetId)
      || await interaction.guild.members.fetch(parsed.targetId).catch(() => null);
    if (!member) {
      await interaction.editReply({
        embeds: [card("Breakthru Connected", `<@&${role.id}> is the Breakthru role. That member is no longer in the server.`, { guild: interaction.guild })],
        components: []
      });
      return true;
    }
    try {
      await finish(interaction, member, role, { connected: true });
    } catch {
      await interaction.editReply({
        embeds: [card("Cannot Assign Role", "I saved the role, but I could not give it. It needs to be below my highest role.", { guild: interaction.guild })],
        components: []
      });
    }
    return true;
  }

  let role = await findRole(interaction.guild, store.getBreakthruRole(interaction.guild.id));
  let recreated = false;
  if (!role) {
    try {
      role = await makeRole(interaction.guild);
    } catch {
      await interaction.editReply({
        embeds: [card("Cannot Make Role", "I could not make the Breakthru role. I need Manage Roles, and the role has to sit below mine.", { guild: interaction.guild })],
        components: []
      });
      return true;
    }
    save(interaction.guild.id, role.id);
    recreated = true;
  } else {
    remember(interaction.guild.id, role.id);
  }
  await openCalls(interaction.guild, role.id);
  const member = interaction.guild.members.cache.get(parsed.targetId)
    || await interaction.guild.members.fetch(parsed.targetId).catch(() => null);
  if (!member) {
    await interaction.editReply({
      embeds: [card("Breakthru Role Made", `<@&${role.id}> is ready. That member is no longer in the server.`, { guild: interaction.guild })],
      components: []
    });
    return true;
  }
  try {
    await finish(interaction, member, role, { recreated });
  } catch {
    await interaction.editReply({
      embeds: [card("Cannot Assign Role", "I made the role, but I could not give it. It needs to be below my highest role.", { guild: interaction.guild })],
      components: []
    });
  }
  return true;
}

module.exports = {
  isAlias,
  allow,
  save,
  assign,
  handleInteraction
};
