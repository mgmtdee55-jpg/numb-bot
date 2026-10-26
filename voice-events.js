const { withChannelLock } = require("./channel-lock");
const {
  reserveTempCategory: reserveConfiguredTempCategory,
  noteOwnerDeparture,
  noteOwnerArrival,
  ownerReleaseUser,
  adoptOwnedChannel,
  ownerStillPresent,
  isChannelMember,
  cancelOwnerRelease,
  isRateLimitError,
  releaseChannelForMove
} = require("./voice");
const { logThrottledError } = require("./log-throttle");

// One create at a time per guild. Five creates in five seconds stays under the
// usual guild channel-create bucket; nine member moves in ten seconds stays
// under Discord's member-update bucket (10 per 10 seconds). A 429 pauses the
// guild for Discord's retry_after instead of dropping the person.
const JOIN_PACE = {
  maxConcurrent: 1,
  createLimit: 5,
  createWindowMs: 5000,
  moveLimit: 9,
  moveWindowMs: 10000,
  maxAttempts: 4,
  operationTimeoutMs: 12000
};
const MAX_RETRY_MS = 15 * 60 * 1000;
const FAILURE_RETRY_MS = [2000, 4000, 8000, 15000];

function retryDelayMs(error) {
  if (!isRateLimitError(error)) return 0;
  const bodySeconds = Number(error?.retry_after ?? error?.rawError?.retry_after);
  const libraryMs = Number(error?.retryAfter);
  let ms = 1000;
  if (Number.isFinite(bodySeconds) && bodySeconds > 0) ms = bodySeconds * 1000;
  else if (Number.isFinite(libraryMs) && libraryMs > 0) ms = libraryMs;
  return Math.min(MAX_RETRY_MS, Math.ceil(ms) + 50);
}

function failureDelayMs(error, streak) {
  if (error?.code === "J2C_WAITING") return 1000;
  if (error?.code === "J2C_TIMEOUT") return 200;
  if (error?.code === "J2C_GUILD_FULL") return 1000;
  if (isRateLimitError(error)) return retryDelayMs(error);
  const permissionDenied = Number(error?.code) === 50013 || Number(error?.status) === 403;
  if (permissionDenied) return 30000;
  const index = Math.min(Math.max(streak, 1), FAILURE_RETRY_MS.length) - 1;
  return FAILURE_RETRY_MS[index];
}

function withTimeout(work, ms) {
  let finished = false;
  const pending = Promise.resolve(work);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      finished = true;
      const error = new Error("Join to create timed out");
      error.code = "J2C_TIMEOUT";
      reject(error);
    }, ms);
    timer.unref?.();
    pending.then(
      (value) => {
        clearTimeout(timer);
        if (!finished) resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        if (!finished) reject(error);
      }
    );
  });
}

function leftVoice(error) {
  return error?.code === "J2C_LEFT";
}

function sameId(left, right) {
  return left != null && right != null && String(left) === String(right);
}

function canMove(member) {
  return typeof member?.voice?.setChannel === "function";
}

