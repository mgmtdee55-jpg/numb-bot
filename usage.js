const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } = require("discord.js");

const CYAN = "\u001b[2;36m";
const GREEN = "\u001b[2;32m";
const RESET = "\u001b[0m";
const COLOR = 0x2b2d31;

const SPECS = {
  ban: {
    name: "ban",
    description: "Ban a user from the server.",
    syntax: "ban (user) [$days] [reason] [$silent]",
    example: "ban @user $7 spamming in chat",
    permission: "Ban Members"
  },
  bancheck: {
    name: "ban check",
    description: "Check whether a user is banned.",
    syntax: "ban check (user)",
    example: "ban check @user",
    permission: "Ban Members"
  },
  banned: {
    name: "banned",
    description: "Check whether a user is banned.",
    syntax: "banned (user)",
    example: "banned @user"
  },
  banpurge: {
    name: "ban purge",
    description: "Set how many days of messages a ban deletes.",
    syntax: "ban purge (0-7)",
    example: "ban purge 7",
    permission: "Ban Members"
  },
  hardban: {
    name: "hardban",
    description: "Ban a user and ban them again if they rejoin.",
    syntax: "hardban (user) [reason]",
    example: "hardban @user raiding",
    permission: "Administrator"
  },
  softban: {
    name: "softban",
    description: "Ban a user and unban them to clear their messages.",
    syntax: "softban (user) [reason]",
    example: "softban @user cleanup",
    permission: "Ban Members"
  },
  tempban: {
    name: "tempban",
    description: "Ban a user until a duration ends.",
    syntax: "tempban (user) (duration) [reason]",
    example: "tempban @user 2h spamming",
    permission: "Ban Members"
  },
  unban: {
    name: "unban",
    description: "Unban a user from the server.",
    syntax: "unban (user)",
    example: "unban @user",
    permission: "Ban Members"
  },
  foreverban: {
    name: "foreverban",
    description: "Permanently ban a user. Only foreverunban can lift it.",
    syntax: "foreverban (user) [reason]",
    example: "foreverban @user evading bans",
    permission: "Server owner"
  },
  fb: {
    name: "fb",
    description: "Permanently ban a user. Only foreverunban can lift it.",
    syntax: "fb (user) [reason]",
    example: "fb @user evading bans"
  },
  foreverunban: {
    name: "foreverunban",
    description: "Lift a foreverban.",
    syntax: "foreverunban (user)",
    example: "foreverunban @user",
    permission: "Server owner"
  },
  fub: {
    name: "fub",
    description: "Lift a foreverban.",
    syntax: "fub (user)",
    example: "fub @user"
  },
  role: {
    name: "role",
    description: "Add a role to a member.",
    syntax: "role add (user) (role)",
    example: "role add @user @Mods"
  },
  jail: {
    name: "jail",
    description: "Jail a member and take their other roles.",
    syntax: "jail (user) [reason]",
    example: "jail @user breaking rules"
  },
  unjail: {
    name: "unjail",
    description: "Release a jailed member and give their roles back.",
    syntax: "unjail (user)",
    example: "unjail @user"
  },
  mute: {
    name: "mute",
    description: "Choose a server mute or a chat mute.",
    syntax: "mute (user)",
    example: "mute @user"
  },
  servermute: {
    name: "servermute",
    description: "Server mute a member who is in a voice channel.",
    syntax: "servermute (user)",
    example: "servermute @user"
  },
  cmute: {
    name: "cmute",
    description: "Stop a member from sending messages.",
    syntax: "cmute (user)",
    example: "cmute @user"
  },
  imute: {
    name: "imute",
    description: "Stop a member from sending images.",
    syntax: "imute (user)",
    example: "imute @user"
  },
  rmute: {
    name: "rmute",
    description: "Stop a member from adding reactions.",
    syntax: "rmute (user)",
    example: "rmute @user"
  },
  camblacklist: {
    name: "camblacklist",
    description: "Stop a member from using their camera.",
    syntax: "camblacklist (user)",
    example: "camblacklist @user"
  },
  dragall: {
    name: "dragall",
    description: "Move everyone from a voice channel into yours.",
    syntax: "dragall (channel)",
    example: "dragall #lobby"
  },
  auditlog: {
    name: "auditlog",
    description: "Show recent audit log actions for a user.",
    syntax: "auditlog (user)",
    example: "auditlog @user"
  },
  pban: {
    name: "pban",
    description: "Place a personal ban that only you or the owner can lift.",
    syntax: "pban (user)",
    example: "pban @user"
  },
  instagram: {
    name: "instagram",
    description: "Look up an Instagram profile.",
    syntax: "instagram (username)",
    example: "instagram spanter"
  },
  tiktok: {
    name: "tiktok",
    description: "Look up a TikTok profile.",
    syntax: "tiktok (username)",
    example: "tiktok spanter"
  },
  roblox: {
    name: "roblox",
    description: "Look up a Roblox profile.",
    syntax: "roblox (username)",
    example: "roblox spanter"
  },
  protect: {
    name: "protect",
    description: "Protect a role or one user. You become the only owner of that protection.",
    syntax: "protect (role or user)",
    example: "protect @user",
    permission: "Gods and the server owner"
  },
  unprotect: {
    name: "unprotect",
    description: "Stop owning a role you protected, or take your protection off a user.",
    syntax: "unprotect (role or user)",
    example: "unprotect @user",
    permission: "Gods and the server owner"
  },
  protected: {
    name: "protected",
    description: "List the people you protect.",
    syntax: "protected",
    example: "protected",
    permission: "Everyone"
  },
  plist: {
    name: "plist",
    description: "List every protected role and user in this server.",
    syntax: "plist",
    example: "plist",
    permission: "Everyone"
  },
  protectedlist: {
    name: "protectedlist",
    description: "List every protected role and user in this server.",
    syntax: "protectedlist",
    example: "protectedlist",
    permission: "Everyone"
  },
  proof: {
    name: "proof",
    description: "Browse images a member has sent since they joined.",
    syntax: "proof (user)",
    example: "proof @user",
    permission: "Everyone"
  },
  prooflist: {
    name: "prooflist",
    description: "List members who have uploaded an image since they joined.",
    syntax: "prooflist",
    example: "prooflist",
    permission: "Everyone"
  },
  noproof: {
    name: "noproof",
    description: "List members who have not uploaded an image since they joined.",
    syntax: "noproof",
    example: "noproof",
    permission: "Everyone"
  },
  giveaways: {
    name: "giveaways",
    description: "Start or reroll a giveaway.",
    syntax: "giveaways start [#channel] (duration) (winners) (prize)",
    example: "giveaways start 10m 1 nitro"
  },
  gwhost: {
    name: "set gw host",
    description: "Choose who can host giveaways.",
    syntax: "set gw host (role)",
    example: "set gw host @Giveaway Host"
  },
  vckick: {
    name: "vc kick",
    description: "Remove someone from your voice channel.",
    syntax: "vc kick (user)",
    example: "vc kick @user"
  },
  vcban: {
    name: "vc ban",
    description: "Block someone from joining your voice channel.",
    syntax: "vc ban (user)",
    example: "vc ban @user"
  },
  vcunban: {
    name: "vc unban",
    description: "Let someone join your voice channel again.",
    syntax: "vc unban (user)",
    example: "vc unban @user"
  },
  vcpermit: {
    name: "vc permit",
    description: "Let someone join your locked or full voice channel.",
    syntax: "vc permit (user)",
    example: "vc permit @user"
  },
  vcreject: {
    name: "vc reject",
    description: "Block someone from joining your voice channel.",
    syntax: "vc reject (user)",
    example: "vc reject @user"
  },
  vctransfer: {
    name: "vc transfer",
    description: "Give your voice channel to someone in it.",
    syntax: "vc transfer (user)",
    example: "vc transfer @user"
  },
  vclimit: {
    name: "vc limit",
    description: "Set how many people can join your voice channel.",
    syntax: "vc limit (0-99)",
    example: "vc limit 4"
  },
  kick: {
    name: "kick",
    description: "Remove someone from your voice channel.",
    syntax: "kick (user)",
    example: "kick @user"
  },
  permit: {
    name: "permit",
    description: "Let someone join your locked or full voice channel.",
    syntax: "permit (user)",
    example: "permit @user"
  },
  aliasadd: {
    name: "alias",
    description: "Make a shortcut that runs another command.",
    syntax: "alias add (shortcut) (command)",
    example: "alias add b ban"
  },
  aliasremove: {
    name: "alias",
    description: "Remove a command shortcut.",
    syntax: "alias remove (shortcut)",
    example: "alias remove b"
  },
  aliasremoveall: {
    name: "alias",
    description: "Remove every shortcut for a command.",
    syntax: "alias removeall (command)",
    example: "alias removeall ban"
  },
  aliasview: {
    name: "alias",
    description: "See which command a shortcut runs.",
    syntax: "alias view (shortcut)",
    example: "alias view b"
  },
  forcenickname: {
    name: "forcenickname",
    description: "Keep putting a nickname back if it changes.",
    syntax: "forcenickname (user) (nickname)",
    example: "forcenickname @user muted"
  },
  unforcenickname: {
    name: "unforcenickname",
    description: "Stop enforcing a nickname.",
    syntax: "unforcenickname (user)",
    example: "unforcenickname @user"
  },
  forcestrip: {
    name: "forcestrip",
    description: "Block one user from a role, or strip that role from everyone.",
    syntax: "forcestrip (user) (role)",
    example: "forcestrip @user @Muted"
  },
  grant: {
    name: "grant",
    description: "Let one member use a command.",
    syntax: "grant (command) (user)",
    example: "grant ban @user"
  },
  revoke: {
    name: "revoke",
    description: "Take a granted command away from a member.",
    syntax: "revoke (command) (user)",
    example: "revoke ban @user"
  },
  vcrankassign: {
    name: "vc rank",
    description: "Assign a voice rank to a member. Use breakthru, break, or break thru for Breakthru.",
    syntax: "vc rank assign (user) (rank)",
    example: "vc rank assign @user breakthru"
  },
  vouchlimituser: {
    name: "antinuke vouch limit user",
    description: "Set how many active vouches one member can give.",
    syntax: "antinuke vouch limit user (user) (number)",
    example: "antinuke vouch limit user kutt 3",
    permission: "Gods+"
  },
  limit: {
    name: "limit",
    description: "Limit how many members can hold a role.",
    syntax: "limit (role) (number)",
    example: "limit Mods 5"
  },
  stsu: {
    name: "stsu",
    description: "Keep a member server-muted.",
    syntax: "stsu (user)",
    example: "stsu kutt"
  },
  unstsu: {
    name: "unstsu",
    description: "Stop force-muting a member.",
    syntax: "unstsu (user)",
    example: "unstsu kutt"
  },
  follow: {
    name: "follow",
    description: "Follow a member into voice channels.",
    syntax: "follow (user)",
    example: "follow kutt"
  },
  chain: {
    name: "chain",
    description: "Follow a member and bring people who follow you.",
    syntax: "chain (user)",
    example: "chain kutt"
  },
  bring: {
    name: "bring",
    description: "Move a member into your voice channel.",
    syntax: "bring (user)",
    example: "bring kutt"
  },
  godmode: {
    name: "godmode",
    description: "Turn on voice godmode for a member.",
    syntax: "godmode (user)",
    example: "godmode kutt",
    permission: "Founder+"
  },
  ungodmode: {
    name: "ungodmode",
    description: "Turn off voice godmode for a member.",
    syntax: "ungodmode (user)",
    example: "ungodmode kutt",
    permission: "Founder+"
  },
  shield: {
    name: "shield",
    description: "Shield a member from voice moderation.",
    syntax: "shield (user)",
    example: "shield kutt"
  },
  unshield: {
    name: "unshield",
    description: "Remove a member's voice shield.",
    syntax: "unshield (user)",
    example: "unshield kutt"
  },
  inspect: {
    name: "inspect",
    description: "Show a member's voice status.",
    syntax: "inspect (user)",
    example: "inspect kutt"
  },
  voicehistory: {
    name: "voicehistory",
    description: "Show recent voice events for a member.",
    syntax: "voicehistory (user)",
    example: "voicehistory kutt"
  },
  vchistory: {
    name: "vchistory",
    description: "Show who is in a voice channel and when people joined or left.",
    syntax: "vchistory (channel)",
    example: "vchistory #call",
    permission: "Founder+"
  },
  unrank: {
    name: "unrank",
    description: "Remove a member's voice rank.",
    syntax: "unrank (user)",
    example: "unrank kutt"
  },
  rankinfo: {
    name: "rankinfo",
    description: "Show a member's voice rank.",
    syntax: "rankinfo (user)",
    example: "rankinfo kutt"
  },
  god: {
    name: "god add",
    description: "Give someone Godmode access.",
    syntax: "god add (user)",
    example: "god add kutt",
    permission: "Server owner"
  },
  godtake: {
    name: "god take",
    description: "Remove someone's Godmode access.",
    syntax: "god take (user)",
    example: "god take kutt",
    permission: "Server owner"
  },
  godinfo: {
    name: "god info",
    description: "Show whether someone has Godmode.",
    syntax: "god info (user)",
    example: "god info kutt",
    permission: "Gods+"
  },
  management: {
    name: "management",
    description: "Give or remove Management access.",
    syntax: "management add (user)",
    example: "management add kutt"
  },
  ceo: {
    name: "ceo",
    description: "Add or remove a God.",
    syntax: "ceo add (user)",
    example: "ceo add kutt"
  },
  founder: {
    name: "founder",
    description: "Add or remove a Founder.",
    syntax: "founder add (user)",
    example: "founder add kutt"
  },
  boss: {
    name: "boss",
    description: "Add or remove a Boss.",
    syntax: "boss add (user)",
    example: "boss add kutt"
  },
  antinukeadmin: {
    name: "antinuke admin",
    description: "Add or remove an Anti-Nuke admin.",
    syntax: "antinuke admin add (user)",
    example: "antinuke admin add kutt"
  },
  vouchlimitremove: {
    name: "antinuke vouch limit remove",
    description: "Remove a member's vouch limit override.",
    syntax: "antinuke vouch limit remove (user)",
    example: "antinuke vouch limit remove kutt",
    permission: "Gods+"
  },
  antinukevouch: {
    name: "antinuke vouch",
    description: "Open the vouch command usages.",
    syntax: "antinuke vouch (action)",
    example: "antinuke vouch set Vouched",
    permission: "Gods+"
  },
  antinukevouchunset: {
    name: "antinuke vouch unset",
    description: "Clear the vouch reward and founder roles.",
    syntax: "antinuke vouch unset",
    example: "antinuke vouch unset",
    permission: "Gods+"
  },
  antinukevouchaddgiver: {
    name: "antinuke vouch addgiver",
    description: "Let a member give vouches.",
    syntax: "antinuke vouch addgiver (user)",
    example: "antinuke vouch addgiver kutt",
    permission: "Vouch admin+"
  },
  antinukevouchremovegiver: {
    name: "antinuke vouch removegiver",
    description: "Stop a member from giving vouches.",
    syntax: "antinuke vouch removegiver (user)",
    example: "antinuke vouch removegiver kutt",
    permission: "Vouch admin+"
  },
  antinukevouchlist: {
    name: "antinuke vouch list",
    description: "List members with an active vouch.",
    syntax: "antinuke vouch list",
    example: "antinuke vouch list",
    permission: "Gods+"
  },
  antinukevouchcleanup: {
    name: "antinuke vouch cleanup",
    description: "Remove vouch records for members who left.",
    syntax: "antinuke vouch cleanup",
    example: "antinuke vouch cleanup",
    permission: "Gods+"
  },
  antinukevouchlimitglobal: {
    name: "antinuke vouch limit global",
    description: "Set how many active vouches anyone can give.",
    syntax: "antinuke vouch limit global (number)",
    example: "antinuke vouch limit global 4",
    permission: "Gods+"
  },
  antinukevouchlimitgiver: {
    name: "antinuke vouch limit giver",
    description: "Set how many active vouches a giver can give.",
    syntax: "antinuke vouch limit giver (number)",
    example: "antinuke vouch limit giver 6",
    permission: "Gods+"
  },
  antinukevouchlimitview: {
    name: "antinuke vouch limit view",
    description: "Show the vouch limits.",
    syntax: "antinuke vouch limit view",
    example: "antinuke vouch limit view",
    permission: "Gods+"
  },
  voiceshield: {
    name: "voiceshield",
    description: "Stop a member from being kicked or banned in voice.",
    syntax: "voiceshield (user)",
    example: "voiceshield kutt"
  },
  unforcerolestrip: {
    name: "unforcerolestrip",
    description: "Let a user hold roles that were blocked.",
    syntax: "unforcerolestrip (user)",
    example: "unforcerolestrip kutt"
  },
  modstats: {
    name: "modstats",
    description: "Show moderation actions for a user.",
    syntax: "modstats (user)",
    example: "modstats kutt"
  },
  viewstats: {
    name: "viewstats",
    description: "Show voice activity for a user.",
    syntax: "viewstats (user)",
    example: "viewstats kutt"
  },
  u: {
    name: "u",
    description: "Show an activity card for you or another member.",
    syntax: "s-u (user)",
    example: "s-u @user",
    permission: "Everyone"
  },
  vouchgive: {
    name: "vouch give",
    description: "Give a vouch to a member.",
    syntax: "vouch give (user) [reason]",
    example: "vouch give kutt welcome"
  },
  vouchtake: {
    name: "vouch take",
    description: "Take a vouch away from a user.",
    syntax: "vouch take (user) [reason]",
    example: "vouch take kutt"
  },
  vouchgiver: {
    name: "vouch add giver",
    description: "Let a member give vouches.",
    syntax: "vouch add giver (user)",
    example: "vouch add giver kutt"
  },
  vouchadmin: {
    name: "vouch admin",
    description: "Allow or remove a vouch admin.",
    syntax: "vouch admin allow (user)",
    example: "vouch admin allow kutt"
  },
  vouchblacklist: {
    name: "vouchblacklist",
    description: "Block a user from being vouched.",
    syntax: "vouchblacklist add (user) [reason]",
    example: "vouchblacklist add kutt"
  },
  vouchstrip: {
    name: "vouchstrip",
    description: "Close the active vouches a giver gave.",
    syntax: "vouchstrip (user)",
    example: "vouchstrip kutt"
  },
  vouchsetrole: {
    name: "vouch setrole",
    description: "Choose the role a vouch gives.",
    syntax: "vouch setrole (role)",
    example: "vouch setrole Vouched"
  },
  vouchreward: {
    name: "antinuke vouch set",
    description: "Choose the role given when someone is vouched.",
    syntax: "antinuke vouch set (role)",
    example: "antinuke vouch set Vouched",
    permission: "Gods+"
  },
  vouchfounder: {
    name: "antinuke vouch founder",
    description: "Choose the vouch founder role.",
    syntax: "antinuke vouch founder (role)",
    example: "antinuke vouch founder Founder",
    permission: "Gods+"
  },
  stripstaff: {
    name: "setrole stripstaff",
    description: "Choose the legacy stripstaff role.",
    syntax: "setrole stripstaff (role)",
    example: "setrole stripstaff Staff"
  },
  vouchcheck: {
    name: "vouch check",
    description: "Show vouch status for a user.",
    syntax: "vouch check (user)",
    example: "vouch check kutt"
  },
  vouchview: {
    name: "vouch view",
    description: "Show vouch details for a user.",
    syntax: "vouch view (user)",
    example: "vouch view kutt"
  },
  rolestrip: {
    name: "rolestrip",
    description: "Remove a role from everyone who has it. Exempt members from the menu, then confirm.",
    syntax: "rolestrip (role)",
    example: "rolestrip Muted"
  },
  unmuteall: {
    name: "unmuteall",
    description: "Unmute a voice channel.",
    syntax: "unmuteall (channel)",
    example: "unmuteall lobby"
  },
  rolelimit: {
    name: "role limit",
    description: "Cap how many members can hold a role.",
    syntax: "role limit set (role) (number)",
    example: "role limit set Mods 5"
  },
  vcrole: {
    name: "vc rank",
    description: "Bind a role to a voice rank.",
    syntax: "vc rank (rank) (role)",
    example: "vc rank plus Members"
  },
  userinfo: {
    name: "userinfo",
    description: "Show a member's account and roles.",
    syntax: "userinfo (user)",
    example: "userinfo kutt"
  },
  avatar: {
    name: "avatar",
    description: "Show a member's avatar.",
    syntax: "avatar (user)",
    example: "avatar kutt"
  },
  banner: {
    name: "banner",
    description: "Show a member's banner.",
    syntax: "banner (user)",
    example: "banner kutt"
  },
  securityconfig: {
    name: "securityconfig",
    description: "Show security modules, which are on, and their thresholds.",
    syntax: "securityconfig",
    example: "securityconfig",
    permission: "Server owner and Anti-Nuke admins"
  },
  dangerouspermissionsadd: {
    name: "dangerouspermissionsadd",
    description: "Ban and reverse an administrator permission added to a role.",
    syntax: "dangerouspermissionsadd on|off",
    example: "dpa on",
    permission: "Server owner and Anti-Nuke admins"
  },
  dangerouspermissionsupdate: {
    name: "dangerouspermissionsupdate",
    description: "Ban and reverse dangerous permissions added to a role.",
    syntax: "dangerouspermissionsupdate on|off",
    example: "dpu on",
    permission: "Server owner and Anti-Nuke admins"
  },
  vanityprotection: {
    name: "vanityprotection",
    description: "Restore the server vanity and ban whoever changed it.",
    syntax: "vanityprotection on|off",
    example: "vp on",
    permission: "Server owner and Anti-Nuke admins"
  },
  denybotjoins: {
    name: "denybotjoins",
    description: "Ban bots that join and the member who added them.",
    syntax: "denybotjoins on|off",
    example: "dbj on",
    permission: "Server owner and Anti-Nuke admins"
  },
  massmemberkick: {
    name: "massmemberkick",
    description: "Punish a member who kicks too many people in 8 seconds.",
    syntax: "massmemberkick on|off|threshold (number)|punishment ban|kick|strip",
    example: "mmk threshold 3",
    permission: "Server owner and Anti-Nuke admins"
  },
  massmemberban: {
    name: "massmemberban",
    description: "Punish a member who bans too many people in 8 seconds.",
    syntax: "massmemberban on|off|threshold (number)|punishment ban|kick|strip",
    example: "mmb on",
    permission: "Server owner and Anti-Nuke admins"
  },
  setwatchrole: {
    name: "setwatchrole",
    description: "Log when a role is given or removed.",
    syntax: "setwatchrole (role)",
    example: "setwatchrole @Staff",
    permission: "Server owner and Anti-Nuke admins"
  },
  watchuser: {
    name: "watchuser",
    description: "Log moderation actions a member takes.",
    syntax: "watchuser (user)",
    example: "watchuser @user",
    permission: "Server owner and Anti-Nuke admins"
  },
  antinukesetup: {
    name: "antinuke setup",
    description: "Open the anti-nuke setup wizard.",
    syntax: "antinuke setup",
    example: "antinuke setup",
    permission: "Server owner and anti-nuke administrators"
  },
  antinukealloff: {
    name: "antinukealloff",
    description: "Turn off every anti-nuke action immediately.",
    syntax: "antinukealloff",
    example: "antinukealloff",
    permission: "Server owner and anti-nuke administrators"
  },
  antinukewhitelist: {
    name: "antinukewhitelist",
    description: "Add, remove, or list trusted anti-nuke accounts.",
    syntax: "antinukewhitelist add|remove|list (user)",
    example: "antinukewhitelist add @user",
    permission: "Server owner and anti-nuke administrators"
  },
  poolsetup: {
    name: "poolsetup",
    description: "Open the wizard that creates standby voice channels.",
    syntax: "poolsetup",
    example: "poolsetup",
    permission: "Server owner"
  },
  stoppool: {
    name: "stoppool",
    description: "Stop creating new pool channels. Existing calls stay.",
    syntax: "stoppool",
    example: "stoppool",
    permission: "Server owner"
  },
  cleanpools: {
    name: "cleanpools",
    description: "Delete empty unclaimed pool channels the bot tracks.",
    syntax: "cleanpools",
    example: "cleanpools",
    permission: "Server owner"
  },
  poolstatus: {
    name: "poolstatus",
    description: "Show empty pools, claimed calls, and whether refill is running.",
    syntax: "poolstatus",
    example: "poolstatus",
    permission: "Server owner"
  },
  newcommands: {
    name: "newcommands",
    description: "Show the commands that were just added, in a few words.",
    syntax: "newcommands",
    example: "newcommands",
    permission: "Everyone"
  },
  verifiedseller: {
    name: "verifiedseller",
    description: "Set the one Verified Seller role, or view who has it.",
    syntax: "verifiedseller (role)",
    example: "verifiedseller @Verified Seller",
    permission: "CEOs and the server owner"
  },
  verifiedselleradd: {
    name: "verifiedseller add",
    description: "Give someone the Verified Seller role. Create the role if it is not set.",
    syntax: "verifiedseller add (user)",
    example: "verifiedseller add @user",
    permission: "CEOs and the server owner"
  },
  verifiedsellerremove: {
    name: "verifiedseller remove",
    description: "Remove a verified seller and take the role off them.",
    syntax: "verifiedseller remove (user)",
    example: "verifiedseller remove @user",
    permission: "CEOs and the server owner"
  },
  verifiedselleraddgiver: {
    name: "verifiedseller addgiver",
    description: "Let verified sellers grant one command.",
    syntax: "verifiedseller addgiver (command)",
    example: "verifiedseller addgiver forcenickname",
    permission: "CEOs and the server owner"
  },
  verifiedsellerremovegiver: {
    name: "verifiedseller removegiver",
    description: "Stop verified sellers from granting a command.",
    syntax: "verifiedseller removegiver (command)",
    example: "verifiedseller removegiver forcenickname",
    permission: "CEOs and the server owner"
  }
};

