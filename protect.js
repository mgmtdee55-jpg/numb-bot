const {
  ActionRowBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  RoleSelectMenuBuilder
} = require("discord.js");
const { connection } = require("./db");
const access = require("./systems/access");
const store = require("./systems/store");
const roles = require("./vouch/roles");
const { ACCENT } = require("./vouch/constants");
const { reply } = require("./vouch/ui");
const { logThrottledError } = require("./log-throttle");

connection.exec(`
CREATE TABLE IF NOT EXISTS protection_roles (
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  godmode INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, role_id)
);
CREATE TABLE IF NOT EXISTS protected_users (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, role_id)
);
`);

const statements = {
  role: connection.prepare("SELECT * FROM protection_roles WHERE guild_id=? AND role_id=?"),
  roles: connection.prepare("SELECT * FROM protection_roles WHERE guild_id=? ORDER BY created_at ASC"),
  ownedRoles: connection.prepare("SELECT * FROM protection_roles WHERE guild_id=? AND owner_id=? ORDER BY created_at ASC"),
  saveRole: connection.prepare(`
    INSERT INTO protection_roles(guild_id, role_id, owner_id, godmode, created_at)
    VALUES(?,?,?,?,?)
    ON CONFLICT(guild_id, role_id) DO NOTHING
  `),
  setGodmode: connection.prepare("UPDATE protection_roles SET godmode=? WHERE guild_id=? AND role_id=? AND owner_id=?"),
  users: connection.prepare("SELECT * FROM protected_users WHERE guild_id=? ORDER BY created_at ASC"),
  ownedUsers: connection.prepare("SELECT * FROM protected_users WHERE guild_id=? AND owner_id=? ORDER BY created_at ASC"),
  saveUser: connection.prepare(`
    INSERT INTO protected_users(guild_id, user_id, role_id, owner_id, created_at)
    VALUES(?,?,?,?,?)
    ON CONFLICT(guild_id, user_id, role_id) DO NOTHING
  `),
  dropUser: connection.prepare("DELETE FROM protected_users WHERE guild_id=? AND user_id=? AND role_id=?")
};

const sessions = new Map();
let nextToken = 0;

function canAssignRoles(member) {
  return access.isServerOwner(member) || access.isGod(member);
}

function roleRow(guildId, roleId) {
  return statements.role.get(String(guildId), String(roleId)) || null;
}

function ownedRoles(guildId, userId) {
  return statements.ownedRoles.all(String(guildId), String(userId));
}

function memberHasGodmode(member) {
  if (!member?.roles?.cache || !member.guild) return false;
  for (const roleId of member.roles.cache.keys()) {
    const row = roleRow(member.guild.id, roleId);
    if (row?.godmode) return true;
  }
  return false;
}

function stamp(row) {
  const unix = Math.floor(Number(row.created_at) / 1000);
  return unix > 0 ? `<t:${unix}:R>` : "just now";
}

function rankLabel(guildId, userId) {
  const rank = store.getRank(guildId, userId);
  return access.rankByKey(rank?.rank_key)?.label || "No VC rank";
}

function embed(title, description) {
  return new EmbedBuilder().setColor(ACCENT).setTitle(title).setDescription(String(description || "").slice(0, 4000));
}

function sessionToken() {
  nextToken += 1;
  return `${Date.now().toString(36)}${nextToken.toString(36)}`;
}

function saveSession(data) {
  const token = sessionToken();
  sessions.set(token, { ...data, createdAt: Date.now() });
  if (sessions.size > 200) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (oldest) sessions.delete(oldest[0]);
  }
  return token;
}

function takeSession(token, userId) {
  const session = sessions.get(token);
  if (!session || String(session.userId) !== String(userId)) return null;
  if (Date.now() - session.createdAt > 120000) {
    sessions.delete(token);
    return null;
  }
  sessions.delete(token);
  return session;
}

function peekSession(token, userId) {
  const session = sessions.get(token);
  if (!session || String(session.userId) !== String(userId)) return null;
  if (Date.now() - session.createdAt > 120000) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function buttonRows(buttons) {
  const rows = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(new ActionRowBuilder().addComponents(...buttons.slice(index, index + 5)));
  }
  return rows.slice(0, 5);
}

