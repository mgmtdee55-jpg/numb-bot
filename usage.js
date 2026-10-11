const { EmbedBuilder } = require("discord.js");

const CYAN = "\u001b[2;36m";
const GREEN = "\u001b[2;32m";
const RESET = "\u001b[0m";
const COLOR = 0x2b2d31;

const SPECS = {
  ban: {
    name: "ban",
    description: "Ban a user from the server.",
    syntax: "ban (user) [$days] [reason] [$silent]",
    example: "ban @user $7 spamming in chat"
  },
  bancheck: {
    name: "ban check",
    description: "Check whether a user is banned.",
    syntax: "ban check (user)",
    example: "ban check @user"
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
    example: "ban purge 7"
  },
  hardban: {
    name: "hardban",
    description: "Ban a user and ban them again if they rejoin.",
    syntax: "hardban (user) [reason]",
    example: "hardban @user raiding"
  },
  softban: {
    name: "softban",
    description: "Ban a user and unban them to clear their messages.",
    syntax: "softban (user) [reason]",
    example: "softban @user cleanup"
  },
  tempban: {
    name: "tempban",
    description: "Ban a user until a duration ends.",
    syntax: "tempban (user) (duration) [reason]",
    example: "tempban @user 2h spamming"
  },
  unban: {
    name: "unban",
    description: "Unban a user from the server.",
    syntax: "unban (user)",
    example: "unban @user"
  },
  foreverban: {
    name: "foreverban",
    description: "Permanently ban a user. Only foreverunban can lift it.",
    syntax: "foreverban (user) [reason]",
    example: "foreverban @user evading bans"
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
    example: "foreverunban @user"
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
    description: "Protect a role or one user.",
    syntax: "protect (role or user)",
    example: "protect @user"
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
    description: "Assign a voice rank to a member.",
    syntax: "vc rank assign (user) (rank)",
    example: "vc rank assign @user premium"
  },
  vouchlimituser: {
    name: "antinuke vouch limit",
    description: "Set how many active vouches one member can give.",
    syntax: "antinuke vouch limit user (user) (number)",
    example: "antinuke vouch limit user @user 3"
  },
  limit: {
    name: "limit",
    description: "Limit how many members can hold a role.",
    syntax: "limit (role) (number)",
    example: "limit @Mods 5"
  }
};

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

function usageEmbed(message, spec) {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setDescription([
      `**Command:** ${spec.name}`,
      spec.description,
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

function replyUsage(message, key) {
  const spec = SPECS[key];
  if (!spec) throw new Error(`Unknown usage: ${key}`);
  return message.reply({ embeds: [usageEmbed(message, spec)] });
}

module.exports = {
  SPECS,
  usageEmbed,
  replyUsage,
  usageBlock
};
