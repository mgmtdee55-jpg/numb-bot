const {
  ActionRowBuilder,
  MessageFlags,
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
    `\`${p}mkick\` — owner only. Mass kick by server tag, vanity, or everyone`,
    `\`${p}pban @user\` / \`${p}personalban\` — only the banner or owner can lift it`,
    `\`${p}hardban @user [reason]\``,
    `\`${p}fb @user [reason]\` / \`${p}foreverban\``,
    `\`${p}fub @user\` / \`${p}foreverunban\``,
    `\`${p}role add @user @role\``,
    `\`${p}fp add @role <permission>\``,
    `\`${p}fakepermissions\``,
    `\`${p}serversetup\` — create or select jail, mute, and camera roles`,
    `\`${p}jail @user [reason]\` / \`${p}unjail @user\``,
    `\`${p}cmute @user\` / \`${p}chatmute\` — toggle chat mute`,
    `\`${p}imute @user\` / \`${p}imagemute\` — toggle image mute`,
    `\`${p}rmute @user\` / \`${p}reactionmute\` — toggle reaction mute`,
    `\`${p}mute @user\` — ask server mute or chat mute`,
    `\`${p}servermute @user\``,
    `\`${p}auditlog @user\` — recent server mutes, deafens, disconnects, timeouts, and bans`,
    `\`${p}cam set @role\` / \`${p}camblacklist set @role\` / \`${p}camblacklist @user\``
  ].join("\n");
}

function voiceText(prefix) {
  const p = prefix;
  return [
    `\`${p}vc\` — channel controls while in a temporary VC`,
    `\`${p}vc setup\` — owner setup wizard`,
    `\`${p}vc edit\` — connect an auto-unmute call or a random-join call`,
    `\`${p}vc lock|unlock|ghost|unghost\``,
    `\`${p}vc kick @user\` — remove someone from your VC`,
    `\`${p}vc ban|reject @user\` — block joining, the channel stays visible`,
    `\`${p}vc permit @user\` — let them join a locked or full VC`,
    `\`${p}vc unban @user\``,
    `\`${p}vc claim\``,
    `\`${p}vc transfer @user\` — give your VC to someone in it`,
    `\`${p}vc config\` / \`${p}voicemaster configuration\` — view VoiceMaster settings`,
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
    `\`${p}newcommands\` — what was just added`,
    `\`${p}snipe\` / \`${p}s\` — deleted messages in this channel from the last 2 hours`,
    `\`${p}clearsnipe\` / \`${p}cs\` — clear that snipe history`,
    `\`${p}modstats [@user]\` — warns, kicks, bans, and mutes they issued`,
    `\`${p}viewstats [@user]\` — voice time and messages`,
    `\`${p}u [@user]\` / \`s-u [@user]\` — activity card`,
    `\`${p}setprefix <prefix>\` — persists after restart`,
    `\`${p}embedcreate\` — build an embed`,
    `\`${p}alias add <shortcut> <command>\``,
    `\`${p}alias remove <shortcut>\``,
    `\`${p}alias removeall <command>\``,
    `\`${p}alias view <shortcut>\``,
    `\`${p}alias list\``,
    `\`${p}alias reset\``,
    `\`${p}afk [status]\` — set an away status`,
    `\`${p}afk mentions\` — who mentioned you while you were away`,
    `\`${p}instagram <username>\` / \`${p}ig\` / \`${p}insta\``,
    `\`${p}tiktok <username>\``,
    `\`${p}roblox <username>\``,
    `\`${p}giveaways start [#channel] <duration> <winners> <prize>\``,
    `\`${p}giveaways reroll [message link] [winners]\``,
    `\`${p}set gw host @role\``,
    `\`${p}restart\` — Founders, Gods, and the server owner`,
    `\`${p}modsetup\` — Gods set vouch, voice ranks, and numb bot logs`,
    `\`${p}modlogreset\` — clear saved log channels and set them up again`
  ].join("\n");
}

