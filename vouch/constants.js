const { PermissionFlagsBits } = require("discord.js");

const DEFAULT_PREFIX = "-";
const DEFAULT_ALLOWANCE = 2;
const MAX_ALLOWANCE = 100;
const MAX_ROLE_LIMIT = 500;
const PAGE_SIZE = 8;
const OVERVIEW_EMOJI = { id: "1555789384140328960", name: "YOUR_CUSTOM_EMOJI_ID" };
const ACCENT = 0x2b2d31;

const STAFF_FLAG_NAMES = [
  "Administrator",
  "ManageGuild",
  "ManageRoles",
  "ManageChannels",
  "KickMembers",
  "BanMembers",
  "ModerateMembers",
  "MuteMembers",
  "DeafenMembers",
  "ManageMessages",
  "ManageWebhooks",
  "ManageNicknames",
  "ManageThreads",
  "MoveMembers",
  "ViewAuditLog",
  "ManageEvents",
  "ManageGuildExpressions"
];

const STAFF_PERMISSIONS = STAFF_FLAG_NAMES
  .map((name) => PermissionFlagsBits[name])
  .filter((flag) => typeof flag === "bigint");

const BUILTIN_COMMANDS = new Set([
  "help", "bothelp", "showallcommands", "setprefix", "alias", "vouch", "vouchblacklist", "vouchstrip",
  "setrole", "forcemanage", "forcenickname",
  "unforcenickname", "forcerolestrip", "forcestrip", "unforcerolestrip", "unforcestrip",
  "rolestrip", "vc", "mvc", "send", "lock", "unlock", "ghost", "unghost", "claim",
  "kick", "permit", "ban", "banned", "hardban", "softban", "tempban", "unban",
  "unbanall", "fb", "foreverban", "fub", "foreverunban", "pban", "personalban", "role", "fp", "fakepermissions",
  "rank", "ranks", "god", "m", "management", "mgmt", "managegod", "logging", "logs",
  "restart", "antinuke", "avatar", "banner", "serverinfo", "userinfo", "lockdown", "unlockdown",
  "ceo", "founder", "boss", "grant", "grants", "revoke", "ungrant", "hide", "unhide", "lockall", "unlockall", "nuke",
  "forceownership", "voiceoverride", "dragall", "voicehistory", "godmode", "ungodmode",
  "muteall", "unmuteall", "shield", "unshield", "voiceshield", "follow", "unfollow", "chain", "bring",
  "inspect", "forceclaim", "stfu", "unstfu", "stsu", "unstsu", "modsetup", "modlogreset", "voice", "rankinfo", "unrank", "afk",
  "embedcreate", "instagram", "ig", "insta", "tiktok", "roblox", "giveaways", "gw", "voicemaster", "set",
  "vanity", "vanitysetup"
]);

const RANK = { user: 0, giver: 1, admin: 2, os: 3, owner: 4 };

module.exports = {
  DEFAULT_PREFIX,
  DEFAULT_ALLOWANCE,
  MAX_ALLOWANCE,
  MAX_ROLE_LIMIT,
  PAGE_SIZE,
  OVERVIEW_EMOJI,
  ACCENT,
  STAFF_PERMISSIONS,
  BUILTIN_COMMANDS,
  RANK
};
