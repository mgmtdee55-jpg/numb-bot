const { withChannelLock } = require("./channel-lock");
const {
  reserveTempCategory: reserveConfiguredTempCategory,
  isChannelMember,
  scheduleOwnerRelease,
  cancelOwnerRelease
} = require("./voice");
const { logThrottledError } = require("./log-throttle");

function createVoiceStateHandler({
  db,
  createTempChannel,
  renderVoiceChannelInterface,
  reserveTempCategory = reserveConfiguredTempCategory,
  cleanupEmptyTempChannels,
  cleanupTempChannel
}) {
  if (typeof renderVoiceChannelInterface !== "function" || typeof reserveTempCategory !== "function") {
    throw new TypeError("createVoiceStateHandler requires the interface renderer and category reservation helper.");
  }
  const pendingCreates = new Map();
  const guildCreateQueues = new Map();
  const maxConcurrentCreatesPerGuild = 5;

  function createWithGuildLimit(guildId, operation) {
    let queue = guildCreateQueues.get(guildId);
    if (!queue) {
      queue = { active: 0, waiting: [] };
      guildCreateQueues.set(guildId, queue);
    }
    return new Promise((resolve, reject) => {
      queue.waiting.push({ operation, resolve, reject });
      const pump = () => {
        while (queue.active < maxConcurrentCreatesPerGuild && queue.waiting.length) {
          const task = queue.waiting.shift();
          queue.active += 1;
          Promise.resolve()
            .then(task.operation)
            .then(task.resolve, task.reject)
            .then(() => {
              queue.active -= 1;
              if (!queue.active && !queue.waiting.length) guildCreateQueues.delete(guildId);
              else pump();
            });
        }
      };
      pump();
    });
  }

  return async function handleVoiceStateUpdate(oldState, newState) {
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
        const managedBeforeLock = db.getTempChannel(oldState.channelId);
        if (managedBeforeLock) {
          await withChannelLock(oldState.channelId, async () => {
            const managed = db.getTempChannel(oldState.channelId);
            if (!managed) return;
            const memberId = oldState.member?.id || oldState.id;
            if (!memberId || String(managed.owner_id) !== String(memberId)) return;
            if (isChannelMember(guild, oldState.channelId, memberId)) {
              cancelOwnerRelease(oldState.channelId, memberId);
              return;
            }
            if (newState.channelId) {
              cancelOwnerRelease(oldState.channelId, memberId);
              db.clearOwner(oldState.channelId, memberId);
              return;
            }
            scheduleOwnerRelease(oldState.channelId, memberId, () => withChannelLock(oldState.channelId, () => {
              const current = db.getTempChannel(oldState.channelId);
              if (!current || String(current.owner_id) !== String(memberId)) return;
              if (isChannelMember(guild, oldState.channelId, memberId)) return;
              db.clearOwner(oldState.channelId, memberId);
            }));
          });
          if (cleanupTempChannel) await cleanupTempChannel(guild, oldState.channelId);
          else await cleanupEmptyTempChannels(guild);
        }
      }

      const joinedJoinToCreate =
        newState.channelId === config.j2c_channel_id &&
        oldState.channelId !== newState.channelId;
      if (joinedJoinToCreate) {
        const key = `${guild.id}:${newState.id}`;
        if (pendingCreates.has(key)) return pendingCreates.get(key);
        const member = newState.member || guild.members.cache.get(newState.id);
        if (!member || member.voice.channelId !== config.j2c_channel_id) return;
        const creation = withChannelLock(`j2c-user:${key}`, () =>
          createWithGuildLimit(guild.id, async () => {
            const currentMember = guild.members.cache.get(member.id) || member;
            if (currentMember.voice.channelId !== config.j2c_channel_id) return null;
            const categoryReservation = reserveTempCategory(guild, config, currentMember.id);
            let memberMoved = false;
            try {
              const temp = await createTempChannel(guild, currentMember, {
                ...config,
                category_id: categoryReservation.categoryId
              });
              const latestMember = guild.members.cache.get(member.id) || currentMember;
              if (latestMember.voice.channelId !== config.j2c_channel_id) {
                if (cleanupTempChannel) await cleanupTempChannel(guild, temp.id);
                else await cleanupEmptyTempChannels(guild);
                return null;
              }
              await latestMember.voice.setChannel(temp.id, "VoiceMaster: created temporary voice channel");
              memberMoved = true;
              if (typeof db.forceOwner === "function") db.forceOwner(temp.id, currentMember.id);
              cancelOwnerRelease(temp.id, currentMember.id);
              return { temp, ownerId: currentMember.id };
            } finally {
              categoryReservation.release(memberMoved);
            }
          })
        );
        pendingCreates.set(key, creation);
        try {
          const created = await creation;
          if (!created) return;
          try {
            await renderVoiceChannelInterface(created.temp, created.ownerId);
          } catch (error) {
            logThrottledError(
              `temp-interface:${guild.id}`,
              `[temp interface creation] ${created.temp.id}`,
              error
            );
          }
        } catch (error) {
          logThrottledError(`j2c-create:${guild.id}`, `[J2C create] ${guild.id}:${newState.id}`, error);
        } finally {
          if (pendingCreates.get(key) === creation) pendingCreates.delete(key);
        }
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
}

module.exports = { createVoiceStateHandler };