function godmodePrompt(token, roleIds) {
  const mentions = roleIds.map((id) => `<@&${id}>`).join(", ");
  return {
    embeds: [embed("Protection Godmode", `Add godmode to ${mentions}?\nAnyone with ${roleIds.length > 1 ? "these roles" : "this role"} cannot stay server-muted or server-deafened.`)],
    components: buttonRows([
      new ButtonBuilder().setCustomId(`spanter:protect:god:yes:${token}`).setLabel("Yes").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`spanter:protect:god:no:${token}`).setLabel("No").setStyle(ButtonStyle.Secondary)
    ])
  };
}

function claimRole(guildId, roleId, ownerId) {
  const existing = roleRow(guildId, roleId);
  if (existing && String(existing.owner_id) !== String(ownerId)) return existing;
  if (!existing) {
    statements.saveRole.run(String(guildId), String(roleId), String(ownerId), 0, Date.now());
  }
  return null;
}

function rememberUser(guildId, userId, roleId, ownerId) {
  statements.saveUser.run(String(guildId), String(userId), String(roleId), String(ownerId), Date.now());
}

async function giveRole(member, roleId) {
  if (member.roles?.cache?.has?.(roleId)) {
    rememberUser(member.guild.id, member.id, roleId, roleRow(member.guild.id, roleId)?.owner_id || member.id);
    return true;
  }
  await roles.addRole(member, roleId, "Protection role");
  return true;
}

function idFrom(raw) {
  const id = String(raw || "").replace(/[<@!&>]/g, "");
  return /^\d{17,20}$/.test(id) ? id : null;
}

function targetsFrom(message, args) {
  const rolesFound = new Map();
  const usersFound = new Map();
  const mentionedRoles = message.mentions?.roles;
  if (mentionedRoles && typeof mentionedRoles.values === "function") {
    for (const role of mentionedRoles.values()) rolesFound.set(role.id, role);
  }
  const mentionedMembers = message.mentions?.members;
  if (mentionedMembers && typeof mentionedMembers.values === "function") {
    for (const member of mentionedMembers.values()) usersFound.set(member.id, member);
  }
  for (const part of args.slice(1).join(" ").split(/[,\s]+/)) {
    const id = idFrom(part);
    if (!id || rolesFound.has(id) || usersFound.has(id)) continue;
    const role = message.guild.roles.cache.get(id);
    if (role) {
      rolesFound.set(role.id, role);
      continue;
    }
    const member = message.guild.members.cache.get(id);
    if (member) usersFound.set(member.id, member);
    else usersFound.set(id, { id, unresolved: true });
  }
  return { roles: [...rolesFound.values()], users: [...usersFound.values()] };
}

async function resolveUser(message, target) {
  if (!target) return null;
  if (target.user && !target.unresolved) return target;
  return message.guild.members.cache.get(target.id) || await message.guild.members.fetch(target.id).catch(() => null);
}

function listAll(message) {
  const roleRows = statements.roles.all(String(message.guild.id));
  const userRows = statements.users.all(String(message.guild.id));
  if (!roleRows.length && !userRows.length) {
    return reply(message, "Protected List", "Nothing is protected in this server.");
  }
  const roleLines = roleRows.slice(0, 15).map((row) => {
    const count = userRows.filter((user) => user.role_id === row.role_id).length;
    return `<@&${row.role_id}> · <@${row.owner_id}> · ${row.godmode ? "godmode" : "no godmode"} · ${count} user${count === 1 ? "" : "s"}`;
  });
  const userLines = userRows.slice(0, 20).map((row) => `<@${row.user_id}> · <@&${row.role_id}> · <@${row.owner_id}> · ${stamp(row)}`);
  const parts = [];
  if (roleLines.length) parts.push(`**Roles**\n${roleLines.join("\n")}`);
  if (userLines.length) parts.push(`**People**\n${userLines.join("\n")}`);
  const extraRoles = Math.max(0, roleRows.length - 15);
  const extraUsers = Math.max(0, userRows.length - 20);
  if (extraRoles || extraUsers) parts.push(`+${extraRoles + extraUsers} more`);
  return reply(message, "Protected List", parts.join("\n\n"));
}

