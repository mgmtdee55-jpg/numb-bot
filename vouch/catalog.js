const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } = require("discord.js");
const { ACCENT } = require("./constants");
const access = require("../systems/access");

const WHO = {
  ban: "Gods+", "ban check": "Gods+", "ban list": "Gods+", "ban purge": "Gods+", "ban recent": "Gods+",
  banned: "Gods+", softban: "Gods+", tempban: "Gods+", unban: "Gods+", unbanall: "Gods+",
  hardban: "Gods+", foreverban: "Gods+", foreverunban: "Gods+", pban: "Gods+", "personal ban": "Gods+", "role add": "Gods+",
  "fp add": "Gods+", "fp remove": "Gods+", "fp list": "Gods+", "fp reset": "Gods+", "fp template": "Gods+",
  serversetup: "Gods+", jail: "Gods+", unjail: "Gods+", cmute: "Gods+", chatmute: "Gods+",
  imute: "Gods+", imagemute: "Gods+", rmute: "Gods+", reactionmute: "Gods+",
  mute: "Gods+", servermute: "Gods+", "cam set": "Gods+", camblacklist: "Gods+", "camblacklist set": "Gods+",
  avatar: "Everyone", banner: "Everyone", serverinfo: "Everyone", userinfo: "Everyone",
  lock: "Founder+", unlock: "Founder+", hide: "Founder+", unhide: "Founder+",
  lockall: "Founder+", unlockall: "Founder+", nuke: "Founder+ · 25s", lockdown: "Founder+", unlockdown: "Founder+",
  logging: "Gods+", "logging set": "Gods+", "logging remove": "Gods+", "logging test": "Gods+", logs: "Gods+",
  modlogreset: "Gods+",
  "role limit set": "Gods+", "role limit remove": "Gods+", "role limit view": "Gods+",
  vc: "Everyone", "vc setup": "Owner", "vc lock": "Everyone", "vc unlock": "Everyone",
  "vc ghost": "Premium+", "vc unghost": "Premium+", "vc kick": "Everyone", "vc reject": "Everyone", "vc ban": "Everyone",
  voiceshield: "Gods+",
  "vc permit": "Everyone", "vc claim": "Everyone · 30s", "vc transfer": "Everyone", "vc limit": "Everyone",
  "vc config": "Gods+", "voicemaster configuration": "Gods+", "vc edit": "Owner", mvc: "Everyone",
  "send interface": "Everyone", ghost: "Premium+", unghost: "Premium+", claim: "Everyone · 30s",
  "vc rank": "Everyone", "vc rank assign": "Gods+", "vc unrank": "Gods+", "vc rankinfo": "Everyone",
  "voice plus": "Gods+", "voice premium": "Gods+", "vouch premium plus": "Gods+",
  forceownership: "Founder+", voiceoverride: "Premium+", dragall: "Founder+", voicehistory: "Founder+",
  godmode: "Founder+", ungodmode: "Founder+", muteall: "Gods+", unmuteall: "Gods+",
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
  grant: "Gods+", revoke: "Gods+", "grant list": "Gods+",
  forcemanage: "Founder+", forcenickname: "Founder+", unforcenickname: "Founder+",
  forcerolestrip: "Founder+", unforcerolestrip: "Founder+", rolestrip: "Founder+",
  help: "Everyone", showallcommands: "Everyone", afk: "Everyone", "afk mentions": "Everyone", setprefix: "Founder+",
  snipe: "Everyone", s: "Everyone", clearsnipe: "Everyone", cs: "Everyone",
  modstats: "Everyone", viewstats: "Everyone",
  "alias add": "Founder+", "alias remove": "Founder+", "alias removeall": "Founder+", "alias reset": "Founder+",
  "alias view": "Founder+", "alias list": "Founder+", restart: "Founder+",
  embedcreate: "Everyone", instagram: "Everyone", tiktok: "Everyone", roblox: "Everyone",
  "giveaways start": "Gods+", "giveaways reroll": "Gods+", "gw start": "Gods+", "gw reroll": "Gods+",
  "set gw host": "Gods+", modsetup: "Gods+",
  "vanity set": "Gods+", "vanity reward": "Gods+", vanitysetup: "Gods+", vanity: "Gods+"
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
      ["pban", "personal ban that only the banner or owner can lift"],
      ["role add", "give a role"],
      ["fp add", "grant a fake permission"],
      ["fp remove", "take a fake permission"],
      ["fp list", "list fake permissions"],
      ["fp reset", "clear fake permissions"],
      ["fp template", "save or load a template"],
      ["serversetup", "jail and mute setup"],
      ["jail", "strip roles and show only jail"],
      ["unjail", "give the jailed roles back"],
      ["cmute", "stop someone typing"],
      ["imute", "stop someone sending images"],
      ["rmute", "stop someone reacting"],
      ["mute", "ask server mute or chat mute"],
      ["servermute", "server mute in voice"],
      ["camblacklist", "take camera roles"],
      ["cam set", "choose the camera role"]
    ])],
    ["Info", block(prefix, [
      ["avatar", "show an avatar"],
      ["banner", "show a banner"],
      ["serverinfo", "server details"],
      ["userinfo", "user details"],
      ["snipe", "deleted messages from the last 2 hours"],
      ["s", "alias of snipe"],
      ["clearsnipe", "clear deleted message history"],
      ["cs", "alias of clearsnipe"],
      ["modstats", "moderation actions issued"],
      ["viewstats", "voice time and messages"]
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
      ["logs", "alias of logging"],
      ["modlogreset", "clear saved log channels"]
    ])],
    ["Role Limits", block(prefix, [
      ["role limit set", "cap a role"],
      ["role limit remove", "clear a role cap"],
      ["role limit view", "show role caps"]
    ])],
    ["Voice", block(prefix, [
      ["vc", "open your VC panel"],
      ["vc setup", "VoiceMaster setup"],
      ["vc edit", "connect auto-unmute or random join"],
      ["vc lock", "lock your VC"],
      ["vc unlock", "unlock your VC"],
      ["vc ghost", "hide your VC"],
      ["vc unghost", "show your VC"],
      ["vc kick", "kick from your VC"],
      ["vc reject", "block joining, channel stays visible"],
      ["vc ban", "block joining, channel stays visible"],
      ["vc permit", "join a locked or full VC"],
      ["vc claim", "claim an empty VC"],
      ["vc transfer", "give your VC to someone in it"],
      ["vc config", "view VoiceMaster settings"],
      ["voicemaster configuration", "view VoiceMaster settings"],
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
      ["voiceshield", "block VC kick, ban, and reject"],
      ["dragall", "pull one VC into yours"],
      ["voicehistory", "recent voice moves"],
      ["godmode", "protect from server mute"],
      ["ungodmode", "clear voice godmode"],
      ["muteall", "mute your current VC"],
      ["unmuteall", "unmute your current VC"],
      ["shield", "keep a member in VC"],
      ["unshield", "clear a shield"],
      ["follow", "follow a member"],
      ["chain", "follow their follows"],
      ["unfollow", "stop following"],
      ["bring", "pull one member"],
      ["inspect", "view voice state"],
      ["forceclaim", "become the VC owner"],
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
      ["antinuke admin list", "list antinuke admins"],
      ["grant", "whitelist one command"],
      ["revoke", "remove a command whitelist"],
      ["grant list", "list command whitelists"]
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
    ["Social", block(prefix, [
      ["instagram", "view a profile (ig, insta)"],
      ["tiktok", "view a TikTok profile"],
      ["roblox", "view a Roblox profile"]
    ])],
    ["Vanity", block(prefix, [
      ["vanity set", "set the status word"],
      ["vanity reward", "set the reward roles"],
      ["vanitysetup", "open the vanity panel"]
    ])],
    ["Giveaways", block(prefix, [
      ["giveaways start", "start a giveaway"],
      ["giveaways reroll", "pick a new winner"],
      ["gw start", "alias of giveaways start"],
      ["gw reroll", "alias of giveaways reroll"],
      ["set gw host", "set the host role"]
    ])],
    ["Bot", block(prefix, [
      ["help", "open the category menu"],
      ["showallcommands", "this list"],
      ["embedcreate", "build an embed"],
      ["setprefix", "change the prefix"],
      ["alias add", "add a shortcut"],
      ["alias remove", "remove a shortcut"],
      ["alias removeall", "remove aliases for one command"],
      ["alias view", "show what an alias runs"],
      ["alias list", "list shortcuts"],
      ["alias reset", "clear every alias"],
      ["restart", "restart the bot"],
      ["afk", "set an away status"],
      ["afk mentions", "see who mentioned you"]
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

function commandPages(prefix = "-") {
  const pages = [];
  for (const category of categories(prefix)) {
    const lines = String(category.value || "").split("\n").filter(Boolean);
    const chunks = [];
    for (let index = 0; index < lines.length; index += 12) chunks.push(lines.slice(index, index + 12));
    if (!chunks.length) chunks.push(["No commands."]);
    chunks.forEach((chunk, index) => {
      pages.push({
        name: category.name,
        title: chunks.length > 1 ? `${category.name} · ${index + 1}/${chunks.length}` : category.name,
        description: chunk.join("\n")
      });
    });
  }
  return pages;
}

function pageMessage(prefix = "-", index = 0, member = null) {
  const pages = commandPages(prefix);
  const safe = Math.min(Math.max(pages.length - 1, 0), Math.max(0, Number(index) || 0));
  const page = pages[safe];
  const rank = member ? access.rankLine(member) : "";
  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(page.title)
    .setDescription(page.description.slice(0, 4096))
    .setFooter({ text: [`Page ${safe + 1} / ${pages.length}`, rank].filter(Boolean).join(" · ") });
  const seen = new Set();
  const options = [];
  pages.forEach((item, index) => {
    if (seen.has(item.name) || options.length >= 25) return;
    seen.add(item.name);
    options.push({
      label: item.name.slice(0, 100),
      value: String(index),
      default: item.name === page.name
    });
  });
  const menu = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("spanter:commands:cat")
      .setPlaceholder("Jump to a category")
      .addOptions(options)
  );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`spanter:commands:${safe - 1}`).setLabel("Back").setStyle(ButtonStyle.Secondary).setDisabled(safe <= 0),
    new ButtonBuilder().setCustomId(`spanter:commands:${safe + 1}`).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(safe >= pages.length - 1)
  );
  return { embeds: [embed], components: [menu, row] };
}

module.exports = { categories, commandPages, pageMessage, splitField };
