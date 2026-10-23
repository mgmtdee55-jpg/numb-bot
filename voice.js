const {
  ChannelType,
  OverwriteType,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");
const db = require("./db");
const { withChannelLock } = require("./channel-lock");
const { logThrottledError } = require("./log-throttle");
const breakthru = require("./breakthru");

const tempInterfaceTasks = new Map();
const interfaceSentAt = new Map();
const INTERFACE_RESEND_GAP_MS = 10000;
const serverInterfaceTasks = new Map();
const interfaceEmojiStrings = new Map();
const pendingCategoryMembers = new Map();
const pendingCategoryChannels = new Map();
const SERVER_INTERFACE_TOPIC = "Persistent VoiceMaster server interface";
const DEFAULT_CATEGORY_OVERFLOW_THRESHOLD = 99;
const MAX_TEMP_CATEGORIES = 3;
const DISCORD_CATEGORY_CHANNEL_CAP = 50;
const CATEGORY_RESERVATION_TTL_MS = 10000;
const OWNER_RELEASE_GRACE_MS = 5 * 60 * 1000;
const pendingOwnerReleases = new Map();
const channelsAwaitingMove = new Set();
const VC_INTERFACE_ICONS = {
  lock: "1472443164995358872",
  unlock: "1472443249745723402",
  ghost: "1496366812340686958",
  unghost: "1496366791092342885",
  kick: "1473734317518618767",
  ban: "1473734312720466124",
  unban: "1473734330109919360",
  permit: "1473734325882192130",
  claim: "1473734314989584451",
  limit: "1473734316331765857"
};

function sameId(left, right) {
  return left != null && right != null && String(left) === String(right);
}

function voiceStateChannelId(state) {
  return state?.channelId || state?.channel?.id || null;
}

function voiceStateUserId(state) {
  return state?.id || state?.userId || state?.member?.id || null;
}

function isChannelMember(guild, channelId, userId) {
  if (!guild || channelId == null || userId == null) return false;
  const channel = guild.channels?.cache?.get?.(channelId) || guild.channels?.cache?.get?.(String(channelId));
  if (channel && channelHasOccupant(channel, userId)) return true;
  const state = guild.voiceStates?.cache?.get?.(String(userId)) || guild.voiceStates?.cache?.get?.(userId);
  const stateChannel = state?.channelId || state?.channel?.id || null;
  if (stateChannel != null && sameId(stateChannel, channelId)) return true;
  const member = guild.members?.cache?.get?.(String(userId)) || guild.members?.cache?.get?.(userId);
  const memberChannel = member?.voice?.channelId || member?.voice?.channel?.id || null;
  return memberChannel != null && sameId(memberChannel, channelId);
}

function ownerReleasePending(channelId) {
  const entry = pendingOwnerReleases.get(String(channelId));
  return !!entry && !entry.cancelled;
}

function cancelOwnerRelease(channelId, userId) {
  const key = String(channelId);
  const entry = pendingOwnerReleases.get(key);
  if (!entry) return false;
  if (userId != null && String(entry.userId) !== String(userId)) return false;
  entry.cancelled = true;
  clearTimeout(entry.timer);
  pendingOwnerReleases.delete(key);
  return true;
}

function scheduleOwnerRelease(channelId, userId, callback, delayMs = OWNER_RELEASE_GRACE_MS, expiresAt = Date.now() + delayMs) {
  const key = String(channelId);
  cancelOwnerRelease(key);
  let started = false;
  const entry = {
    userId: String(userId),
    expiresAt,
    cancelled: false,
    timer: null,
    run: () => {
      if (started || entry.cancelled) return null;
      if (pendingOwnerReleases.get(key) !== entry) return null;
      started = true;
      clearTimeout(entry.timer);
      return callback(entry);
    }
  };
  entry.timer = setTimeout(() => {
    Promise.resolve(entry.run()).catch((error) => {
      logThrottledError(`owner-release:${key}`, `[owner release] ${key}`, error);
    });
  }, Math.max(0, delayMs));
  entry.timer.unref?.();
  pendingOwnerReleases.set(key, entry);
  return entry;
}

async function flushOwnerReleases(channelId) {
  const entries = channelId == null
    ? [...pendingOwnerReleases.entries()]
    : [[String(channelId), pendingOwnerReleases.get(String(channelId))]].filter(([, entry]) => entry);
  for (const [, entry] of entries) {
    clearTimeout(entry.timer);
    await entry.run();
  }
}

function clearStoredRelease(channelId) {
  if (typeof db.setOwnerRelease !== "function") return;
  db.setOwnerRelease(channelId, null);
}

function storeOwnerRelease(channelId, expiresAt) {
  if (typeof db.setOwnerRelease !== "function") return;
  db.setOwnerRelease(channelId, expiresAt);
}

function reservationDeadline(channelId, row = null) {
  const entry = pendingOwnerReleases.get(String(channelId));
  const memory = entry && !entry.cancelled ? Number(entry.expiresAt) || 0 : 0;
  const stored = Number(row?.owner_release_at) || 0;
  return Math.max(memory, stored);
}

function reservationSeconds(channelId, row = null) {
  const deadline = reservationDeadline(channelId, row);
  if (!deadline || deadline <= Date.now()) return 0;
  return Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
}

function reservationMessage(seconds) {
  const remaining = Math.max(1, Math.ceil(Number(seconds) || 0));
  return `This VC is temporarily reserved for its owner. You can claim it in ${remaining} seconds.`;
}

function noteOwnerPresent(channelId, userId) {
  cancelOwnerRelease(channelId, userId);
  clearStoredRelease(channelId);
}

function ownerReleaseUser(channelId) {
  const entry = pendingOwnerReleases.get(String(channelId));
  return entry && !entry.cancelled ? entry.userId : null;
}

function restoreReservedOwner(channelId, userId) {
  const row = typeof db.getTempChannel === "function" ? db.getTempChannel(channelId) : null;
  if (!row || row.owner_id || typeof db.forceOwner !== "function") return false;
  const entry = pendingOwnerReleases.get(String(channelId));
  if (!entry || entry.cancelled || !sameId(entry.userId, userId) || entry.expiresAt <= Date.now()) return false;
  return db.forceOwner(channelId, userId);
}

function beginOwnerReservation(guild, channelId, userId) {
  const key = String(channelId);
  const existing = pendingOwnerReleases.get(key);
  if (
    existing &&
    !existing.cancelled &&
    sameId(existing.userId, userId) &&
    existing.expiresAt > Date.now()
  ) {
    return existing;
  }
  const expiresAt = Date.now() + OWNER_RELEASE_GRACE_MS;
  storeOwnerRelease(channelId, expiresAt);
  return scheduleOwnerRelease(
    channelId,
    userId,
    () => withChannelLock(channelId, () => expireOwnerReservation(guild, channelId, userId)),
    OWNER_RELEASE_GRACE_MS,
    expiresAt
  );
}

function resumeOwnerReservation(guild, channelId, userId, expiresAt) {
  const existing = pendingOwnerReleases.get(String(channelId));
  if (existing && !existing.cancelled && sameId(existing.userId, userId)) return existing;
  const remaining = Number(expiresAt) - Date.now();
  if (remaining <= 0) return null;
  return scheduleOwnerRelease(
    channelId,
    userId,
    () => withChannelLock(channelId, () => expireOwnerReservation(guild, channelId, userId)),
    remaining,
    expiresAt
  );
}

async function expireOwnerReservation(guild, channelId, userId) {
  const key = String(channelId);
  const entry = pendingOwnerReleases.get(key);
  if (entry?.cancelled) return;
  if (entry && !sameId(entry.userId, userId)) return;
  const current = typeof db.getTempChannel === "function" ? db.getTempChannel(channelId) : null;
  if (!current || !sameId(current.owner_id, userId)) {
    cancelOwnerRelease(channelId, userId);
    clearStoredRelease(channelId);
    return;
  }
  if (await ownerStillPresent(guild, channelId, userId) || isChannelMember(guild, channelId, userId)) {
    noteOwnerPresent(channelId, userId);
    return;
  }
  const latest = pendingOwnerReleases.get(key);
  if (!latest || latest.cancelled || !sameId(latest.userId, userId)) return;
  if (latest !== entry && entry) return;
  if (typeof db.clearOwner === "function") db.clearOwner(channelId, userId);
  clearStoredRelease(channelId);
  cancelOwnerRelease(channelId, userId);
}

async function ownerHasNewerTemp(guild, channelId, userId) {
  if (!guild || typeof db.getTempChannels !== "function") return false;
  for (const row of db.getTempChannels(guild.id)) {
    if (!row || sameId(row.channel_id, channelId) || !sameId(row.owner_id, userId)) continue;
    if (await ownerStillPresent(guild, row.channel_id, userId) || isChannelMember(guild, row.channel_id, userId)) {
      return true;
    }
  }
  return false;
}

async function noteOwnerDeparture(guild, channelId, userId) {
  const current = typeof db.getTempChannel === "function" ? db.getTempChannel(channelId) : null;
  if (!current || !sameId(current.owner_id, userId)) return false;
  if (await ownerStillPresent(guild, channelId, userId) || isChannelMember(guild, channelId, userId)) {
    noteOwnerPresent(channelId, userId);
    return false;
  }
  const fresh = db.getTempChannel(channelId);
  if (!fresh || !sameId(fresh.owner_id, userId)) return false;
  if (await ownerHasNewerTemp(guild, channelId, userId)) {
    cancelOwnerRelease(channelId, userId);
    if (typeof db.clearOwner === "function") db.clearOwner(channelId, userId);
    clearStoredRelease(channelId);
    return false;
  }
  if (isChannelMember(guild, channelId, userId)) {
    noteOwnerPresent(channelId, userId);
    return false;
  }
  beginOwnerReservation(guild, channelId, userId);
  return true;
}

async function noteOwnerArrival(guild, channelId, userId) {
  const row = typeof db.getTempChannel === "function" ? db.getTempChannel(channelId) : null;
  const reservedUser = ownerReleaseUser(channelId);
  if (!sameId(row?.owner_id, userId) && !sameId(reservedUser, userId)) return false;
  if (!await ownerStillPresent(guild, channelId, userId) && !isChannelMember(guild, channelId, userId)) {
    return false;
  }
  restoreReservedOwner(channelId, userId);
  noteOwnerPresent(channelId, userId);
  return true;
}

async function releaseOtherOwnedChannels(guild, ownerId, keepChannelId, alsoChannelId = null) {
  const ids = new Set();
  if (guild && typeof db.getTempChannels === "function") {
    for (const row of db.getTempChannels(guild.id)) {
      if (row && sameId(row.owner_id, ownerId)) ids.add(String(row.channel_id));
    }
  }
  for (const [channelId, entry] of pendingOwnerReleases) {
    if (entry && !entry.cancelled && sameId(entry.userId, ownerId)) ids.add(String(channelId));
  }
  if (alsoChannelId != null) ids.add(String(alsoChannelId));
  ids.delete(String(keepChannelId));
  for (const channelId of ids) {
    await withChannelLock(channelId, async () => {
      const row = typeof db.getTempChannel === "function" ? db.getTempChannel(channelId) : null;
      if (row?.owner_id && !sameId(row.owner_id, ownerId)) return;
      const pending = pendingOwnerReleases.get(channelId);
      if (!row?.owner_id && !(pending && sameId(pending.userId, ownerId))) return;
      if (await ownerStillPresent(guild, channelId, ownerId) || isChannelMember(guild, channelId, ownerId)) {
        noteOwnerPresent(channelId, ownerId);
        return;
      }
      cancelOwnerRelease(channelId, ownerId);
      if (row && sameId(row.owner_id, ownerId) && typeof db.clearOwner === "function") {
        db.clearOwner(channelId, ownerId);
      }
      clearStoredRelease(channelId);
    });
  }
}

async function adoptOwnedChannel(guild, channel, ownerId, previousChannelId = null) {
  if (!channel?.id || ownerId == null) return;
  if (typeof db.forceOwner === "function") db.forceOwner(channel.id, ownerId);
  noteOwnerPresent(channel.id, ownerId);
  if (guild) await releaseOtherOwnedChannels(guild, ownerId, channel.id, previousChannelId);
}

async function assessClaim(guild, channel, userId) {
  const current = typeof db.getTempChannel === "function" ? db.getTempChannel(channel?.id) : null;
  if (!current) return { status: "missing" };
  if (!isChannelMember(guild, channel.id, userId) && !await ownerStillPresent(guild, channel.id, userId)) {
    return { status: "not-in-channel" };
  }
  if (!isChannelMember(guild, channel.id, userId)) return { status: "not-in-channel" };

  const pending = pendingOwnerReleases.get(String(channel.id));
  let row = db.getTempChannel(channel.id) || current;
  if (!row.owner_id && pending && !pending.cancelled) {
    const reservedUser = pending.userId;
    if (isChannelMember(guild, channel.id, reservedUser) || await ownerStillPresent(guild, channel.id, reservedUser)) {
      if (typeof db.forceOwner === "function") db.forceOwner(channel.id, reservedUser);
      noteOwnerPresent(channel.id, reservedUser);
      row = db.getTempChannel(channel.id) || { ...row, owner_id: reservedUser };
    }
  }

  const ownerId = row.owner_id;
  if (ownerId && sameId(ownerId, userId)) {
    if (isChannelMember(guild, channel.id, ownerId) || await ownerStillPresent(guild, channel.id, ownerId)) {
      noteOwnerPresent(channel.id, ownerId);
    }
    return { status: "already-owner" };
  }
  if (!ownerId) {
    const seconds = reservationSeconds(channel.id, row);
    if (seconds > 0) return { status: "reserved", seconds };
    return { status: "open" };
  }
  if (isChannelMember(guild, channel.id, ownerId) || await ownerStillPresent(guild, channel.id, ownerId)) {
    noteOwnerPresent(channel.id, ownerId);
    return { status: "owned" };
  }
  if (isChannelMember(guild, channel.id, ownerId)) {
    noteOwnerPresent(channel.id, ownerId);
    return { status: "owned" };
  }
  const latest = db.getTempChannel(channel.id) || row;
  const seconds = reservationSeconds(channel.id, latest);
  if (seconds > 0) return { status: "reserved", seconds };
  const deadline = reservationDeadline(channel.id, latest);
  if ((deadline && deadline <= Date.now()) || ownerReleasePending(channel.id)) {
    if (typeof db.clearOwner === "function") db.clearOwner(channel.id, ownerId);
    cancelOwnerRelease(channel.id, ownerId);
    clearStoredRelease(channel.id);
    const opened = db.getTempChannel(channel.id);
    if (opened?.owner_id) return { status: "owned" };
    return { status: "open" };
  }
  return { status: "owned" };
}

function unknownVoiceState(error) {
  return error?.code === 10065 || error?.status === 404;
}

async function ownerStillPresent(guild, channelId, userId) {
  if (isChannelMember(guild, channelId, userId)) return true;
  const fetchState = guild?.voiceStates?.fetch;
  if (typeof fetchState !== "function") return false;
  try {
    const state = await fetchState.call(guild.voiceStates, userId, { force: true });
    const stateChannel = voiceStateChannelId(state);
    return stateChannel != null && sameId(stateChannel, channelId);
  } catch (error) {
    if (unknownVoiceState(error)) return false;
    return true;
  }
}

function channelHasOccupant(channel, userId = null) {
  const states = channel?.guild?.voiceStates?.cache;
  if (userId) {
    const direct = states?.get?.(String(userId)) || states?.get?.(userId);
    if (sameId(voiceStateChannelId(direct), channel.id)) return true;
    if (typeof states?.values === "function") {
      for (const state of states.values()) {
        if (!sameId(voiceStateChannelId(state), channel.id)) continue;
        if (sameId(voiceStateUserId(state), userId)) return true;
      }
    }
    if (channel?.members?.has?.(userId) || channel?.members?.has?.(String(userId))) return true;
    const member = channel?.guild?.members?.cache?.get?.(String(userId)) || channel?.guild?.members?.cache?.get?.(userId);
    return sameId(member?.voice?.channelId, channel.id);
  }
  if (typeof states?.values === "function") {
    for (const state of states.values()) {
      if (sameId(voiceStateChannelId(state), channel.id)) return true;
    }
  }
  return (channel?.members?.size || 0) > 0;
}

function listedMessages(result) {
  if (!result) return [];
  if (typeof result.values === "function") return [...result.values()];
  return [...result];
}

function olderMessageId(left, right) {
  try {
    return BigInt(left) < BigInt(right);
  } catch {
    return String(left) < String(right);
  }
}

function messageMatches(message, botId, title) {
  if (String(message?.author?.id) !== String(botId)) return false;
  return (message.embeds || []).some((embed) => (embed?.title || embed?.data?.title) === title);
}

async function findBotMessage(channel, title) {
  const botId = channel.client?.user?.id || channel.guild?.members?.me?.id;
  if (!botId) return null;
  let before = null;
  const seen = new Set();
  for (let page = 0; page < 4; page += 1) {
    const query = { limit: 50 };
    if (before) query.before = before;
    const list = listedMessages(await channel.messages.fetch(query));
    const found = list.find((message) => messageMatches(message, botId, title));
    if (found) return found;
    if (list.length < 50) return null;
    const oldest = list.reduce((lowest, message) => {
      if (!message?.id) return lowest;
      if (!lowest || olderMessageId(message.id, lowest)) return message.id;
      return lowest;
    }, null);
    if (!oldest || seen.has(oldest)) return null;
    seen.add(oldest);
    before = oldest;
  }
  return null;
}

async function getInterfaceEmojiStrings(guild) {
  let pending = interfaceEmojiStrings.get(guild.id);
  if (!pending) {
    pending = (async () => {
      let emojiCache = guild.emojis?.cache;
      if (Object.values(VC_INTERFACE_ICONS).some((id) => !emojiCache?.has(id))) {
        try {
          emojiCache = await guild.emojis.fetch();
        } catch (error) {
          console.error(`[VC interface emoji lookup] ${guild.id}`, error);
          emojiCache = guild.emojis?.cache;
        }
      }
      return Object.fromEntries(Object.entries(VC_INTERFACE_ICONS).map(([action, id]) => {
        const emoji = emojiCache?.get(id) || guild.emojis?.cache?.get(id);
        return [action, emoji ? emoji.toString() : ""];
      }));
    })();
    interfaceEmojiStrings.set(guild.id, pending);
    pending.catch(() => {
      if (interfaceEmojiStrings.get(guild.id) === pending) interfaceEmojiStrings.delete(guild.id);
    });
  }
  return pending;
}

function panelEmbed(ownerId, guildIconUrl = null, emojiStrings = {}) {
  const commandDescriptions = {
    lock: "`vc lock` — Lock your voice channel",
    unlock: "`vc unlock` — Unlock your voice channel",
    ghost: "`vc ghost` — Hide your voice channel",
    unghost: "`vc unghost` — Show your voice channel",
    kick: "`vc kick` @user — Kick a user",
    ban: "`vc ban` @user — Block joining, the channel stays visible",
    unban: "`vc unban` @user — Allow a banned user to join",
    permit: "`vc permit` @user — Join even if the channel is locked or full",
    claim: "`vc claim` — Take ownership of an empty channel",
    limit: "`vc limit` `<number>` — Set user limit",
    transfer: "`vc transfer` @user — Give ownership to someone in the channel"
  };
  const commandList = [
    ...Object.entries(commandDescriptions).map(([action, description]) =>
      emojiStrings[action] ? `${emojiStrings[action]} ${description}` : description
    )
  ].join("\n");
  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle("VoiceMaster Interface")
    .setDescription(
      `${ownerId ? `<@${ownerId}>` : ""}\n\n` +
      "Use the controls below to manage\nyour voice channel with ease.\n\n" +
      commandList
    );
  if (guildIconUrl) embed.setThumbnail(guildIconUrl);
  return embed;
}

function panelRows() {
  const ids = ["lock", "unlock", "ghost", "unghost", "kick", "ban", "unban", "permit", "claim", "limit"];
  const rows = [];
  for (let i = 0; i < ids.length; i += 5) {
    rows.push(
      new ActionRowBuilder().addComponents(
        ...ids.slice(i, i + 5).map((id) => {
          const button = new ButtonBuilder()
            .setCustomId(`vc_${id}`)
            .setStyle(ButtonStyle.Secondary);
          if (VC_INTERFACE_ICONS[id]) button.setEmoji({ id: VC_INTERFACE_ICONS[id] });
          return button;
        })
      )
    );
  }
  return rows;
}

function configuredCategoryIds(config) {
  let ids = [];
  try {
    ids = Array.isArray(config.category_ids) ? config.category_ids : JSON.parse(config.category_ids || "[]");
  } catch {
    ids = [];
  }
  return [...new Set([config.category_id, ...ids].filter(Boolean))].slice(0, MAX_TEMP_CATEGORIES);
}

function categoryChildCount(guild, categoryId) {
  return [...guild.channels.cache.values()].filter((channel) => channel.parentId === categoryId).length;
}

function pendingSetSize(store, key) {
  return store.get(key)?.size || 0;
}

function categoryChannelLoad(guild, categoryId) {
  return categoryChildCount(guild, categoryId)
    + pendingSetSize(pendingCategoryChannels, `${guild.id}:${categoryId}`);
}

function categoryMemberLoad(guild, categoryId) {
  const channels = [...guild.channels.cache.values()]
    .filter((channel) => channel.type === ChannelType.GuildVoice && channel.parentId === categoryId);
  const connectedMembers = new Set(channels.flatMap((channel) => [...channel.members.keys()]));
  const pendingMembers = pendingCategoryMembers.get(`${guild.id}:${categoryId}`) || new Set();
  const notYetObservedReservations = [...pendingMembers]
    .filter((userId) => !connectedMembers.has(userId)).length;
  return connectedMembers.size + notYetObservedReservations;
}

function isRateLimitError(error) {
  return Number(error?.status) === 429 || Number(error?.code) === 429 || error?.name === "RateLimitError";
}

function channelLimitKind(error) {
  if (isRateLimitError(error)) return null;
  const message = String(error?.message || "");
  const code = Number(error?.code);
  const mentionsChannels = code === 30013 || /maximum number of (?:server |guild )?channels/i.test(message);
  if (!mentionsChannels) return null;
  if (/category/i.test(message)) return "category";
  if (/server|guild/i.test(message)) return "guild";
  return code === 30013 ? "category" : null;
}

function isCategoryLimitError(error) {
  return channelLimitKind(error) === "category";
}

function guildFullError(error) {
  const full = new Error("This server is at Discord's channel limit.");
  full.code = "J2C_GUILD_FULL";
  if (error) full.cause = error;
  return full;
}

function everyoneRoleId(guild) {
  return guild.roles?.everyone?.id || guild.id;
}

function holdChannelForMove(channelId) {
  if (channelId != null) channelsAwaitingMove.add(String(channelId));
}

function releaseChannelForMove(channelId, { immediate = false } = {}) {
  if (channelId == null) return;
  const key = String(channelId);
  if (immediate) {
    channelsAwaitingMove.delete(key);
    return;
  }
  const timer = setTimeout(() => channelsAwaitingMove.delete(key), 20000);
  timer.unref?.();
}

function guildBitrateCap(guild) {
  try {
    const max = Number(guild?.maximumBitrate);
    if (Number.isFinite(max) && max > 0) return max;
  } catch {
    // Guild.features is missing until the guild payload has finished loading.
  }
  return 96000;
}

function clampBitrate(guild, bitrate) {
  const requested = Number(bitrate);
  const fallback = 64000;
  const max = guildBitrateCap(guild);
  const chosen = Number.isFinite(requested) && requested > 0 ? requested : fallback;
  return Math.min(max, Math.max(8000, Math.round(chosen)));
}

function clampUserLimit(limit) {
  const requested = Number(limit);
  if (!Number.isFinite(requested) || requested <= 0) return 0;
  return Math.min(99, Math.floor(requested));
}

function addPending(store, key, reservationId) {
  let reservations = store.get(key);
  if (!reservations) {
    reservations = new Set();
    store.set(key, reservations);
  }
  reservations.add(reservationId);
}

function removePending(store, key, reservationId) {
  const current = store.get(key);
  current?.delete(reservationId);
  if (current?.size === 0) store.delete(key);
}

function categoryOverflowThreshold() {
  const rawValue = process.env.VC_CATEGORY_OVERFLOW_THRESHOLD;
  const configured = /^\d+$/.test(rawValue || "") ? Number(rawValue) : NaN;
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_CATEGORY_OVERFLOW_THRESHOLD;
}

function reserveTempCategory(guild, config, memberId = null) {
  const categoryIds = configuredCategoryIds(config);
  if (!categoryIds.length && config.category_id) categoryIds.push(config.category_id);
  if (!categoryIds.length) throw new Error(`No temporary VC categories configured for guild ${guild.id}.`);

  const memberCap = categoryOverflowThreshold();
  let selectedIndex = categoryIds.findIndex((categoryId, index) => {
    const isLast = index === categoryIds.length - 1;
    if (categoryChannelLoad(guild, categoryId) >= DISCORD_CATEGORY_CHANNEL_CAP) return false;
    if (!isLast && categoryMemberLoad(guild, categoryId) >= memberCap) return false;
    return true;
  });
  if (selectedIndex < 0) {
    selectedIndex = categoryIds.findIndex((categoryId) => (
      categoryChannelLoad(guild, categoryId) < DISCORD_CATEGORY_CHANNEL_CAP
    ));
  }
  if (selectedIndex < 0) selectedIndex = categoryIds.length - 1;
  const categoryId = categoryIds[selectedIndex];
  const reservationKey = `${guild.id}:${categoryId}`;
  const reservationId = memberId || Symbol("pending category member");
  addPending(pendingCategoryMembers, reservationKey, reservationId);
  addPending(pendingCategoryChannels, reservationKey, reservationId);
  let released = false;

  return {
    categoryId,
    release(waitForVoiceCache = true) {
      if (released) return;
      released = true;
      removePending(pendingCategoryChannels, reservationKey, reservationId);
      const releaseMemberReservation = () => {
        removePending(pendingCategoryMembers, reservationKey, reservationId);
      };
      if (!waitForVoiceCache) {
        releaseMemberReservation();
        return;
      }
      const timer = setTimeout(releaseMemberReservation, CATEGORY_RESERVATION_TTL_MS);
      timer.unref?.();
    }
  };
}

async function buildVoiceChannelInterfacePayload(guild, ownerId = null, { showOwner = true } = {}) {
  const emojiStrings = await getInterfaceEmojiStrings(guild);
  return {
    embeds: [panelEmbed(
      showOwner ? ownerId : null,
      guild.iconURL({ extension: "png", size: 128 }),
      emojiStrings
    )],
    components: panelRows()
  };
}

function renderName(template, member) {
  return template
    .replaceAll("{nickname}", member.displayName)
    .replaceAll("{username}", member.user.username)
    .replaceAll("{user.mention}", `<@${member.id}>`)
    .slice(0, 100);
}

async function ensureTempInterface(channel, ownerId) {
  if (tempInterfaceTasks.has(channel.id)) return tempInterfaceTasks.get(channel.id);
  const task = (async () => {
    const fresh = db.getTempChannel(channel.id);
    const savedMessageId = fresh?.interface_message_id || null;
    const panelOwner = fresh?.owner_id ?? ownerId ?? null;
    if (savedMessageId) {
      try {
        return await channel.messages.fetch(savedMessageId);
      } catch (error) {
        if (error.code !== 10008) throw error;
      }
    }
    const existingMessage = await findBotMessage(channel, "VoiceMaster Interface");
    if (existingMessage) {
      if (existingMessage.id !== savedMessageId) db.updateTempInterface(channel.id, existingMessage.id);
      return existingMessage;
    }
    const sentAt = interfaceSentAt.get(String(channel.id)) || 0;
    if (Date.now() - sentAt < INTERFACE_RESEND_GAP_MS) {
      logThrottledError(
        `temp-interface-repeat:${channel.id}`,
        `[temp interface] ${channel.id}`,
        new Error("Skipped a repeated interface message")
      );
      return null;
    }
    const panel = await buildVoiceChannelInterfacePayload(channel.guild, panelOwner);
    const message = await channel.send(panel);
    interfaceSentAt.set(String(channel.id), Date.now());
    db.updateTempInterface(channel.id, message.id);
    return message;
  })();
  tempInterfaceTasks.set(channel.id, task);
  try {
    return await task;
  } finally {
    tempInterfaceTasks.delete(channel.id);
  }
}

async function renderVoiceChannelInterface(channel, ownerId, savedMessageId = null, recoverOrphan = false) {
  if (tempInterfaceTasks.has(channel.id)) return tempInterfaceTasks.get(channel.id);
  const task = (async () => {
    const panel = await buildVoiceChannelInterfacePayload(channel.guild, ownerId);
    if (savedMessageId) {
      try {
        const message = await channel.messages.fetch(savedMessageId);
        await message.edit(panel);
        return message;
      } catch (error) {
        if (error.code !== 10008) throw error;
      }
    }
    if (recoverOrphan) {
      const existingMessage = await findBotMessage(channel, "VoiceMaster Interface");
      if (existingMessage) {
        await existingMessage.edit(panel);
        db.updateTempInterface(channel.id, existingMessage.id);
        return existingMessage;
      }
    }
    const message = await channel.send(panel);
    db.updateTempInterface(channel.id, message.id);
    return message;
  })();
  tempInterfaceTasks.set(channel.id, task);
  try {
    return await task;
  } finally {
    tempInterfaceTasks.delete(channel.id);
  }
}

async function createTempChannelInCategory(guild, member, config, categoryId) {
  const channel = await guild.channels.create({
    name: renderName(config.name_template || "{nickname}'s Channel", member),
    type: ChannelType.GuildVoice,
    parent: categoryId,
    bitrate: clampBitrate(guild, config.bitrate),
    userLimit: clampUserLimit(config.user_limit),
    permissionOverwrites: [
      {
        id: everyoneRoleId(guild),
        type: OverwriteType.Role,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
      },
      {
        id: member.id,
        type: OverwriteType.Member,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
      }
    ],
    reason: "VoiceMaster: temporary voice channel"
  });

  try {
    db.addTemp({
      channel_id: channel.id,
      guild_id: guild.id,
      owner_id: member.id,
      interface_message_id: null,
      created_at: Date.now()
    });
    holdChannelForMove(channel.id);
    breakthru.allow(channel);
    return channel;
  } catch (error) {
    releaseChannelForMove(channel.id, { immediate: true });
    if (!channelHasOccupant(channel)) {
      await channel.delete("VoiceMaster: failed to finish temporary channel setup").catch((deleteError) => {
        console.error(`[temp channel rollback] ${channel.id}`, deleteError);
      });
      db.markTempDeleted(channel.id);
    }
    throw error;
  }
}

async function resolveCategory(guild, categoryId) {
  if (!categoryId) return null;
  const cached = guild.channels?.cache?.get?.(categoryId) || guild.channels?.cache?.get?.(String(categoryId));
  const candidate = cached || await guild.channels?.fetch?.(categoryId).catch((error) => {
    if (Number(error?.code) === 10003) return null;
    throw error;
  });
  if (!candidate || candidate.type !== ChannelType.GuildCategory) return null;
  return candidate;
}

function rememberCategory(guild, config, categoryId) {
  const saved = db.getConfig(guild.id);
  if (!saved?.j2c_channel_id) return;
  const ids = [categoryId, ...configuredCategoryIds(saved).filter((id) => String(id) !== String(categoryId))]
    .slice(0, MAX_TEMP_CATEGORIES);
  db.setConfig({
    ...saved,
    category_id: categoryId,
    category_ids: JSON.stringify(ids)
  });
}

async function createOverflowCategory(guild, config) {
  const created = await guild.channels.create({
    name: "Voice Channels",
    type: ChannelType.GuildCategory,
    reason: "VoiceMaster: join-to-create category"
  });
  rememberCategory(guild, config, created.id);
  return created.id;
}

async function usableCategoryIds(guild, config) {
  const ids = [...new Set([config.category_id, ...configuredCategoryIds(config)].filter(Boolean))];
  const usable = [];
  for (const categoryId of ids) {
    const category = await resolveCategory(guild, categoryId);
    if (!category) continue;
    if (categoryChildCount(guild, category.id) >= DISCORD_CATEGORY_CHANNEL_CAP) continue;
    usable.push(category.id);
  }
  if (usable.length) return usable;
  return [await createOverflowCategory(guild, config)];
}

async function createTempChannel(guild, member, config) {
  const categoryIds = await usableCategoryIds(guild, config);
  let lastError;
  for (const categoryId of categoryIds) {
    try {
      return await createTempChannelInCategory(guild, member, config, categoryId);
    } catch (error) {
      lastError = error;
      if (isRateLimitError(error)) throw error;
      const kind = channelLimitKind(error);
      if (kind === "guild") throw guildFullError(error);
      if (kind !== "category") throw error;
    }
  }
  let extra;
  try {
    extra = await createOverflowCategory(guild, config);
  } catch (error) {
    if (channelLimitKind(error) === "guild") throw guildFullError(error);
    throw error || lastError;
  }
  try {
    return await createTempChannelInCategory(guild, member, config, extra);
  } catch (error) {
    if (channelLimitKind(error) === "guild") throw guildFullError(error);
    throw error || lastError;
  }
}

async function createServerInterface(guild, config, existingConfig = null, { deferExistingEdit = false } = {}) {
  if (serverInterfaceTasks.has(guild.id)) return serverInterfaceTasks.get(guild.id);
  const task = (async () => {
    let channel = null;
    let createdChannel = false;
    let createdMessage = false;
    let message = null;
    const payload = await buildVoiceChannelInterfacePayload(guild, null, { showOwner: false });

    if (existingConfig?.server_interface_enabled && existingConfig.server_interface_channel_id !== "disabled") {
      channel = await guild.channels.fetch(existingConfig.server_interface_channel_id).catch((error) => {
        if (error.code === 10003) return null;
        throw error;
      });
    }
    if (!channel) {
      channel = [...guild.channels.cache.values()].find((candidate) =>
        candidate.type === ChannelType.GuildText &&
        candidate.name === "server-interface" &&
        candidate.topic === SERVER_INTERFACE_TOPIC &&
        candidate.parentId === config.category_id
      ) || null;
    }
    if (!channel || channel.type !== ChannelType.GuildText) {
      channel = await guild.channels.create({
        name: "server-interface",
        type: ChannelType.GuildText,
        parent: config.category_id,
        topic: SERVER_INTERFACE_TOPIC,
        permissionOverwrites: [{
          id: everyoneRoleId(guild),
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
          deny: [PermissionFlagsBits.SendMessages]
        }],
        reason: "VoiceMaster: persistent server interface"
      });
      createdChannel = true;
    }

    try {
      if (!createdChannel) {
        await channel.permissionOverwrites.edit(everyoneRoleId(guild), {
          ViewChannel: true,
          ReadMessageHistory: true,
          SendMessages: false
        });
      }
      if (existingConfig?.server_interface_message_id && !createdChannel) {
        try {
          message = await channel.messages.fetch(existingConfig.server_interface_message_id);
          if (!deferExistingEdit) await message.edit(payload);
        } catch (error) {
          if (error.code !== 10008) throw error;
        }
      }
      if (!message && !createdChannel) {
        message = await findBotMessage(channel, "VoiceMaster Interface") ||
          await findBotMessage(channel, "VoiceMaster");
        if (message && !deferExistingEdit) await message.edit(payload);
      }
      if (!message) {
        message = await channel.send(payload);
        createdMessage = true;
      }
      return { text: channel, message, payload, createdChannel, createdMessage };
    } catch (error) {
      if (createdChannel) {
        await channel.delete("VoiceMaster: failed to create persistent interface").catch((deleteError) => {
          console.error(`[server interface rollback] ${channel.id}`, deleteError);
        });
      }
      throw error;
    }
  })();
  serverInterfaceTasks.set(guild.id, task);
  try {
    return await task;
  } finally {
    serverInterfaceTasks.delete(guild.id);
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function cleanupEmptyTempChannels(guild, options = {}) {
  const rows = db.getTempChannels(guild.id);
  const config = db.getConfig(guild.id);
  const pauseMs = Number(options.pauseMs) || 0;
  const shouldStop = typeof options.shouldStop === "function" ? options.shouldStop : null;
  const requestedLimit = Number(options.limit);
  const maxDeletes = Number.isInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : Infinity;
  if (pauseMs > 0 || shouldStop || Number.isFinite(maxDeletes)) {
    let removedCount = 0;
    for (const row of rows) {
      if (shouldStop?.() || removedCount >= maxDeletes) return;
      let removed = false;
      try {
        removed = await withChannelLock(row.channel_id, () => cleanupTempChannelUnlocked(guild, row, config)) === true;
      } catch (error) {
        logThrottledError(`temp-cleanup:${guild.id}`, `[temp cleanup] ${row.channel_id}`, error);
      }
      if (!removed) continue;
      removedCount += 1;
      if (removedCount >= maxDeletes) return;
      if (pauseMs > 0) await sleep(pauseMs);
    }
    return;
  }
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(8, rows.length) }, async () => {
    while (nextIndex < rows.length) {
      const row = rows[nextIndex++];
      try {
        await withChannelLock(row.channel_id, () => cleanupTempChannelUnlocked(guild, row, config));
      } catch (error) {
        logThrottledError(`temp-cleanup:${guild.id}`, `[temp cleanup] ${row.channel_id}`, error);
      }
    }
  });
  await Promise.all(workers);
}

async function cleanupTempChannelUnlocked(guild, row, config = db.getConfig(guild.id)) {
  try {
    row = db.getTempChannel(row.channel_id);
    if (!row) return;
    if (row.channel_id === config?.j2c_channel_id) return;
    if (channelsAwaitingMove.has(String(row.channel_id))) return;
    let channel = guild.channels.cache.get(row.channel_id);
    if (!channel) {
      channel = await guild.channels.fetch(row.channel_id).catch((error) => {
        if (error.code === 10003) return null;
        throw error;
      });
    }
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      db.markTempDeleted(row.channel_id);
      require("./pool").forgetChannel(row.channel_id);
      return;
    }
    if (channelHasOccupant(channel)) {
      if (row.empty_since !== null) db.setEmptySince(row.channel_id, null);
      return;
    }

    const emptySince = row.empty_since ?? Date.now();
    if (row.empty_since === null) db.setEmptySince(row.channel_id, emptySince);
    const cleanupMs = Math.max(0, config?.cleanup_seconds ?? 0) * 1000;
    if (Date.now() - emptySince < cleanupMs || channelHasOccupant(channel)) return;
    if ((channel.members?.size || 0) > 0 || channelHasOccupant(channel)) return;
    if (require("./vc-features").isProtectedChannel(guild.id, channel.id)) return;

    await channel.delete("VoiceMaster: empty temporary channel cleanup");
    db.markTempDeleted(row.channel_id);
    require("./pool").forgetChannel(row.channel_id);
    return true;
  } catch (error) {
    logThrottledError(`temp-cleanup:${guild.id}`, `[temp cleanup] ${row.channel_id}`, error);
  }
}

