const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits } = require("discord.js");
const { connection } = require("./db");
const { reply } = require("./vouch/ui");
const { replyUsage } = require("./usage");
const { resolveMember } = require("./vouch/resolve");
const { logThrottledError } = require("./log-throttle");

const PAGE_SIZE = 8;
const FETCH_BUDGET = 40;
const PAGE_PAUSE_MS = process.env.npm_lifecycle_event === "test" || process.env.NODE_TEST_CONTEXT ? 0 : 300;
const TEXT_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread
]);

connection.exec(`
CREATE TABLE IF NOT EXISTS proof_images (
  guild_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  image_url TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  content TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, message_id, image_url)
);
CREATE INDEX IF NOT EXISTS idx_proof_author ON proof_images(guild_id, author_id, created_at);
CREATE TABLE IF NOT EXISTS proof_joins (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  inviter_id TEXT,
  invite_code TEXT,
  vanity INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER,
  PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE IF NOT EXISTS proof_scans (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  before_id TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
);
`);

const statements = {
  saveImage: connection.prepare(`
    INSERT OR IGNORE INTO proof_images(guild_id, message_id, image_url, channel_id, author_id, content, created_at)
    VALUES(?,?,?,?,?,?,?)
  `),
  images: connection.prepare(`
    SELECT * FROM proof_images
    WHERE guild_id=? AND author_id=? AND created_at>=?
    ORDER BY created_at DESC, message_id DESC, image_url ASC
  `),
  stamps: connection.prepare("SELECT author_id, created_at FROM proof_images WHERE guild_id=?"),
  join: connection.prepare("SELECT * FROM proof_joins WHERE guild_id=? AND user_id=?"),
  insertJoin: connection.prepare(`
    INSERT INTO proof_joins(guild_id, user_id, inviter_id, invite_code, vanity, joined_at)
    VALUES(?,?,?,?,?,?)
  `),
  updateJoin: connection.prepare(`
    UPDATE proof_joins SET inviter_id=?, invite_code=?, vanity=?, joined_at=? WHERE guild_id=? AND user_id=?
  `),
  scan: connection.prepare("SELECT * FROM proof_scans WHERE guild_id=? AND channel_id=?"),
  saveScan: connection.prepare(`
    INSERT INTO proof_scans(guild_id, channel_id, before_id, done, updated_at)
    VALUES(?,?,?,?,?)
    ON CONFLICT(guild_id, channel_id) DO UPDATE SET
      before_id=excluded.before_id,
      done=excluded.done,
      updated_at=excluded.updated_at
  `)
};

const inviteCache = new Map();

function valuesOf(collection) {
  if (!collection) return [];
  if (typeof collection.values === "function") return [...collection.values()];
  if (Array.isArray(collection)) return collection;
  return [];
}

function createdOf(message) {
  const stamp = Number(message?.createdTimestamp || 0);
  if (stamp > 0) return stamp;
  const parsed = message?.createdAt ? new Date(message.createdAt).getTime() : 0;
  return parsed > 0 ? parsed : Date.now();
}

function isImage(file) {
  const name = `${file?.contentType || ""} ${file?.name || ""} ${file?.url || ""} ${file?.proxyURL || ""}`;
  return /image\/|\.png|\.jpe?g|\.gif|\.webp|\.bmp/i.test(name);
}

function contentImages(content) {
  const found = String(content || "").match(/https?:\/\/\S+\.(?:png|jpe?g|gif|webp|bmp)(?:\?\S*)?/gi) || [];
  return found.map((url) => url.replace(/[>),.\]]+$/, ""));
}

function imageUrls(message) {
  const urls = [];
  for (const file of valuesOf(message.attachments)) {
    if (!isImage(file)) continue;
    const url = file.url || file.proxyURL;
    if (url) urls.push(url);
  }
  for (const embed of valuesOf(message.embeds)) {
    const image = embed?.image?.url || embed?.data?.image?.url;
    const thumb = embed?.thumbnail?.url || embed?.data?.thumbnail?.url;
    if (image) urls.push(image);
    else if (thumb && isImage({ url: thumb })) urls.push(thumb);
  }
  for (const url of contentImages(message.content)) urls.push(url);
  return [...new Set(urls)];
}

