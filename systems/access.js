const store = require("./store");

const LADDER = [
  {
    key: "plus",
    label: "Voice Plus",
    aliases: ["plus", "voiceplus", "vcplus"],
    commands: ["inspect"]
  },
  {
    key: "premium",
    label: "Voice Premium",
    aliases: ["premium", "voicepremium"],
    commands: ["follow", "unfollow", "chain", "bring", "inspect", "forceclaim"]
  },
  {
    key: "premiumplus",
    label: "Voice Premium Plus",
    aliases: ["premiumplus", "voicepremiumplus", "premium+"],
    commands: [
      "voiceoverride", "muteall", "unmuteall", "stsu", "unstsu",
      "follow", "unfollow", "chain", "bring", "inspect", "forceclaim"
    ]
  }
];

const FOUNDER_COMMANDS = new Set([
  "forceownership", "dragall", "voicehistory", "godmode", "ungodmode", "shield", "unshield"
]);

const VOICE_COMMANDS = [
  ...FOUNDER_COMMANDS,
  ...LADDER.flatMap((rank) => rank.commands),
  "stfu", "unstfu"
];

const STAFF = [
  { key: "boss", label: "Boss", title: "Admin", command: "boss" },
  { key: "founder", label: "Founder", title: "Super Admin", command: "founder" },
  { key: "god", label: "God", title: "Root Owner", command: "ceo" }
];

const LOG_CATEGORIES = ["message", "voice", "channel", "role", "server", "member"];
const ANTINUKE_LOG = "antinuke";
const PUNISHMENT_LOG = "punishments";

const REQUIREMENT = {
  forceownership: "Gods and Founders",
  dragall: "Gods and Founders",
  voicehistory: "Gods and Founders",
  godmode: "Gods and Founders",
  ungodmode: "Gods and Founders",
  shield: "Gods and Founders",
  unshield: "Gods and Founders",
  voiceoverride: "Voice Premium Plus",
  muteall: "Voice Premium Plus",
  unmuteall: "Voice Premium Plus",
  stsu: "Voice Premium Plus",
  unstsu: "Voice Premium Plus",
  stfu: "Voice Premium Plus",
  unstfu: "Voice Premium Plus",
  follow: "Voice Premium",
  unfollow: "Voice Premium",
  chain: "Voice Premium",
  bring: "Voice Premium",
  forceclaim: "Voice Premium",
  inspect: "Voice Plus"
};

function botOwnerIds() {
  return String(process.env.BOT_OWNER || process.env.OWNER_ID || "")
    .split(/[,\s]+/)
    .map((id) => id.trim())
    .filter(Boolean);
}

function isBotOwner(userId) {
  return botOwnerIds().includes(String(userId || ""));
}

function isServerOwner(member) {
  return !!member?.guild && String(member.id) === String(member.guild.ownerId);
}

function isAntinukeAdmin(member) {
  return !!member?.guild && store.isAntinukeAdmin(member.guild.id, member.id);
}

function isManagement(member) {
  return !!member?.guild && store.isManagement(member.guild.id, member.id);
}

function staffByKey(key) {
  return STAFF.find((tier) => tier.key === key) || null;
}

function staffTier(member) {
  if (!member?.guild) return null;
  return store.getStaff(member.guild.id, member.id)?.tier || null;
}

function staffLevel(tier) {
  return STAFF.findIndex((item) => item.key === tier);
}

function hasStaff(member, minimum) {
  const current = staffLevel(staffTier(member));
  const needed = staffLevel(minimum);
  return current >= 0 && needed >= 0 && current >= needed;
}

function isGod(member) {
  return staffTier(member) === "god";
}

function aboveStaff(member) {
  return isServerOwner(member) || isBotOwner(member?.id);
}

function canGrantStaff(member, tier) {
  if (tier === "god") return isServerOwner(member);
  if (aboveStaff(member)) return true;
  if (tier === "founder") return hasStaff(member, "god");
  return hasStaff(member, "founder");
}

function canAssignRanks(member) {
  return aboveStaff(member) || hasStaff(member, "god");
}

function canManageManagement(member) {
  return canAssignRanks(member);
}

function canManageGodmode(member) {
  return canAssignRanks(member);
}

function canUseLogs(member) {
  return aboveStaff(member) || hasStaff(member, "god");
}

function canConfigureLogs(member) {
  return canUseLogs(member);
}

