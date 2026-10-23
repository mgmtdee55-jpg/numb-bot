const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  Routes,
  StringSelectMenuBuilder
} = require("discord.js");
const { card } = require("./feedback");
const vanity = require("./vanity");
const cooldowns = require("./systems/cooldowns");

const CATEGORIES = {
  tag: "Not repping server tag",
  all: "Kick all members",
  vanity: "Not repping guild vanity"
};

// Kick route is about 5 requests per 5 seconds per guild. DMs are a separate, tighter bucket.
// One member a second, plus a longer pause every 5, stays under both. 429s are waited out.
const KICK_GAP_MS = 1100;
const BURST_SIZE = 5;
const BURST_PAUSE_MS = 1500;
const PAGE_PAUSE_MS = 350;

const jobs = new Map();

function testing() {
  return !!(process.env.NODE_TEST_CONTEXT || process.env.npm_lifecycle_event === "test");
}

function embed(title, description, guild) {
  return card(title, description, { guild });
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function pause(ms, job) {
  if (!(ms > 0) || testing()) return;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (job?.cancelled) return;
    await sleep(Math.min(200, end - Date.now()));
  }
}

function retryMs(error) {
  const status = Number(error?.status || error?.code);
  const raw = Number(error?.rawError?.retry_after ?? error?.requestData?.retryAfter ?? error?.data?.retry_after);
  if (raw > 0) return Math.ceil(raw * 1000) + 250;
  const given = Number(error?.retryAfter);
  if (given > 0) return Math.ceil(given < 100 ? given * 1000 : given) + 250;
  if (status === 429) return 2000;
  return 0;
}

function errorCode(error) {
  return Number(error?.code || error?.rawError?.code || 0);
}

function isOwner(guild, userId) {
  return !!guild && !!userId && String(userId) === String(guild.ownerId);
}

function inviteCode(guild, code) {
  return String(code || guild?.vanityURLCode || "yrs").replace(/^\/+/, "") || "yrs";
}

function dmText(category, guild) {
  const name = guild?.name || "the server";
  if (category === "tag") return `Kicked from ${name} for not having the server tag on. No direct message is sent.`;
  if (category === "vanity") return `Kicked from ${name} for not having the guild vanity on. No direct message is sent.`;
  return `Kicked from ${name}. No direct message is sent.`;
}

function repsServerTag(user, guildId) {
  const primary = user?.primaryGuild || user?.primary_guild || user?.clan || null;
  if (!primary || typeof primary !== "object") return false;
  const id = primary.identityGuildId || primary.identity_guild_id;
  if (!id || String(id) !== String(guildId)) return false;
  const enabled = primary.identityEnabled ?? primary.identity_enabled;
  return enabled !== false && enabled !== 0;
}

function vanityNames(guild, code) {
  const names = [];
  const config = vanity.getConfig(guild.id);
  if (config?.name) names.push(config.name);
  const live = inviteCode(guild, code);
  if (live && live !== "yrs") names.push(live);
  else if (guild.vanityURLCode || code) names.push(live);
  return [...new Set(names.map((name) => String(name).trim()).filter(Boolean))];
}

function repsVanity(presence, names) {
  const text = vanity.statusText(presence);
  if (!text || !names.length) return false;
  return names.some((name) => vanity.hasVanity(text, name));
}

function highestPosition(guild, roleIds) {
  let highest = 0;
  let unknown = false;
  for (const roleId of roleIds || []) {
    if (String(roleId) === String(guild.id)) continue;
    const role = guild.roles?.cache?.get?.(roleId);
    if (!role) {
      unknown = true;
      continue;
    }
    if (role.position > highest) highest = role.position;
  }
  return { highest, unknown };
}

function canKick(guild, member) {
  if (!member?.id || member.bot) return false;
  const me = guild.members?.me;
  if (!me || member.id === guild.ownerId || member.id === me.id) return false;
  if (me.permissions?.has && !me.permissions.has(PermissionFlagsBits.KickMembers)) return false;
  const botPos = me.roles?.highest?.position ?? 0;
  const { highest, unknown } = highestPosition(guild, member.roles);
  if (unknown || highest >= botPos) return false;
  return true;
}