function listMine(message) {
  const rows = statements.ownedUsers.all(String(message.guild.id), String(message.author.id));
  if (!rows.length) return reply(message, "Your Protection", "You are not protecting anyone yet.");
  const lines = rows.slice(0, 15).map((row) => [
    `<@${row.user_id}> · <@&${row.role_id}>`,
    `${stamp(row)} · ${rankLabel(message.guild.id, row.user_id)}`
  ].join("\n"));
  const extra = rows.length > 15 ? `\n\n+${rows.length - 15} more` : "";
  return reply(message, "Your Protection", `${lines.join("\n\n")}${extra}`);
}

async function protectRoles(message, roleList) {
  if (!canAssignRoles(message.member)) {
    return reply(message, "Access Denied", "Only Gods and the server owner can protect a role.");
  }
  const usable = roleList.filter((role) => role && role.id !== message.guild.id && !role.managed);
  if (!usable.length) return reply(message, "Usage", "`-protect @role` or `-protect @role, @role`");
  const blocked = [];
  const ready = [];
  for (const role of usable) {
    const owner = claimRole(message.guild.id, role.id, message.author.id);
    if (owner) blocked.push(`<@&${role.id}> is already protected by <@${owner.owner_id}>`);
    else ready.push(role.id);
  }
  if (!ready.length) return reply(message, "Already Protected", blocked.join("\n"));
  const token = saveSession({
    userId: message.author.id,
    guildId: message.guild.id,
    kind: "godmode",
    roleIds: ready
  });
  const note = blocked.length ? `\n\n${blocked.join("\n")}` : "";
  const prompt = godmodePrompt(token, ready);
  prompt.embeds[0].setDescription(`${prompt.embeds[0].data.description}\n\nYou own ${ready.map((id) => `<@&${id}>`).join(", ")}.${note}`);
  return message.reply(prompt);
}

function setupPrompt(token) {
  return {
    embeds: [embed("Protection Role", "You need a protection role before you can protect someone.\nCreate one, or connect a role you already have.")],
    components: buttonRows([
      new ButtonBuilder().setCustomId(`spanter:protect:setup:create:${token}`).setLabel("Create a role").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`spanter:protect:setup:existing:${token}`).setLabel("Use an existing role").setStyle(ButtonStyle.Secondary)
    ])
  };
}

function pickPrompt(token, roleIds) {
  return {
    embeds: [embed("Choose a Protection Role", "Which role should this user get?")],
    components: buttonRows(roleIds.map((roleId) => new ButtonBuilder()
      .setCustomId(`spanter:protect:pick:${roleId}:${token}`)
      .setLabel(`Role ${roleId}`.slice(0, 80))
      .setStyle(ButtonStyle.Secondary)))
  };
}

async function protectUsers(message, userList) {
  if (!canAssignRoles(message.member)) {
    return reply(message, "Access Denied", "Only Gods and the server owner can protect someone.");
  }
  const members = [];
  for (const target of userList) {
    const member = await resolveUser(message, target);
    if (!member || member.user?.bot) continue;
    members.push(member);
  }
  if (!members.length) return reply(message, "Missing User", "Mention a member or paste their ID. `-protect @user`");
  const mine = ownedRoles(message.guild.id, message.author.id);
  if (!mine.length) {
    const token = saveSession({
      userId: message.author.id,
      guildId: message.guild.id,
      kind: "setup",
      targetIds: members.map((member) => member.id)
    });
    return message.reply(setupPrompt(token));
  }
  if (mine.length > 1) {
    if (members.length > 1) {
      return reply(message, "One User", "Pick one user when you own more than one protection role.");
    }
    const token = saveSession({
      userId: message.author.id,
      guildId: message.guild.id,
      kind: "pick",
      roleIds: mine.map((row) => row.role_id),
      targetIds: members.map((member) => member.id)
    });
    const prompt = pickPrompt(token, mine.map((row) => row.role_id));
    const labels = mine.map((row) => {
      const role = message.guild.roles.cache.get(row.role_id);
      return role?.name || row.role_id;
    });
    prompt.components = buttonRows(mine.map((row, index) => new ButtonBuilder()
      .setCustomId(`spanter:protect:pick:${row.role_id}:${token}`)
      .setLabel(String(labels[index]).slice(0, 80))
      .setStyle(ButtonStyle.Secondary)));
    return message.reply(prompt);
  }
  return assignUsers(message, members, mine[0].role_id);
}

