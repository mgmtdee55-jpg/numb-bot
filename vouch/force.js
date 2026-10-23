const store = require("./store");
const access = require("../systems/access");
const logging = require("./logging");
const roles = require("./roles");
const { resolveMember, resolveRole, resolveUserId } = require("./resolve");
const { mentionUser } = require("./util");
const { embed, reply } = require("./ui");
const { replyUsage } = require("../usage");
const cooldowns = require("../systems/cooldowns");
const crypto = require("crypto");
const { ActionRowBuilder, AuditLogEvent, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits, StringSelectMenuBuilder } = require("discord.js");

const NICK_LIMIT = 32;

function usage(prefix) {
  return [
    `\`${prefix}forcenickname @user <nickname>\``,
    `\`${prefix}unforcenickname @user\``,
    `\`${prefix}forcerolestrip @user @role\``,
    `\`${prefix}forcestrip @user @role\` — block one user`,
    `\`${prefix}forcestrip @role\` — remove that role from everyone`,
    `\`${prefix}unforcerolestrip @user\``,
    `\`${prefix}unforcestrip @user\``,
    `\`${prefix}rolestrip @role\``,
    "",
    "Each force command has a **20 second** cooldown."
  ].join("\n");
}

function forceCooldown(message, action) {
  const wait = cooldowns.consume(message.guild.id, message.author.id, action);
  if (!wait) return null;
  return reply(message, "Please Wait", cooldowns.waitText(wait));
}

function panelRow(userId = "") {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`spanter:force:${userId}`)
      .setPlaceholder("Force Management")
      .addOptions(
        { label: "Overview", value: "overview", description: "What this panel controls" },
        { label: "Nickname", value: "nickname", description: "Force or clear a nickname" },
        { label: "Role Block", value: "block", description: "Stop one user from holding a role" },
        { label: "Role Strip", value: "strip", description: "Remove a role from everyone" }
      )
  );
}

function panelEmbed(prefix, section = "overview") {
  const pages = {
    overview: `Force Management\n\n${usage(prefix)}`,
    nickname: `\`${prefix}forcenickname @user <nickname>\`\nKeeps putting that nickname back if it changes.\n\n\`${prefix}unforcenickname @user\`\nStops enforcing it and clears the nickname.`,
    block: `\`${prefix}forcerolestrip @user @role\`\nAlias: \`${prefix}forcestrip @user @role\`\n\nThe user cannot hold that role. If they already have it, it is removed.\n\n\`${prefix}unforcerolestrip @user\`\nAlias: \`${prefix}unforcestrip @user\``,
    strip: `\`${prefix}rolestrip @role\`\nAlias: \`${prefix}forcestrip @role\`\n\nRemoves the role from everyone who currently has it. A menu lets you exempt members, then confirm. If the role is the vouch role, active vouches close for members who lose it.`
  };
  return embed("Force Management", pages[section] || pages.overview, true);
}

async function openPanel(message, prefix) {
  if (!access.canUseForce(message.member, "forcemanage")) {
    return reply(message, "Not Allowed", "Only Founders, Gods, and the server owner can use Force Management.");
  }
  return message.reply({ embeds: [panelEmbed(prefix)], components: [panelRow(message.author.id)] });
}

async function handleSelect(interaction, prefix) {
  const ownerId = String(interaction.customId || "").startsWith("spanter:force:")
    ? interaction.customId.slice("spanter:force:".length)
    : "";
  if (ownerId && interaction.user?.id && ownerId !== interaction.user.id) {
    await interaction.reply({
      embeds: [embed("Not Yours", "Only the person who opened this can change it.")],
      flags: MessageFlags.Ephemeral
    }).catch(() => null);
    return true;
  }
  const member = interaction.member;
  if (member && !member.guild && interaction.guild) member.guild = interaction.guild;
  if (!access.canUseForce(member, "forcemanage")) {
    await interaction.reply({
      embeds: [embed("Not Allowed", "Only Founders, Gods, and the server owner can use Force Management.")],
      flags: MessageFlags.Ephemeral
    });
    return true;
  }
  const section = interaction.values?.[0] || "overview";
  await interaction.update({ embeds: [panelEmbed(prefix, section)], components: [panelRow(ownerId || interaction.user?.id || "")] });
  return true;
}

