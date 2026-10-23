const {
  ActionRowBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits
} = require("discord.js");
const { connection } = require("./db");
const access = require("./systems/access");
const roles = require("./vouch/roles");
const { embed, reply } = require("./vouch/ui");
const { replyUsage } = require("./usage");
const { resolveMember, resolveRole } = require("./vouch/resolve");

const STALE_MS = 20000;
const claims = new Set();

connection.exec(`
CREATE TABLE IF NOT EXISTS verified_sellers (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  added_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE IF NOT EXISTS verified_seller_config (
  guild_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS verified_seller_givers (
  guild_id TEXT NOT NULL,
  command TEXT NOT NULL,
  PRIMARY KEY (guild_id, command)
);
`);

const statements = {
  role: connection.prepare("SELECT role_id FROM verified_seller_config WHERE guild_id=?"),
  setRole: connection.prepare(`
    INSERT INTO verified_seller_config (guild_id, role_id) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET role_id=excluded.role_id
  `),
  add: connection.prepare(`
    INSERT INTO verified_sellers (guild_id, user_id, added_by, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET added_by=excluded.added_by, created_at=excluded.created_at
  `),
  remove: connection.prepare("DELETE FROM verified_sellers WHERE guild_id=? AND user_id=?"),
  has: connection.prepare("SELECT 1 FROM verified_sellers WHERE guild_id=? AND user_id=?"),
  list: connection.prepare("SELECT user_id, added_by FROM verified_sellers WHERE guild_id=? ORDER BY created_at"),
  give: connection.prepare("INSERT OR REPLACE INTO verified_seller_givers (guild_id, command) VALUES (?, ?)"),
  take: connection.prepare("DELETE FROM verified_seller_givers WHERE guild_id=? AND command=?"),
  canGive: connection.prepare("SELECT 1 FROM verified_seller_givers WHERE guild_id=? AND command=?"),
  givers: connection.prepare("SELECT command FROM verified_seller_givers WHERE guild_id=? ORDER BY command")
};

function roleId(guildId) {
  return statements.role.get(String(guildId))?.role_id || null;
}

function isSeller(member) {
  if (!member?.guild || !member.id) return false;
  const configured = roleId(member.guild.id);
  if (configured && member.roles?.cache?.has?.(configured)) return true;
  return !!statements.has.get(String(member.guild.id), String(member.id));
}

function canGive(guildId, command) {
  const name = access.canonicalCommand(command);
  if (!name) return false;
  return !!statements.canGive.get(String(guildId), name);
}

function canManage(member) {
  return access.isServerOwner(member) || access.isGod(member);
}

function deny(message) {
  return reply(message, "Access Denied", "Only CEOs and the server owner can manage Verified Sellers.");
}

function botId(guild) {
  return String(guild?.client?.user?.id || guild?.members?.me?.id || "");
}

function executorId(entry) {
  return entry?.executorId || entry?.executor?.id || null;
}

function targetId(entry) {
  return entry?.targetId || entry?.target?.id || null;
}

function changesOf(entry) {
  const changes = entry?.changes;
  if (!changes) return [];
  if (Array.isArray(changes)) return changes;
  if (typeof changes[Symbol.iterator] === "function") return [...changes];
  return [];
}

function roleIds(change) {
  const list = change?.new || change?.new_value || change?.newValue || [];
  return (Array.isArray(list) ? list : []).map((role) => String(role?.id || role)).filter(Boolean);
}

async function fetchMember(guild, id) {
  if (!guild || !id) return null;
  const cached = guild.members?.cache?.get?.(String(id));
  if (cached) return cached;
  if (typeof guild.members?.fetch !== "function") return null;
  return guild.members.fetch(String(id)).catch(() => null);
}

async function liveRole(guild) {
  const id = roleId(guild.id);
  if (!id) return null;
  return guild.roles?.cache?.get?.(id) || await guild.roles?.fetch?.(id).catch(() => null) || null;
}