async function assignUsers(message, members, roleId, interaction) {
  const row = roleRow(message.guild.id, roleId);
  if (!row || String(row.owner_id) !== String(message.author?.id || message.user?.id)) {
    const payload = { embeds: [embed("Not Your Role", "Only the person who protected that role can put it on someone.")] };
    if (interaction) return interaction.update(payload);
    return message.reply(payload);
  }
  const added = [];
  for (const member of members) {
    rememberUser(message.guild.id, member.id, roleId, row.owner_id);
    try {
      await giveRole(member, roleId);
      added.push(member.id);
    } catch (error) {
      logThrottledError(`protect-add:${message.guild.id}`, `[protect add] ${member.id}`, error);
    }
  }
  if (!added.length) {
    const payload = { embeds: [embed("Unable to Protect", "I could not add that role. Check that my role is above it.")] };
    if (interaction) return interaction.update(payload);
    return message.reply(payload);
  }
  if (row.godmode) {
    const payload = { embeds: [embed("Protected", `${added.map((id) => `<@${id}>`).join(", ")} now has <@&${roleId}>. Godmode is already on for that role.`)], components: [] };
    if (interaction) return interaction.update(payload);
    return message.reply(payload);
  }
  const token = saveSession({
    userId: message.author?.id || message.user?.id,
    guildId: message.guild.id,
    kind: "godmode",
    roleIds: [roleId]
  });
  const prompt = godmodePrompt(token, [roleId]);
  prompt.embeds[0].setDescription(`Protected ${added.map((id) => `<@${id}>`).join(", ")} with <@&${roleId}>.\n\n${prompt.embeds[0].data.description}`);
  if (interaction) return interaction.update(prompt);
  return message.reply(prompt);
}

async function handleCommand(message, name, args) {
  if (name === "plist" || name === "protectedlist") return listAll(message);
  if (name === "protected") return listMine(message);
  if (name !== "protect") return false;
  const found = targetsFrom(message, args);
  if (found.roles.length && found.users.length) {
    return reply(message, "Usage", "Protect roles or one user, not both in the same command.\n`-protect @role, @role`\n`-protect @user`");
  }
  if (found.roles.length) return protectRoles(message, found.roles);
  if (found.users.length) return protectUsers(message, found.users);
  return reply(message, "Usage", "`-protect @role, @role`\n`-protect @user`\n`-protected`\n`-plist`");
}

function actorId(interaction) {
  return interaction.user?.id || interaction.member?.id;
}

async function enableGodmode(interaction, session) {
  for (const roleId of session.roleIds) {
    statements.setGodmode.run(1, String(session.guildId), String(roleId), String(session.userId));
  }
  const mentions = session.roleIds.map((id) => `<@&${id}>`).join(", ");
  await interaction.update({
    embeds: [embed("Godmode On", `${mentions} now undoes server mute and server deafen.`)],
    components: []
  });
}

async function createProtectionRole(interaction, session) {
  const name = `${interaction.member?.displayName || interaction.user.username} Protected`.slice(0, 100);
  let role;
  try {
    role = await interaction.guild.roles.create({
      name,
      permissions: [],
      reason: "Protection role"
    });
  } catch (error) {
    logThrottledError(`protect-role:${interaction.guild.id}`, "[protect role]", error);
    await interaction.update({
      embeds: [embed("Unable to Create", "I could not create that role. I need Manage Roles.")],
      components: []
    });
    return;
  }
  const blocked = claimRole(interaction.guild.id, role.id, session.userId);
  if (blocked) {
    await interaction.update({ embeds: [embed("Already Protected", "That new role is already owned.")], components: [] });
    return;
  }
  const members = [];
  for (const userId of session.targetIds || []) {
    const member = interaction.guild.members.cache.get(userId) || await interaction.guild.members.fetch(userId).catch(() => null);
    if (member) members.push(member);
  }
  const message = {
    guild: interaction.guild,
    author: { id: session.userId },
    user: interaction.user
  };
  await assignUsers(message, members, role.id, interaction);
}

