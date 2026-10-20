const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } = require("discord.js");
const { ACCENT } = require("./constants");
const access = require("../systems/access");

const WHO = {
  ban: "Gods+", "ban check": "Gods+", "ban list": "Gods+", "ban purge": "Gods+", "ban recent": "Gods+",
  banned: "Gods+", softban: "Gods+", tempban: "Gods+", unban: "Gods+", unbanall: "Gods+",
  mkick: "Owner",
  hardban: "Gods+", foreverban: "Gods+", foreverunban: "Gods+", pban: "Gods+", "personal ban": "Gods+", "role add": "Gods+",
  "fp add": "Gods+", "fp remove": "Gods+", "fp list": "Gods+", "fp reset": "Gods+", "fp template": "Gods+",
  serversetup: "Gods+", jail: "Gods+", unjail: "Gods+", cmute: "Gods+", chatmute: "Gods+",
  imute: "Gods+", imagemute: "Gods+", rmute: "Gods+", reactionmute: "Gods+",
  mute: "Gods+", servermute: "Gods+", "cam set": "Gods+", camblacklist: "Gods+", "camblacklist set": "Gods+",
  avatar: "Everyone", banner: "Everyone", serverinfo: "Everyone", userinfo: "Everyone", roles: "Everyone",
  lock: "Founder+", unlock: "Founder+", hide: "Founder+", unhide: "Founder+",
  lockall: "Founder+", unlockall: "Founder+", nuke: "Founder+ · 25s", lockdown: "Founder+", unlockdown: "Founder+",
  logging: "Gods+", "logging set": "Gods+", "logging remove": "Gods+", "logging test": "Gods+", logs: "Gods+",
  auditlog: "Everyone",
  modlogreset: "Gods+",
  "role limit set": "Gods+", "role limit remove": "Gods+", "role limit view": "Gods+",
  vc: "Everyone", "vc setup": "Owner", "vc lock": "Everyone", "vc unlock": "Everyone",
  "vc ghost": "Premium+", "vc unghost": "Premium+", "vc kick": "Everyone", "vc reject": "Everyone", "vc ban": "Everyone",
  voiceshield: "Gods+",
  "vc permit": "Everyone", "vc claim": "Everyone · 30s", "vc transfer": "Everyone", "vc limit": "Everyone",
  "vc config": "Gods+", "voicemaster configuration": "Gods+", "vc edit": "Owner", mvc: "Everyone",
  poolsetup: "Owner", stoppool: "Owner", cleanpools: "Owner", poolstatus: "Owner",
  "send interface": "Everyone", ghost: "Premium+", unghost: "Premium+", claim: "Everyone · 30s",
  "vc rank": "Everyone", "vc rank assign": "Verified Seller, CEOs, and the server owner", "vc unrank": "Gods+", "vc rankinfo": "Everyone",
  "voice plus": "Gods+", "voice premium": "Gods+", "vouch premium plus": "Gods+",
  forceownership: "Founder+", voiceoverride: "Premium+", dragall: "Founder+", voicehistory: "Founder+", vchistory: "Founder+",
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
  grant: "Gods+ and authorized Verified Sellers", revoke: "Gods+", "grant list": "Gods+",
  verifiedseller: "CEOs and the server owner", "verifiedseller add": "CEOs and the server owner",
  "verifiedseller remove": "CEOs and the server owner", "verifiedseller addgiver": "CEOs and the server owner",
  "verifiedseller removegiver": "CEOs and the server owner",
  forcemanage: "Founder+", forcenickname: "Founder+", unforcenickname: "Founder+",
  forcerolestrip: "Founder+", unforcerolestrip: "Founder+", rolestrip: "Founder+",
  help: "Everyone", showallcommands: "Everyone", newcommands: "Everyone", afk: "Everyone", "afk mentions": "Everyone", setprefix: "Founder+",
  snipe: "Everyone", s: "Everyone", clearsnipe: "Everyone", cs: "Everyone",
  proof: "Everyone", prooflist: "Everyone", noproof: "Everyone",
  modstats: "Everyone", viewstats: "Everyone", u: "Everyone",
  "alias add": "Founder+", "alias remove": "Founder+", "alias removeall": "Founder+", "alias reset": "Founder+",
  "alias view": "Founder+", "alias list": "Founder+", restart: "Founder+",
  embedcreate: "Everyone", instagram: "Everyone", tiktok: "Everyone", roblox: "Everyone",
  "giveaways start": "Gods+", "giveaways reroll": "Gods+", "gw start": "Gods+", "gw reroll": "Gods+",
  "set gw host": "Gods+", modsetup: "Gods+",
  "vanity set": "Gods+", "vanity reward": "Gods+", vanitysetup: "Gods+", vanity: "Gods+",
  protect: "Verified Sellers can protect a role. Gods and the server owner", unprotect: "Gods and the server owner",
  protected: "Everyone", plist: "Everyone", protectedlist: "Everyone",
  securityconfig: "Owner and Anti-Nuke admins",
  dangerouspermissionsadd: "Owner and Anti-Nuke admins",
  dangerouspermissionsupdate: "Owner and Anti-Nuke admins",
  vanityprotection: "Owner and Anti-Nuke admins",
  denybotjoins: "Owner and Anti-Nuke admins",
  massmemberkick: "Owner and Anti-Nuke admins",
  massmemberban: "Owner and Anti-Nuke admins",
  setwatchrole: "Owner and Anti-Nuke admins",
  watchuser: "Owner and Anti-Nuke admins",
  unwatchuser: "Owner and Anti-Nuke admins",
  "antinuke setup": "Owner and anti-nuke administrators",
  antinukeconfig: "Owner and anti-nuke administrators",
  antinukestatus: "Owner and anti-nuke administrators",
  antinuketest: "Owner and anti-nuke administrators",
  antinukelogs: "Owner and anti-nuke administrators",
  antinukelockdown: "Owner and anti-nuke administrators",
  antinukeunlock: "Owner and anti-nuke administrators",
  "antinukewhitelist add": "Owner and anti-nuke administrators",
  "antinukewhitelist remove": "Owner and anti-nuke administrators",
  "antinukewhitelist list": "Owner and anti-nuke administrators",
  "antinuke snapshot": "Owner and anti-nuke administrators",
  "antinuke recovery": "Owner and anti-nuke administrators",
  antinukealloff: "Owner and anti-nuke administrators"
};

