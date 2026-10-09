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

function bitDenied(overwrite, flag) {
  const deny = overwrite?.deny;
  return typeof deny?.has === "function" && deny.has(flag);
}

function bitAllowed(overwrite, flag) {
  const allow = overwrite?.allow;
  return typeof allow?.has === "function" && allow.has(flag);
}

function moveMemberOverwrites(guild, ownerId) {
  const botId = guild.members?.me?.id || guild.client?.user?.id || null;
  const overwrites = [
    {
      id: guild.roles.everyone.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
      deny: [PermissionFlagsBits.MoveMembers]
    },
    {
      id: ownerId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
      deny: [PermissionFlagsBits.MoveMembers]
    }
  ];
  if (botId && botId !== ownerId && botId !== guild.roles.everyone.id) {
    overwrites.push({
      id: botId,
      allow: [PermissionFlagsBits.MoveMembers]
    });
  }
  return overwrites;
}

function occupantIds(channel) {
  const ids = new Set();
  if (typeof channel?.members?.keys === "function") {
    for (const id of channel.members.keys()) ids.add(String(id));
  }
  const states = channel?.guild?.voiceStates?.cache;
  if (typeof states?.values === "function") {
    for (const state of states.values()) {
      if (state?.channelId !== channel.id) continue;
      const id = state.id || state.userId || state.member?.id;
      if (id) ids.add(String(id));
    }
  }
  return ids;
}

function moveRoleIds(guild) {
  const ids = [];
  const roles = guild?.roles?.cache;
  if (typeof roles?.values !== "function") return ids;
  const everyoneId = guild.roles?.everyone?.id;
  for (const role of roles.values()) {
    if (!role?.id || role.id === everyoneId) continue;
    if (typeof role.permissions?.has !== "function") continue;
    if (role.permissions.has(PermissionFlagsBits.MoveMembers) || role.permissions.has(PermissionFlagsBits.Administrator)) {
      ids.push(String(role.id));
    }
  }
  return ids;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function editMoveMembers(channel, id, allowed, reason) {
  const data = { MoveMembers: allowed };
  try {
    await channel.permissionOverwrites.edit(id, data, { reason });
  } catch (error) {
    const wait = Math.min(5000, Math.round((Number(error?.retryAfter) || (error?.status === 429 ? 1.2 : 0)) * 1000));
    if (!wait) throw error;
    await sleep(wait);
    await channel.permissionOverwrites.edit(id, data, { reason });
  }
}

async function disableCallMoveMembers(channel, ownerId = null) {
  if (typeof channel?.permissionOverwrites?.edit !== "function") return;
  const guild = channel.guild;
  const everyoneId = guild?.roles?.everyone?.id;
  if (!everyoneId) return;
  const botId = guild.members?.me?.id || guild.client?.user?.id || null;
  const reason = "VoiceMaster: disconnects use vc kick, ban, or reject";
  const cache = channel.permissionOverwrites.cache;
  const denyIds = new Set([String(everyoneId)]);
  if (ownerId && String(ownerId) !== String(botId)) denyIds.add(String(ownerId));
  for (const id of occupantIds(channel)) {
    if (String(id) !== String(botId)) denyIds.add(String(id));
  }
  for (const id of moveRoleIds(guild)) {
    if (String(id) !== String(botId)) denyIds.add(String(id));
  }
  if (typeof cache?.values === "function") {
    for (const overwrite of cache.values()) {
      const id = overwrite?.id;
      if (!id || String(id) === String(botId)) continue;
      if (!bitDenied(overwrite, PermissionFlagsBits.MoveMembers) || bitAllowed(overwrite, PermissionFlagsBits.MoveMembers)) {
        denyIds.add(String(id));
      }
    }
  }
  for (const id of denyIds) {
    const overwrite = cache?.get?.(id);
    if (bitDenied(overwrite, PermissionFlagsBits.MoveMembers) && !bitAllowed(overwrite, PermissionFlagsBits.MoveMembers)) continue;
    try {
      await editMoveMembers(channel, id, false, reason);
    } catch (error) {
      logThrottledError(`move-members:${guild.id}`, `[disable move members] ${channel.id}:${id}`, error);
    }
  }
  const botOverwrite = botId ? cache?.get?.(botId) : null;
  if (botId && botId !== everyoneId && (!bitAllowed(botOverwrite, PermissionFlagsBits.MoveMembers) || bitDenied(botOverwrite, PermissionFlagsBits.MoveMembers))) {
    try {
      await editMoveMembers(channel, botId, true, "VoiceMaster: bot disconnect for vc commands");
    } catch (error) {
      logThrottledError(`move-members:${guild.id}`, `[disable move members] ${channel.id}:${botId}`, error);
    }
  }
}

function channelHasOccupant(channel, userId = null) {
  const states = channel?.guild?.voiceStates?.cache;
  if (typeof states?.values === "function") {
    for (const state of states.values()) {
      if (state?.channelId !== channel.id) continue;
      if (!userId) return true;
      const stateUserId = state.id || state.userId || state.member?.id;
      if (stateUserId && String(stateUserId) === String(userId)) return true;
    }
  }
  if (userId) return Boolean(channel?.members?.has?.(userId));
  return (channel?.members?.size || 0) > 0;
}

async function findBotMessage(channel, title) {
  const botId = channel.client?.user?.id || channel.guild.members.me?.id;
  if (!botId) return null;
  const messages = await channel.messages.fetch({ limit: 25 });
  return messages.find((message) =>
    message.author.id === botId &&
    message.embeds.some((embed) => embed.title === title)
  ) || null;
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
    permissionOverwrites: moveMemberOverwrites(guild, member.id),
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
    await disableCallMoveMembers(channel, member.id);
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
      if (row.owner_id && !channelHasOccupant(channel, row.owner_id)) db.clearOwner(row.channel_id, row.owner_id);
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
          if (row.owner_id && !channelHasOccupant(channel, row.owner_id)) db.clearOwner(row.channel_id, row.owner_id);
          await disableCallMoveMembers(channel, row.owner_id);
          if (!channelHasOccupant(channel) && row.empty_since === null) {
            db.setEmptySince(row.channel_id, Date.now());
          } else if (channelHasOccupant(channel) && row.empty_since !== null) {
            db.setEmptySince(row.channel_id, null);
          }
          let interfaceMissing = !row.interface_message_id;
          if (row.interface_message_id) {
            await channel.messages.fetch(row.interface_message_id).catch((error) => {
              if (error.code === 10008) {
                interfaceMissing = true;
                return null;
              }
              throw error;
            });
          }
          if (interfaceMissing) {
            await renderVoiceChannelInterface(channel, row.owner_id, row.interface_message_id, true);
          }
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
  disableCallMoveMembers,
  cleanupEmptyTempChannels,
  cleanupTempChannel,
  renderVoiceChannelInterface,
  buildVoiceChannelInterfacePayload,
  ensureTempInterface: renderVoiceChannelInterface,
  reconcileGuild,
  panelEmbed,
  panelRows,
  reserveTempCategory,
  configuredCategoryIds,
  categoryOverflowThreshold,
  DEFAULT_CATEGORY_OVERFLOW_THRESHOLD,
  MAX_TEMP_CATEGORIES,
  DISCORD_CATEGORY_CHANNEL_CAP,
  VC_INTERFACE_ICONS,
  getInterfaceEmojiStrings
};
