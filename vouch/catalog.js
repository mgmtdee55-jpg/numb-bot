const { EmbedBuilder } = require("discord.js");
const { ACCENT } = require("./constants");

const WHO = {
  ban: "Gods+", "ban check": "Gods+", "ban list": "Gods+", "ban purge": "Gods+", "ban recent": "Gods+",
  banned: "Gods+", softban: "Gods+", tempban: "Gods+", unban: "Gods+", unbanall: "Gods+",
  hardban: "Gods+", foreverban: "Gods+", foreverunban: "Gods+", "role add": "Gods+",
  "fp add": "Gods+", "fp remove": "Gods+", "fp list": "Gods+", "fp reset": "Gods+", "fp template": "Gods+",
  avatar: "Everyone", banner: "Everyone", serverinfo: "Everyone", userinfo: "Everyone",
  lock: "Founder+", unlock: "Founder+", hide: "Founder+", unhide: "Founder+",
  lockall: "Founder+", unlockall: "Founder+", nuke: "Founder+ · 25s", lockdown: "Founder+", unlockdown: "Founder+",
  logging: "Gods+", "logging set": "Gods+", "logging remove": "Gods+", "logging test": "Gods+", logs: "Gods+",
  "role limit set": "Gods+", "role limit remove": "Gods+", "role limit view": "Gods+",
  vc: "Everyone", "vc setup": "Owner", "vc lock": "Everyone", "vc unlock": "Everyone",
  "vc ghost": "Premium+", "vc unghost": "Premium+", "vc kick": "Everyone", "vc ban": "Everyone",
  "vc permit": "Everyone", "vc claim": "Everyone · 30s", "vc limit": "Everyone", mvc: "Everyone",
  "send interface": "Everyone", ghost: "Premium+", unghost: "Premium+", claim: "Everyone · 30s",
  "vc rank": "Everyone", "vc rank assign": "Gods+", "vc unrank": "Gods+", "vc rankinfo": "Everyone",
  "voice plus": "Gods+", "voice premium": "Gods+", "vouch premium plus": "Gods+",
  forceownership: "Founder+", voiceoverride: "Premium+", dragall: "Founder+", voicehistory: "Founder+",
  godmode: "Founder+", ungodmode: "Founder+", muteall: "Premium+", unmuteall: "Premium+",
  shield: "Founder+", unshield: "Founder+", follow: "Premium", chain: "Premium", unfollow: "Premium",
  bring: "Premium", inspect: "Plus+", forceclaim: "Premium", stsu: "Premium+", unstsu: "Premium+",
  vouch: "Gods+", "vouch give": "Giver+", "vouch take": "Giver+", vouchstrip: "Gods+",
  "antinuke vouch": "Gods+", "antinuke vouch set": "Gods+", "antinuke vouch founder": "Gods+",
  "antinuke vouch unset": "Gods+", "antinuke vouch addgiver": "Vouch admin+", "antinuke vouch removegiver": "Vouch admin+",
  "antinuke vouch list": "Gods+", "antinuke vouch cleanup": "Gods+",
  "antinuke vouch limit global": "Gods+", "antinuke vouch limit giver": "Gods+", "antinuke vouch limit user": "Gods+",
  "antinuke vouch limit remove": "Gods+", "antinuke vouch limit view": "Gods+",
  "vouch admin allow": "Gods+", "vouch admin remove": "Gods+",
  "vouchblacklist add": "Gods+", "vouchblacklist remove": "Gods+", "vouchblacklist list": "Gods+",
  "setrole stripstaff": "Gods+", "vouch setrole": "Gods+", "vouch unsetrole": "Gods+",
  "ceo add": "Owner", "ceo remove": "Owner", "founder add": "Gods+", "founder remove": "Gods+",
  "boss add": "Founder+", "boss remove": "Founder+", "antinuke admins": "Everyone",
  "antinuke admin add": "Owner", "antinuke admin remove": "Owner", "antinuke admin list": "Everyone",
  "god add": "Gods+", "god take": "Gods+", "god info": "Gods+",
  "m add": "Gods+", "m take": "Gods+", "m list": "Gods+",
  forcemanage: "Founder+", forcenickname: "Founder+", unforcenickname: "Founder+",
  forcerolestrip: "Founder+", unforcerolestrip: "Founder+", rolestrip: "Founder+",
  help: "Everyone", showallcommands: "Everyone", afk: "Everyone", setprefix: "Founder+",
  "alias add": "Founder+", "alias remove": "Founder+", "alias list": "Founder+", restart: "Founder+",
  modsetup: "Gods+"
};

