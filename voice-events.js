const { withChannelLock } = require("./channel-lock");
const {
  reserveTempCategory: reserveConfiguredTempCategory,
  ownerStillPresent,
  scheduleOwnerRelease,
  cancelOwnerRelease,
  isRateLimitError
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
  maxAttempts: 4
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
  if (isRateLimitError(error)) return retryDelayMs(error);
  const permissionDenied = Number(error?.code) === 50013 || Number(error?.status) === 403;
  if (permissionDenied) return 30000;
  const index = Math.min(Math.max(streak, 1), FAILURE_RETRY_MS.length) - 1;
  return FAILURE_RETRY_MS[index];
}

function leftVoice(error) {
  return error?.code === "J2C_LEFT" || Number(error?.code) === 40032;
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
        .then(() => {
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

  function inJoinChannel(member, channelId) {
    const current = member?.voice?.channelId || member?.voice?.channel?.id || null;
    return current === channelId;
  }

  async function memberForJoin(guild, userId, fallback) {
    const cached = guild.members?.cache?.get?.(userId) || guild.members?.cache?.get?.(String(userId)) || fallback;
    if (cached) return cached;
    if (typeof guild.members?.fetch !== "function") return fallback || null;
    try {
      return await guild.members.fetch(userId);
    } catch (error) {
      if (error?.code === 10007) return null;
      if (!isRateLimitError(error)) throw error;
      await pace.sleep(pacer.penalize(guild.id, error));
      return guild.members.fetch(userId).catch((retryError) => {
        if (retryError?.code === 10007) return null;
        throw retryError;
      });
    }
  }

  async function cleanupCreated(guild, channelId) {
    try {
      if (!channelId) return;
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
        if (!state || state.channelId !== channelId) continue;
        add(state.member, state.id);
      }
    }
    const channel = guild.channels?.cache?.get?.(channelId);
    if (typeof channel?.members?.values === "function") {
      for (const member of channel.members.values()) {
        if (member?.voice?.channelId && member.voice.channelId !== channelId) continue;
        add(member, member.id);
      }
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
      const member = guild.members?.cache?.get?.(userId) || box.member;
      if (!member || member.user?.bot) return null;
      if (box.channel && (member.voice?.channelId === box.channel.id)) return box.channel;
      if (!inJoinChannel(member, config.j2c_channel_id)) throw leftJoinChannel();
      let reservation = null;
      let moved = false;
      try {
        if (!box.channel) {
          reservation = reserveTempCategory(guild, config, member.id);
          await pacer.acquire(guild.id, "create");
          const fresh = guild.members?.cache?.get?.(userId) || member;
          if (!inJoinChannel(fresh, config.j2c_channel_id)) throw leftJoinChannel();
          box.channel = await createTempChannel(guild, fresh, {
            ...config,
            category_id: reservation.categoryId
          });
        }
        await pacer.acquire(guild.id, "move");
        const latest = guild.members?.cache?.get?.(userId) || member;
        if (!inJoinChannel(latest, config.j2c_channel_id)) throw leftJoinChannel();
        await latest.voice.setChannel(box.channel.id, "VoiceMaster: created temporary voice channel");
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

  async function stayUntilMoved(guild, config, userId, fallbackMember) {
    const box = { channel: null, member: fallbackMember };
    let streak = 0;
    while (true) {
      try {
        const member = await memberForJoin(guild, userId, box.member);
        box.member = member || box.member;
        if (!member || member.user?.bot) {
          if (box.channel) await cleanupCreated(guild, box.channel.id);
          return null;
        }
        if (box.channel && member.voice?.channelId === box.channel.id) {
          finishOwnership(box.channel, member.id);
          await renderInterface(box.channel, member.id);
          return { temp: box.channel, ownerId: member.id };
        }
        if (!inJoinChannel(member, config.j2c_channel_id)) {
          if (box.channel) await cleanupCreated(guild, box.channel.id);
          return null;
        }
        const channel = await withChannelLock(`j2c-user:${guild.id}:${userId}`, () => openCall(guild, config, userId, box));
        if (!channel) return null;
        finishOwnership(channel, member.id);
        await renderInterface(channel, member.id);
        return { temp: channel, ownerId: member.id };
      } catch (error) {
        if (leftVoice(error)) {
          if (box.channel) await cleanupCreated(guild, box.channel.id);
          return null;
        }
        streak += 1;
        logThrottledError(`j2c-create:${guild.id}`, `[J2C create] ${guild.id}:${userId}`, error);
        if (channelMissing(error) && box.channel) {
          await cleanupCreated(guild, box.channel.id);
          box.channel = null;
        }
        const latest = guild.members?.cache?.get?.(userId) || box.member;
        if (!inJoinChannel(latest, config.j2c_channel_id)) {
          if (box.channel) await cleanupCreated(guild, box.channel.id);
          return null;
        }
        await pace.sleep(failureDelayMs(error, streak));
      }
    }
  }

  function startJoin(guild, config, userId, fallbackMember) {
    const key = `${guild.id}:${userId}`;
    const existing = pendingCreates.get(key);
    if (existing) return existing;
    const creation = stayUntilMoved(guild, config, userId, fallbackMember).catch((error) => {
      logThrottledError(`j2c-create:${guild.id}`, `[J2C create] ${guild.id}:${userId}`, error);
      return null;
    });
    pendingCreates.set(key, creation);
    creation.finally(() => {
      if (pendingCreates.get(key) === creation) pendingCreates.delete(key);
    });
    return creation;
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

      const joinedJoinToCreate =
        newState.channelId === config.j2c_channel_id &&
        oldState.channelId !== newState.channelId;
      if (joinedJoinToCreate) {
        if (newState.member?.user?.bot) return;
        const cachedMember = newState.member || guild.members?.cache?.get?.(newState.id);
        const currentChannel = cachedMember?.voice?.channelId || cachedMember?.voice?.channel?.id || null;
        if (currentChannel && currentChannel !== config.j2c_channel_id) return;
        await startJoin(guild, config, newState.id, cachedMember);
        return;
      }
    } catch (error) {
      logThrottledError(
        `voice-state:${newState.guild?.id}`,
        `[voice state] ${newState.guild?.id}:${newState.id}`,
        error
      );
    }
  };

  handleVoiceStateUpdate.recoverGuild = recoverGuild;
  return handleVoiceStateUpdate;
}

module.exports = { createVoiceStateHandler, JOIN_PACE, retryDelayMs };
