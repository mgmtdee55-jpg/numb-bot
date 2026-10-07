const {
  ActionRowBuilder,
  StringSelectMenuBuilder
} = require("discord.js");
const store = require("./store");
const { OVERVIEW_EMOJI } = require("./constants");
const { embed } = require("./ui");
const force = require("./force");

function vouchText(prefix) {
  const p = prefix;
  return [
    "Vouches, giver access, roles, and limits.",
    "",
    "**Setup**",
    `\`${p}vouch\` — open the vouch menu`,
    `\`${p}antinuke vouch\` — view vouch config`,
    `\`${p}antinuke vouch set <role>\` — bind the reward role`,
    `\`${p}antinuke vouch founder <role>\` — assign the founder role`,
    `\`${p}antinuke vouch unset\` — disconnect linked roles`,
    "",
    "**Givers & Registry**",
    `\`${p}antinuke vouch addgiver <user>\` — authorize a giver`,
    `\`${p}antinuke vouch removegiver <user>\` — remove a giver`,
    `\`${p}antinuke vouch list\` — view vouched users`,
    `\`${p}antinuke vouch cleanup\` — prune members who left`,
    "",
    "**Vouches**",
    `\`${p}vouch give @user [reason]\``,
    `\`${p}vouch take @user [reason]\``,
    `\`${p}vouchstrip @user\` — Gods remove everyone they vouched`,
    "",
    "**Vouch Admins**",
    `\`${p}vouch admin allow @user\``,
    `\`${p}vouch admin remove @user\``,
    `\`${p}vouch admin take @user [reason]\``,
    "A vouch admin can add or remove givers below their tier.",
    "",
    "**Vouch Role**",
    `\`${p}vouch setrole @role\``,
    `\`${p}vouch role add @role\``,
    `\`${p}vouch unsetrole\``,
    `\`${p}vouch role remove\``,
    "",
    "**Stripstaff**",
    `\`${p}setrole stripstaff @role\` — optional legacy role`,
    `\`${p}setrole stripstaff remove\``,
    "",
    "**Blacklist**",
    `\`${p}vouchblacklist add @user [reason]\``,
    `\`${p}vouchblacklist remove @user\``,
    `\`${p}vouchblacklist list [page]\``,
    "",
    "**Allowances**",
    `\`${p}antinuke vouch limit global <#>\` — global vouch cap`,
    `\`${p}antinuke vouch limit giver <#>\` — giver cap`,
    `\`${p}antinuke vouch limit user <user> <#>\` — user override`,
    `\`${p}antinuke vouch limit remove <user>\` — remove a user override`,
    `\`${p}antinuke vouch limit view\` — view user overrides`
  ].join("\n");
}

function forceText(prefix) {
  return force.usage(prefix);
}

function moderationText(prefix) {
  const p = prefix;
  return [
    `\`${p}ban @user [reason]\``,
    `\`${p}banned @user\``,
    `\`${p}softban @user [reason]\``,
    `\`${p}tempban @user <duration> [reason]\``,
    `\`${p}unban <user>\``,
    `\`${p}unbanall\``,
    `\`${p}hardban @user [reason]\``,
    `\`${p}fb @user [reason]\` / \`${p}foreverban\``,
    `\`${p}fub @user\` / \`${p}foreverunban\``,
    `\`${p}role add @user @role\``,
    `\`${p}fp add @role <permission>\``,
    `\`${p}fakepermissions\``
  ].join("\n");
}

function voiceText(prefix) {
  const p = prefix;
  return [
    `\`${p}vc\` — channel controls while in a temporary VC`,
    `\`${p}vc setup\` — owner setup wizard`,
    `\`${p}vc lock|unlock|ghost|unghost\``,
    `\`${p}vc kick|ban|unban|permit @user\``,
    `\`${p}vc claim\``,
    `\`${p}vc limit <0-99>\``,
    `\`${p}mvc\` — voice stats`,
    `\`${p}send interface\` — restore a channel interface`
  ].join("\n");
}