function infoText(prefix) {
  const p = prefix;
  return [
    `\`${p}avatar [@user]\``,
    `\`${p}banner [@user]\``,
    `\`${p}serverinfo\``,
    `\`${p}userinfo [@user]\``,
    `\`${p}roles\``,
    `\`${p}proof @user\` — images they sent since they joined`,
    `\`${p}prooflist\` — who has uploaded an image`,
    `\`${p}noproof\` — who has not uploaded an image`
  ].join("\n");
}

function godmodeText() {
  return [
    "Godmode tiers and rank management.",
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
    "**Voice Premium Plus** — voiceoverride, stsu, unstsu, voice shield, plus Voice Premium and Voice Plus",
    "`-voiceshield @user` — Gods and the server owner can grant the same protection",
    "**Voice Premium** — follow, chain, unfollow, bring, forceclaim, inspect",
    "**Voice Plus** — inspect",
    "**Gods and Founders** — forceownership, dragall, voicehistory, vchistory, godmode, shield",
    "",
    "`-vc rank` — list ranked members",
    "`-vc rank assign @user <rank>` — assign a rank",
    "`-vc rank assign @user breakthru` — join locked temporary calls. `break` and `break thru` work too",
    "`-vc unrank @user` — remove a rank",
    "`-vc rankinfo` — your rank, or `@user` for theirs, including who assigned it",
    "`-voice plus @role` / `-voice premium @role` / `-vouch premium plus @role`",
    "",
    "Only Gods can add or remove these roles, and only with the bot.",
    "Verified Sellers, CEOs, and the server owner can assign a rank with `-vc rank assign`."
  ].join("\n");
}