async function forceNickname(message, userArg, nickname) {
  if (!access.canUseForce(message.member, "forcenickname")) return reply(message, "Not Allowed", "Only Founders, Gods, and the server owner can force nicknames.");
  if (!userArg || !String(nickname || "").trim()) return replyUsage(message, "forcenickname");
  const member = await resolveMember(message, userArg);
  if (!member || member.user?.bot) return replyUsage(message, "forcenickname");
  const forced = access.forceRefusal(message.member, member);
  if (forced) return reply(message, "Unable to Force", forced);
  const name = String(nickname || "").trim().replace(/\s+/g, " ");
  if (!name || name.length > NICK_LIMIT) {
    return reply(message, "Invalid Nickname", `Provide a nickname up to ${NICK_LIMIT} characters.`);
  }
  const wait = forceCooldown(message, "forcenickname");
  if (wait) return wait;
  store.setForcedNick(message.guild.id, member.id, name, message.author.id);
  try {
    await roles.applyNickname(member, name, `Forced nickname by ${message.author.id}`);
  } catch (error) {
    store.clearForcedNick(message.guild.id, member.id);
    return reply(message, "Nickname Failed", "I couldn't change that nickname. Check Manage Nicknames and my role position.");
  }
  await logging.record(message.guild, {
    action: "force_nick",
    actorId: message.author.id,
    targetId: member.id,
    reason: name
  });
  return reply(message, "Forced Nickname", `${mentionUser(member.id)} will keep the nickname **${name}**.`);
}

async function unforceNickname(message, userArg) {
  if (!access.canUseForce(message.member, "unforcenickname")) return reply(message, "Not Allowed", "Only Founders, Gods, and the server owner can clear forced nicknames.");
  const member = await resolveMember(message, userArg);
  const userId = member?.id || await resolveUserId(message, userArg);
  if (!userId) return replyUsage(message, "unforcenickname");
  const cleared = member && access.forceRefusal(message.member, member);
  if (cleared) return reply(message, "Unable to Force", cleared);
  if (!store.getForcedNick(message.guild.id, userId)) {
    return reply(message, "No Forced Nickname", "That user does not have a forced nickname.");
  }
  const wait = forceCooldown(message, "unforcenickname");
  if (wait) return wait;
  store.clearForcedNick(message.guild.id, userId);
  if (member?.setNickname) {
    try {
      await roles.applyNickname(member, null, `Forced nickname cleared by ${message.author.id}`);
    } catch (error) {
      await logging.record(message.guild, {
        action: "force_nick_clear",
        actorId: message.author.id,
        targetId: userId,
        reason: "Force removed; nickname could not be reset"
      });
      return reply(message, "Forced Nickname Removed", "The force was removed, but I could not reset the current nickname.");
    }
  }
  await logging.record(message.guild, {
    action: "force_nick_clear",
    actorId: message.author.id,
    targetId: userId,
    reason: "Forced nickname removed"
  });
  return reply(message, "Forced Nickname Removed", "That user can change their nickname again.");
}

async function forceRoleStrip(message, userArg, roleArg) {
  if (!access.canUseForce(message.member, "forcerolestrip")) return reply(message, "Not Allowed", "Only Founders, Gods, and the server owner can block roles.");
  const member = await resolveMember(message, userArg);
  const role = await resolveRole(message, roleArg);
  if (!member || member.user?.bot || !role) return replyUsage(message, "forcestrip");
  if (!role || role.id === message.guild.id) return reply(message, "Invalid Role", "Mention a role, role ID, or role name.");
  const blocked = access.forceRefusal(message.member, member);
  if (blocked) return reply(message, "Unable to Force", blocked);
  const wait = forceCooldown(message, "forcerolestrip");
  if (wait) return wait;
  store.addForcedRoleStrip(message.guild.id, member.id, role.id, message.author.id);
  if (member.roles.cache.has(role.id)) {
    if (store.getConfig(message.guild.id).vouch_role_id === role.id) {
      store.deactivateVouch(message.guild.id, member.id, message.author.id, "Forced role strip");
    }
    try {
      await roles.removeRole(member, role, `Forced role strip by ${message.author.id}`);
    } catch (error) {
      return reply(message, "Role Blocked", `The block is saved, but I could not remove ${role.name} right now.`);
    }
  }
  await logging.record(message.guild, {
    action: "force_role_strip",
    actorId: message.author.id,
    targetId: member.id,
    reason: `Blocked from ${role.name}`,
    details: { roleId: role.id }
  });
  return reply(message, "Role Blocked", `${mentionUser(member.id)} cannot receive **${role.name}**.`);
}