function remember(message, guildId) {
  try {
    const id = message?.guild?.id || message?.guildId || guildId;
    const authorId = message?.author?.id;
    if (!message?.id || !id || !authorId || message.author?.bot || !message.channelId) return 0;
    const urls = imageUrls(message);
    if (!urls.length) return 0;
    const content = String(message.content || "").slice(0, 1000);
    const createdAt = createdOf(message);
    for (const url of urls) {
      statements.saveImage.run(String(id), String(message.id), String(url), String(message.channelId), String(authorId), content, createdAt);
    }
    return urls.length;
  } catch (error) {
    logThrottledError("proof-remember", "[proof remember]", error);
    return 0;
  }
}

function sinceOf(member, row) {
  const live = Number(member?.joinedTimestamp || 0);
  if (live > 0) return live;
  return Number(row?.joined_at || 0);
}

function joinedLabel(member, row) {
  const when = Number(member?.joinedTimestamp || row?.joined_at || 0);
  if (!when) return "Joined unknown";
  const unix = Math.floor(when / 1000);
  return `Joined <t:${unix}:F> (<t:${unix}:R>)`;
}

function invitedLabel(row) {
  if (row?.inviter_id) return `Invited by <@${row.inviter_id}>`;
  if (row?.vanity) return "Invited by the vanity URL";
  return "Invited by unknown";
}

function createdLabel(userId) {
  try {
    const ms = Number((BigInt(userId) >> 22n) + 1420070400000n);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return `Account created <t:${Math.floor(ms / 1000)}:R>`;
  } catch {
    return null;
  }
}

function profileLines(guildId, userId, member) {
  const row = statements.join.get(String(guildId), String(userId));
  const lines = [`<@${userId}>`, joinedLabel(member, row), invitedLabel(row)];
  const created = createdLabel(userId);
  if (created) lines.push(created);
  return { lines, since: sinceOf(member, row) };
}

function pendingNote(pending) {
  return pending ? "\n\nOlder messages are still being read. Run this again to continue." : "";
}

function embed(title, description) {
  return new EmbedBuilder().setColor(0x2b2d31).setTitle(title).setDescription(String(description || "").slice(0, 4096));
}

function buttons(ownerId, kind, index, total, extra = "") {
  if (total <= 1) return [];
  const tail = extra ? `:${extra}` : "";
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`spanter:proof:${kind}:${ownerId}:${index - 1}${tail}`)
      .setLabel("Back")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(index <= 0),
    new ButtonBuilder()
      .setCustomId(`spanter:proof:${kind}:${ownerId}:${index + 1}${tail}`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(index >= total - 1)
  )];
}

function viewPayload(guild, member, userId, index, ownerId, pending) {
  const profile = profileLines(guild.id, userId, member);
  const rows = statements.images.all(String(guild.id), String(userId), profile.since);
  const header = profile.lines.join("\n");
  if (!rows.length) {
    return {
      embeds: [embed("Proof", `${header}\n\nNo images since they joined.${pendingNote(pending)}`)],
      components: [],
      allowedMentions: { parse: [] }
    };
  }
  const safe = Math.min(rows.length - 1, Math.max(0, Number(index) || 0));
  const entry = rows[safe];
  const unix = Math.floor(Number(entry.created_at) / 1000);
  const when = unix > 0 ? `<t:${unix}:F>` : "unknown time";
  const body = [`${header}`, "", `<#${entry.channel_id}> · ${when}`];
  const caption = String(entry.content || "").trim();
  if (caption && !caption.includes(entry.image_url)) body.push("", caption.slice(0, 500));
  body.push("", `[Jump to message](https://discord.com/channels/${entry.guild_id}/${entry.channel_id}/${entry.message_id})`);
  body.push(pendingNote(pending));
  const name = member?.displayName || member?.user?.username || "Proof";
  const avatar = typeof member?.user?.displayAvatarURL === "function" ? member.user.displayAvatarURL({ size: 128 }) : null;
  const card = embed("Proof", body.filter((line) => line !== undefined).join("\n"))
    .setAuthor(avatar ? { name, iconURL: avatar } : { name })
    .setFooter({ text: `Image ${safe + 1} / ${rows.length}` })
    .setImage(entry.image_url);
  return {
    embeds: [card],
    components: buttons(ownerId, "v", safe, rows.length, userId),
    allowedMentions: { parse: [] }
  };
}