function canUseChannels(member) {
  return aboveStaff(member) || hasStaff(member, "founder");
}

function canModerate(member) {
  return aboveStaff(member) || hasStaff(member, "god");
}

function canUseForce(member) {
  return aboveStaff(member) || hasStaff(member, "founder");
}

function canConfigureBot(member) {
  return aboveStaff(member) || hasStaff(member, "founder");
}

function canRestart(member) {
  return canConfigureBot(member);
}

function canSetup(member) {
  return canUseLogs(member);
}

function parseRank(text) {
  const value = String(text || "").trim().toLowerCase().replace(/[\s_+-]+/g, "");
  if (!value) return null;
  return LADDER.find((rank) => rank.key === value || rank.aliases.includes(value)) || null;
}

function rankByKey(key) {
  return LADDER.find((rank) => rank.key === key) || null;
}

function commandsForRank(key) {
  const rank = rankByKey(key);
  return rank ? [...rank.commands] : [];
}

function voiceRankKey(member) {
  if (!member?.guild) return null;
  const roles = store.getVoiceRoles(member.guild.id);
  const cache = member.roles?.cache;
  if (roles && cache?.has) {
    if (roles.premium_plus_role_id && cache.has(roles.premium_plus_role_id)) return "premiumplus";
    if (roles.premium_role_id && cache.has(roles.premium_role_id)) return "premium";
    if (roles.plus_role_id && cache.has(roles.plus_role_id)) return "plus";
  }
  return store.getRank(member.guild.id, member.id)?.rank_key || null;
}

function voiceRankLabel(member) {
  return rankByKey(voiceRankKey(member))?.label || null;
}

function rankLine(member) {
  if (!member) return "Your rank: Member";
  if (isServerOwner(member)) return "Your rank: Guild Owner";
  const tier = staffByKey(staffTier(member));
  if (tier) return `Your rank: ${tier.key} - ${tier.title.toLowerCase()}`;
  const voice = voiceRankLabel(member);
  if (voice) return `Your rank: ${voice}`;
  return "Your rank: Member";
}

function canUseRankCommand(member, command) {
  if (!member) return false;
  const name = command === "stfu" ? "stsu" : command === "unstfu" ? "unstsu" : command;
  if (isServerOwner(member) || isBotOwner(member.id) || hasStaff(member, "founder")) return true;
  if (FOUNDER_COMMANDS.has(name)) return false;
  return commandsForRank(voiceRankKey(member)).includes(name);
}

function canGhost(member) {
  if (!member?.guild) return false;
  if (isServerOwner(member) || isBotOwner(member.id) || hasStaff(member, "founder")) return true;
  const roles = store.getVoiceRoles(member.guild.id);
  const configured = !!(roles?.premium_role_id || roles?.premium_plus_role_id);
  if (!configured) return true;
  const key = voiceRankKey(member);
  return key === "premium" || key === "premiumplus";
}

function requirementFor(command) {
  const name = command === "stfu" ? "stsu" : command === "unstfu" ? "unstsu" : command;
  return REQUIREMENT[name] || "a VC rank";
}

function ladderText() {
  return [
    "**Gods and Founders** can use every voice command without a VC rank.",
    "**Voice Premium Plus** — voiceoverride, muteall, unmuteall, stsu, unstsu, plus Voice Premium",
    "**Voice Premium** — follow, chain, unfollow, bring, forceclaim, inspect",
    "**Voice Plus** — inspect",
    "",
    "Only Gods can add or remove these roles, and only with the bot."
  ].join("\n");
}

module.exports = {
  LADDER,
  STAFF,
  LOG_CATEGORIES,
  ANTINUKE_LOG,
  PUNISHMENT_LOG,
  VOICE_COMMANDS,
  isBotOwner,
  isServerOwner,
  isAntinukeAdmin,
  isManagement,
  staffByKey,
  staffTier,
  hasStaff,
  isGod,
  canGrantStaff,
  canAssignRanks,
  canManageManagement,
  canManageGodmode,
  canConfigureLogs,
  canUseLogs,
  canUseChannels,
  canModerate,
  canUseForce,
  canConfigureBot,
  canRestart,
  canSetup,
  parseRank,
  rankByKey,
  commandsForRank,
  voiceRankKey,
  voiceRankLabel,
  rankLine,
  canUseRankCommand,
  canGhost,
  requirementFor,
  ladderText
};