function normalize(guild, row) {
  const user = row.user || row;
  const id = String(user.id || row.id || "");
  const cached = guild.members?.cache?.get?.(id);
  const roles = Array.isArray(row.roles)
    ? row.roles.map(String)
    : [...(row.roles?.cache?.keys?.() || cached?.roles?.cache?.keys?.() || [])];
  return {
    id,
    bot: !!(user.bot || row.bot || row.user?.bot),
    roles,
    user,
    presence: cached?.presence || row.presence || null
  };
}

async function fetchRawMembers(guild, job) {
  const rest = guild.client?.rest;
  if (!rest?.get || !Routes?.guildMembers) return null;
  const rows = [];
  let after = "0";
  for (let page = 0; page < 200; page += 1) {
    if (job?.cancelled) break;
    const batch = await rest.get(Routes.guildMembers(guild.id), {
      query: new URLSearchParams({ limit: "1000", after })
    });
    if (!Array.isArray(batch) || !batch.length) break;
    rows.push(...batch);
    if (batch.length < 1000) break;
    const next = batch[batch.length - 1]?.user?.id;
    if (!next || next === after) break;
    after = next;
    await pause(PAGE_PAUSE_MS, job);
  }
  return rows;
}

async function warmPresences(guild) {
  if (!guild.members?.fetch) return;
  try {
    await guild.members.fetch({ withPresences: true });
  } catch {
    await guild.members.fetch().catch(() => null);
  }
}

async function collectMembers(guild, job, { presences = false } = {}) {
  if (guild.roles?.fetch) await guild.roles.fetch().catch(() => null);
  if (presences) await warmPresences(guild);
  const raw = await fetchRawMembers(guild, job).catch((error) => {
    console.error(`[mkick] member list ${guild.id}`, error);
    return null;
  });
  const source = raw || [...(guild.members?.cache?.values?.() || [])];
  const seen = new Set();
  const members = [];
  for (const row of source) {
    const member = normalize(guild, row);
    if (!member.id || seen.has(member.id)) continue;
    seen.add(member.id);
    members.push(member);
  }
  return { members, fromRest: Array.isArray(raw) };
}

async function vanityCode(guild) {
  if (guild.vanityURLCode) return guild.vanityURLCode;
  if (!guild.fetchVanityData) return null;
  const data = await guild.fetchVanityData().catch(() => null);
  return data?.code || null;
}

function targetsFor(category, guild, members, code) {
  const names = vanityNames(guild, code);
  return members.filter((member) => {
    if (!canKick(guild, member)) return false;
    if (category === "all") return true;
    if (category === "tag") return !repsServerTag(member.user, guild.id);
    if (category === "vanity") return !repsVanity(member.presence, names);
    return false;
  });
}

function menuRow(ownerId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`spanter:mkick:pick:${ownerId}`)
      .setPlaceholder("Choose who to kick")
      .addOptions([
        { label: CATEGORIES.tag, value: "tag", description: "No server tag for this guild" },
        { label: CATEGORIES.all, value: "all", description: "Everyone the bot is allowed to kick" },
        { label: CATEGORIES.vanity, value: "vanity", description: "No guild vanity in their status" }
      ])
  );
}