function line(prefix, command, blurb) {
  const who = WHO[command];
  return who ? `\`${prefix}${command}\` ${blurb} · ${who}` : `\`${prefix}${command}\` ${blurb}`;
}

function block(prefix, rows) {
  return rows.map(([command, blurb]) => line(prefix, command, blurb)).join("\n");
}

function categories(prefix) {
  return [
    ["Moderation", block(prefix, [
      ["ban", "ban a member"],
      ["ban check", "check a ban"],
      ["ban list", "list bans"],
      ["ban purge", "set deleted message days"],
      ["ban recent", "recent ban actions"],
      ["banned", "check one user"],
      ["softban", "ban, then unban"],
      ["tempban", "timed ban"],
      ["unban", "lift a ban"],
      ["unbanall", "unban everyone"],
      ["hardban", "ban that blocks unban"],
      ["foreverban", "owner-tier ban"],
      ["foreverunban", "lift a foreverban"],
      ["role add", "give a role"],
      ["fp add", "grant a fake permission"],
      ["fp remove", "take a fake permission"],
      ["fp list", "list fake permissions"],
      ["fp reset", "clear fake permissions"],
      ["fp template", "save or load a template"]
    ])],
    ["Info", block(prefix, [
      ["avatar", "show an avatar"],
      ["banner", "show a banner"],
      ["serverinfo", "server details"],
      ["userinfo", "user details"]
    ])],
    ["Channels", block(prefix, [
      ["lock", "lock a channel"],
      ["unlock", "unlock a channel"],
      ["hide", "hide a channel"],
      ["unhide", "show a channel"],
      ["lockall", "lock all text channels"],
      ["unlockall", "unlock all text channels"],
      ["nuke", "clone and delete a channel"],
      ["lockdown", "lock the server"],
      ["unlockdown", "clear a lockdown"]
    ])],
    ["Logging", block(prefix, [
      ["logging", "view log channels"],
      ["logging set", "set a log channel"],
      ["logging remove", "clear a log channel"],
      ["logging test", "send a test log"],
      ["logs", "alias of logging"]
    ])],
    ["Role Limits", block(prefix, [
      ["role limit set", "cap a role"],
      ["role limit remove", "clear a role cap"],
      ["role limit view", "show role caps"]
    ])],
    ["Voice", block(prefix, [
      ["vc", "open your VC panel"],
      ["vc setup", "VoiceMaster setup"],
      ["vc lock", "lock your VC"],
      ["vc unlock", "unlock your VC"],
      ["vc ghost", "hide your VC"],
      ["vc unghost", "show your VC"],
      ["vc kick", "kick from your VC"],
      ["vc ban", "ban from your VC"],
      ["vc permit", "allow into your VC"],
      ["vc claim", "claim an empty VC"],
      ["vc limit", "set the VC user limit"],
      ["mvc", "voice stats"],
      ["send interface", "restore a VC panel"],
      ["ghost", "hide your VC"],
      ["unghost", "show your VC"],
      ["claim", "claim an empty VC"]
    ])],
    ["VC Ranks", block(prefix, [
      ["vc rank", "list ranked members"],
      ["vc rank assign", "assign a VC rank"],
      ["vc unrank", "remove a VC rank"],
      ["vc rankinfo", "show a member's rank"],
      ["voice plus", "set the plus role"],
      ["voice premium", "set the premium role"],
      ["vouch premium plus", "set the premium plus role"],
      ["forceownership", "take VC ownership"],
      ["voiceoverride", "bypass a VC lock"],
      ["dragall", "pull members to you"],
      ["voicehistory", "recent voice moves"],
      ["godmode", "protect from server mute"],
      ["ungodmode", "clear voice godmode"],
      ["muteall", "mute the VC"],
      ["unmuteall", "unmute the VC"],
      ["shield", "keep a member in VC"],
      ["unshield", "clear a shield"],
      ["follow", "follow a member"],
      ["chain", "follow their follows"],
      ["unfollow", "stop following"],
      ["bring", "pull one member"],
      ["inspect", "view voice state"],
      ["forceclaim", "take over a VC"],
      ["stsu", "keep a member server-muted"],
      ["unstsu", "clear that mute"]
    ])],
    ["Vouch", block(prefix, [
      ["vouch", "open the vouch menu"],
      ["vouch give", "vouch a member"],
      ["vouch take", "remove a vouch"],
      ["vouchstrip", "clear a giver's vouches"],
      ["antinuke vouch", "view vouch config"],
      ["antinuke vouch set", "bind reward role"],
      ["antinuke vouch founder", "set founder role"],
      ["antinuke vouch unset", "clear linked roles"],
      ["antinuke vouch addgiver", "add a giver"],
      ["antinuke vouch removegiver", "remove a giver"],
      ["antinuke vouch list", "list vouches"],
      ["antinuke vouch cleanup", "prune leavers"],
      ["antinuke vouch limit global", "global cap"],
      ["antinuke vouch limit giver", "giver cap"],
      ["antinuke vouch limit user", "user cap"],
      ["antinuke vouch limit remove", "clear a cap"],
      ["antinuke vouch limit view", "show caps"],
      ["vouch admin allow", "add a vouch admin"],
      ["vouch admin remove", "remove a vouch admin"],
      ["vouchblacklist add", "block vouches"],
      ["vouchblacklist remove", "unblock a user"],
      ["vouchblacklist list", "list blocks"],
      ["setrole stripstaff", "set strip role"],
      ["modsetup", "set roles and logs"],
      ["vouch setrole", "bind vouch role"],
      ["vouch unsetrole", "clear vouch role"]
    ])],
    ["Staff", block(prefix, [
      ["ceo add", "add God"],
      ["ceo remove", "remove God"],
      ["founder add", "add Founder"],
      ["founder remove", "remove Founder"],
      ["boss add", "add Boss"],
      ["boss remove", "remove Boss"],
      ["antinuke admins", "staff registry"],
      ["antinuke admin add", "add an antinuke admin"],
      ["antinuke admin remove", "remove an antinuke admin"],
      ["antinuke admin list", "list antinuke admins"]
    ])],
    ["Godmode", block(prefix, [
      ["god add", "give godmode"],
      ["god take", "remove godmode"],
      ["god info", "godmode status"],
      ["m add", "grant management"],
      ["m take", "remove management"],
      ["m list", "list management"]
    ])],
    ["Force", block(prefix, [
      ["forcemanage", "open the force menu"],
      ["forcenickname", "force a nickname"],
      ["unforcenickname", "clear a nickname"],
      ["forcerolestrip", "block one role"],
      ["unforcerolestrip", "clear a role block"],
      ["rolestrip", "strip a role from everyone"]
    ])],
    ["Bot", block(prefix, [
      ["help", "open the category menu"],
      ["showallcommands", "this list"],
      ["setprefix", "change the prefix"],
      ["alias add", "add a shortcut"],
      ["alias remove", "remove a shortcut"],
      ["alias list", "list shortcuts"],
      ["restart", "restart the bot"],
      ["afk", "set an away status"]
    ])]
  ].map(([name, value]) => ({ name, value }));
}

function splitField(field) {
  if (field.value.length <= 1000) return [field];
  const parts = [];
  let current = [];
  let size = 0;
  for (const line of field.value.split("\n")) {
    if (size + line.length + 1 > 1000 && current.length) {
      parts.push(current.join("\n"));
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length) parts.push(current.join("\n"));
  return parts.map((value, index) => ({
    name: index === 0 ? field.name : `${field.name} ${index + 1}`,
    value
  }));
}

function embeds(prefix = "-") {
  const pages = [];
  let fields = [];
  let size = 8;
  const flush = () => {
    if (!fields.length) return;
    pages.push(new EmbedBuilder().setColor(ACCENT).setTitle("Commands").addFields(fields));
    fields = [];
    size = 8;
  };
  for (const field of categories(prefix).flatMap(splitField)) {
    const addition = field.name.length + field.value.length;
    if (fields.length === 8 || size + addition > 5600) flush();
    fields.push(field);
    size += addition;
  }
  flush();
  if (pages.length > 1) {
    pages.forEach((page, index) => page.setTitle(`Commands ${index + 1}/${pages.length}`));
  }
  return pages;
}

module.exports = { categories, embeds };