async function sendDM(user, content) {
  if (!user) return;
  const send = user.send?.bind(user) || user.user?.send?.bind(user.user);
  if (!send) return;
  await send({ content, allowedMentions: { parse: [] } }).catch((error) => {
    console.error("[verified seller dm]", error?.code || error?.message || error);
  });
}

function remember(guildId, userId, addedBy) {
  statements.add.run(String(guildId), String(userId), addedBy ? String(addedBy) : null, Date.now());
}

async function moveSellers(guild, previousId, nextRole) {
  if (!previousId || previousId === nextRole.id) return;
  for (const row of statements.list.all(String(guild.id))) {
    const member = await fetchMember(guild, row.user_id);
    if (!member) continue;
    await roles.removeRole(member, previousId, "Verified Seller role changed").catch(() => null);
    await roles.addRole(member, nextRole, "Verified Seller role changed").catch(() => null);
  }
}

async function assign(guild, member, actorId) {
  const role = await liveRole(guild);
  if (!role) return null;
  await roles.addRole(member, role, "Verified Seller");
  remember(guild.id, member.id, actorId);
  return role;
}

function status(message, prefix) {
  const configured = roleId(message.guild.id);
  const people = statements.list.all(String(message.guild.id));
  const commands = statements.givers.all(String(message.guild.id));
  return reply(message, "Verified Seller", [
    configured ? `**Role:** <@&${configured}>` : `No role is set. Use \`${prefix}verifiedseller @role\`, or add someone and create one.`,
    `**Sellers:** ${people.length ? people.map((row) => `<@${row.user_id}>`).join(", ") : "none"}`,
    `**Commands they can grant:** ${commands.length ? commands.map((row) => `\`${prefix}${row.command}\``).join(", ") : "none"}`,
    "",
    "Verified Sellers can assign VC ranks and protect a role.",
    `Use \`${prefix}verifiedseller addgiver <command>\` before they can \`${prefix}grant\` that command.`
  ].join("\n"));
}

function askForRole(message, target) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`spanter:seller:create:${message.author.id}:${target.id}`)
      .setLabel("Create role")
      .setStyle(ButtonStyle.Primary)
  );
  return message.reply({
    embeds: [embed(
      "Verified Seller Role",
      `No Verified Seller role is set. Only one role can be used.\nSet it with \`-verifiedseller @role\`, or create one and give it to <@${target.id}>.`,
      { guild: message.guild }
    )],
    components: [row]
  });
}

async function setConfiguredRole(message, role) {
  if (!role || role.id === message.guild.id || role.managed) {
    return reply(message, "Invalid Role", "Choose a normal server role the bot can manage.");
  }
  const previous = roleId(message.guild.id);
  if (previous === role.id) return reply(message, "Verified Seller", `<@&${role.id}> is already the Verified Seller role.`);
  statements.setRole.run(String(message.guild.id), String(role.id));
  await moveSellers(message.guild, previous, role);
  const replaced = previous ? `\n<@&${previous}> is no longer the Verified Seller role.` : "";
  return reply(message, "Verified Seller Role Set", `The Verified Seller role is <@&${role.id}>. Only one role can be set.${replaced}`);
}