async function handleInteraction(interaction) {
  const id = interaction.customId || "";
  if (!id.startsWith("spanter:protect:")) return false;
  const userId = actorId(interaction);
  if (interaction.isRoleSelectMenu?.() && id.startsWith("spanter:protect:existing:")) {
    const token = id.slice("spanter:protect:existing:".length);
    const session = takeSession(token, userId);
    if (!session) {
      await interaction.reply({ embeds: [embed("Expired", "Run `-protect` again.")], flags: 64 }).catch(() => null);
      return true;
    }
    const roleId = interaction.values?.[0];
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role || role.managed || role.id === interaction.guild.id) {
      await interaction.update({ embeds: [embed("Unavailable Role", "Pick a normal role the bot can assign.")], components: [] });
      return true;
    }
    const blocked = claimRole(interaction.guild.id, role.id, session.userId);
    if (blocked) {
      await interaction.update({
        embeds: [embed("Already Protected", `<@&${role.id}> is already protected by <@${blocked.owner_id}>.`)],
        components: []
      });
      return true;
    }
    const members = [];
    for (const targetId of session.targetIds || []) {
      const member = interaction.guild.members.cache.get(targetId) || await interaction.guild.members.fetch(targetId).catch(() => null);
      if (member) members.push(member);
    }
    await assignUsers({
      guild: interaction.guild,
      author: { id: session.userId },
      user: interaction.user
    }, members, role.id, interaction);
    return true;
  }
  if (!interaction.isButton?.()) return false;
  const parts = id.split(":");
  const action = parts[2];
  if (action === "god") {
    const token = parts[4];
    const session = takeSession(token, userId);
    if (!session) {
      await interaction.reply({ embeds: [embed("Expired", "Run `-protect` again.")], flags: 64 }).catch(() => null);
      return true;
    }
    if (parts[3] === "yes") {
      await enableGodmode(interaction, session);
      return true;
    }
    await interaction.update({
      embeds: [embed("Godmode Skipped", "The role stays protected without godmode.")],
      components: []
    });
    return true;
  }
  if (action === "pick") {
    const roleId = parts[3];
    const token = parts[4];
    const session = takeSession(token, userId);
    if (!session || !session.roleIds?.includes(roleId)) {
      await interaction.reply({ embeds: [embed("Expired", "Run `-protect` again.")], flags: 64 }).catch(() => null);
      return true;
    }
    const members = [];
    for (const targetId of session.targetIds || []) {
      const member = interaction.guild.members.cache.get(targetId) || await interaction.guild.members.fetch(targetId).catch(() => null);
      if (member) members.push(member);
    }
    await assignUsers({
      guild: interaction.guild,
      author: { id: session.userId },
      user: interaction.user
    }, members, roleId, interaction);
    return true;
  }
  if (action === "setup") {
    const choice = parts[3];
    const token = parts[4];
    const session = choice === "existing" ? peekSession(token, userId) : takeSession(token, userId);
    if (!session) {
      await interaction.reply({ embeds: [embed("Expired", "Run `-protect` again.")], flags: 64 }).catch(() => null);
      return true;
    }
    if (choice === "create") {
      await createProtectionRole(interaction, session);
      return true;
    }
    if (choice === "existing") {
      await interaction.update({
        embeds: [embed("Connect a Role", "Choose the role you want to protect. You will be its only owner.")],
        components: [
          new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder()
              .setCustomId(`spanter:protect:existing:${token}`)
              .setPlaceholder("Protection role")
              .setMinValues(1)
              .setMaxValues(1)
          )
        ]
      });
      return true;
    }
  }
  return false;
}

function diffRoles(before, after) {
  const guildId = after.guild.id;
  const previous = new Set(before.roles?.cache?.keys?.() || []);
  const next = new Set(after.roles?.cache?.keys?.() || []);
  const added = [...next].filter((id) => id !== guildId && !previous.has(id));
  const removed = [...previous].filter((id) => id !== guildId && !next.has(id));
  return { added, removed };
}

function entryRoles(change) {
  const value = change?.new ?? change?.new_value ?? change?.old ?? [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => (item && typeof item === "object" ? item.id : item)).filter(Boolean);
}