async function membersOf(guild) {
  if (typeof guild.members?.fetch === "function") {
    const fetched = await guild.members.fetch().catch(() => null);
    if (fetched?.values) return [...fetched.values()];
  }
  return [...(guild.members?.cache?.values?.() || [])];
}

async function collect(guild) {
  const stamps = new Map();
  for (const row of statements.stamps.all(String(guild.id))) {
    const list = stamps.get(row.author_id) || [];
    list.push(Number(row.created_at) || 0);
    stamps.set(row.author_id, list);
  }
  const uploaded = [];
  const missing = [];
  const seen = new Set();
  for (const member of await membersOf(guild)) {
    if (!member?.id || member.user?.bot) continue;
    seen.add(member.id);
    const row = statements.join.get(String(guild.id), String(member.id));
    const since = sinceOf(member, row);
    const count = (stamps.get(member.id) || []).filter((stamp) => stamp >= since).length;
    const entry = { id: member.id, member, count, joined: Number(member.joinedTimestamp || row?.joined_at || 0) };
    if (count > 0) uploaded.push(entry);
    else missing.push(entry);
  }
  for (const [id, times] of stamps) {
    if (seen.has(id)) continue;
    const row = statements.join.get(String(guild.id), String(id));
    const since = sinceOf(null, row);
    const count = times.filter((stamp) => stamp >= since).length;
    if (count > 0) uploaded.push({ id, member: null, count, joined: Number(row?.joined_at || 0) });
  }
  uploaded.sort((a, b) => b.count - a.count || String(a.id).localeCompare(String(b.id)));
  missing.sort((a, b) => (b.joined || 0) - (a.joined || 0) || String(a.id).localeCompare(String(b.id)));
  return { uploaded, missing };
}

function personLine(guildId, entry, withCount) {
  const row = statements.join.get(String(guildId), String(entry.id));
  const count = withCount ? ` · ${entry.count} image${entry.count === 1 ? "" : "s"}` : "";
  return `<@${entry.id}> · ${joinedLabel(entry.member, row)} · ${invitedLabel(row)}${count}`;
}

function listPayload(guild, people, kind, index, ownerId, pending) {
  const title = kind === "uploaded" ? "Proof List" : "No Proof";
  const noun = people.length === 1 ? "person has" : "people have";
  const summary = kind === "uploaded"
    ? `**${people.length}** ${noun} uploaded an image since joining.`
    : `**${people.length}** ${noun} not uploaded an image since joining.`;
  if (!people.length) {
    const empty = kind === "uploaded"
      ? "Nobody has uploaded an image since they joined."
      : "Everyone here has uploaded an image since they joined.";
    return {
      embeds: [embed(title, `${empty}${pendingNote(pending)}`)],
      components: [],
      allowedMentions: { parse: [] }
    };
  }
  const pages = Math.ceil(people.length / PAGE_SIZE);
  const safe = Math.min(pages - 1, Math.max(0, Number(index) || 0));
  const slice = people.slice(safe * PAGE_SIZE, safe * PAGE_SIZE + PAGE_SIZE);
  const lines = slice.map((entry, offset) => `**${safe * PAGE_SIZE + offset + 1}.** ${personLine(guild.id, entry, kind === "uploaded")}`);
  const card = embed(title, `${summary}\n\n${lines.join("\n")}${pendingNote(pending)}`)
    .setFooter({ text: `Page ${safe + 1} / ${pages}` });
  return {
    embeds: [card],
    components: buttons(ownerId, kind === "uploaded" ? "l" : "n", safe, pages),
    allowedMentions: { parse: [] }
  };
}

function canReadChannel(guild, channel) {
  if (!TEXT_TYPES.has(channel?.type) || typeof channel.messages?.fetch !== "function") return false;
  try {
    const me = guild.members?.me;
    if (!me || typeof channel.permissionsFor !== "function") return true;
    const perms = channel.permissionsFor(me);
    if (!perms?.has) return true;
    return perms.has(PermissionFlagsBits.ViewChannel) && perms.has(PermissionFlagsBits.ReadMessageHistory);
  } catch {
    return true;
  }
}