async function handleCommand(message, name, args, prefix) {
  if (name !== "verifiedseller") return false;
  if (!canManage(message.member)) return deny(message);
  const sub = String(args[1] || "").trim().toLowerCase();
  if (!sub || sub === "list" || sub === "ls") return status(message, prefix);
  if (sub === "add") {
    const member = await resolveMember(message, args[2]);
    if (!member) return replyUsage(message, "verifiedselleradd");
    if (member.user?.bot) return reply(message, "Invalid Target", "Bots cannot be verified sellers.");
    if (member.id === message.guild.ownerId) return reply(message, "Server Owner", "The server owner already outranks Verified Seller.");
    const role = await liveRole(message.guild);
    if (!role) return askForRole(message, member);
    await assign(message.guild, member, message.author.id);
    return reply(message, "Verified Seller Added", `<@${member.id}> is a Verified Seller with <@&${role.id}>.`);
  }
  if (sub === "remove") {
    const member = await resolveMember(message, args[2]);
    if (!member) return replyUsage(message, "verifiedsellerremove");
    const configured = roleId(message.guild.id);
    const hadRole = !!(configured && member.roles?.cache?.has?.(configured));
    const hadRow = !!statements.has.get(String(message.guild.id), String(member.id));
    if (!hadRole && !hadRow) return reply(message, "Not a Seller", `<@${member.id}> is not a verified seller.`);
    if (configured) await roles.removeRole(member, configured, "Verified Seller removed").catch(() => null);
    statements.remove.run(String(message.guild.id), String(member.id));
    return reply(message, "Verified Seller Removed", `<@${member.id}> is no longer a verified seller.`);
  }
  if (sub === "addgiver" || sub === "removegiver") {
    const command = access.canonicalCommand(args.slice(2).join(" "));
    if (!command) return replyUsage(message, sub === "addgiver" ? "verifiedselleraddgiver" : "verifiedsellerremovegiver");
    if (!access.isGrantable(command)) {
      return reply(message, "Unknown Command", `That command cannot be granted on its own.\n\n${access.grantHelp(prefix)}`);
    }
    if (sub === "removegiver") {
      const removed = statements.take.run(String(message.guild.id), command);
      if (!removed.changes) return reply(message, "Not Authorized", `Verified Sellers cannot grant \`${prefix}${command}\`.`);
      return reply(message, "Grant Closed", `Verified Sellers can no longer grant \`${prefix}${command}\`.`);
    }
    statements.give.run(String(message.guild.id), command);
    return reply(message, "Grant Opened", `Verified Sellers can now \`${prefix}grant ${command} @user\`.`);
  }
  const role = await resolveRole(message, args.slice(1).join(" "));
  if (!role) return replyUsage(message, "verifiedseller");
  return setConfiguredRole(message, role);
}

async function handleInteraction(interaction) {
  const id = String(interaction?.customId || "");
  if (!id.startsWith("spanter:seller:")) return false;
  const [, , action, actorId, targetId] = id.split(":");
  if (actorId && interaction.user?.id && actorId !== interaction.user.id) {
    await interaction.reply({
      embeds: [embed("Not Yours", "Only the person who opened this can use it.")],
      flags: 64
    }).catch(() => null);
    return true;
  }
  if (action !== "create") return true;
  const member = interaction.member;
  if (!canManage(member)) {
    await interaction.reply({
      embeds: [embed("Access Denied", "Only CEOs and the server owner can manage Verified Sellers.")],
      flags: 64
    }).catch(() => null);
    return true;
  }
  const guild = interaction.guild;
  let role = await liveRole(guild);
  if (!role) {
    if (typeof guild.roles?.create !== "function") {
      await interaction.reply({
        embeds: [embed("Unable to Create", "The bot could not create a role. Set one with `-verifiedseller @role`.")],
        flags: 64
      }).catch(() => null);
      return true;
    }
    role = await guild.roles.create({
      name: "Verified Seller",
      permissions: [],
      reason: "Verified Seller role"
    }).catch(() => null);
    if (!role) {
      await interaction.reply({
        embeds: [embed("Unable to Create", "The bot needs Manage Roles to create the Verified Seller role.")],
        flags: 64
      }).catch(() => null);
      return true;
    }
    statements.setRole.run(String(guild.id), String(role.id));
  }
  const target = await fetchMember(guild, targetId);
  if (!target || target.user?.bot) {
    await interaction.update({
      embeds: [embed("Verified Seller Role Set", `The role is <@&${role.id}>. The member could not be updated.`, { guild })],
      components: []
    }).catch(() => null);
    return true;
  }
  await roles.addRole(target, role, "Verified Seller").catch(() => null);
  remember(guild.id, target.id, interaction.user.id);
  await interaction.update({
    embeds: [embed("Verified Seller Added", `<@${target.id}> is a Verified Seller with <@&${role.id}>.`, { guild })],
    components: []
  }).catch(() => null);
  return true;
}