async function findExecutor(guild, userId, roleIds) {
  if (!roleIds.length || typeof guild.fetchAuditLogs !== "function") return null;
  for (const delay of [0, 600]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 6 }).catch(() => null);
    const entries = logs?.entries?.values ? [...logs.entries.values()] : Array.isArray(logs?.entries) ? logs.entries : [];
    const now = Date.now();
    const match = entries.find((entry) => {
      const targetId = entry.targetId || entry.target?.id;
      if (String(targetId) !== String(userId)) return false;
      if (entry.createdTimestamp && now - entry.createdTimestamp > 20000) return false;
      const ids = new Set((entry.changes || []).flatMap(entryRoles));
      return roleIds.some((roleId) => ids.has(String(roleId)));
    });
    const executorId = match?.executorId || match?.executor?.id;
    if (executorId) return { id: String(executorId), bot: !!match.executor?.bot };
  }
  return null;
}

async function stripAttacker(member) {
  if (!member || member.user?.bot) return [];
  const removed = [];
  for (const role of member.roles?.cache?.values?.() || []) {
    if (!role || role.managed || role.id === member.guild.id) continue;
    if (!roles.roleGrantsStaff(role)) continue;
    if (!roles.botCanManageRole(member.guild, role)) continue;
    removed.push(role.id);
  }
  if (removed.length) {
    await roles.removeRoles(member, removed, "Staff removed after tampering with a protected role").catch((error) => {
      logThrottledError(`protect-strip:${member.guild.id}`, `[protect strip] ${member.id}`, error);
    });
  }
  store.clearStaff(member.guild.id, member.id);
  return removed;
}

async function observe(before, after) {
  if (!after?.guild || !before?.roles?.cache || !after?.roles?.cache || after.user?.bot) return;
  const { added, removed } = diffRoles(before, after);
  const watched = [...added, ...removed].filter((roleId) => roleRow(after.guild.id, roleId));
  if (!watched.length) return;
  const realAdded = added.filter((roleId) => roleRow(after.guild.id, roleId) && !roles.consumeRole(after.guild.id, after.id, roleId, "add"));
  const realRemoved = removed.filter((roleId) => roleRow(after.guild.id, roleId) && !roles.consumeRole(after.guild.id, after.id, roleId, "remove"));
  if (!realAdded.length && !realRemoved.length) return;
  const executor = await findExecutor(after.guild, after.id, [...realAdded, ...realRemoved]);
  const botId = after.guild.client?.user?.id;
  if (executor && botId && executor.id === String(botId)) return;
  const executorMember = executor
    ? after.guild.members.cache.get(executor.id) || await after.guild.members.fetch(executor.id).catch(() => null)
    : null;
  const executorIsBot = !!executor?.bot || !!executorMember?.user?.bot;

  for (const roleId of realRemoved) {
    const row = roleRow(after.guild.id, roleId);
    if (!row) continue;
    if (executor && String(executor.id) === String(row.owner_id) && !executorIsBot) {
      statements.dropUser.run(String(after.guild.id), String(after.id), String(roleId));
      continue;
    }
    try {
      await roles.addRole(after, roleId, "Restored a protected role");
    } catch (error) {
      logThrottledError(`protect-restore:${after.guild.id}`, `[protect restore] ${roleId}`, error);
    }
  }

  for (const roleId of realAdded) {
    const row = roleRow(after.guild.id, roleId);
    if (!row) continue;
    if (executor && String(executor.id) === String(row.owner_id) && !executorIsBot) {
      rememberUser(after.guild.id, after.id, roleId, row.owner_id);
      continue;
    }
    try {
      await roles.removeRole(after, roleId, "Removed an unauthorized protected role");
    } catch (error) {
      logThrottledError(`protect-revert:${after.guild.id}`, `[protect revert] ${roleId}`, error);
    }
  }

  if (!executor || executorIsBot || !executorMember) return;
  const tampered = [...realAdded, ...realRemoved].some((roleId) => {
    const row = roleRow(after.guild.id, roleId);
    return row && String(row.owner_id) !== String(executor.id);
  });
  if (tampered) await stripAttacker(executorMember);
}

module.exports = {
  canAssignRoles,
  memberHasGodmode,
  handleCommand,
  handleInteraction,
  observe,
  roleRow,
  ownedRoles
};