function securityText(prefix) {
  const p = prefix;
  return [
    "These modules act on the audit event. Vanity, dangerous permissions, and bot joins ban and reverse immediately. Mass kick and mass ban use the threshold you set.",
    "The server owner, this bot, and Anti-Nuke admins are whitelisted.",
    "",
    `\`${p}securityconfig\` — modules, on or off, and thresholds`,
    `\`${p}dangerouspermissionsadd on|off\` · \`${p}dpa\``,
    `\`${p}dangerouspermissionsupdate on|off\` · \`${p}dpu\``,
    `\`${p}vanityprotection on|off\` · \`${p}vp\``,
    `\`${p}denybotjoins on|off\` · \`${p}dbj\``,
    `\`${p}massmemberkick on|off\` · \`${p}mmk threshold <number>\` · \`${p}mmk punishment ban|kick|strip\``,
    `\`${p}massmemberban on|off\` · \`${p}mmb threshold <number>\` · \`${p}mmb punishment ban|kick|strip\``,
    "",
    `\`${p}setwatchrole @role\` — log who gives or removes that role`,
    `\`${p}unwatchrole @role\``,
    `\`${p}watchuser @user\` — log moderation that member does`,
    `\`${p}unwatchuser @user\``,
    "",
    "Turning a module on opens #security-events. The first watched role opens #watchlist. Only administrators can see those channels."
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
    "Event categories: message, role, server, member",
    "Bans, kicks, timeouts, and unbans share `punishments`.",
    "Vouches, giver changes, and Anti-Nuke actions share `antinuke`.",
    `\`${p}logging set antinuke [#channel]\``,
    `\`${p}logging set punishments [#channel]\``,
    "`all` does not change the Anti-Nuke or punishment log.",
    `\`${p}modlogreset\` clears the saved channels so \`${p}modsetup\` can place them again.`,
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

function protectionText(prefix) {
  const p = prefix;
  return [
    "Protect a role or a user. Only the person who protected it can remove that protection.",
    "Verified Sellers can protect a role. Unprotect stays with Gods and the server owner.",
    "",
    "**Gods and the server owner**",
    `\`${p}protect @role\` — protect a role. You become its only owner.`,
    `\`${p}protect @user\` — give someone a role you protect.`,
    `\`${p}unprotect @role\` — stop owning a role you protected.`,
    `\`${p}unprotect @user\` — take your protection off a user.`,
    "",
    "**Everyone**",
    `\`${p}protected\` — people you protect`,
    `\`${p}plist\` / \`${p}protectedlist\` — everyone protected in this server`
  ].join("\n");
}

function vanityText(prefix) {
  const p = prefix;
  return [
    "Gods and the server owner set a status word and the roles it gives.",
    "",
    `\`${p}vanity set tunes\``,
    `\`${p}vanity reward @role, role2, @role 3\``,
    `\`${p}vanitysetup\` — buttons for the name and reward roles`,
    "",
    "The status has to contain that word. Capitals are ignored.",
    "`carTUNES`, `/tunes`, `tunes101`, and `@tUnEs` all match `tunes`."
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

function sellerText(prefix) {
  const p = prefix;
  return [
    "Verified Seller sits under CEO / God and above Founder.",
    "Only CEOs and the server owner can set the one role or add someone.",
    "If a person gives or removes that role by hand, the bot reverses it, kicks that person, and tells administrators.",
    "Another bot is never kicked, and its role change is left for a CEO or the server owner to fix by hand.",
    "",
    "**CEOs and the server owner**",
    `\`${p}verifiedseller @role\` — set the one role`,
    `\`${p}verifiedseller add @user\` — make someone a verified seller`,
    `\`${p}verifiedseller remove @user\` — remove a verified seller`,
    `\`${p}verifiedseller addgiver <command>\` — let sellers grant that command`,
    `\`${p}verifiedseller removegiver <command>\` — close that grant`,
    "",
    "**Verified Sellers**",
    `\`${p}vc rank assign @user <rank>\``,
    `\`${p}protect @role\``,
    `\`${p}grant <command> @user\` — only commands opened with addgiver`
  ].join("\n");
}

function catalogText(prefix, name) {
  const category = require("./catalog").categories(prefix).find((item) => item.name === name);
  return category?.value || "";
}

function fit(text) {
  const lines = String(text || "").split("\n");
  const kept = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > 3200 && kept.length) {
      kept.push("", "The rest of this category is in `-showallcommands`.");
      break;
    }
    kept.push(line);
    size += line.length + 1;
  }
  return kept.join("\n");
}

const PAGES = {
  overview: {
    title: "Categories",
    body(prefix) {
      return [
        "Moderation — Bans, security, staff, channels, logging, and the rest",
        "Voice Management — VC, ranks, and voice tools",
        "Vouch — Vouches, giver access, roles, and limits",
        "Role Management — Role limits, protection, and force",
        "Verified Seller — The seller role, rank assign, protect, and grants",
        "",
        `\`${prefix}newcommands\` — short list of what was just added`,
        "",
        "Use the menu below to open a category."
      ].join("\n");
    }
  },
  vouch: { title: "Vouch", body: vouchText },
  force: { title: "Force Management", body: forceText },
  moderation: {
    title: "Moderation",
    body(prefix) {
      return fit(catalogText(prefix, "Moderation"));
    }
  },
  voice: {
    title: "Voice Management",
    body(prefix) {
      return fit([
        "Verified Sellers, CEOs, and the server owner can assign a VC rank.",
        "",
        catalogText(prefix, "Voice Management")
      ].join("\n"));
    }
  },
  roles: {
    title: "Role Management",
    body(prefix) {
      return fit([
        "Verified Sellers can protect a role. Unprotect stays with Gods and the server owner.",
        "",
        catalogText(prefix, "Role Management")
      ].join("\n"));
    }
  },
  seller: { title: "Verified Seller", body: sellerText },
  info: { title: "Info & Avatars", body: infoText },
  godmode: { title: "Godmode", body: godmodeText },
  ranks: { title: "VC Ranks", body: ranksText },
  antinuke: { title: "AntiNuke", body: antinukeText },
  security: { title: "Security", body: securityText },
  logging: { title: "Event Logging", body: loggingText },
  rolelimits: { title: "Role Limits", body: roleLimitText },
  management: { title: "Management", body: managementText },
  staff: { title: "Staff Access", body: staffText },
  channels: { title: "Channel Controls", body: channelText },
  bot: { title: "Bot", body: botText },
  vanity: { title: "Vanity", body: vanityText },
  protection: { title: "Protection", body: protectionText }
};

const CATEGORY_ACCESS = {
  overview: "Everyone. Each category says who can use it.",
  moderation: "Depends on the command. Gods and above for most moderation.",
  info: "Everyone",
  voice: "Everyone for their own VC. Verified Sellers, CEOs, and the server owner can assign ranks.",
  roles: "Role limits and force follow staff ranks. Verified Sellers can protect a role.",
  seller: "CEOs and the server owner manage the role. Verified Sellers assign ranks, protect a role, and grant opened commands.",
  godmode: "Gods and above",
  ranks: "Gods and Founders, or the VC rank listed on each command",
  antinuke: "Gods and above. Anti-Nuke admin changes are the server owner.",
  security: "The server owner and Anti-Nuke admins.",
  channels: "Founders and above",
  logging: "Gods and above",
  rolelimits: "Gods and above",
  vouch: "Gods and above, Anti-Nuke admins, and the vouch founder role",
  management: "Gods and above",
  staff: "Assigned tiers. The server owner can use every command.",
  force: "Founders and above",
  bot: "Help is everyone. Prefix, aliases, and restart are Founders and above.",
  vanity: "Gods and the server owner",
  protection: "Gods and the server owner protect and unprotect. Everyone can view the lists."
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
    { label: "Moderation", value: "moderation", description: "Bans, security, staff, and the rest" },
    { label: "Voice Management", value: "voice", description: "VC, ranks, and voice tools" },
    { label: "Vouch", value: "vouch", description: "Vouches, givers, limits, blacklist" },
    { label: "Role Management", value: "roles", description: "Limits, protection, and force" },
    { label: "Verified Seller", value: "seller", description: "Seller role, assign, protect, grants" }
  ];
  return options.map((option) => {
    const data = { ...option, default: option.value === selected };
    if (option.value === "overview" && withEmoji) data.emoji = { ...OVERVIEW_EMOJI };
    return data;
  });
}

function helpRow(selected = "overview", withEmoji = true, userId = "") {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`spanter:help:${userId}`)
      .setPlaceholder("Select a category")
      .addOptions(helpOptions(selected, withEmoji))
  );
}