function allowedGiver(guild, member, executor) {
  if (!executor) return false;
  if (String(executor) === botId(guild)) return true;
  if (!member) return false;
  return access.isServerOwner(member) || access.isGod(member);
}

async function isBotActor(guild, entry, member, executor) {
  if (!executor) return false;
  if (String(executor) === botId(guild)) return true;
  if (entry?.executor?.bot || member?.user?.bot) return true;
  const cached = guild.client?.users?.cache?.get?.(String(executor));
  if (cached?.bot) return true;
  const fetched = await guild.client?.users?.fetch?.(String(executor)).catch(() => null);
  return !!fetched?.bot;
}

async function notifyAdmins(guild, skipId, content) {
  const seen = new Set();
  const members = [];
  const owner = await fetchMember(guild, guild.ownerId);
  if (owner) members.push(owner);
  for (const member of guild.members?.cache?.values?.() || []) {
    if (member.permissions?.has?.(PermissionFlagsBits.Administrator) || String(member.id) === String(guild.ownerId)) {
      members.push(member);
    }
  }
  let sent = 0;
  for (const member of members) {
    if (!member?.id || seen.has(String(member.id)) || String(member.id) === String(skipId) || member.user?.bot) continue;
    seen.add(String(member.id));
    if (sent >= 20) break;
    if (sent > 0 && process.env.npm_lifecycle_event !== "test" && !process.env.NODE_TEST_CONTEXT) {
      await require("./vouch/util").sleep(1100);
    }
    await sendDM(member, content);
    sent += 1;
  }
}

async function noteBot(guild, entry, action) {
  const started = Date.now();
  const removing = action === "remove";
  const executor = executorId(entry);
  const target = targetId(entry);
  const claim = `bot:${guild.id}:${entry.id || `${executor}:${target}`}:${action}`;
  if (claims.has(claim)) return;
  claims.add(claim);
  await notifyAdmins(guild, executor, [
    `Verified Seller role was ${removing ? "removed" : "given"} by a bot.`,
    `Who: <@${executor}>`,
    `To: <@${target}>`,
    "Punishment: none. Bots are not kicked or removed for this.",
    "A CEO or the server owner needs to change this role by hand if it should not stay.",
    `Response time: ${Date.now() - started}ms`
  ].join("\n"));
}

