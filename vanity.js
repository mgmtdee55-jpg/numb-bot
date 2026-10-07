const {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  RoleSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");
const { connection } = require("./db");
const access = require("./systems/access");
const roles = require("./vouch/roles");
const { ACCENT } = require("./vouch/constants");
const { reply } = require("./vouch/ui");

connection.exec(`
CREATE TABLE IF NOT EXISTS vanity_config (
  guild_id TEXT PRIMARY KEY,
  name TEXT,
  role_ids TEXT NOT NULL DEFAULT '[]'
);
`);

const readConfig = connection.prepare("SELECT name, role_ids FROM vanity_config WHERE guild_id=?");
const writeConfig = connection.prepare(`
  INSERT INTO vanity_config(guild_id, name, role_ids) VALUES(?,?,?)
  ON CONFLICT(guild_id) DO UPDATE SET name=excluded.name, role_ids=excluded.role_ids
`);

function canConfigure(member) {
  return access.isServerOwner(member) || access.isBotOwner(member?.id) || access.isGod(member);
}

function getConfig(guildId) {
  const row = readConfig.get(String(guildId));
  let roleIds = [];
  try {
    roleIds = JSON.parse(row?.role_ids || "[]");
  } catch {
    roleIds = [];
  }
  if (!Array.isArray(roleIds)) roleIds = [];
  return { name: row?.name || "", roleIds: roleIds.map(String).filter(Boolean).slice(0, 10) };
}

function saveConfig(guildId, name, roleIds) {
  writeConfig.run(String(guildId), name || null, JSON.stringify(roleIds.slice(0, 10)));
}

function cleanName(value) {
  return String(value || "").trim().slice(0, 32);
}

function validName(name) {
  return /^[a-z0-9][a-z0-9_-]{1,31}$/i.test(name);
}

function hasVanity(status, name) {
  const vanity = cleanName(name).toLowerCase();
  if (!validName(vanity)) return false;
  return String(status || "").toLowerCase().includes(vanity);
}

function activityList(presence) {
  const activities = presence?.activities;
  if (!activities) return [];
  if (typeof activities.values === "function") return [...activities.values()];
  return [...activities];
}

function statusText(presence) {
  if (!presence) return null;
  const custom = activityList(presence).filter((activity) => activity?.type === ActivityType.Custom || activity?.type === 4);
  if (custom.length) return custom.map((activity) => activity.state || "").join(" ");
  if (!presence.status || presence.status === "offline" || presence.status === "invisible") return null;
  return "";
}

function roleList(guild, roleIds) {
  if (!roleIds.length) return "Not set";
  return roleIds.map((id) => guild?.roles?.cache?.get(id)?.name ? `<@&${id}>` : `\`${id}\``).join(", ");
}

function summary(guild, config) {
  return [
    `**Name:** ${config.name ? `\`${config.name}\`` : "Not set"}`,
    `**Rewards:** ${roleList(guild, config.roleIds)}`,
    "",
    "A custom status gets the reward when it contains that word.",
    "Capitals are ignored, and numbers or symbols around it still count.",
    "`carTUNES`, `/tunes`, `tunes101`, and `@tUnEs` all match `tunes`.",
    "The roles are removed when that word is no longer in the status."
  ].join("\n");
}

function panel(guild) {
  const config = getConfig(guild.id);
  const embed = new EmbedBuilder().setColor(ACCENT).setTitle("Vanity Rewards").setDescription(summary(guild, config));
  const select = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId("spanter:vanity:roles")
      .setPlaceholder("Choose reward roles")
      .setMinValues(1)
      .setMaxValues(10)
  );
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("spanter:vanity:name").setLabel("Set name").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("spanter:vanity:clear").setLabel("Clear").setStyle(ButtonStyle.Danger)
  );
  return { embeds: [embed], components: [select, buttons] };
}

function nameModal(current) {
  const input = new TextInputBuilder()
    .setCustomId("value")
    .setLabel("Vanity name")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(2)
    .setMaxLength(32)
    .setPlaceholder("tunes");
  if (current) input.setValue(current.slice(0, 32));
  return new ModalBuilder()
    .setCustomId("spanter:vanity:modal")
    .setTitle("Vanity name")
    .addComponents(new ActionRowBuilder().addComponents(input));
}

function deny(message) {
  return reply(message, "Access Denied", "Only Gods and the server owner can configure vanity rewards.");
}

function usableRoles(guild, list) {
  const accepted = [];
  const skipped = [];
  for (const role of list) {
    if (!role || role.id === guild.id || role.managed) {
      if (role) skipped.push(role.name || role.id);
      continue;
    }
    accepted.push(role);
  }
  return { accepted: accepted.slice(0, 10), skipped };
}

function resolveRoles(message, text) {
  const found = new Map();
  const mentioned = message.mentions?.roles;
  if (mentioned && typeof mentioned.values === "function") {
    for (const role of mentioned.values()) found.set(role.id, role);
  }
  for (const part of String(text || "").split(",")) {
    const raw = part.trim();
    if (!raw) continue;
    const id = raw.replace(/[<@&>]/g, "");
    if (/^\d{17,20}$/.test(id)) {
      const role = message.guild.roles.cache.get(id);
      if (role) found.set(role.id, role);
      continue;
    }
    const name = raw.replace(/^@/, "").trim().toLowerCase();
    if (!name) continue;
    const role = [...message.guild.roles.cache.values()].find((item) => item.name.toLowerCase() === name);
    if (role) found.set(role.id, role);
  }
  return [...found.values()];
}

async function applyMember(member) {
  if (!member?.guild || member.user?.bot) return;
  const config = getConfig(member.guild.id);
  if (!config.name || !config.roleIds.length) return;
  const text = statusText(member.presence);
  if (text == null) return;
  const matched = hasVanity(text, config.name);
  for (const roleId of config.roleIds) {
    const has = member.roles?.cache?.has?.(roleId);
    if (matched && !has) {
      await roles.addRole(member, roleId, "Vanity status").catch(() => null);
    } else if (!matched && has) {
      await roles.removeRole(member, roleId, "Vanity status removed").catch(() => null);
    }
  }
}

async function syncGuild(guild) {
  const config = getConfig(guild?.id);
  if (!config.name || !config.roleIds.length) return;
  let members = guild.members?.cache;
  if (typeof guild.members?.fetch === "function") {
    const fetched = await guild.members.fetch({ withPresences: true }).catch(() => null);
    if (fetched) members = fetched;
  }
  if (!members || typeof members.values !== "function") return;
  for (const member of members.values()) {
    await applyMember(member);
  }
}

async function open(message) {
  if (!canConfigure(message.member)) return deny(message);
  return message.reply(panel(message.guild));
}

async function setName(message, raw) {
  if (!canConfigure(message.member)) return deny(message);
  const name = cleanName(raw);
  if (!validName(name)) {
    return reply(message, "Usage", "`-vanity set <name>`\nUse 2 to 32 letters, numbers, dashes, or underscores. Example: `-vanity set tunes`");
  }
  const config = getConfig(message.guild.id);
  saveConfig(message.guild.id, name, config.roleIds);
  syncGuild(message.guild).catch((error) => console.error(`[vanity] ${message.guild.id}`, error));
  return reply(message, "Vanity Name Set", `Custom statuses containing **${name}** can receive the reward. Capitals and extra numbers still count.`);
}

async function setRewards(message, text) {
  if (!canConfigure(message.member)) return deny(message);
  const { accepted, skipped } = usableRoles(message.guild, resolveRoles(message, text));
  if (!accepted.length) {
    return reply(message, "Usage", "`-vanity reward @role, role2, @role 3`\nPick roles the bot can assign. Managed roles are skipped.");
  }
  const config = getConfig(message.guild.id);
  saveConfig(message.guild.id, config.name, accepted.map((role) => role.id));
  syncGuild(message.guild).catch((error) => console.error(`[vanity] ${message.guild.id}`, error));
  const names = accepted.map((role) => `<@&${role.id}>`).join(", ");
  const note = skipped.length ? `\nSkipped: ${skipped.join(", ")}` : "";
  return reply(message, "Vanity Rewards Set", `${names} will be given while the vanity is in a custom status.${note}`);
}

async function handleCommand(message, args, prefix) {
  const sub = (args[0] || "").toLowerCase();
  if (sub === "set") return setName(message, args.slice(1).join(" "));
  if (sub === "reward" || sub === "rewards") return setRewards(message, args.slice(1).join(" "));
  if (sub === "setup" || !sub) return open(message);
  return reply(message, "Vanity", [
    `\`${prefix}vanity set <name>\``,
    `\`${prefix}vanity reward @role, role2\``,
    `\`${prefix}vanitysetup\``
  ].join("\n"));
}