const GROUPS = {
  ban: ["ban", "bancheck", "banpurge", "hardban", "softban", "tempban", "unban", "foreverban", "foreverunban"],
  protect: ["protect", "unprotect", "protected", "plist", "protectedlist"],
  security: ["securityconfig", "dangerouspermissionsadd", "dangerouspermissionsupdate", "vanityprotection", "denybotjoins", "massmemberkick", "massmemberban", "setwatchrole", "watchuser"],
  verifiedseller: ["verifiedseller", "verifiedselleradd", "verifiedsellerremove", "verifiedselleraddgiver", "verifiedsellerremovegiver"],
  antinuke: ["antinukesetup", "antinukewhitelist", "antinukealloff"],
  proof: ["proof", "prooflist", "noproof"],
  godmode: ["godmode", "ungodmode"],
  god: ["god", "godtake", "godinfo"],
  stsu: ["stsu", "unstsu"],
  shield: ["shield", "unshield"],
  antinukevouch: [
    "antinukevouch",
    "vouchreward",
    "vouchfounder",
    "antinukevouchunset",
    "antinukevouchaddgiver",
    "antinukevouchremovegiver",
    "antinukevouchlist",
    "antinukevouchcleanup",
    "antinukevouchlimitglobal",
    "antinukevouchlimitgiver",
    "vouchlimituser",
    "vouchlimitremove",
    "antinukevouchlimitview"
  ]
};

