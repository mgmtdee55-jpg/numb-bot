const {
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");
const db = require("./db");
const { withChannelLock } = require("./channel-lock");
const { logThrottledError } = require("./log-throttle");

const tempInterfaceTasks = new Map();
const serverInterfaceTasks = new Map();
const interfaceEmojiStrings = new Map();
const pendingCategoryMembers = new Map();
const pendingCategoryChannels = new Map();
const SERVER_INTERFACE_TOPIC = "Persistent VoiceMaster server interface";
const DEFAULT_CATEGORY_OVERFLOW_THRESHOLD = 99;
const MAX_TEMP_CATEGORIES = 3;
const DISCORD_CATEGORY_CHANNEL_CAP = 50;
const CATEGORY_RESERVATION_TTL_MS = 10000;
const OWNER_RELEASE_GRACE_MS = 5000;
const pendingOwnerReleases = new Map();
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
  return pendingOwnerReleases.has(String(channelId));
}

function cancelOwnerRelease(channelId, userId) {
  const key = String(channelId);
  const entry = pendingOwnerReleases.get(key);
  if (!entry) return false;
  if (userId != null && String(entry.userId) !== String(userId)) return false;
  clearTimeout(entry.timer);
  pendingOwnerReleases.delete(key);
  return true;
}

function scheduleOwnerRelease(channelId, userId, callback) {
  const key = String(channelId);
  cancelOwnerRelease(key);
  let ran = false;
  const entry = {
    userId: String(userId),
    timer: null,
    run: () => {
      if (ran) return null;
      ran = true;
      clearTimeout(entry.timer);
      if (pendingOwnerReleases.get(key) === entry) pendingOwnerReleases.delete(key);
      return callback();
    }
  };
  entry.timer = setTimeout(() => {
    entry.run();
  }, OWNER_RELEASE_GRACE_MS);
  entry.timer.unref?.();
  pendingOwnerReleases.set(key, entry);
  return entry;
}

async function flushOwnerReleases(channelId) {
  const entries = channelId == null
    ? [...pendingOwnerReleases.entries()]
    : [[String(channelId), pendingOwnerReleases.get(String(channelId))]].filter(([, entry]) => entry);
  for (const [key, entry] of entries) {
    pendingOwnerReleases.delete(key);
    clearTimeout(entry.timer);
    await entry.run();
  }
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

function isCategoryLimitError(error) {
  return [30013, 30030, 50035].includes(Number(error?.code))
    || /maximum|full|limit|category/i.test(error?.message || "");
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
    const panel = await buildVoiceChannelInterfacePayload(channel.guild, panelOwner);
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
    bitrate: config.bitrate,
    userLimit: config.user_limit,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
      },
      {
        id: member.id,
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
    return channel;
  } catch (error) {
    if (!channelHasOccupant(channel)) {
      await channel.delete("VoiceMaster: failed to finish temporary channel setup").catch((deleteError) => {
        console.error(`[temp channel rollback] ${channel.id}`, deleteError);
      });
      db.markTempDeleted(channel.id);
    }
    throw error;
  }
}

async function createTempChannel(guild, member, config) {
  const preferred = config.category_id;
  const categoryIds = [...new Set([preferred, ...configuredCategoryIds(config)].filter(Boolean))];
  if (!categoryIds.length) throw new Error(`No temporary VC categories configured for guild ${guild.id}.`);

  let lastError;
  for (const [index, categoryId] of categoryIds.entries()) {
    const isLast = index === categoryIds.length - 1;
    if (!isLast && categoryChildCount(guild, categoryId) >= DISCORD_CATEGORY_CHANNEL_CAP) continue;
    try {
      return await createTempChannelInCategory(guild, member, config, categoryId);
    } catch (error) {
      lastError = error;
      if (!isCategoryLimitError(error) || isLast) throw error;
    }
  }
  throw lastError || new Error("All configured VoiceMaster categories are full.");
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
          id: guild.roles.everyone.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
          deny: [PermissionFlagsBits.SendMessages]
        }],
        reason: "VoiceMaster: persistent server interface"
      });
      createdChannel = true;
    }

    try {
      if (!createdChannel) {
        await channel.permissionOverwrites.edit(guild.roles.everyone, {
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

async function cleanupEmptyTempChannels(guild) {
  const rows = db.getTempChannels(guild.id);
  const config = db.getConfig(guild.id);
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
    let channel = guild.channels.cache.get(row.channel_id);
    if (!channel) {
      channel = await guild.channels.fetch(row.channel_id).catch((error) => {
        if (error.code === 10003) return null;
        throw error;
      });
    }
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      db.markTempDeleted(row.channel_id);
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
          if (
            fresh.owner_id &&
            !ownerReleasePending(fresh.channel_id) &&
            channelHasOccupant(channel) &&
            !channelHasOccupant(channel, fresh.owner_id) &&
            (guild.voiceStates?.cache?.size || 0) > 0 &&
            !await ownerStillPresent(guild, fresh.channel_id, fresh.owner_id)
          ) {
            db.clearOwner(fresh.channel_id, fresh.owner_id);
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
  isChannelMember,
  scheduleOwnerRelease,
  cancelOwnerRelease,
  ownerReleasePending,
  flushOwnerReleases,
  OWNER_RELEASE_GRACE_MS,
  configuredCategoryIds,
  categoryOverflowThreshold,
  DEFAULT_CATEGORY_OVERFLOW_THRESHOLD,
  MAX_TEMP_CATEGORIES,
  DISCORD_CATEGORY_CHANNEL_CAP,
  VC_INTERFACE_ICONS,
  getInterfaceEmojiStrings
};