function botText(prefix) {
  const p = prefix;
  return [
    `\`${p}help\` / \`${p}bothelp\` — category menu`,
    `\`${p}showallcommands\` — every command, grouped`,
    `\`${p}setprefix <prefix>\` — persists after restart`,
    `\`${p}alias add <shortcut> <command>\``,
    `\`${p}alias remove <shortcut>\``,
    `\`${p}alias list\``,
    `\`${p}afk [status]\` — set an away status`,
    `\`${p}restart\` — Founders, Gods, and the server owner`,
    `\`${p}modsetup\` — Gods set vouch, voice ranks, and logs`
  ].join("\n");
}

function infoText(prefix) {
  const p = prefix;
  return [
    `\`${p}avatar [@user]\``,
    `\`${p}banner [@user]\``,
    `\`${p}serverinfo\``,
    `\`${p}userinfo [@user]\``
  ].join("\n");
}

function godmodeText() {
  return [
    "Godmode tiers, rank management, and protection commands.",
    "",
    "`-god add @user` — give Godmode",
    "`-god take @user` — remove Godmode",
    "`-god info @user` — view Godmode status",
    "",
    "Gods and the server owner can manage Godmode and Management."
  ].join("\n");
}

function ranksText() {
  return [
    "Voice Plus, Voice Premium, and Voice Premium Plus are protected roles.",
    "Gods and Founders can use the other voice commands without one of those roles.",
    "",
    "**Gods and the server owner** — muteall, unmuteall",
    "**Voice Premium Plus** — voiceoverride, stsu, unstsu, plus Premium",
    "**Voice Premium** — follow, chain, unfollow, bring, forceclaim, inspect",
    "**Voice Plus** — inspect",
    "**Gods and Founders** — forceownership, dragall, voicehistory, godmode, shield",
    "",
    "`-vc rank` — list ranked members",
    "`-vc rank assign @user <rank>` — assign a rank",
    "`-vc unrank @user` — remove a rank",
    "`-vc rankinfo` — your rank, or `@user` for theirs, including who assigned it",
    "`-voice plus @role` / `-voice premium @role` / `-vouch premium plus @role`",
    "",
    "Only Gods can add or remove these roles, and only with the bot."
  ].join("\n");
}

function antinukeText(prefix) {
  const p = prefix;
  return [
    "Protection modules and status commands.",
    "",
    `\`${p}antinuke admin add @user\``,
    `\`${p}antinuke admin remove @user\``,
    `\`${p}antinuke admin list\``,
    "",
    `\`${p}antinuke vouch limit global <#>\``,
    `\`${p}antinuke vouch limit giver <#>\``,
    `\`${p}antinuke vouch limit user @user <#>\``,
    `\`${p}antinuke vouch limit remove @user\``,
    `\`${p}antinuke vouch limit view\``
  ].join("\n");
}

function loggingText(prefix) {
  const p = prefix;
  return [
    "Configure per-category event logs.",
    "",
    `\`${p}logging\` — view configured log channels`,
    `\`${p}logging set <category> [#channel]\``,
    `\`${p}logging set all [#channel]\``,
    `\`${p}logging remove <category|all>\``,
    `\`${p}logging test <category>\``,
    `\`${p}logging help\``,
    "",
    "Event categories: message, voice, channel, role, server, member",
    "Anti-Nuke and vouch commands use a separate channel: `antinuke`",
    `\`${p}logging set antinuke [#channel]\``,
    "`all` does not change the Anti-Nuke log.",
    `Alias: \`${p}logs\``
  ].join("\n");
}

function roleLimitText(prefix) {
  const p = prefix;
  return [
    "Member and per-role limit commands.",
    "",
    `\`${p}role limit set @role <#>\``,
    `\`${p}role limit remove @role\``,
    `\`${p}role limit view\``
  ].join("\n");
}

function managementText(prefix) {
  const p = prefix;
  return [
    "Management is a standalone access level with no tiers. Management users can manage Godmode, but cannot grant or remove Management access.",
    "",
    `\`${p}m add @user\``,
    `\`${p}m take @user\``,
    `\`${p}m list\``,
    `\`${p}management\` / \`${p}mgmt\` / \`${p}managegod\` / \`${p}m\` — open the Management panel`
  ].join("\n");
}

