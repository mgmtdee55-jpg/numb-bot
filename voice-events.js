const { withChannelLock } = require("./channel-lock");
const {
  reserveTempCategory: reserveConfiguredTempCategory,
  ownerStillPresent,
  scheduleOwnerRelease,
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
  if (error?.code === "J2C_TIMEOUT") return 200;
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
    Promise.resolve()
      .then(task.operation)
      .then(task.resolve, task.reject)
      .finally(() => {
        queue.active -= 1;
        pump(guildId);
      });
    }
  }

  return { acquire, penalize, schedule };
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

  function voiceChannelId(guild, userId) {
    const state = voiceStateFor(guild, userId);
    const fromState = state?.channelId || state?.channel?.id || null;
    if (fromState != null) return fromState;
    const member = guild?.members?.cache?.get?.(userId) || guild?.members?.cache?.get?.(String(userId));
    return member?.voice?.channelId || member?.voice?.channel?.id || null;
  }

  function stillInJoin(guild, userId, channelId, box) {
    if (listedInChannel(guild, channelId, userId)) return true;
    const current = voiceChannelId(guild, userId);
    if (current != null && sameId(current, channelId)) return true;
    const fresh = box?.expectJoin && Date.now() < box.expectJoin;
    if (!fresh) return false;
    if (current == null) return true;
    if (box.fetchedHere) return true;
    // The cache can still show the channel they stepped out of for a moment
    // after the join event. That is not proof they left the lobby.
    return !!(box.fromChannelId && sameId(current, box.fromChannelId));
  }

  async function leftJoin(guild, userId, channelId, box) {
    if (stillInJoin(guild, userId, channelId, box)) return false;
    if (typeof guild?.voiceStates?.fetch !== "function") return true;
    try {
      const state = await guild.voiceStates.fetch(userId);
      const current = state?.channelId || state?.channel?.id || null;
      if (sameId(current, channelId)) {
        if (box) {
          box.expectJoin = Date.now() + 3000;
          box.fetchedHere = true;
        }
        return false;
      }
      return true;
    } catch (error) {
      if (error?.code === 10065 || error?.status === 404) return true;
      return false;
    }
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

  async function memberForJoin(guild, userId, fallback) {
    const cached = guild.members?.cache?.get?.(userId) || guild.members?.cache?.get?.(String(userId));
    if (canMove(cached)) return cached;
    if (canMove(fallback)) return fallback;
    if (typeof guild.members?.fetch !== "function") return null;
    try {
      return await guild.members.fetch(userId);
    } catch (error) {
      if (error?.code === 10007) return null;
      if (!isRateLimitError(error)) return null;
      await pace.sleep(pacer.penalize(guild.id, error));
      return guild.members.fetch(userId).catch((retryError) => {
        if (retryError?.code === 10007 || !isRateLimitError(retryError)) return null;
        throw retryError;
      });
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

  function finishOwnership(channel, ownerId) {
    if (typeof db.forceOwner === "function") db.forceOwner(channel.id, ownerId);
    cancelOwnerRelease(channel.id, ownerId);
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
      try {
        if (!box.channel) {
          reservation = reserveTempCategory(guild, config, member.id);
          await pacer.acquire(guild.id, "create");
          const freshCached = guild.members?.cache?.get?.(userId);
          const fresh = (canMove(freshCached) ? freshCached : null) || member;
          if (!stillInJoin(guild, userId, config.j2c_channel_id, box)) throw leftJoinChannel();
          const creating = createTempChannel(guild, fresh, {
            ...config,
            category_id: reservation.categoryId
          });
          try {
            box.channel = await withTimeout(creating, timeoutMs);
          } catch (error) {
            if (error?.code === "J2C_TIMEOUT") {
              creating.then((channel) => {
                if (!channel) return;
                if (!box.channel) {
                  box.channel = channel;
                  return;
                }
                if (!sameId(box.channel.id, channel.id)) {
                  cleanupCreated(guild, channel.id).catch(() => null);
                }
              }).catch(() => null);
            }
            throw error;
          }
        }
        await pacer.acquire(guild.id, "move");
        if (!stillInJoin(guild, userId, config.j2c_channel_id, box)) throw leftJoinChannel();
        const mover = voiceStateFor(guild, userId);
        const reason = "VoiceMaster: created temporary voice channel";
        const moving = typeof mover?.setChannel === "function"
          ? mover.setChannel(box.channel.id, reason)
          : typeof member.voice?.setChannel === "function"
            ? member.voice.setChannel(box.channel.id, reason)
            : guild.members.edit(userId, { channel: box.channel.id, reason });
        await withTimeout(moving, timeoutMs);
        moved = true;
        return box.channel;
      } catch (error) {
        if (isRateLimitError(error)) pacer.penalize(guild.id, error);
        throw error;
      } finally {
        reservation?.release(moved);
      }
    });
  }

  async function stayUntilMoved(guild, config, userId, fallbackMember, fromChannelId) {
    const box = {
      channel: null,
      member: fallbackMember,
      fromChannelId: fromChannelId || null,
      expectJoin: Date.now() + 3000
    };
    let streak = 0;
    while (true) {
      try {
        const member = await memberForJoin(guild, userId, box.member);
        if (member?.user?.bot) {
          if (box.channel) await cleanupCreated(guild, box.channel.id);
          return null;
        }
        const actor = member || personForChannel(guild, userId, box.member);
        box.member = actor;
        if (box.channel && sameId(voiceStateFor(guild, userId)?.channelId || actor.voice?.channelId, box.channel.id)) {
          releaseChannelForMove(box.channel.id);
          finishOwnership(box.channel, actor.id);
          await renderInterface(box.channel, actor.id);
          return { temp: box.channel, ownerId: actor.id };
        }
        if (await leftJoin(guild, userId, config.j2c_channel_id, box)) {
          if (box.channel) await cleanupCreated(guild, box.channel.id);
          return null;
        }
        const channel = await withChannelLock(`j2c-user:${guild.id}:${userId}`, () => openCall(guild, config, userId, box));
        if (!channel) {
          streak += 1;
          if (await leftJoin(guild, userId, config.j2c_channel_id, box)) {
            if (box.channel) await cleanupCreated(guild, box.channel.id);
            return null;
          }
          await pace.sleep(failureDelayMs(new Error("Join to create is still waiting for the member"), streak));
          continue;
        }
        releaseChannelForMove(channel.id);
        finishOwnership(channel, actor.id);
        await renderInterface(channel, actor.id);
        return { temp: channel, ownerId: actor.id };
      } catch (error) {
        if (leftVoice(error)) {
          if (!(await leftJoin(guild, userId, config.j2c_channel_id, box))) {
            streak += 1;
            await pace.sleep(failureDelayMs(error, streak));
            continue;
          }
          if (box.channel) await cleanupCreated(guild, box.channel.id);
          return null;
        }
        streak += 1;
        logThrottledError(`j2c-create:${guild.id}`, `[J2C create] ${guild.id}:${userId}`, error);
        if (channelMissing(error) && box.channel) {
          await cleanupCreated(guild, box.channel.id);
          box.channel = null;
        }
        if (await leftJoin(guild, userId, config.j2c_channel_id, box)) {
          if (box.channel) await cleanupCreated(guild, box.channel.id);
          return null;
        }
        await pace.sleep(failureDelayMs(error, streak));
      }
    }
  }

  function startJoin(guild, config, userId, fallbackMember, fromChannelId) {
    const key = `${guild.id}:${userId}`;
    const existing = pendingCreates.get(key);
    if (existing) return existing;
    const creation = stayUntilMoved(guild, config, userId, fallbackMember, fromChannelId).catch((error) => {
      logThrottledError(`j2c-create:${guild.id}`, `[J2C create] ${guild.id}:${userId}`, error);
      return null;
    });
    pendingCreates.set(key, creation);
    creation.finally(() => {
      if (pendingCreates.get(key) === creation) pendingCreates.delete(key);
    });
    return creation;
  }

  function nudgeGuild(guild) {
    const config = db.getConfig(guild.id);
    if (!config?.j2c_channel_id) return 0;
    const waiting = membersWaiting(guild, config.j2c_channel_id);
    for (const member of waiting) startJoin(guild, config, member.id, member);
    return waiting.length;
  }

  function lobbyBusy(guildId) {
    const prefix = `${guildId}:`;
    for (const key of pendingCreates.keys()) {
      if (String(key).startsWith(prefix)) return true;
    }
    return false;
  }

  async function recoverGuild(guild) {
    const config = db.getConfig(guild.id);
    if (!config?.j2c_channel_id) return;
    const tasks = membersWaiting(guild, config.j2c_channel_id).map((member) =>
      startJoin(guild, config, member.id, member)
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
      if (newState.channelId && joinedMemberId) {
        cancelOwnerRelease(newState.channelId, joinedMemberId);
      }

      const joinedJoinToCreate =
        sameId(newState.channelId, config.j2c_channel_id) &&
        !sameId(oldState.channelId, newState.channelId);
      const joinTask = joinedJoinToCreate && !newState.member?.user?.bot
        ? startJoin(
          guild,
          config,
          newState.id,
          newState.member || guild.members?.cache?.get?.(newState.id),
          oldState.channelId
        )
        : null;

      if (oldState.channelId && oldState.channelId !== newState.channelId) {
        try {
          const managedBeforeLock = db.getTempChannel(oldState.channelId);
          if (managedBeforeLock) {
            await withChannelLock(oldState.channelId, async () => {
              const managed = db.getTempChannel(oldState.channelId);
              if (!managed) return;
              const memberId = oldState.member?.id || oldState.id;
              if (!memberId || String(managed.owner_id) !== String(memberId)) return;
              if (await ownerStillPresent(guild, oldState.channelId, memberId)) {
                cancelOwnerRelease(oldState.channelId, memberId);
                return;
              }
              if (newState.channelId) {
                cancelOwnerRelease(oldState.channelId, memberId);
                db.clearOwner(oldState.channelId, memberId);
                return;
              }
              scheduleOwnerRelease(oldState.channelId, memberId, () => withChannelLock(oldState.channelId, async () => {
                const current = db.getTempChannel(oldState.channelId);
                if (!current || String(current.owner_id) !== String(memberId)) return;
                if (await ownerStillPresent(guild, oldState.channelId, memberId)) return;
                db.clearOwner(oldState.channelId, memberId);
              }));
            });
            if (cleanupTempChannel) await cleanupTempChannel(guild, oldState.channelId);
            else await cleanupEmptyTempChannels(guild);
          }
        } catch (error) {
          logThrottledError(`voice-leave:${guild.id}`, `[voice leave] ${guild.id}:${oldState.channelId}`, error);
        }
      }

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