function channelMissing(error) {
  return Number(error?.code) === 10003;
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function createGuildPacer(pace) {
  const guilds = new Map();

  function state(guildId) {
    let queue = guilds.get(guildId);
    if (!queue) {
      queue = { active: 0, waiting: [], creates: [], moves: [], pausedUntil: 0 };
      guilds.set(guildId, queue);
    }
    return queue;
  }

  function stampsFor(queue, kind) {
    return kind === "move" ? queue.moves : queue.creates;
  }

  function budgetFor(kind) {
    return kind === "move"
      ? { limit: pace.moveLimit, windowMs: pace.moveWindowMs }
      : { limit: pace.createLimit, windowMs: pace.createWindowMs };
  }

  async function acquire(guildId, kind) {
    const queue = state(guildId);
    const { limit, windowMs } = budgetFor(kind);
    for (let spin = 0; spin < 10000; spin += 1) {
      const time = pace.now();
      const stamps = stampsFor(queue, kind);
      while (stamps.length && time - stamps[0] >= windowMs) stamps.shift();
      const windowWait = stamps.length < limit ? 0 : windowMs - (time - stamps[0]);
      const pauseWait = Math.max(0, queue.pausedUntil - time);
      const wait = Math.max(windowWait, pauseWait);
      if (wait <= 0) {
        stamps.push(time);
        return;
      }
      await pace.sleep(wait);
    }
    throw new Error(`Join pacing could not acquire a Discord ${kind} slot.`);
  }

  function penalize(guildId, error) {
    const delay = retryDelayMs(error);
    if (!delay) return 0;
    const queue = state(guildId);
    queue.pausedUntil = Math.max(queue.pausedUntil, pace.now() + delay);
    return delay;
  }

  function schedule(guildId, operation) {
    const queue = state(guildId);
    return new Promise((resolve, reject) => {
      queue.waiting.push({ operation, resolve, reject });
      pump(guildId);
    });
  }

  function pump(guildId) {
    const queue = state(guildId);
    while (queue.active < pace.maxConcurrent && queue.waiting.length) {
      const task = queue.waiting.shift();
      queue.active += 1;
      let settled = false;
      const started = pace.now();
      const finish = (error, value, failed) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        queue.active = Math.max(0, queue.active - 1);
        if (failed) task.reject(error);
        else task.resolve(value);
        pump(guildId);
      };
      // One operation can wait out a rate-limit pause, then create and move.
      // If it runs longer than that, the slot is released so the rest of the
      // lobby is not stuck behind a Discord request that never comes back.
      const allowance = Math.max(0, queue.pausedUntil - started)
        + (pace.operationTimeoutMs * 2)
        + pace.createWindowMs
        + pace.moveWindowMs
        + 2000;
      const watchdog = setTimeout(() => {
        const error = new Error("Join to create queue stalled");
        error.code = "J2C_TIMEOUT";
        finish(error, null, true);
      }, allowance);
      watchdog.unref?.();
      Promise.resolve()
        .then(task.operation)
        .then(
          (value) => finish(null, value, false),
          (error) => finish(error, null, true)
        );
    }
  }

  function isActive(guildId) {
    const queue = guilds.get(guildId);
    return !!queue && queue.active > 0;
  }

  return { acquire, penalize, schedule, isActive };
}