function staffText(prefix) {
  const p = prefix;
  return [
    "Root-owner controlled access management for the bot's three staff tiers.",
    "God can only be handed out by the server owner.",
    "",
    "**God • Root Owner**",
    `\`${p}ceo add @user\` — add a God`,
    `\`${p}ceo remove @user\``,
    "Logs, lockdown, role limits, VC ranks, Godmode, Management, vouch setup, and Anti-Nuke admins.",
    "",
    "**Founder • Super Admin**",
    `\`${p}founder add @user\` — add a Founder`,
    `\`${p}founder remove @user\``,
    "Everything Boss can do, plus VC ranks, Godmode, Management, and vouch setup.",
    "",
    "**Boss • Admin**",
    `\`${p}boss add @user\` — add a Boss`,
    `\`${p}boss remove @user\``,
    "Event logs, lockdown, channel controls, role limits, and vouch limits.",
    "",
    "**Registry**",
    `\`${p}antinuke admins\` — view the current staff registry`,
    "",
    "The server owner or a God can add and remove Founder and Boss.",
    "",
    "**Command grants**",
    "Gods and the server owner can whitelist one command without giving the rest of a rank.",
    `\`${p}grant muteall @user\``,
    `\`${p}grant forcenickname @user\``,
    `\`${p}revoke <command> @user\``,
    `\`${p}grant list [@user]\``
  ].join("\n");
}

function channelText(prefix) {
  const p = prefix;
  return [
    "Lock/unlock, hide/unhide, and full lockdown.",
    "",
    `\`${p}lock [#channel]\` — lock a channel`,
    `\`${p}unlock [#channel]\` — unlock a channel`,
    `\`${p}hide [#channel]\` — hide a channel`,
    `\`${p}unhide [#channel]\` — make a channel visible`,
    `\`${p}lockall\` — lock all text channels`,
    `\`${p}unlockall\` — unlock all text channels`,
    `\`${p}nuke [#channel]\` — clone a channel and delete the old one`,
    "",
    `\`${p}vc lock|unlock|ghost|unghost\` — your temporary VC`,
    `\`${p}lockdown\` — lock every text and voice channel`,
    `\`${p}unlockdown\` — clear that lockdown`
  ].join("\n");
}

const PAGES = {
  overview: {
    title: "Categories",
    body: [
      "Moderation — Jail, mutes, bans, kicks, timeouts, warnings, purge",
      "Info & Avatars — Avatar, banner, server info, user info",
      "Voice / VC — VoiceMaster controls and VC command categories",
      "Godmode — Godmode tiers, rank management, and protection commands",
      "VC Ranks — Voice Plus, Premium, and Premium Plus",
      "AntiNuke — Protection modules and status commands",
      "Channel Controls — Lock/unlock, hide/unhide, and full lockdown",
      "Event Logging — Configure per-category event logs",
      "Role Limits — Member and per-role limit commands",
      "Vouch — Vouches, giver access, roles, and limits",
      "Management — Management access and Godmode administration",
      "Staff Access — God, Founder, Boss, and administrator registry",
      "",
      "Use the menu below to open a category."
    ].join("\n")
  },
  vouch: { title: "Vouch", body: vouchText },
  force: { title: "Force Management", body: forceText },
  moderation: { title: "Moderation", body: moderationText },
  voice: { title: "Voice / VC", body: voiceText },
  info: { title: "Info & Avatars", body: infoText },
  godmode: { title: "Godmode", body: godmodeText },
  ranks: { title: "VC Ranks", body: ranksText },
  antinuke: { title: "AntiNuke", body: antinukeText },
  logging: { title: "Event Logging", body: loggingText },
  rolelimits: { title: "Role Limits", body: roleLimitText },
  management: { title: "Management", body: managementText },
  staff: { title: "Staff Access", body: staffText },
  channels: { title: "Channel Controls", body: channelText },
  bot: { title: "Bot", body: botText }
};