function line(prefix, command, blurb) {
  const who = WHO[command];
  return who ? `\`${prefix}${command}\` ${blurb} · ${who}` : `\`${prefix}${command}\` ${blurb}`;
}

function block(prefix, rows) {
  return rows.map(([command, blurb]) => line(prefix, command, blurb)).join("\n");
}

function rawCategories(prefix) {
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
      ["mkick", "mass kick by server tag, vanity, or everyone"],
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
      ["cam set", "choose the camera role"],
      ["auditlog", "recent mutes, deafens, disconnects, timeouts, and bans"]
    ])],
    ["Info", block(prefix, [
      ["avatar", "show an avatar"],
      ["banner", "show a banner"],
      ["serverinfo", "server details"],
      ["userinfo", "user details"],
      ["roles", "list roles and member counts"],
      ["snipe", "deleted messages from the last 2 hours"],
      ["s", "alias of snipe"],
      ["clearsnipe", "clear deleted message history"],
      ["cs", "alias of clearsnipe"],
      ["modstats", "moderation actions issued"],
      ["viewstats", "voice time and messages"],
      ["u", "activity card"],
      ["proof", "images a member sent since joining"],
      ["prooflist", "who has uploaded an image"],
      ["noproof", "who has not uploaded an image"]
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
      ["claim", "claim an empty VC"],
      ["poolsetup", "create standby voice pools"],
      ["stoppool", "stop making new pools"],
      ["cleanpools", "delete empty unclaimed pools"],
      ["poolstatus", "show pool counts"]
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
      ["vchistory", "who joined and left a call"],
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
      ["rolestrip", "strip a role, with exemptions"]
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
    ["Protection", block(prefix, [
      ["protect", "protect a role or user"],
      ["unprotect", "undo a role or user you protected"],
      ["protected", "people you protect"],
      ["plist", "everyone protected"],
      ["protectedlist", "everyone protected"]
    ])],
    ["Security", block(prefix, [
      ["securityconfig", "view modules and thresholds"],
      ["dangerouspermissionsadd", "ban and undo administrator grants"],
      ["dangerouspermissionsupdate", "ban and undo dangerous grants"],
      ["vanityprotection", "restore the server vanity and ban"],
      ["denybotjoins", "ban new bots and whoever added them"],
      ["massmemberkick", "kick burst threshold and punishment"],
      ["massmemberban", "ban burst threshold and punishment"],
      ["setwatchrole", "log when a role is given or removed"],
      ["watchuser", "log a member's moderation"],
      ["unwatchuser", "stop watching a member"]
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
      ["newcommands", "what was just added"],
      ["antinuke setup", "start anti-nuke setup"],
      ["antinukeconfig", "edit anti-nuke settings"],
      ["antinukestatus", "protection health"],
      ["antinuketest", "simulated anti-nuke test"],
      ["antinukelogs", "recent incidents"],
      ["antinukelockdown", "start lockdown"],
      ["antinukeunlock", "end lockdown"],
      ["antinukewhitelist add", "trust a user or bot"],
      ["antinukewhitelist remove", "remove a trusted account"],
      ["antinukewhitelist list", "show trusted accounts"],
      ["antinuke snapshot", "save channels and roles"],
      ["antinuke recovery", "restore from a snapshot"],
      ["antinukealloff", "turn every anti-nuke action off"],
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

const CATEGORY_ORDER = ["Moderation", "Voice Management", "Vouch", "Role Management", "Verified Seller"];

const VOICE_NAMES = new Set([
  "ghost", "unghost", "claim", "muteall", "unmuteall", "dragall", "follow", "chain",
  "unfollow", "bring", "inspect", "forceclaim", "stsu", "unstsu", "shield", "unshield",
  "godmode", "ungodmode", "forceownership", "mvc", "send interface"
]);

const SECURITY_NAMES = new Set([
  "securityconfig", "dangerouspermissionsadd", "dangerouspermissionsupdate", "vanityprotection",
  "denybotjoins", "massmemberkick", "massmemberban", "setwatchrole", "unwatchrole", "watchuser", "unwatchuser",
  "antinuke setup", "antinukeconfig", "antinukestatus", "antinuketest", "antinukelogs", "antinukelockdown",
  "antinukeunlock", "antinukewhitelist add", "antinukewhitelist remove", "antinukewhitelist list",
  "antinuke snapshot", "antinuke recovery", "antinukealloff"
]);

function commandOf(line, prefix) {
  const match = /^`([^`]+)`/.exec(line);
  if (!match) return "";
  const shown = match[1];
  return shown.startsWith(prefix) ? shown.slice(prefix.length) : shown;
}

function place(command) {
  const name = String(command || "").toLowerCase();
  if (name.startsWith("verifiedseller") || name === "grant" || name === "revoke" || name === "grant list") return "Verified Seller";
  if (name.includes("vouch")) return "Vouch";
  if (name.includes("vc") || name.includes("voice") || VOICE_NAMES.has(name)) return "Voice Management";
  if (SECURITY_NAMES.has(name)) return "Moderation";
  if (name === "plist" || name.includes("limit") || name.includes("role") || name.includes("protect") || name.includes("force") || name.includes("strip")) return "Role Management";
  return "Moderation";
}

function categories(prefix) {
  const buckets = new Map(CATEGORY_ORDER.map((name) => [name, []]));
  for (const category of rawCategories(prefix)) {
    for (const line of String(category.value || "").split("\n").filter(Boolean)) {
      buckets.get(place(commandOf(line, prefix))).push(line);
    }
  }
  const seller = block(prefix, [
    ["verifiedseller", "view the role, sellers, and commands they can grant"],
    ["verifiedseller add", "make someone a verified seller"],
    ["verifiedseller remove", "remove a verified seller"],
    ["verifiedseller addgiver", "let verified sellers grant a command"],
    ["verifiedseller removegiver", "stop verified sellers granting a command"]
  ]).split("\n").filter(Boolean);
  const existing = new Set(buckets.get("Verified Seller"));
  for (const line of seller) {
    if (!existing.has(line)) buckets.get("Verified Seller").push(line);
  }
  return CATEGORY_ORDER.map((name) => ({ name, value: buckets.get(name).join("\n") }));
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
  const userId = member?.id || "";
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
      .setCustomId(`spanter:commands:cat:${userId}`)
      .setPlaceholder("Jump to a category")
      .addOptions(options)
  );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`spanter:commands:${userId}:${safe - 1}`).setLabel("Back").setStyle(ButtonStyle.Secondary).setDisabled(safe <= 0),
    new ButtonBuilder().setCustomId(`spanter:commands:${userId}:${safe + 1}`).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(safe >= pages.length - 1)
  );
  return { embeds: [embed], components: [menu, row] };
}

function newCommandsMessage(prefix = "-", member = null) {
  const p = prefix;
  const lines = [
    "What was just added.",
    "",
    "**Voice pools**",
    `\`${p}poolsetup\` — standby voice channels`,
    `\`${p}poolstatus\` — empty, claimed, and refill`,
    `\`${p}stoppool\` — stop new pools`,
    `\`${p}cleanpools\` — delete empty unclaimed pools`,
    "",
    "**Verified Seller**",
    `\`${p}verifiedseller @role\` — set the one seller role`,
    `\`${p}verifiedseller add @user\` — make them a verified seller`,
    `\`${p}verifiedseller remove @user\` — take the rank off`,
    `\`${p}verifiedseller addgiver <command>\` — let sellers grant that command`,
    `\`${p}verifiedseller removegiver <command>\` — stop that grant`,
    "Sellers can assign a VC rank and protect a role.",
    "",
    "**Security**",
    `\`${p}securityconfig\` — see which modules are on`,
    `\`${p}dpa\` — undo administrator on a role, then ban`,
    `\`${p}dpu\` — undo ban, kick, manage server, or webhooks, then ban`,
    `\`${p}vp\` — put the vanity back and ban who changed it`,
    `\`${p}dbj\` — ban a new bot and whoever added it`,
    `\`${p}mmk\` / \`${p}mmb\` — punish a kick or ban burst`,
    `\`${p}setwatchrole @role\` — log when that role is given`,
    `\`${p}watchuser @user\` — log what that member does`,
    "",
    "**Also new**",
    `\`${p}mkick\` — owner mass kick by server tag, vanity, or everyone`,
    `\`${p}u @user\` — activity card`,
    `\`${p}proof @user\` — images they posted since joining`,
    `\`${p}auditlog @user\` — recent mutes, bans, and voice actions`,
    `\`${p}vchistory #channel\` — who joined and left that call`,
    `\`${p}unprotect\` — undo a protection you set`,
    "",
    "**Anti-nuke**",
    `\`${p}antinuke setup\` — turn protection on`,
    `\`${p}antinukeconfig\` — edit modules and thresholds`,
    `\`${p}antinukestatus\` — what is on and the last incident`,
    "Empty voice deletes are allowed. Deleting a voice channel with people in it kicks that person.",
    `\`${p}antinukealloff\` — stop every anti-nuke action`
  ];
  const rank = member ? access.rankLine(member) : "";
  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle("New Commands")
    .setDescription(lines.join("\n").slice(0, 4096))
    .setFooter({ text: rank || "Everyone" });
  return { embeds: [embed] };
}

module.exports = { categories, commandPages, pageMessage, newCommandsMessage, splitField };