function createVoiceStateHandler({
  db,
  createTempChannel,
  renderVoiceChannelInterface,
  reserveTempCategory = reserveConfiguredTempCategory,
  cleanupEmptyTempChannels,
  cleanupTempChannel,
  pace: paceOverrides
}) {
  if (typeof renderVoiceChannelInterface !== "function" || typeof reserveTempCategory !== "function") {
    throw new TypeError("createVoiceStateHandler requires the interface renderer and category reservation helper.");
  }
  const pace = {
    ...JOIN_PACE,
    now: Date.now,
    sleep: defaultSleep,
    ...paceOverrides
  };
  const pendingCreates = new Map();
  const pacer = createGuildPacer(pace);
  const discordSlots = new Map();
  const DISCORD_INFLIGHT_LIMIT = 2;

  function slotBucket(guildId, kind) {
    let guildSlots = discordSlots.get(guildId);
    if (!guildSlots) {
      guildSlots = { create: new Set(), move: new Set() };
      discordSlots.set(guildId, guildSlots);
    }
    return guildSlots[kind];
  }

  // Two unanswered Discord calls is the cap. A third request would sit behind
  // them in Discord's queue. A call that never comes back used to keep that
  // slot forever, and then nobody in the lobby could get a channel. The slot
  // is dropped after a few timeouts so the next try can go out.
  function takeDiscordSlot(guildId, kind) {
    const slots = slotBucket(guildId, kind);
    const now = pace.now();
    const holdMs = pace.operationTimeoutMs * 3;
    for (const held of slots) {
      if (now - held.startedAt >= holdMs) slots.delete(held);
    }
    if (slots.size >= DISCORD_INFLIGHT_LIMIT) {
      const error = new Error("Join to create is waiting for Discord");
      error.code = "J2C_WAITING";
      throw error;
    }
    const slot = { startedAt: now };
    slots.add(slot);
    return {
      bind(promise) {
        slot.startedAt = pace.now();
        Promise.resolve(promise).then(
          () => slots.delete(slot),
          () => slots.delete(slot)
        );
      },
      release() {
        slots.delete(slot);
      }
    };
  }

  function voiceStateFor(guild, userId) {
    return guild?.voiceStates?.cache?.get?.(userId) || guild?.voiceStates?.cache?.get?.(String(userId)) || null;
  }

  function listedInChannel(guild, channelId, userId) {
    const channel = guild?.channels?.cache?.get?.(channelId) || guild?.channels?.cache?.get?.(String(channelId));
    const members = channel?.members;
    if (!members) return false;
    if (members.has?.(userId) || members.has?.(String(userId))) return true;
    if (typeof members.values !== "function") return false;
    for (const member of members.values()) {
      if (sameId(member?.id, userId)) return true;
    }
    return false;
  }

  function joinChannelIds(guild, userId, box) {
    const member = box?.member
      || guild?.members?.cache?.get?.(userId)
      || guild?.members?.cache?.get?.(String(userId));
    const state = box?.voiceState && sameId(box.voiceState.id || box.voiceState.member?.id, userId)
      ? box.voiceState
      : voiceStateFor(guild, userId);
    return [
      state?.channelId,
      state?.channel?.id,
      box?.voiceState?.channelId,
      box?.voiceState?.channel?.id,
      member?.voice?.channelId,
      member?.voice?.channel?.id
    ];
  }

  function evidenceInChannel(guild, userId, channelId, box) {
    if (!channelId) return false;
    if (listedInChannel(guild, channelId, userId)) return true;
    const member = box?.member
      || guild?.members?.cache?.get?.(userId)
      || guild?.members?.cache?.get?.(String(userId));
    const live = voiceStateFor(guild, userId);
    const ids = [
      live?.channelId,
      live?.channel?.id,
      member?.voice?.channelId,
      member?.voice?.channel?.id
    ];
    if (ids.some((id) => sameId(id, channelId))) return true;
    const known = ids.filter((id) => id != null);
    if (known.length) return false;
    const fresh = box?.expectJoin && Date.now() < box.expectJoin;
    if (!fresh) return false;
    return sameId(box?.voiceState?.channelId, channelId) || sameId(box?.voiceState?.channel?.id, channelId);
  }

  function stillInJoin(guild, userId, channelId, box) {
    if (evidenceInChannel(guild, userId, channelId, box)) return true;
    const fresh = box?.expectJoin && Date.now() < box.expectJoin;
    if (!fresh) return false;
    const currentIds = joinChannelIds(guild, userId, box).filter((id) => id != null);
    if (!currentIds.length) return true;
    if (box.fetchedHere) return true;
    // The cache can still show the channel they stepped out of for a moment
    // after the join event. That is not proof they left the lobby.
    return !!(box.fromChannelId && currentIds.some((id) => sameId(id, box.fromChannelId)));
  }

  async function leftJoin(guild, userId, channelId, box) {
    if (stillInJoin(guild, userId, channelId, box)) return false;
    if (typeof guild?.voiceStates?.fetch !== "function") {
      return !evidenceInChannel(guild, userId, channelId, box);
    }
    try {
      const state = await withTimeout(guild.voiceStates.fetch(userId), 4000);
      const current = state?.channelId || state?.channel?.id || null;
      if (sameId(current, channelId)) {
        if (box) {
          box.expectJoin = Date.now() + 3000;
          box.fetchedHere = true;
          box.voiceState = state;
        }
        return false;
      }
      if (evidenceInChannel(guild, userId, channelId, box)) return false;
      return true;
    } catch (error) {
      if (error?.code === "J2C_TIMEOUT") return false;
      if (error?.code === 10065 || error?.status === 404) {
        return !evidenceInChannel(guild, userId, channelId, box);
      }
      return false;
    }
  }

  async function evictFromLobby(guild, userId, channelId, actor) {
    if (!evidenceInChannel(guild, userId, channelId, { member: actor })) return false;
    const reason = "Join to create: lingering in the trigger channel is not allowed";
    try {
      if (typeof actor?.voice?.disconnect === "function") {
        await withTimeout(actor.voice.disconnect(reason), pace.operationTimeoutMs);
      } else if (typeof actor?.voice?.setChannel === "function") {
        await withTimeout(actor.voice.setChannel(null, reason), pace.operationTimeoutMs);
      } else {
        const state = voiceStateFor(guild, userId);
        if (typeof state?.setChannel === "function") {
          await withTimeout(state.setChannel(null, reason), pace.operationTimeoutMs);
        } else if (typeof guild.members?.edit === "function") {
          await withTimeout(guild.members.edit(userId, { channel: null, reason }), pace.operationTimeoutMs);
        } else {
          return false;
        }
      }
      return true;
    } catch (error) {
      if (isRateLimitError(error)) pacer.penalize(guild.id, error);
      logThrottledError(`j2c-evict:${guild.id}`, `[J2C evict] ${guild.id}:${userId}`, error);
      return false;
    }
  }

  function shouldEvictIdle(error, streak) {
    const permissionDenied = Number(error?.code) === 50013 || Number(error?.status) === 403;
    if (permissionDenied && streak >= 2) return true;
    if (error?.code === "J2C_GUILD_FULL" && streak >= 4) return true;
    return false;
  }

  function personForChannel(guild, userId, fallback) {
    if (fallback?.id && (fallback.user || fallback.displayName || canMove(fallback))) return fallback;
    const user = guild.client?.users?.cache?.get?.(userId) || guild.client?.users?.cache?.get?.(String(userId));
    const name = user?.globalName || user?.username || "Voice";
    return {
      id: String(userId),
      displayName: name,
      user: { id: String(userId), username: user?.username || "voice", bot: !!user?.bot }
    };
  }

  async function memberForJoin(guild, userId, fallback, voiceState) {
    const cached = guild.members?.cache?.get?.(userId) || guild.members?.cache?.get?.(String(userId));
    if (canMove(cached)) return cached;
    if (canMove(fallback)) return fallback;
    const state = typeof voiceState?.setChannel === "function" ? voiceState : voiceStateFor(guild, userId);
    if (typeof state?.setChannel === "function") return personForChannel(guild, userId, fallback);
    if (typeof guild.members?.fetch !== "function") return null;
    try {
      return await withTimeout(guild.members.fetch(userId), 4000);
    } catch (error) {
      if (error?.code === "J2C_TIMEOUT" || error?.code === 10007) return null;
      if (!isRateLimitError(error)) return null;
      await pace.sleep(Math.min(pacer.penalize(guild.id, error), 4000));
      return withTimeout(guild.members.fetch(userId), 4000).catch(() => null);
    }
  }

  async function cleanupCreated(guild, channelId) {
    try {
      if (!channelId) return;
      releaseChannelForMove(channelId, { immediate: true });
      if (cleanupTempChannel) await cleanupTempChannel(guild, channelId);
      else await cleanupEmptyTempChannels(guild);
    } catch (error) {
      logThrottledError(`j2c-cleanup:${guild.id}`, `[J2C cleanup] ${channelId}`, error);
    }
  }

  function leftJoinChannel() {
    const error = new Error("Member left join-to-create");
    error.code = "J2C_LEFT";
    return error;
  }

  function membersWaiting(guild, channelId) {
    const found = new Map();
    const add = (member, id) => {
      const userId = member?.id || id;
      if (!userId || member?.user?.bot) return;
      found.set(String(userId), member || { id: String(userId) });
    };
    const states = guild.voiceStates?.cache;
    if (typeof states?.values === "function") {
      for (const state of states.values()) {
        if (!state || !sameId(state.channelId, channelId)) continue;
        add(state.member, state.id);
      }
    }
    const channel = guild.channels?.cache?.get?.(channelId);
    if (typeof channel?.members?.values === "function") {
      for (const member of channel.members.values()) add(member, member.id);
    }
    return [...found.values()];
  }

  async function renderInterface(channel, ownerId) {
    try {
      await renderVoiceChannelInterface(channel, ownerId);
    } catch (error) {
      if (!isRateLimitError(error)) {
        logThrottledError(`temp-interface:${channel.guild?.id}`, `[temp interface creation] ${channel.id}`, error);
        return;
      }
      try {
        await pace.sleep(retryDelayMs(error));
        await renderVoiceChannelInterface(channel, ownerId);
      } catch (retryError) {
        logThrottledError(`temp-interface:${channel.guild?.id}`, `[temp interface creation] ${channel.id}`, retryError);
      }
    }
  }

  async function finishOwnership(guild, channel, ownerId, previousChannelId = null) {
    await adoptOwnedChannel(guild || channel.guild, channel, ownerId, previousChannelId);
    if (!previousChannelId || sameId(previousChannelId, channel?.id)) return;
    const row = typeof db.getTempChannel === "function" ? db.getTempChannel(previousChannelId) : null;
    if (!row || !sameId(row.owner_id, ownerId)) return;
    if (
      await ownerStillPresent(guild, previousChannelId, ownerId) ||
      isChannelMember(guild, previousChannelId, ownerId)
    ) {
      return;
    }
    cancelOwnerRelease(previousChannelId, ownerId);
    if (typeof db.clearOwner === "function") db.clearOwner(previousChannelId, ownerId);
  }

  async function openCall(guild, config, userId, box) {
    return pacer.schedule(guild.id, async () => {
      const cached = guild.members?.cache?.get?.(userId) || guild.members?.cache?.get?.(String(userId));
      const member = (canMove(cached) ? cached : null) || personForChannel(guild, userId, box.member);
      if (member.user?.bot) return null;
      const state = voiceStateFor(guild, userId);
      if (box.channel && sameId(state?.channelId || member.voice?.channelId, box.channel.id)) return box.channel;
      if (!stillInJoin(guild, userId, config.j2c_channel_id, box)) throw leftJoinChannel();
      let reservation = null;
      let moved = false;
      const timeoutMs = pace.operationTimeoutMs;
      const adoptCreatedChannel = (channel, generation) => {
        if (!channel?.id) return;
        const current = box.channel;
        const stale = generation !== box.createGeneration;
        if (stale && current) {
          if (!sameId(current.id, channel.id)) cleanupCreated(guild, channel.id).catch(() => null);
          return;
        }
        box.channel = channel;
        if (current && !sameId(current.id, channel.id)) cleanupCreated(guild, current.id).catch(() => null);
      };
      try {
        if (!box.channel) {
          reservation = reserveTempCategory(guild, config, member.id);
          const slot = takeDiscordSlot(guild.id, "create");
          let creating;
          let keepCreate = false;
          const generation = (box.createGeneration || 0) + 1;
          box.createGeneration = generation;
          try {
            await pacer.acquire(guild.id, "create");
            const freshCached = guild.members?.cache?.get?.(userId);
            const fresh = (canMove(freshCached) ? freshCached : null) || member;
            if (!stillInJoin(guild, userId, config.j2c_channel_id, box)) throw leftJoinChannel();
            creating = createTempChannel(guild, fresh, {
              ...config,
              category_id: reservation.categoryId
            });
            slot.bind(creating);
            adoptCreatedChannel(await withTimeout(creating, timeoutMs), generation);
          } catch (error) {
            if (error?.code === "J2C_TIMEOUT" && creating) {
              keepCreate = true;
              Promise.resolve(creating).then((channel) => {
                adoptCreatedChannel(channel, generation);
              }).catch(() => null);
            }
            throw error;
          } finally {
            if (!keepCreate) slot.release();
          }
        }
        const moveSlot = takeDiscordSlot(guild.id, "move");
        let keepMove = false;
        try {
          await pacer.acquire(guild.id, "move");
          if (!stillInJoin(guild, userId, config.j2c_channel_id, box)) throw leftJoinChannel();
          const mover = typeof box.voiceState?.setChannel === "function" ? box.voiceState : voiceStateFor(guild, userId);
          const reason = "VoiceMaster: created temporary voice channel";
          const targetId = box.channel.id;
          const moving = typeof mover?.setChannel === "function"
            ? mover.setChannel(targetId, reason)
            : typeof member.voice?.setChannel === "function"
              ? member.voice.setChannel(targetId, reason)
              : guild.members.edit(userId, { channel: targetId, reason });
          moveSlot.bind(moving);
          await withTimeout(moving, timeoutMs);
          moved = true;
          return box.channel;
        } catch (error) {
          if (error?.code === "J2C_TIMEOUT") keepMove = true;
          throw error;
        } finally {
          if (!keepMove) moveSlot.release();
        }
      } catch (error) {
        if (isRateLimitError(error)) pacer.penalize(guild.id, error);
        throw error;
      } finally {
        reservation?.release(moved);
      }
    });
  }

  async function stayUntilMoved(guild, config, userId, box) {
    let streak = 0;
    while (true) {
      try {
        if (!box.voiceState) box.voiceState = voiceStateFor(guild, userId);
        const member = await memberForJoin(guild, userId, box.member, box.voiceState);
        if (member?.user?.bot) {
          if (box.channel) await cleanupCreated(guild, box.channel.id);
          return null;
        }
        const actor = member || personForChannel(guild, userId, box.member);
        box.member = actor;
        if (box.channel && evidenceInChannel(guild, userId, box.channel.id, box)) {
          releaseChannelForMove(box.channel.id);
          await finishOwnership(guild, box.channel, actor.id, box.fromChannelId);
          await renderInterface(box.channel, actor.id);
          return { temp: box.channel, ownerId: actor.id };
        }
        if (await leftJoin(guild, userId, config.j2c_channel_id, box)) {
          if (box.channel && evidenceInChannel(guild, userId, box.channel.id, box)) {
            releaseChannelForMove(box.channel.id);
            await finishOwnership(guild, box.channel, actor.id, box.fromChannelId);
            await renderInterface(box.channel, actor.id);
            return { temp: box.channel, ownerId: actor.id };
          }
          if (evidenceInChannel(guild, userId, config.j2c_channel_id, box)) {
            streak += 1;
            await pace.sleep(failureDelayMs(new Error("Join to create is still waiting for the member"), streak));
            continue;
          }
          if (box.channel) await cleanupCreated(guild, box.channel.id);
          return null;
        }
        if (!box.poolAt || Date.now() >= box.poolAt) {
          box.poolAt = Date.now() + 3000;
          try {
            const pooled = await withTimeout(
              require("./pool").moveFromLobby(guild, actor, config.j2c_channel_id, box.voiceState),
              8000
            );
            if (pooled?.channel) {
              await finishOwnership(guild, pooled.channel, actor.id, box.fromChannelId);
              return { temp: pooled.channel, ownerId: actor.id };
            }
          } catch (poolError) {
            if (poolError?.code !== "J2C_TIMEOUT") {
              logThrottledError(`j2c-pool:${guild.id}`, `[J2C pool] ${guild.id}:${userId}`, poolError);
            }
          }
        }
        const channel = await withChannelLock(`j2c-user:${guild.id}:${userId}`, () => openCall(guild, config, userId, box));
        if (!channel) {
          streak += 1;
          if (await leftJoin(guild, userId, config.j2c_channel_id, box)) {
            if (evidenceInChannel(guild, userId, config.j2c_channel_id, box)) {
              await pace.sleep(failureDelayMs(new Error("Join to create is still waiting for the member"), streak));
              continue;
            }
            if (box.channel) await cleanupCreated(guild, box.channel.id);
            return null;
          }
          await pace.sleep(failureDelayMs(new Error("Join to create is still waiting for the member"), streak));
          continue;
        }
        releaseChannelForMove(channel.id);
        await finishOwnership(guild, channel, actor.id, box.fromChannelId);
        await renderInterface(channel, actor.id);
        return { temp: channel, ownerId: actor.id };
      } catch (error) {
        const actor = box.member || personForChannel(guild, userId, box.member);
        if (leftVoice(error)) {
          if (box.channel && evidenceInChannel(guild, userId, box.channel.id, box)) {
            releaseChannelForMove(box.channel.id);
            await finishOwnership(guild, box.channel, actor.id, box.fromChannelId);
            await renderInterface(box.channel, actor.id);
            return { temp: box.channel, ownerId: actor.id };
          }
          if (!(await leftJoin(guild, userId, config.j2c_channel_id, box))
            || evidenceInChannel(guild, userId, config.j2c_channel_id, box)) {
            streak += 1;
            await pace.sleep(failureDelayMs(error, streak));
            continue;
          }
          if (box.channel) await cleanupCreated(guild, box.channel.id);
          return null;
        }
        streak += 1;
        if (error?.code !== "J2C_TIMEOUT" && error?.code !== "J2C_WAITING") {
          logThrottledError(`j2c-create:${guild.id}`, `[J2C create] ${guild.id}:${userId}`, error);
        }
        if (channelMissing(error) && box.channel) {
          await cleanupCreated(guild, box.channel.id);
          box.channel = null;
        }
        if (box.channel && evidenceInChannel(guild, userId, box.channel.id, box)) {
          releaseChannelForMove(box.channel.id);
          await finishOwnership(guild, box.channel, actor.id, box.fromChannelId);
          await renderInterface(box.channel, actor.id);
          return { temp: box.channel, ownerId: actor.id };
        }
        if (await leftJoin(guild, userId, config.j2c_channel_id, box)) {
          if (evidenceInChannel(guild, userId, config.j2c_channel_id, box)) {
            // Stale leave signal while they are still sitting in the trigger.
          } else {
            if (box.channel) await cleanupCreated(guild, box.channel.id);
            return null;
          }
        }
        if (error?.code === "J2C_GUILD_FULL" && typeof cleanupEmptyTempChannels === "function") {
          box.poolAt = 0;
          try {
            await cleanupEmptyTempChannels(guild, { limit: 10, pauseMs: 200 });
          } catch (cleanupError) {
            logThrottledError(`j2c-cleanup:${guild.id}`, `[J2C cleanup] ${guild.id}`, cleanupError);
          }
        }
        if (shouldEvictIdle(error, streak) && evidenceInChannel(guild, userId, config.j2c_channel_id, box)) {
          if (box.channel) await cleanupCreated(guild, box.channel.id);
          await evictFromLobby(guild, userId, config.j2c_channel_id, actor);
          return null;
        }
        await pace.sleep(failureDelayMs(error, streak));
      }
    }
  }

  function startJoin(guild, config, userId, fallbackMember, fromChannelId, voiceState) {
    const key = `${guild.id}:${userId}`;
    const existing = pendingCreates.get(key);
    if (existing) return existing.promise;
    const box = {
      channel: null,
      member: fallbackMember,
      fromChannelId: fromChannelId || null,
      expectJoin: Date.now() + 3000,
      voiceState: voiceState || null
    };
    const promise = stayUntilMoved(guild, config, userId, box).catch((error) => {
      logThrottledError(`j2c-create:${guild.id}`, `[J2C create] ${guild.id}:${userId}`, error);
      return null;
    });
    const record = { promise, box, startedAt: Date.now() };
    pendingCreates.set(key, record);
    promise.finally(() => {
      if (pendingCreates.get(key) === record) pendingCreates.delete(key);
    });
    return promise;
  }

  function nudgeGuild(guild) {
    const config = db.getConfig(guild.id);
    if (!config?.j2c_channel_id) return 0;
    const waiting = membersWaiting(guild, config.j2c_channel_id);
    for (const member of waiting) {
      startJoin(guild, config, member.id, member, null, voiceStateFor(guild, member.id));
    }
    return waiting.length;
  }

  function lobbyBusy(guildId) {
    return pacer.isActive(guildId);
  }

  async function recoverGuild(guild) {
    const config = db.getConfig(guild.id);
    if (!config?.j2c_channel_id) return;
    const tasks = membersWaiting(guild, config.j2c_channel_id).map((member) =>
      startJoin(guild, config, member.id, member, null, voiceStateFor(guild, member.id))
    );
    await Promise.all(tasks);
  }

  async function handleVoiceStateUpdate(oldState, newState) {
    try {
      if (!newState.guild) return;
      const guild = newState.guild;
      const config = db.getConfig(guild.id);
      if (!config) return;

      const joinedMemberId = newState.member?.id || newState.id;
      if (newState.channelId && joinedMemberId && !sameId(oldState.channelId, newState.channelId)) {
        const joinedRow = db.getTempChannel(newState.channelId);
        const releaseUser = ownerReleaseUser(newState.channelId);
        if (joinedRow && (sameId(joinedRow.owner_id, joinedMemberId) || sameId(releaseUser, joinedMemberId))) {
          await withChannelLock(newState.channelId, async () => {
            await noteOwnerArrival(guild, newState.channelId, joinedMemberId);
          });
        }
      }

      const joinedJoinToCreate =
        sameId(newState.channelId, config.j2c_channel_id) &&
        !sameId(oldState.channelId, newState.channelId);
      const joinedMember = newState.member || guild.members?.cache?.get?.(newState.id);
      const knownUser = guild.client?.users?.cache?.get?.(newState.id);
      const joinTask = joinedJoinToCreate && !newState.member?.user?.bot && !knownUser?.bot
        ? startJoin(
          guild,
          config,
          newState.id,
          joinedMember,
          oldState.channelId,
          newState
        )
        : null;
      const poolTask = !joinTask && newState.channelId && !sameId(oldState.channelId, newState.channelId) && !joinedMember?.user?.bot
        ? require("./pool").claimJoin(guild, joinedMember, newState.channelId, oldState.channelId).catch((error) => {
          logThrottledError(`pool-join:${guild.id}`, `[pool join] ${guild.id}:${newState.channelId}`, error);
          return null;
        })
        : null;

      if (oldState.channelId && !sameId(oldState.channelId, newState.channelId)) {
        try {
          const managedBeforeLock = db.getTempChannel(oldState.channelId);
          if (managedBeforeLock) {
            await withChannelLock(oldState.channelId, async () => {
              const managed = db.getTempChannel(oldState.channelId);
              if (!managed) return;
              const memberId = oldState.member?.id || oldState.id;
              if (!memberId || String(managed.owner_id) !== String(memberId)) return;
              // Channel changes and brief disconnects are not proof the owner left.
              // Keep the saved owner until a live voice-state check says they are
              // still gone after the rejoin window, or they open a new temporary VC.
              await noteOwnerDeparture(guild, oldState.channelId, memberId);
            });
            if (cleanupTempChannel) await cleanupTempChannel(guild, oldState.channelId);
            else await cleanupEmptyTempChannels(guild);
          }
        } catch (error) {
          logThrottledError(`voice-leave:${guild.id}`, `[voice leave] ${guild.id}:${oldState.channelId}`, error);
        }
      }

      if (poolTask) await poolTask;
      if (joinTask) await joinTask;
    } catch (error) {
      logThrottledError(
        `voice-state:${newState.guild?.id}`,
        `[voice state] ${newState.guild?.id}:${newState.id}`,
        error
      );
    }
  };

  handleVoiceStateUpdate.recoverGuild = recoverGuild;
  handleVoiceStateUpdate.nudgeGuild = nudgeGuild;
  handleVoiceStateUpdate.lobbyBusy = lobbyBusy;
  return handleVoiceStateUpdate;
}

module.exports = { createVoiceStateHandler, JOIN_PACE, retryDelayMs };