const ALIASES = {
  fb: "foreverban",
  fub: "foreverunban",
  banned: "bancheck",
  stfu: "stsu",
  unstfu: "unstsu"
};

function locate(key) {
  const name = ALIASES[key] || key;
  for (const [group, keys] of Object.entries(GROUPS)) {
    const index = keys.indexOf(name);
    if (index !== -1) return { group, keys, index };
  }
  if (!SPECS[name]) return null;
  return { group: name, keys: [name], index: 0 };
}

function authorName(message) {
  const author = message?.author || message?.user || {};
  const user = message?.member?.user || {};
  return author.username || author.globalName || user.username || user.globalName || message?.member?.displayName || "user";
}

function avatarUrl(message) {
  const author = message?.author || message?.user;
  if (typeof author?.displayAvatarURL === "function") {
    const url = author.displayAvatarURL({ extension: "png", size: 128 });
    if (url) return url;
  }
  return null;
}

function usageBlock(syntax, example) {
  return [
    "```ansi",
    `${CYAN}Syntax:${RESET} ${GREEN}${syntax}${RESET}`,
    `${CYAN}Example:${RESET} ${GREEN}${example}${RESET}`,
    "```"
  ].join("\n");
}

function specFor(specOrKey) {
  if (specOrKey && typeof specOrKey === "object") {
    const key = Object.keys(SPECS).find((item) => SPECS[item] === specOrKey);
    return { key, spec: specOrKey, located: key ? locate(key) : null };
  }
  const located = locate(specOrKey);
  const key = located ? located.keys[located.index] : specOrKey;
  return { key, spec: SPECS[key], located };
}