const CATEGORY_ACCESS = {
  overview: "Everyone. Each category says who can use it.",
  moderation: "Gods and above",
  info: "Everyone",
  voice: "Everyone. Ghost requires Voice Premium. Setup is the server owner.",
  godmode: "Gods and above",
  ranks: "Gods and Founders, or the VC rank listed on each command",
  antinuke: "Gods and above. Anti-Nuke admin changes are the server owner.",
  channels: "Founders and above",
  logging: "Gods and above",
  rolelimits: "Gods and above",
  vouch: "Gods and above, Anti-Nuke admins, and the vouch founder role",
  management: "Gods and above",
  staff: "Assigned tiers. The server owner can use every command.",
  force: "Founders and above",
  bot: "Help is everyone. Prefix, aliases, and restart are Founders and above."
};

function renderHelp(category, prefix, member) {
  const page = PAGES[category] || PAGES.overview;
  const body = typeof page.body === "function" ? page.body(prefix) : page.body;
  const access = require("../systems/access");
  const header = [
    access.rankLine(member),
    `**Who can use this:** ${CATEGORY_ACCESS[category] || CATEGORY_ACCESS.overview}`,
    ""
  ].join("\n");
  return embed(page.title, `${header}\n${body}`, true);
}

function helpOptions(selected, withEmoji) {
  const options = [
    { label: "Categories", value: "overview", description: "Command groups" },
    { label: "Moderation", value: "moderation", description: "Bans and fake permissions" },
    { label: "Info & Avatars", value: "info", description: "Avatar, banner, server and user info" },
    { label: "Voice / VC", value: "voice", description: "VoiceMaster controls" },
    { label: "Godmode", value: "godmode", description: "Godmode access" },
    { label: "VC Ranks", value: "ranks", description: "Plus, Premium, Premium Plus" },
    { label: "AntiNuke", value: "antinuke", description: "Admins and vouch limits" },
    { label: "Channel Controls", value: "channels", description: "Lock, hide, and lockdown" },
    { label: "Event Logging", value: "logging", description: "Per-category event logs" },
    { label: "Role Limits", value: "rolelimits", description: "Per-role member limits" },
    { label: "Vouch", value: "vouch", description: "Vouches, givers, limits, blacklist" },
    { label: "Management", value: "management", description: "Godmode administration" },
    { label: "Staff Access", value: "staff", description: "God, Founder, and Boss" },
    { label: "Force Management", value: "force", description: "Nicknames and role strips" },
    { label: "Bot", value: "bot", description: "Prefix, aliases, restart" }
  ];
  return options.map((option) => {
    const data = { ...option, default: option.value === selected };
    if (option.value === "overview" && withEmoji) data.emoji = { ...OVERVIEW_EMOJI };
    return data;
  });
}

function helpRow(selected = "overview", withEmoji = true) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("spanter:help")
      .setPlaceholder("Select a category")
      .addOptions(helpOptions(selected, withEmoji))
  );
}

async function sendHelp(message, prefix) {
  const payload = (withEmoji) => ({
    embeds: [renderHelp("overview", prefix, message.member)],
    components: [helpRow("overview", withEmoji)]
  });
  try {
    return await message.reply(payload(true));
  } catch (error) {
    return message.reply(payload(false));
  }
}

async function handleInteraction(interaction) {
  if (!interaction?.customId) return false;
  const prefix = store.getPrefix(interaction.guildId || interaction.guild?.id);
  if (interaction.customId === "spanter:help") {
    const category = interaction.values?.[0] || "overview";
    const payload = (withEmoji) => ({
      embeds: [renderHelp(category, prefix, interaction.member)],
      components: [helpRow(category, withEmoji)]
    });
    try {
      await interaction.update(payload(true));
    } catch (error) {
      if (!interaction.replied && !interaction.deferred) await interaction.update(payload(false));
    }
    return true;
  }
  if (interaction.customId === "spanter:force") {
    return force.handleSelect(interaction, prefix);
  }
  if (interaction.customId === "spanter:vouch") {
    const panel = require("./panel");
    return panel.handleSelect(interaction, prefix);
  }
  return false;
}

module.exports = {
  sendHelp,
  handleInteraction,
  renderHelp,
  vouchText
};