async function punish(guild, entry, roleId, action) {
  const started = Date.now();
  const removing = action === "remove";
  const executor = executorId(entry);
  const target = targetId(entry);
  const claim = `${guild.id}:${entry.id || `${executor}:${target}`}:${roleId}:${action}`;
  if (claims.has(claim)) return;
  claims.add(claim);
  const recipient = await fetchMember(guild, target);
  if (removing) {
    if (recipient?.roles?.add) {
      await recipient.roles.add(roleId, "Verified Seller role was removed without permission").catch(() => null);
    } else if (recipient?.roles?.cache?.set) {
      recipient.roles.cache.set(String(roleId), { id: String(roleId) });
    }
    remember(guild.id, target, null);
  } else if (recipient?.roles?.remove) {
    await recipient.roles.remove(roleId, "Verified Seller role was given without permission").catch(() => null);
    statements.remove.run(String(guild.id), String(target));
  } else if (recipient?.roles?.cache?.delete) {
    recipient.roles.cache.delete(roleId);
    statements.remove.run(String(guild.id), String(target));
  } else {
    statements.remove.run(String(guild.id), String(target));
  }
  const giver = await fetchMember(guild, executor);
  const elapsed = () => Date.now() - started;
  const verb = removing ? "remove" : "give";
  if (!executor || String(executor) === botId(guild)) {
    await notifyAdmins(guild, null, [
      `Verified Seller role was ${removing ? "removed" : "given"} without a confirmed CEO or server owner.`,
      "Who: unknown",
      `To: <@${target}>`,
      `Punishment: ${removing ? "put the role back" : "removed the role"}. Nobody was kicked because the member could not be confirmed.`,
      `Response time: ${elapsed()}ms`
    ].join("\n"));
    return;
  }
  const same = String(executor) === String(target);
  const why = removing
    ? `You were kicked from ${guild.name || "the server"}.\nYou ${same ? "removed your own" : `removed <@${target}>'s`} Verified Seller role.\nOnly CEOs and the server owner can ${verb} that role. The role was put back and you were kicked.`
    : `You were kicked from ${guild.name || "the server"}.\nYou ${same ? "gave yourself" : `gave <@${target}>`} the Verified Seller role.\nOnly CEOs and the server owner can ${verb} that role. The role was removed and you were kicked.`;
  await sendDM(giver, why);
  let kicked = false;
  const protectedGiver = String(executor) === String(guild.ownerId);
  if (!protectedGiver && typeof guild.members?.kick === "function") {
    kicked = await guild.members.kick(
      executor,
      removing
        ? "Removed the Verified Seller role without being a CEO or the server owner"
        : "Gave the Verified Seller role without being a CEO or the server owner"
    ).then(() => true).catch(() => false);
  }
  const ms = elapsed();
  const punishment = kicked
    ? `kicked <@${executor}> and ${removing ? `put the role back on <@${target}>` : `removed the role from <@${target}>`}`
    : `${removing ? `put the role back on <@${target}>` : `removed the role from <@${target}>`}; the kick did not go through`;
  await notifyAdmins(guild, executor, [
    `Verified Seller role was ${removing ? "removed" : "given"} without permission.`,
    `Who: <@${executor}>`,
    `To: <@${target}>`,
    `Punishment: ${punishment}`,
    `Response time: ${ms}ms`
  ].join("\n"));
}

async function handleAudit(guild, entry) {
  if (!guild?.id || entry?.action !== AuditLogEvent.MemberRoleUpdate) return;
  const configured = roleId(guild.id);
  if (!configured) return;
  const when = Number(entry.createdTimestamp) || Date.now();
  if (Date.now() - when > STALE_MS) return;
  const executor = executorId(entry);
  const target = targetId(entry);
  if (!target) return;
  let added = false;
  let removed = false;
  for (const change of changesOf(entry)) {
    const ids = roleIds(change);
    if (!ids.includes(String(configured))) continue;
    if (change.key === "$add" || change.key === "add") added = true;
    if (change.key === "$remove" || change.key === "remove") removed = true;
  }
  const member = await fetchMember(guild, executor);
  if (await isBotActor(guild, entry, member, executor)) {
    const own = String(executor) === botId(guild);
    if (removed && !added) {
      statements.remove.run(String(guild.id), String(target));
      if (!own) await noteBot(guild, entry, "remove");
      return;
    }
    if (!added) return;
    remember(guild.id, target, executor);
    if (!own) await noteBot(guild, entry, "add");
    return;
  }
  const allowed = allowedGiver(guild, member, executor);
  if (removed && !added) {
    if (allowed) {
      statements.remove.run(String(guild.id), String(target));
      return;
    }
    await punish(guild, entry, configured, "remove");
    return;
  }
  if (!added) return;
  if (allowed) {
    remember(guild.id, target, executor);
    return;
  }
  await punish(guild, entry, configured, "add");
}

const boundClients = new WeakSet();

function bind(client) {
  if (!client || boundClients.has(client)) return;
  boundClients.add(client);
  client.on("guildAuditLogEntryCreate", (entry, guild) => {
    handleAudit(guild, entry).catch((error) => console.error("[verified seller]", error));
  });
}

module.exports = {
  bind,
  handleCommand,
  handleInteraction,
  handleAudit,
  isSeller,
  canGive,
  roleId
};