async function unforceRoleStrip(message, userArg) {
  if (!access.canUseForce(message.member, "unforcerolestrip")) return reply(message, "Not Allowed", "Only Founders, Gods, and the server owner can clear role blocks.");
  const userId = await resolveUserId(message, userArg);
  if (!userId) return replyUsage(message, "unforcerolestrip");
  const member = await resolveMember(message, userArg);
  const cleared = member && access.forceRefusal(message.member, member);
  if (cleared) return reply(message, "Unable to Force", cleared);
  const existing = store.listForcedRoleStrips(message.guild.id, userId);
  if (!existing.length) {
    return reply(message, "No Role Blocks", "That user has no forced role strips.");
  }
  const wait = forceCooldown(message, "unforcerolestrip");
  if (wait) return wait;
  if (!store.clearForcedRoleStrips(message.guild.id, userId)) {
    return reply(message, "No Role Blocks", "That user has no forced role strips.");
  }
  await logging.record(message.guild, {
    action: "force_role_strip_clear",
    actorId: message.author.id,
    targetId: userId,
    reason: `Cleared ${existing.length} role block(s)`
  });
  return reply(message, "Role Blocks Cleared", `Removed **${existing.length}** role block(s). Those roles were not given back.`);
}

function heldFor(since, now = Date.now()) {
  if (!since) return "not in the audit log";
  const minutes = Math.floor(Math.max(0, now - since) / 60000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

function grantFrom(entry) {
  const executor = entry.executor || {};
  return {
    at: entry.createdTimestamp || 0,
    executorId: String(entry.executorId || executor.id || "").trim(),
    executorBot: executor.bot === true,
    executorName: String(executor.globalName || executor.username || executor.tag || "").trim()
  };
}

async function roleGrants(guild, roleId) {
  const grants = new Map();
  if (typeof guild.fetchAuditLogs !== "function") return grants;
  let before;
  for (let page = 0; page < 5; page += 1) {
    const logs = await guild.fetchAuditLogs({
      type: AuditLogEvent.MemberRoleUpdate,
      limit: 100,
      ...(before ? { before } : {})
    }).catch(() => null);
    const entries = [...(logs?.entries?.values?.() || [])];
    if (!entries.length) break;
    for (const entry of entries) {
      const targetId = entry.targetId || entry.target?.id;
      const added = (entry.changes || []).some((change) => change.key === "$add" && (change.new || []).some((role) => role.id === roleId));
      if (added && targetId && !grants.has(targetId)) grants.set(String(targetId), grantFrom(entry));
    }
    before = entries.at(-1)?.id;
    if (entries.length < 100 || !before) break;
  }
  return grants;
}

function personRef(id, name) {
  const clean = String(id || "").trim();
  if (/^\d{15,22}$/.test(clean)) return `<@${clean}>`;
  const label = String(name || "").replace(/[\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return label || "Unknown";
}

function giverLine(grant) {
  const who = personRef(grant?.executorId, grant?.executorName);
  if (!grant || who === "Unknown") return "Giver unknown";
  return grant.executorBot ? `Given by bot ${who}` : `Given manually by ${who}`;
}

function heldLine(grant) {
  if (!grant?.at) return "Held for unknown";
  return `Held for ${heldFor(grant.at)}`;
}

function transcriptHeader(role, actorId, removedCount, failed, keptIds) {
  const lines = [
    `**${role.name}** removed from **${removedCount}** ${removedCount === 1 ? "person" : "people"}.`,
    `Stripped by ${personRef(actorId)}`
  ];
  if (failed) lines.push(`Could not remove it from **${failed}**.`);
  if (keptIds.length) {
    const shown = keptIds.slice(0, 15).map((id) => personRef(id));
    const more = keptIds.length > 15 ? `, and **${keptIds.length - 15}** more` : "";
    lines.push(`Kept on ${shown.join(", ")}${more}.`);
  }
  return lines.join("\n");
}

function packBlocks(header, entries) {
  const blocks = [];
  let current = header;
  for (const entry of entries) {
    const next = `${current}\n\n${entry}`;
    if (next.length > 3800) {
      blocks.push(current);
      current = entry;
    } else {
      current = next;
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function administrators(guild) {
  const people = [];
  const seen = new Set();
  for (const member of guild.members?.cache?.values?.() || []) {
    if (!member?.id || member.user?.bot || seen.has(member.id)) continue;
    const admin = [...(member.roles?.cache?.values?.() || [])].some((role) => {
      return role && role.id !== guild.id && role.permissions?.has?.(PermissionFlagsBits.Administrator) === true;
    });
    if (!admin) continue;
    seen.add(member.id);
    people.push(member);
  }
  return people.slice(0, 20);
}

async function deliverDM(member, payload) {
  const send = typeof member.send === "function"
    ? member.send.bind(member)
    : (typeof member.user?.send === "function" ? member.user.send.bind(member.user) : null);
  if (!send) return;
  await send(payload).catch((error) => {
    console.error("[role strip dm]", error?.code || error?.message || error);
  });
}

async function notifyStripAdmins(guild, role, actorId, removed, grants, keptIds, failed, admins) {
  if (!removed.length || !admins.length) return;
  const header = transcriptHeader(role, actorId, removed.length, failed, keptIds);
  const entries = removed.map((member) => [
    personRef(member.id, memberLabel(member)),
    heldLine(grants.get(member.id)),
    giverLine(grants.get(member.id))
  ].join("\n"));
  const blocks = packBlocks(header, entries);
  let sent = 0;
  for (const admin of admins) {
    for (const block of blocks) {
      if (sent > 0 && process.env.npm_lifecycle_event !== "test" && !process.env.NODE_TEST_CONTEXT) {
        await require("./util").sleep(1100);
      }
      await deliverDM(admin, {
        embeds: [embed("Role Stripped", block, { guild })],
        allowedMentions: { parse: [] }
      });
      sent += 1;
    }
  }
}

const PAGE_SIZE = 25;
const STRIP_TTL_MS = 5 * 60 * 1000;
const pendingStrips = new Map();
const STRIP_ID = /^spanter:rolestrip:([a-f0-9]{16}):(exempt|confirm|cancel|prev|next)$/;

function stripToken() {
  return crypto.randomBytes(8).toString("hex");
}

function memberLabel(member) {
  const raw = member.displayName || member.nickname || member.user?.globalName || member.user?.username || member.id;
  const label = String(raw).replace(/[\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  return label || String(member.id);
}

function holdersOf(guild, roleId) {
  return [...(guild.members?.cache?.values?.() || [])]
    .filter((member) => member.roles?.cache?.has?.(roleId))
    .sort((left, right) => memberLabel(left).localeCompare(memberLabel(right), "en", { sensitivity: "base" }) || String(left.id).localeCompare(String(right.id)));
}

async function loadHolders(guild) {
  if (typeof guild.members?.fetch === "function" && (guild.memberCount || 0) <= 2000) {
    await guild.members.fetch().catch(() => null);
  }
  return true;
}

function pruneStrips(now = Date.now()) {
  for (const [token, pending] of pendingStrips) {
    if (now - pending.createdAt > STRIP_TTL_MS) pendingStrips.delete(token);
  }
}

function dropActorStrips(guildId, actorId) {
  for (const [token, pending] of pendingStrips) {
    if (pending.guildId === guildId && pending.actorId === actorId) pendingStrips.delete(token);
  }
}

function keepingLine(ids) {
  if (!ids.length) return "Keeping it: nobody yet. Confirm removes it from everyone.";
  const shown = ids.slice(0, 15).map((id) => `<@${id}>`).join(", ");
  const more = ids.length > 15 ? `, and **${ids.length - 15}** more` : "";
  return `Keeping it: ${shown}${more}`;
}

function keptSentence(role, ids) {
  if (!ids.length) return "";
  const shown = ids.slice(0, 15).map((id) => `<@${id}>`).join(", ");
  const more = ids.length > 15 ? `, and **${ids.length - 15}** more` : "";
  return ` Kept **${role.name}** on ${shown}${more}.`;
}

function stripView(guild, pending, role) {
  const holders = holdersOf(guild, pending.roleId);
  if (!holders.length) return null;
  const pages = Math.ceil(holders.length / PAGE_SIZE);
  pending.page = Math.min(Math.max(0, pending.page), pages - 1);
  const slice = holders.slice(pending.page * PAGE_SIZE, (pending.page + 1) * PAGE_SIZE);
  const holding = new Set(holders.map((member) => member.id));
  for (const id of [...pending.exempt]) {
    if (!holding.has(id)) pending.exempt.delete(id);
  }
  const exemptIds = holders.filter((member) => pending.exempt.has(member.id)).map((member) => member.id);
  const body = [
    `**${role.name}** is on **${holders.length}** member${holders.length === 1 ? "" : "s"}.`,
    "Select who should keep the role, then press **Confirm**.",
    keepingLine(exemptIds)
  ];
  if (pages > 1) body.push(`Page **${pending.page + 1}**/**${pages}**`);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`spanter:rolestrip:${pending.token}:exempt`)
    .setPlaceholder("Exempt users")
    .setMinValues(0)
    .setMaxValues(slice.length);
  for (const member of slice) {
    const option = {
      label: memberLabel(member),
      value: member.id,
      description: "Keeps this role"
    };
    if (pending.exempt.has(member.id)) option.default = true;
    menu.addOptions(option);
  }
  const buttons = [
    new ButtonBuilder().setCustomId(`spanter:rolestrip:${pending.token}:confirm`).setLabel("Confirm").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`spanter:rolestrip:${pending.token}:cancel`).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
  ];
  if (pages > 1) {
    buttons.push(
      new ButtonBuilder().setCustomId(`spanter:rolestrip:${pending.token}:prev`).setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(pending.page <= 0),
      new ButtonBuilder().setCustomId(`spanter:rolestrip:${pending.token}:next`).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(pending.page >= pages - 1)
    );
  }
  return {
    pageIds: new Set(slice.map((member) => member.id)),
    payload: {
      embeds: [embed("Role Strip", body.join("\n"), { guild })],
      components: [
        new ActionRowBuilder().addComponents(menu),
        new ActionRowBuilder().addComponents(buttons)
      ],
      allowedMentions: { parse: [] }
    }
  };
}

function privateReply(interaction, title, description) {
  return interaction.reply({
    embeds: [embed(title, description, { guild: interaction.guild })],
    flags: MessageFlags.Ephemeral
  }).catch(() => null);
}

function closeStrip(interaction, title, description) {
  return interaction.update({
    embeds: [embed(title, description, { guild: interaction.guild })],
    components: [],
    allowedMentions: { parse: [] }
  });
}

async function removeRoleFromHolders(guild, actorId, role, exempt) {
  await loadHolders(guild);
  const holders = holdersOf(guild, role.id);
  const grants = await roleGrants(guild, role.id);
  const admins = administrators(guild);
  const vouchRole = store.getConfig(guild.id).vouch_role_id === role.id;
  const removedMembers = [];
  const keptIds = [];
  let failed = 0;
  let closed = 0;
  for (const member of holders) {
    if (exempt.has(member.id)) {
      keptIds.push(member.id);
      continue;
    }
    if (vouchRole && store.deactivateVouch(guild.id, member.id, actorId, "rolestrip")) closed += 1;
    try {
      await roles.withRateLimit(() => roles.removeRole(member, role, `Role strip by ${actorId}`));
      removedMembers.push(member);
    } catch (error) {
      failed += 1;
    }
  }
  await logging.record(guild, {
    action: "role_strip",
    actorId,
    targetId: role.id,
    reason: `Stripped ${role.name} from ${removedMembers.length} member(s)`,
    details: { removed: removedMembers.length, failed, closed, kept: keptIds.length }
  });
  await notifyStripAdmins(guild, role, actorId, removedMembers, grants, keptIds, failed, admins).catch(() => null);
  if (!holders.length) return [`**${role.name}** is not on anyone right now.`];
  const vouchNote = vouchRole ? ` Closed **${closed}** active vouch(es).` : "";
  const failedNote = failed ? ` ${failed} failed.` : "";
  const lines = removedMembers.map((member) => `<@${member.id}> — ${heldFor(grants.get(member.id)?.at)}`);
  let summary = `Removed **${role.name}** from **${removedMembers.length}** member(s).${failedNote}${keptSentence(role, keptIds)}${vouchNote}`;
  const blocks = [];
  for (const line of lines) {
    const next = `${summary}\n${line}`;
    if (next.length > 3800) {
      blocks.push(summary);
      summary = line;
    } else {
      summary = next;
    }
  }
  blocks.push(summary);
  return blocks;
}

async function showStripResult(interaction, blocks) {
  const guild = interaction.guild;
  const first = {
    embeds: [embed("Role Stripped", blocks[0], { guild })],
    components: [],
    allowedMentions: { parse: [] }
  };
  let shown = false;
  if (typeof interaction.message?.edit === "function") {
    try {
      await interaction.message.edit(first);
      shown = true;
    } catch (error) {
      shown = false;
    }
  }
  if (!shown && typeof interaction.followUp === "function") await interaction.followUp(first);
  for (const extra of blocks.slice(1)) {
    const payload = {
      embeds: [embed("Role Stripped", extra, { guild })],
      allowedMentions: { parse: [] }
    };
    if (typeof interaction.followUp === "function") await interaction.followUp(payload);
    else if (typeof interaction.channel?.send === "function") await interaction.channel.send(payload);
  }
}

async function resolveStripRole(guild, roleId) {
  const cached = guild.roles?.cache?.get(roleId);
  if (cached) return cached;
  if (typeof guild.roles?.fetch !== "function") return null;
  return guild.roles.fetch(roleId).catch(() => null);
}

async function stripRoleFromEveryone(message, roleArg) {
  if (!access.canUseForce(message.member, "rolestrip")) return reply(message, "Not Allowed", "Only Founders, Gods, and the server owner can strip a role from everyone.");
  const role = await resolveRole(message, roleArg);
  if (!role) return replyUsage(message, "rolestrip");
  if (role.id === message.guild.id || role.managed) return reply(message, "Invalid Role", "Choose a normal server role.");
  if (!roles.botCanManageRole(message.guild, role)) {
    return reply(message, "Cannot Manage Role", "Move my role above that role and grant me Manage Roles.");
  }
  await loadHolders(message.guild);
  if (!holdersOf(message.guild, role.id).length) {
    return reply(message, "Role Strip", `**${role.name}** is not on anyone right now.`);
  }
  const wait = forceCooldown(message, "rolestrip");
  if (wait) return wait;
  pruneStrips();
  dropActorStrips(message.guild.id, message.author.id);
  const pending = {
    token: stripToken(),
    guildId: message.guild.id,
    actorId: message.author.id,
    roleId: role.id,
    exempt: new Set(),
    page: 0,
    running: false,
    createdAt: Date.now()
  };
  pendingStrips.set(pending.token, pending);
  try {
    return await message.reply(stripView(message.guild, pending, role).payload);
  } catch (error) {
    pendingStrips.delete(pending.token);
    throw error;
  }
}

async function handleStripInteraction(interaction) {
  const parsed = String(interaction.customId || "").match(STRIP_ID);
  if (!parsed) return false;
  pruneStrips();
  const token = parsed[1];
  const action = parsed[2];
  const pending = pendingStrips.get(token);
  const guildId = interaction.guildId || interaction.guild?.id;
  if (!pending || pending.guildId !== guildId) {
    await privateReply(interaction, "Expired", "That role strip expired. Run it again.");
    return true;
  }
  if (pending.actorId !== interaction.user?.id) {
    await privateReply(interaction, "Not Yours", "Only the person who ran this can change it.");
    return true;
  }
  const member = interaction.member;
  if (member && !member.guild && interaction.guild) member.guild = interaction.guild;
  if (!access.canUseForce(member, "rolestrip")) {
    pendingStrips.delete(token);
    await closeStrip(interaction, "Not Allowed", "Only Founders, Gods, and the server owner can strip a role from everyone.").catch(() => null);
    return true;
  }
  if (pending.running) {
    await privateReply(interaction, "Role Strip", "That strip is already running.");
    return true;
  }
  const role = await resolveStripRole(interaction.guild, pending.roleId);
  if (!role || role.id === interaction.guild.id || role.managed) {
    pendingStrips.delete(token);
    await closeStrip(interaction, "Invalid Role", "That role is no longer available.").catch(() => null);
    return true;
  }
  if (action === "cancel") {
    pendingStrips.delete(token);
    await closeStrip(interaction, "Role Strip Cancelled", `Nobody lost **${role.name}**.`);
    return true;
  }
  if (action === "prev" || action === "next") {
    const pages = Math.max(1, Math.ceil(holdersOf(interaction.guild, pending.roleId).length / PAGE_SIZE));
    pending.page = action === "prev" ? Math.max(0, pending.page - 1) : Math.min(pages - 1, pending.page + 1);
    const view = stripView(interaction.guild, pending, role);
    if (!view) {
      pendingStrips.delete(token);
      await closeStrip(interaction, "Role Strip", `**${role.name}** is not on anyone right now.`);
      return true;
    }
    await interaction.update(view.payload);
    return true;
  }
  if (action === "exempt") {
    const current = stripView(interaction.guild, pending, role);
    if (!current) {
      pendingStrips.delete(token);
      await closeStrip(interaction, "Role Strip", `**${role.name}** is not on anyone right now.`);
      return true;
    }
    const selected = new Set((interaction.values || []).map(String));
    for (const id of current.pageIds) {
      if (selected.has(id)) pending.exempt.add(id);
      else pending.exempt.delete(id);
    }
    await interaction.update(stripView(interaction.guild, pending, role).payload);
    return true;
  }
  if (!roles.botCanManageRole(interaction.guild, role)) {
    await privateReply(interaction, "Cannot Manage Role", "Move my role above that role and grant me Manage Roles.");
    return true;
  }
  pending.running = true;
  try {
    await interaction.update({
      embeds: [embed("Role Strip", "currently taking all members from this role my boy, ill update ya when done.", { guild: interaction.guild })],
      components: []
    });
  } catch (error) {
    pending.running = false;
    throw error;
  }
  const exempt = new Set(pending.exempt);
  pendingStrips.delete(token);
  const blocks = await removeRoleFromHolders(interaction.guild, interaction.user.id, role, exempt);
  await showStripResult(interaction, blocks);
  return true;
}

async function dispatchForceStrip(message, first, second) {
  if (!first) return replyUsage(message, "forcestrip");
  if (second) return forceRoleStrip(message, first, second);
  const role = await resolveRole(message, first);
  const member = await resolveMember(message, first);
  if (role && !member) return stripRoleFromEveryone(message, first);
  return replyUsage(message, "forcestrip");
}

module.exports = {
  usage,
  openPanel,
  handleSelect,
  panelEmbed,
  forceNickname,
  unforceNickname,
  forceRoleStrip,
  unforceRoleStrip,
  stripRoleFromEveryone,
  handleStripInteraction,
  dispatchForceStrip
};
