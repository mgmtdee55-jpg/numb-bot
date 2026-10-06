const db = require("./db");

const PERMISSIONS = {
  ban_members: { group: "Moderation", grants: "Banning and unbanning members" },
  kick_members: { group: "Moderation", grants: "Removing members from the server" },
  foreverban_members: { group: "Moderation", grants: "Owner-tier foreverban / foreverunban (not granted by administrator)" },
  manage_messages: { group: "Moderation", grants: "Deleting and purging messages" },
  manage_nicknames: { group: "Moderation", grants: "Changing other members’ nicknames" },
  change_nickname: { group: "Moderation", grants: "Changing their own nickname" },
  view_audit_log: { group: "Moderation", grants: "Reading the server audit log" },
  mute_members: { group: "Voice", grants: "Server-muting members in voice" },
  deafen_members: { group: "Voice", grants: "Server-deafening members in voice" },
  move_members: { group: "Voice", grants: "Dragging members between voice channels" },
  administrator: { group: "Server", grants: "Every moderation command this bot offers" },
  manage_guild: { group: "Server", grants: "Editing server-level settings" },
  manage_channels: { group: "Server", grants: "Creating, editing, and deleting channels" },
  manage_roles: { group: "Server", grants: "Creating and assigning roles" },
  manage_webhooks: { group: "Server", grants: "Managing server webhooks" },
  manage_expressions: { group: "Server", grants: "Managing emojis, stickers, and soundboard" }
};

function normalizePermission(value) {
  const key = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return PERMISSIONS[key] ? key : null;
}

function memberRoleIds(member) {
  const roles = member?.roles?.cache;
  if (!roles) return [];
  if (typeof roles.keys === "function") return [...roles.keys()];
  if (Array.isArray(roles)) return roles.map((role) => role.id || role);
  return [...roles].map((entry) => (Array.isArray(entry) ? entry[0] : entry.id || entry));
}

function isGuildOwner(member) {
  return !!member?.guild && String(member.id) === String(member.guild.ownerId);
}

function grantedFakePermissions(member) {
  if (!member?.guild) return new Set();
  return new Set([
    ...db.fakePermissionsForRoles(member.guild.id, memberRoleIds(member)),
    ...db.fakePermissionsForUser(member.guild.id, member.id)
  ]);
}

function hasAdministratorFakePermission(member) {
  return isGuildOwner(member) || grantedFakePermissions(member).has("administrator");
}

function canManageFakePermissions(member) {
  return hasAdministratorFakePermission(member);
}

function canForeverBan(member) {
  return isGuildOwner(member) || grantedFakePermissions(member).has("foreverban_members");
}

function hasFakePermission(member, permission) {
  if (permission === "foreverban_members") return canForeverBan(member);
  if (hasAdministratorFakePermission(member)) return true;
  return grantedFakePermissions(member).has(permission);
}

function canUseBanCommands(member) {
  return hasFakePermission(member, "ban_members");
}

function canManageRoles(member) {
  return hasFakePermission(member, "manage_roles");
}

function permissionHelpText() {
  const groups = { Moderation: [], Voice: [], Server: [] };
  for (const [name, info] of Object.entries(PERMISSIONS)) {
    groups[info.group].push(`\`${name}\` — ${info.grants}`);
  }
  return [
    "**Moderation**",
    groups.Moderation.join("\n"),
    "",
    "**Voice**",
    groups.Voice.join("\n"),
    "",
    "**Server**",
    groups.Server.join("\n")
  ].join("\n");
}

module.exports = {
  PERMISSIONS,
  normalizePermission,
  isGuildOwner,
  hasFakePermission,
  hasAdministratorFakePermission,
  canManageFakePermissions,
  canForeverBan,
  canUseBanCommands,
  canManageRoles,
  permissionHelpText,
  memberRoleIds
};