async function channelsToScan(guild) {
  const found = new Map();
  for (const channel of guild.channels?.cache?.values?.() || []) {
    if (canReadChannel(guild, channel)) found.set(channel.id, channel);
  }
  if (typeof guild.channels?.fetchActiveThreads === "function") {
    const active = await guild.channels.fetchActiveThreads().catch(() => null);
    const threads = active?.threads?.values ? active.threads.values() : active?.values?.() || [];
    for (const thread of threads) {
      if (canReadChannel(guild, thread)) found.set(thread.id, thread);
    }
  }
  return [...found.values()];
}

async function fetchPage(channel, before) {
  try {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch?.size) return [];
    return [...batch.values()].filter((message) => message?.id).sort((a, b) => createdOf(b) - createdOf(a));
  } catch (error) {
    logThrottledError(`proof-history:${channel.guild?.id || channel.id}`, `[proof history] ${channel.id}`, error);
    return null;
  }
}

function pause() {
  if (!PAGE_PAUSE_MS) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, PAGE_PAUSE_MS));
}

async function scanGuild(guild) {
  const channels = await channelsToScan(guild);
  let fetches = 0;
  const queue = channels.filter((channel) => !statements.scan.get(String(guild.id), String(channel.id))?.done);
  while (queue.length && fetches < FETCH_BUDGET) {
    const channel = queue.shift();
    const state = statements.scan.get(String(guild.id), String(channel.id));
    const before = state?.before_id || null;
    fetches += 1;
    const batch = await fetchPage(channel, before);
    if (batch == null) continue;
    for (const message of batch) remember(message, guild.id);
    const oldest = batch[batch.length - 1];
    if (!batch.length || batch.length < 100 || !oldest?.id || oldest.id === before) {
      statements.saveScan.run(String(guild.id), String(channel.id), oldest?.id || before, 1, Date.now());
      continue;
    }
    statements.saveScan.run(String(guild.id), String(channel.id), oldest.id, 0, Date.now());
    if (fetches < FETCH_BUDGET) queue.push(channel);
    await pause();
  }
  const pending = channels.some((channel) => !statements.scan.get(String(guild.id), String(channel.id))?.done);
  return { pending, channels: channels.length };
}

function inviteEntry(invite, vanity = false) {
  return {
    uses: Number(invite?.uses || 0),
    inviterId: invite?.inviterId || invite?.inviter?.id || null,
    vanity
  };
}

async function cacheInvites(guild) {
  const next = new Map(inviteCache.get(String(guild.id)) || []);
  if (typeof guild.invites?.fetch === "function") {
    const invites = await guild.invites.fetch().catch(() => null);
    if (invites) {
      next.clear();
      for (const invite of valuesOf(invites)) {
        if (invite?.code) next.set(invite.code, inviteEntry(invite));
      }
    }
  }
  if (typeof guild.fetchVanityData === "function") {
    const vanity = await guild.fetchVanityData().catch(() => null);
    if (vanity?.code) next.set(`vanity:${vanity.code}`, inviteEntry(vanity, true));
  }
  inviteCache.set(String(guild.id), next);
  return next;
}

function cacheInvite(invite) {
  const guildId = invite?.guild?.id;
  if (!guildId || !invite.code) return;
  const map = inviteCache.get(String(guildId)) || new Map();
  map.set(invite.code, inviteEntry(invite));
  inviteCache.set(String(guildId), map);
}

function forgetInvite(invite) {
  const guildId = invite?.guild?.id;
  if (!guildId || !invite.code) return;
  inviteCache.get(String(guildId))?.delete(invite.code);
}

function saveJoin(guildId, userId, inviterId, code, vanity, joinedAt) {
  const existing = statements.join.get(String(guildId), String(userId));
  const joined = Number(joinedAt || 0);
  if (!existing) {
    statements.insertJoin.run(String(guildId), String(userId), inviterId || null, code || null, vanity ? 1 : 0, joined || null);
    return;
  }
  const previous = Number(existing.joined_at || 0);
  const nextJoined = previous > 0 && joined > 0 ? Math.min(previous, joined) : (previous || joined || null);
  statements.updateJoin.run(
    inviterId || existing.inviter_id || null,
    code || existing.invite_code || null,
    vanity || existing.vanity ? 1 : 0,
    nextJoined,
    String(guildId),
    String(userId)
  );
}