function usageEmbed(message, specOrKey) {
  const { spec, located } = specFor(specOrKey);
  if (!spec) throw new Error(`Unknown usage: ${specOrKey}`);
  const index = located?.index || 0;
  const total = located?.keys.length || 1;
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setFooter({ text: `Command ${index + 1}/${total}` })
    .setDescription([
      `**Command:** ${spec.name}`,
      spec.description,
      "",
      "**Permissions**",
      spec.permission || "Allowed members",
      "",
      "**How To Use**",
      usageBlock(spec.syntax, spec.example)
    ].join("\n"));
  const author = { name: authorName(message) };
  const iconURL = avatarUrl(message);
  if (iconURL) author.iconURL = iconURL;
  embed.setAuthor(author);
  return embed;
}

function buttonRow(ownerId, group, index, total) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`spanter:usage:${ownerId}:${group}:${index}:prev`).setEmoji({ name: "⬅️" }).setStyle(ButtonStyle.Secondary).setDisabled(index <= 0),
    new ButtonBuilder().setCustomId(`spanter:usage:${ownerId}:${group}:${index}:next`).setEmoji({ name: "➡️" }).setStyle(ButtonStyle.Secondary).setDisabled(index >= total - 1),
    new ButtonBuilder().setCustomId(`spanter:usage:${ownerId}:${group}:${index}:search`).setEmoji({ name: "🔍" }).setStyle(ButtonStyle.Secondary)
  );
}