function buttonRow(ownerId, kind, category) {
  if (kind === "confirm") {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`spanter:mkick:start:${ownerId}:${category}`).setLabel("Start kick").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`spanter:mkick:cancel:${ownerId}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    );
  }
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`spanter:mkick:stop:${ownerId}`).setLabel("Abort").setStyle(ButtonStyle.Danger)
  );
}

async function ensureMe(guild) {
  if (guild.members?.me?.permissions) return guild.members.me;
  if (guild.members?.fetchMe) return guild.members.fetchMe().catch(() => null);
  const id = guild.client?.user?.id;
  if (id && guild.members?.fetch) return guild.members.fetch(id).catch(() => null);
  return guild.members?.me || null;
}

async function handleCommand(message, args, prefix) {
  const command = String(args[0] || "").toLowerCase();
  if (command !== `${prefix}mkick`.toLowerCase()) return false;
  if (!isOwner(message.guild, message.author.id)) {
    await message.reply({ embeds: [embed("Owner Only", "Only the server owner can use `-mkick`.", message.guild)] });
    return true;
  }
  if (jobs.has(String(message.guild.id))) {
    await message.reply({
      embeds: [embed("Mass Kick Running", "One is already running. Press **Abort** on that message to stop it.", message.guild)]
    });
    return true;
  }
  const wait = cooldowns.consume(message.guild.id, message.author.id, "mkick");
  if (wait) {
    await message.reply({ embeds: [embed("Please Wait", cooldowns.waitText(wait), message.guild)] });
    return true;
  }
  const me = await ensureMe(message.guild);
  if (!me?.permissions?.has?.(PermissionFlagsBits.KickMembers)) {
    await message.reply({
      embeds: [embed("Bot Missing Permission", "I need the Discord **Kick Members** permission, and my role has to be above the people you want kicked.", message.guild)]
    });
    return true;
  }
  await message.reply({
    embeds: [embed(
      "Mass Kick",
      [
        "Pick a category. Nothing is kicked until you press **Start kick**.",
        "Bots, you, and anyone above my highest role are skipped.",
        "Kicks are spaced out, and **Abort** stops the run after the current member."
      ].join("\n"),
      message.guild
    )],
    components: [menuRow(message.author.id)]
  });
  return true;
}

function parseId(customId) {
  const text = String(customId || "");
  if (!text.startsWith("spanter:mkick:")) return null;
  const [, , action, ownerId, category] = text.split(":");
  if (!/^\d{17,20}$/.test(ownerId || "") && !/^\d+$/.test(ownerId || "")) return null;
  if (!["pick", "start", "cancel", "stop"].includes(action)) return null;
  if (action === "start" && !CATEGORIES[category]) return null;
  return { action, ownerId, category: category || null };
}

async function deny(interaction, title, description) {
  const payload = { embeds: [embed(title, description, interaction.guild)], flags: 64 };
  if (interaction.replied || interaction.deferred) {
    if (interaction.followUp) return interaction.followUp(payload);
    if (interaction.editReply) return interaction.editReply(payload);
  }
  return interaction.reply(payload);
}

async function render(interaction, payload) {
  if ((interaction.deferred || interaction.replied) && interaction.message?.edit) {
    return interaction.message.edit(payload);
  }
  if (interaction.update && !interaction.deferred && !interaction.replied) return interaction.update(payload);
  if (interaction.editReply) return interaction.editReply(payload);
  if (interaction.message?.edit) return interaction.message.edit(payload);
  return null;
}

async function acknowledge(interaction) {
  if (interaction.deferred || interaction.replied) return;
  if (interaction.deferUpdate) {
    await interaction.deferUpdate();
    return;
  }
  if (interaction.update) await interaction.update({});
}

function progressText(label, counts, note) {
  return [
    `**${label}**`,
    `Kicked **${counts.kicked}** · Could not kick **${counts.failed}** · Left **${counts.left}** · Remaining **${counts.leftCount}**`,
    note
  ].join("\n");
}

async function kickOne(guild, member, reason, job) {
  const run = () => {
    if (typeof guild.members?.kick === "function") return guild.members.kick(member.id, reason);
    const cached = guild.members?.cache?.get?.(member.id);
    if (cached?.kick) return cached.kick(reason);
    throw new Error("kick unavailable");
  };
  try {
    await run();
    return "kicked";
  } catch (error) {
    const wait = retryMs(error);
    if (wait && !job.cancelled) {
      await pause(wait, job);
      if (job.cancelled) return "aborted";
      try {
        await run();
        return "kicked";
      } catch (again) {
        if (errorCode(again) === 10007) return "left";
        if (errorCode(again) === 50013 || errorCode(again) === 50001) return "abort";
        return "failed";
      }
    }
    if (errorCode(error) === 10007) return "left";
    if (errorCode(error) === 50013 || errorCode(error) === 50001) return "abort";
    return "failed";
  }
}

async function runKick(interaction, category, job) {
  const guild = interaction.guild;
  const label = CATEGORIES[category];
  const message = interaction.message;
  const counts = { kicked: 0, failed: 0, left: 0, leftCount: 0 };
  const show = async (note, components) => {
    const payload = {
      embeds: [embed(note === "done" ? (job.cancelled ? "Mass Kick Aborted" : "Mass Kick Finished") : "Mass Kick", note === "done"
        ? [
          job.cancelled ? "Stopped early." : "Finished.",
          `**${label}**`,
          `Kicked **${counts.kicked}**. Could not kick **${counts.failed}**. Already left **${counts.left}**. Nobody was sent a direct message.`
        ].join("\n")
        : note, guild)],
      components: components || []
    };
    try {
      if (message?.edit) await message.edit(payload);
      else await render(interaction, payload);
    } catch (error) {
      const wait = retryMs(error);
      if (wait) await pause(wait, job);
    }
  };

  await show("Checking members. Press **Abort** if you want this to stop.", [buttonRow(job.ownerId, "stop")]);
  const { members, fromRest } = await collectMembers(guild, job, { presences: category === "vanity" });
  if (job.cancelled) {
    await show("done", []);
    return;
  }
  const code = category === "vanity" || category === "tag" || category === "all" ? await vanityCode(guild) : null;
  if (category === "vanity" && !vanityNames(guild, code).length) {
    await message?.edit?.({
      embeds: [embed("No Vanity", "This server has no vanity URL, and `-vanity set` has not been used. I can't tell who is repping one.", guild)],
      components: []
    });
    return;
  }
  if (category === "tag" && !fromRest) {
    await message?.edit?.({
      embeds: [embed("Server Tags Unavailable", "I couldn't read server tags from Discord, so nobody was kicked.", guild)],
      components: []
    });
    return;
  }
  const targets = targetsFor(category, guild, members, code);
  counts.leftCount = targets.length;
  if (!targets.length) {
    await message?.edit?.({
      embeds: [embed("Nobody To Kick", `No kickable members matched **${label}**. Bots, you, and anyone above my role are skipped.`, guild)],
      components: []
    });
    return;
  }

  const reason = `Mass kick (${label}) by the server owner`;
  let sinceBurst = 0;
  for (const member of targets) {
    if (job.cancelled) break;
    counts.leftCount = Math.max(0, counts.leftCount - 1);
    if (!canKick(guild, member)) continue;
    if (job.cancelled) break;
    const result = await kickOne(guild, member, reason, job);
    if (result === "abort") {
      counts.failed += 1;
      job.cancelled = true;
      await show("I lost permission to kick, so the run stopped.", []);
      return;
    }
    if (result === "kicked") counts.kicked += 1;
    else if (result === "left") counts.left += 1;
    else if (result === "failed") counts.failed += 1;
    sinceBurst += 1;
    const gap = KICK_GAP_MS + (sinceBurst % BURST_SIZE === 0 ? BURST_PAUSE_MS : 0);
    if (job.cancelled) break;
    if (counts.kicked > 0 && counts.kicked % 3 === 0) {
      await show(progressText(label, counts, "Press **Abort** to stop after the current member."), [buttonRow(job.ownerId, "stop")]);
    }
    await pause(gap, job);
  }
  counts.leftCount = 0;
  await show("done", []);
}

async function preview(interaction, category) {
  const guild = interaction.guild;
  await acknowledge(interaction);
  await render(interaction, {
    embeds: [embed("Mass Kick", "Checking members...", guild)],
    components: []
  });
  const code = await vanityCode(guild);
  if (category === "vanity" && !vanityNames(guild, code).length) {
    await render(interaction, {
      embeds: [embed("No Vanity", "This server has no vanity URL, and `-vanity set` has not been used. I can't tell who is repping one.", guild)],
      components: []
    });
    return;
  }
  const { members, fromRest } = await collectMembers(guild, null, { presences: category === "vanity" });
  if (category === "tag" && !fromRest) {
    await render(interaction, {
      embeds: [embed("Server Tags Unavailable", "I couldn't read server tags from Discord, so nobody was kicked.", guild)],
      components: []
    });
    return;
  }
  const targets = targetsFor(category, guild, members, code);
  const label = CATEGORIES[category];
  const lines = [
    `**${label}**`,
    `**${targets.length}** member(s) will be kicked.`,
    "Bots, you, and anyone above my highest role are skipped.",
    "About one member a second, with an extra pause every 5 kicks. Rate limits are waited out.",
    "Nobody is sent a direct message or an invite."
  ];
  if (category === "vanity") {
    lines.splice(3, 0, "Offline members count as not repping, because their status is not visible.");
  }
  await render(interaction, {
    embeds: [embed("Mass Kick", lines.join("\n"), guild)],
    components: targets.length ? [buttonRow(interaction.user.id, "confirm", category)] : []
  });
}

async function handleInteraction(interaction) {
  const parsed = parseId(interaction.customId);
  if (!parsed) {
    if (String(interaction.customId || "").startsWith("spanter:mkick:")) {
      await deny(interaction, "Expired", "Run `-mkick` again.");
      return true;
    }
    return false;
  }
  const guild = interaction.guild;
  const userId = interaction.user?.id;
  if (!isOwner(guild, userId) || String(userId) !== String(parsed.ownerId)) {
    await deny(interaction, "Owner Only", "Only the server owner who opened this can use it.");
    return true;
  }
  if (parsed.action === "stop") {
    const job = jobs.get(String(guild.id));
    if (!job) {
      await deny(interaction, "Nothing Running", "There is no mass kick running.");
      return true;
    }
    job.cancelled = true;
    await deny(interaction, "Aborting", "The mass kick will stop after the current member.");
    return true;
  }
  if (parsed.action === "cancel") {
    await acknowledge(interaction);
    await render(interaction, {
      embeds: [embed("Mass Kick Cancelled", "Nobody was kicked.", guild)],
      components: []
    });
    return true;
  }
  if (jobs.has(String(guild.id))) {
    await deny(interaction, "Mass Kick Running", "One is already running. Press **Abort** to stop it.");
    return true;
  }
  if (parsed.action === "pick") {
    const category = interaction.values?.[0];
    if (!CATEGORIES[category]) {
      await deny(interaction, "Unknown Category", "Pick server tag, everyone, or guild vanity.");
      return true;
    }
    await preview(interaction, category);
    return true;
  }
  const me = await ensureMe(guild);
  if (!me?.permissions?.has?.(PermissionFlagsBits.KickMembers)) {
    await deny(interaction, "Bot Missing Permission", "I need the Discord **Kick Members** permission.");
    return true;
  }
  const job = { cancelled: false, ownerId: userId };
  jobs.set(String(guild.id), job);
  try {
    await acknowledge(interaction);
    await runKick(interaction, parsed.category, job);
  } catch (error) {
    console.error(`[mkick] ${guild.id}`, error);
    job.cancelled = true;
    await interaction.message?.edit?.({
      embeds: [embed("Mass Kick Stopped", "The run stopped because Discord returned an unexpected error.", guild)],
      components: []
    }).catch(() => null);
  } finally {
    jobs.delete(String(guild.id));
  }
  return true;
}

module.exports = {
  handleCommand,
  handleInteraction,
  retryMs,
  dmText,
  repsServerTag
};