async function noteJoin(member) {
  if (!member?.guild || !member.id || member.user?.bot) return;
  try {
    const previous = inviteCache.get(String(member.guild.id)) || new Map();
    const next = await cacheInvites(member.guild);
    let chosen = null;
    const fresh = [];
    for (const [key, invite] of next) {
      const old = previous.get(key);
      const candidate = { delta: old ? invite.uses - old.uses : invite.uses, inviterId: invite.inviterId, code: invite.vanity ? key.slice("vanity:".length) : key, vanity: !!invite.vanity };
      if (old && invite.uses > old.uses) {
        if (!chosen) chosen = candidate;
        else if (!!candidate.inviterId !== !!chosen.inviterId) chosen = candidate.inviterId ? candidate : chosen;
        else if (candidate.delta > chosen.delta) chosen = candidate;
      } else if (!old && invite.uses > 0) fresh.push(candidate);
    }
    if (!chosen && fresh.length === 1) chosen = fresh[0];
    saveJoin(member.guild.id, member.id, chosen?.inviterId || null, chosen?.code || null, !!chosen?.vanity, member.joinedTimestamp || Date.now());
  } catch (error) {
    logThrottledError(`proof-join:${member.guild.id}`, `[proof join] ${member.id}`, error);
  }
}

async function prime(client) {
  for (const guild of client?.guilds?.cache?.values?.() || []) {
    await cacheInvites(guild).catch((error) => {
      logThrottledError(`proof-invites:${guild.id}`, `[proof invites] ${guild.id}`, error);
    });
  }
}

function snowflake(value) {
  const id = String(value || "").replace(/[<@!>]/g, "");
  return /^\d{17,20}$/.test(id) ? id : null;
}

async function handleCommand(message, name, args) {
  if (!message.guild) return false;
  const ownerId = message.author.id;
  if (name === "proof") {
    const member = await resolveMember(message, args[1]);
    const userId = member?.id || snowflake(args[1]);
    if (!userId) return replyUsage(message, "proof");
    if (member?.user?.bot) return reply(message, "Not a Member", "Pick a person, not a bot.");
    await message.channel?.sendTyping?.().catch(() => null);
    const scan = await scanGuild(message.guild);
    if (!scan.channels) {
      return reply(message, "Proof", "I need to see text channels and their message history.");
    }
    return message.reply(viewPayload(message.guild, member, userId, 0, ownerId, scan.pending));
  }
  if (name === "prooflist" || name === "noproof") {
    await message.channel?.sendTyping?.().catch(() => null);
    const scan = await scanGuild(message.guild);
    if (!scan.channels) {
      return reply(message, name === "prooflist" ? "Proof List" : "No Proof", "I need to see text channels and their message history.");
    }
    const lists = await collect(message.guild);
    const people = name === "prooflist" ? lists.uploaded : lists.missing;
    return message.reply(listPayload(message.guild, people, name === "prooflist" ? "uploaded" : "missing", 0, ownerId, scan.pending));
  }
  return false;
}

async function handleButton(interaction) {
  const id = String(interaction.customId || "");
  if (!id.startsWith("spanter:proof:")) return false;
  const parts = id.split(":");
  const kind = parts[2];
  const ownerId = parts[3];
  const index = Number(parts[4]);
  if (ownerId && interaction.user?.id && ownerId !== interaction.user.id) {
    await interaction.reply({
      embeds: [embed("Not Yours", "Only the person who opened this can change it.")],
      flags: 64
    }).catch(() => null);
    return true;
  }
  if (kind === "v") {
    const userId = parts[5];
    const member = await interaction.guild.members.fetch(userId).catch(() => interaction.guild.members.cache.get(userId) || null);
    await interaction.update(viewPayload(interaction.guild, member, userId, index, ownerId, false));
    return true;
  }
  if (kind === "l" || kind === "n") {
    const lists = await collect(interaction.guild);
    const people = kind === "l" ? lists.uploaded : lists.missing;
    await interaction.update(listPayload(interaction.guild, people, kind === "l" ? "uploaded" : "missing", index, ownerId, false));
    return true;
  }
  return false;
}

module.exports = {
  remember,
  noteJoin,
  cacheInvites,
  cacheInvite,
  forgetInvite,
  prime,
  handleCommand,
  handleButton,
  imageUrls
};