function searchRow(ownerId, group, keys, current) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`spanter:usage:${ownerId}:${group}:pick`)
      .setPlaceholder("Jump to a command")
      .addOptions(keys.slice(0, 25).map((key) => ({
        label: SPECS[key].name.slice(0, 100),
        value: key,
        default: key === current
      })))
  );
}

function usagePayload(actor, key, ownerId, searching = false) {
  const located = locate(key);
  if (!located || !SPECS[located.keys[located.index]]) throw new Error(`Unknown usage: ${key}`);
  const current = located.keys[located.index];
  const components = [buttonRow(ownerId, located.group, located.index, located.keys.length)];
  if (searching) components.push(searchRow(ownerId, located.group, located.keys, current));
  return {
    embeds: [usageEmbed(actor, current)],
    components,
    allowedMentions: { parse: [] }
  };
}

function replyUsage(message, key) {
  const ownerId = message.author?.id || message.user?.id || "";
  return message.reply(usagePayload(message, key, ownerId));
}

function refuseUsage(interaction) {
  return interaction.reply({
    embeds: [new EmbedBuilder().setColor(COLOR).setDescription("**Not Yours**\nOnly the person who opened this can change it.")],
    flags: 64
  }).catch(() => null);
}

async function handleInteraction(interaction) {
  const id = String(interaction.customId || "");
  if (!id.startsWith("spanter:usage:")) return false;
  const parts = id.split(":");
  const ownerId = parts[2] || "";
  const group = parts[3] || "";
  const marker = parts[4] || "";
  const action = parts[5] || "";
  if (ownerId && interaction.user?.id && ownerId !== interaction.user.id) {
    await refuseUsage(interaction);
    return true;
  }
  const keys = GROUPS[group] || (SPECS[group] ? [group] : null);
  if (!keys) return false;
  if (marker === "pick") {
    const picked = interaction.values?.[0];
    if (!keys.includes(picked)) return true;
    await interaction.update(usagePayload(interaction, picked, ownerId));
    return true;
  }
  let index = Number(marker) || 0;
  if (action === "search") {
    await interaction.update(usagePayload(interaction, keys[index] || keys[0], ownerId, true));
    return true;
  }
  if (action === "prev") index = Math.max(0, index - 1);
  if (action === "next") index = Math.min(keys.length - 1, index + 1);
  index = Math.min(Math.max(index, 0), keys.length - 1);
  await interaction.update(usagePayload(interaction, keys[index], ownerId));
  return true;
}

module.exports = {
  SPECS,
  GROUPS,
  usageEmbed,
  usagePayload,
  replyUsage,
  usageBlock,
  handleInteraction
};