async function handleInteraction(interaction) {
  const id = interaction.customId || "";
  if (!id.startsWith("spanter:vanity:")) return false;
  if (!canConfigure(interaction.member)) {
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(ACCENT).setDescription("Only Gods and the server owner can configure vanity rewards.")],
      flags: 64
    }).catch(() => null);
    return true;
  }
  if (interaction.isButton?.() && id === "spanter:vanity:name") {
    await interaction.showModal(nameModal(getConfig(interaction.guild.id).name));
    return true;
  }
  if (interaction.isButton?.() && id === "spanter:vanity:clear") {
    saveConfig(interaction.guild.id, "", []);
    await interaction.update(panel(interaction.guild));
    return true;
  }
  if (interaction.isRoleSelectMenu?.() && id === "spanter:vanity:roles") {
    const selected = interaction.roles?.map?.((role) => role) || interaction.values.map((roleId) => interaction.guild.roles.cache.get(roleId)).filter(Boolean);
    const { accepted } = usableRoles(interaction.guild, selected);
    if (!accepted.length) {
      await interaction.reply({
        embeds: [new EmbedBuilder().setColor(ACCENT).setDescription("Pick roles the bot can assign. Managed roles are skipped.")],
        flags: 64
      }).catch(() => null);
      return true;
    }
    const config = getConfig(interaction.guild.id);
    saveConfig(interaction.guild.id, config.name, accepted.map((role) => role.id));
    syncGuild(interaction.guild).catch((error) => console.error(`[vanity] ${interaction.guild.id}`, error));
    await interaction.update(panel(interaction.guild));
    return true;
  }
  if (interaction.isModalSubmit?.() && id === "spanter:vanity:modal") {
    const name = cleanName(interaction.fields.getTextInputValue("value"));
    if (!validName(name)) {
      await interaction.reply({
        embeds: [new EmbedBuilder().setColor(ACCENT).setDescription("Use 2 to 32 letters, numbers, dashes, or underscores.")],
        flags: 64
      }).catch(() => null);
      return true;
    }
    const config = getConfig(interaction.guild.id);
    saveConfig(interaction.guild.id, name, config.roleIds);
    syncGuild(interaction.guild).catch((error) => console.error(`[vanity] ${interaction.guild.id}`, error));
    await interaction.update(panel(interaction.guild));
    return true;
  }
  return false;
}

async function handlePresence(oldPresence, newPresence) {
  const member = newPresence?.member;
  if (!member) return;
  await applyMember(member);
}

async function syncAll(client) {
  for (const guild of client.guilds?.cache?.values?.() || []) {
    await syncGuild(guild).catch((error) => console.error(`[vanity] ${guild.id}`, error));
  }
}

module.exports = {
  canConfigure,
  getConfig,
  hasVanity,
  statusText,
  open,
  handleCommand,
  handleInteraction,
  handlePresence,
  syncGuild,
  syncAll,
  panel
};