async function refuseOther(interaction) {
  await interaction.reply({
    embeds: [embed("Not Yours", "Only the person who opened this can change it.")],
    flags: MessageFlags.Ephemeral
  }).catch(() => null);
}

async function sendHelp(message, prefix) {
  const payload = (withEmoji) => ({
    embeds: [renderHelp("overview", prefix, message.member)],
    components: [helpRow("overview", withEmoji, message.author.id)]
  });
  try {
    return await message.reply(payload(true));
  } catch (error) {
    return message.reply(payload(false));
  }
}

function helpOwner(customId) {
  const id = String(customId || "");
  if (!id.startsWith("spanter:help:")) return "";
  return id.slice("spanter:help:".length);
}

async function handleInteraction(interaction) {
  if (!interaction?.customId) return false;
  const prefix = store.getPrefix(interaction.guildId || interaction.guild?.id);
  if (interaction.customId === "spanter:help" || interaction.customId.startsWith("spanter:help:")) {
    const ownerId = helpOwner(interaction.customId);
    if (ownerId && interaction.user?.id && ownerId !== interaction.user.id) {
      await refuseOther(interaction);
      return true;
    }
    const category = interaction.values?.[0] || "overview";
    const payload = (withEmoji) => ({
      embeds: [renderHelp(category, prefix, interaction.member)],
      components: [helpRow(category, withEmoji, ownerId || interaction.user?.id || "")]
    });
    try {
      await interaction.update(payload(true));
    } catch (error) {
      if (!interaction.replied && !interaction.deferred) await interaction.update(payload(false));
    }
    return true;
  }
  if (interaction.customId === "spanter:force" || interaction.customId.startsWith("spanter:force:")) {
    return force.handleSelect(interaction, prefix);
  }
  if (interaction.customId === "spanter:vouch" || interaction.customId.startsWith("spanter:vouch:")) {
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