async function cleanupTempChannel(guild, channelId) {
  return withChannelLock(channelId, async () => {
    const row = db.getTempChannel(channelId);
    if (row) await cleanupTempChannelUnlocked(guild, row, db.getConfig(guild.id));
  });
}

async function reconcileGuild(guild, { tempBatchSize = Infinity, cursor = 0 } = {}) {
  const config = db.getConfig(guild.id);
  if (!config) return 0;
  if (config.server_interface_enabled) {
    try {
      const existing = guild.channels.cache.get(config.server_interface_channel_id) ||
        await guild.channels.fetch(config.server_interface_channel_id).catch((error) => {
        if (error.code === 10003) return null;
        throw error;
      });
      let messageMissing = !existing || !config.server_interface_message_id;
      if (existing && config.server_interface_message_id) {
        await existing.messages.fetch(config.server_interface_message_id).catch((error) => {
          if (error.code === 10008) {
            messageMissing = true;
            return null;
          }
          throw error;
        });
      }
      if (messageMissing) {
        const serverInterface = await createServerInterface(guild, config, config);
        db.updateServerInterface(guild.id, serverInterface.text.id, serverInterface.message.id);
      }
    } catch (error) {
      logThrottledError(`server-interface-recovery:${guild.id}`, `[server interface recovery] ${guild.id}`, error);
    }
  }

  const allRows = db.getTempChannels(guild.id);
  const rows = allRows.length > tempBatchSize
    ? Array.from({ length: Math.min(tempBatchSize, allRows.length) }, (_, index) =>
      allRows[(cursor + index) % allRows.length]
    )
    : allRows;
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(8, rows.length) }, async () => {
    while (nextIndex < rows.length) {
      const row = rows[nextIndex++];
      await withChannelLock(row.channel_id, async () => {
        try {
          const channel = guild.channels.cache.get(row.channel_id) ||
            await guild.channels.fetch(row.channel_id).catch((error) => {
              if (error.code === 10003) return null;
              throw error;
            });
          if (!channel || channel.type !== ChannelType.GuildVoice) {
            db.markTempDeleted(row.channel_id);
            return;
          }
          const fresh = db.getTempChannel(row.channel_id) || row;
          if (fresh.owner_id && (channelHasOccupant(channel, fresh.owner_id) || isChannelMember(guild, channel.id, fresh.owner_id))) {
            noteOwnerPresent(fresh.channel_id, fresh.owner_id);
          } else if (fresh.owner_id) {
            const releaseAt = reservationDeadline(fresh.channel_id, fresh);
            if (releaseAt > Date.now() || ownerReleasePending(fresh.channel_id)) {
              if (!ownerReleasePending(fresh.channel_id)) {
                resumeOwnerReservation(guild, fresh.channel_id, fresh.owner_id, releaseAt);
              }
            } else if (
              channelHasOccupant(channel) &&
              !channelHasOccupant(channel, fresh.owner_id) &&
              (guild.voiceStates?.cache?.size || 0) > 0 &&
              !await ownerStillPresent(guild, fresh.channel_id, fresh.owner_id) &&
              !isChannelMember(guild, fresh.channel_id, fresh.owner_id)
            ) {
              db.clearOwner(fresh.channel_id, fresh.owner_id);
              clearStoredRelease(fresh.channel_id);
            }
          }
          if (!channelHasOccupant(channel) && fresh.empty_since === null) {
            db.setEmptySince(fresh.channel_id, Date.now());
          } else if (channelHasOccupant(channel) && fresh.empty_since !== null) {
            db.setEmptySince(fresh.channel_id, null);
          }
          const current = db.getTempChannel(fresh.channel_id);
          if (current) await ensureTempInterface(channel, current.owner_id);
        } catch (error) {
          logThrottledError(
            `temp-interface-recovery:${guild.id}`,
            `[temp interface recovery] ${row.channel_id}`,
            error
          );
        }
      });
    }
  });
  await Promise.all(workers);
  return allRows.length > 0 ? (cursor + rows.length) % allRows.length : 0;
}

module.exports = {
  createServerInterface,
  createTempChannel,
  cleanupEmptyTempChannels,
  cleanupTempChannel,
  renderVoiceChannelInterface,
  buildVoiceChannelInterfacePayload,
  ensureTempInterface,
  ownerStillPresent,
  reconcileGuild,
  panelEmbed,
  panelRows,
  reserveTempCategory,
  isRateLimitError,
  channelLimitKind,
  holdChannelForMove,
  releaseChannelForMove,
  clampBitrate,
  clampUserLimit,
  renderName,
  isChannelMember,
  scheduleOwnerRelease,
  cancelOwnerRelease,
  ownerReleasePending,
  flushOwnerReleases,
  noteOwnerDeparture,
  noteOwnerArrival,
  ownerReleaseUser,
  adoptOwnedChannel,
  assessClaim,
  reservationMessage,
  reservationSeconds,
  OWNER_RELEASE_GRACE_MS,
  configuredCategoryIds,
  categoryOverflowThreshold,
  DEFAULT_CATEGORY_OVERFLOW_THRESHOLD,
  MAX_TEMP_CATEGORIES,
  DISCORD_CATEGORY_CHANNEL_CAP,
  VC_INTERFACE_ICONS,
  getInterfaceEmojiStrings
};
