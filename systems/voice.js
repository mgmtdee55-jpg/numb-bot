const { AuditLogEvent, ChannelType, PermissionFlagsBits } = require("discord.js");
const db = require("../db");
const store = require("./store");
const access = require("./access");
const cooldowns = require("./cooldowns");
const stats = require("../stats");
const { embed, reply } = require("../vouch/ui");
const { replyUsage } = require("../usage");

const moving = new Map();
const muteAttempts = new Map();

function guardKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function denyRank(message, command) {
  const requirement = access.requirementFor(command);
  const note = access.isGodCommand(command)
    ? "Only Gods and the server owner can use it, unless one of them grants it."
    : "Gods and Founders can use the other voice commands.";
  return reply(message, "Rank Required", `**${command}** requires **${requirement}**. ${note}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withGuard(token, work) {
  const previous = moving.get(token) || Promise.resolve();
  const run = previous.then(work, work);
  moving.set(token, run);
  try {
    return await run;
  } finally {
    if (moving.get(token) === run) moving.delete(token);
  }
}

async function setMuteSafe(member, muted, reason) {
  if (typeof member?.voice?.setMute !== "function") return;
  try {
    await member.voice.setMute(muted, reason);
  } catch (error) {
    const wait = Math.min(5000, Math.round((Number(error?.retryAfter) || (error?.status === 429 ? 1.2 : 0)) * 1000));
    if (!wait) return;
    await sleep(wait);
    await member.voice.setMute(muted, reason).catch(() => null);
  }
}

function currentChannel(member) {
  return member?.voice?.channel || null;
}

async function editOverwrite(channel, id, data) {
  if (!channel?.permissionOverwrites?.edit) return false;
  await channel.permissionOverwrites.edit(id, data);
  return true;
}

async function takeOwnership(message, claimed) {
  const channel = currentChannel(message.member);
  const row = channel && db.getTempChannel(channel.id);
  if (!channel || !row) return reply(message, "Temporary VC Required", "Join a temporary voice channel created by this bot.");
  if (!db.forceOwner(channel.id, message.author.id)) {
    return reply(message, "Unable to Claim", "That channel is no longer managed.");
  }
  require("../voice").cancelOwnerRelease(channel.id);
  return reply(message, claimed ? "Channel Force Claimed" : "Ownership Forced", `You now own <#${channel.id}>. The previous owner stays in the channel.`);
}

async function voiceOverride(message) {
  const channel = currentChannel(message.member);
  if (!channel) return reply(message, "Join a Voice Channel", "Join the voice channel you want to override.");
  const ok = await editOverwrite(channel, message.author.id, { ViewChannel: true, Connect: true });
  if (!ok) return reply(message, "Unable to Override", "I could not edit that channel's permissions.");
  return reply(message, "Voice Override", `You can view and join <#${channel.id}>.`);
}

function occupants(channel) {
  const found = new Map();
  const states = channel?.guild?.voiceStates?.cache;
  if (typeof states?.values === "function") {
    for (const state of states.values()) {
      if (!state || state.channelId !== channel.id) continue;
      const member = state.member || channel.guild.members?.cache?.get?.(state.id);
      if (member?.id) found.set(String(member.id), member);
    }
  }
  if (typeof channel?.members?.values === "function") {
    for (const member of channel.members.values()) {
      if (!member?.id) continue;
      if (member.voice?.channelId && member.voice.channelId !== channel.id) continue;
      found.set(String(member.id), member);
    }
  }
  return [...found.values()];
}

function isVoiceChannel(channel) {
  return channel?.type === ChannelType.GuildVoice || channel?.type === ChannelType.GuildStageVoice;
}

async function dragAll(message, argument) {
  if (!String(argument || "").trim()) return replyUsage(message, "dragall");
  const destination = currentChannel(message.member);
  if (!destination) return reply(message, "Join a Voice Channel", "Join the voice channel people should be dragged into.");
  const source = await resolveVoiceChannel(message, argument);
  if (!isVoiceChannel(source)) return replyUsage(message, "dragall");
  if (source.id === destination.id) return reply(message, "Same Channel", "Name a different voice channel. People already in your call are left where they are.");
  const wait = cooldowns.consume(message.guild.id, message.author.id, "dragall");
  if (wait) return reply(message, "Please Wait", cooldowns.waitText(wait));
  let moved = 0;
  let skipped = 0;
  for (const member of occupants(source)) {
    if (!member || member.user?.bot || member.id === message.author.id) continue;
    const guard = store.getGuard(message.guild.id, member.id);
    if (guard?.shield || guard?.godmode) {
      skipped += 1;
      continue;
    }
    if (typeof member.voice?.setChannel !== "function") continue;
    await member.voice.setChannel(destination, "Voice dragall").catch(() => null);
    moved += 1;
  }
  return reply(message, "Drag All", `Moved **${moved}** member(s) from <#${source.id}> into <#${destination.id}>.${skipped ? ` Skipped **${skipped}** protected member(s).` : ""}`);
}

async function voiceHistory(message, userId) {
  const rows = userId
    ? store.listHistoryFor(message.guild.id, userId, 10)
    : store.listHistory(message.guild.id, 10);
  if (!rows.length) return reply(message, "Voice History", "No voice events have been recorded yet.");
  const lines = rows.map((row) => `<@${row.user_id}> — ${row.summary}`).join("\n");
  return reply(message, "Voice History", lines);
}

function stamp(createdAt) {
  const seconds = Math.floor(Number(createdAt) / 1000);
  if (!seconds) return "unknown time";
  return `<t:${seconds}:F> (<t:${seconds}:R>)`;
}

function openJoinAt(rows, userId) {
  let joinedAt = null;
  for (const row of rows) {
    if (String(row.user_id) !== String(userId)) continue;
    joinedAt = row.action === "join" ? row.created_at : null;
  }
  return joinedAt;
}

function packLines(lines) {
  const bodies = [];
  let bucket = [];
  let size = 0;
  for (const line of lines) {
    const nextSize = size + (bucket.length ? 1 : 0) + line.length;
    if (bucket.length && nextSize > 3600) {
      bodies.push(bucket.join("\n"));
      bucket = [line];
      size = line.length;
      continue;
    }
    bucket.push(line);
    size = nextSize;
  }
  if (bucket.length) bodies.push(bucket.join("\n"));
  return bodies;
}

function fitBodies(intro, historyLines) {
  let omitted = 0;
  let lines = intro.concat(historyLines);
  let bodies = packLines(lines);
  while (bodies.length > 10 && omitted < historyLines.length) {
    omitted = Math.min(historyLines.length, omitted + Math.max(1, (bodies.length - 10) * 12));
    const note = `Showing the latest **${historyLines.length - omitted}** of **${historyLines.length}** joins and leaves.`;
    lines = intro.concat([note], historyLines.slice(omitted));
    bodies = packLines(lines);
  }
  return bodies.slice(0, 10);
}

function callIntro(channelId, live, rows) {
  const present = live.map((member) => {
    const joinedAt = openJoinAt(rows, member.id);
    return joinedAt
      ? `<@${member.id}> — joined ${stamp(joinedAt)}`
      : `<@${member.id}> — in the call now. Join time was not recorded.`;
  }).sort();
  const lines = [
    `**Channel:** <#${channelId}>`,
    present.length ? `**In the call (${present.length})**` : "**In the call**",
    ...(present.length ? present : ["Nobody is connected right now."]),
    "",
    rows.length ? `**Joins and leaves (${rows.length})**` : "**Joins and leaves**"
  ];
  if (!rows.length) lines.push("No joins or leaves have been recorded for this call yet.");
  return lines;
}

async function loadCallChannel(message, channelId) {
  const channel = message.guild.channels.cache.get(channelId) || await message.guild.channels.fetch(channelId).catch(() => null);
  if (channel && !isVoiceChannel(channel)) return { error: ["Not a Voice Channel", "That channel is not a voice channel."] };
  if (!channel) {
    const rows = store.listCallHistory(message.guild.id, channelId, 1);
    if (!rows.length) return { error: ["Voice Channel Required", "I could not find that voice channel."] };
    return { channel: null, channelId };
  }
  return { channel, channelId: channel.id };
}

async function resolveCallTarget(message, argument) {
  const text = String(argument || "").trim();
  const link = text.match(/https?:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/channels\/(\d{17,20})\/(\d{17,20})/i);
  if (link) {
    if (link[1] !== String(message.guild.id)) return { error: ["Wrong Server", "That channel link is for another server."] };
    return loadCallChannel(message, link[2]);
  }
  const mentioned = message.mentions?.channels?.first?.();
  if (mentioned && (text.includes(`<#${mentioned.id}>`) || text === mentioned.id)) {
    if (!isVoiceChannel(mentioned)) return { error: ["Not a Voice Channel", "Mention a voice channel, or paste its link or ID."] };
    return { channel: mentioned, channelId: mentioned.id };
  }
  const id = text.replace(/[<#>]/g, "");
  if (/^\d{17,20}$/.test(id)) return loadCallChannel(message, id);
  const named = await resolveVoiceChannel(message, text);
  if (named) return { channel: named, channelId: named.id };
  return { error: ["Voice Channel Required", "Use a voice channel mention, link, or ID."] };
}

async function channelHistory(message, argument) {
  if (!String(argument || "").trim()) return replyUsage(message, "vchistory");
  const resolved = await resolveCallTarget(message, argument);
  if (resolved.error) return reply(message, resolved.error[0], resolved.error[1]);
  const rows = store.listCallHistory(message.guild.id, resolved.channelId, 400);
  const live = (resolved.channel ? occupants(resolved.channel) : []).filter((member) => member?.id && !member.user?.bot);
  const historyLines = rows.map((row) => `${stamp(row.created_at)} — <@${row.user_id}> ${row.action === "leave" ? "left" : "joined"}`);
  const bodies = fitBodies(callIntro(resolved.channelId, live, rows), historyLines);
  const embeds = bodies.map((body) => embed("Call History", body, { guild: message.guild }));
  return message.reply({ embeds });
}

async function setVoiceFlag(message, user, flag, enabled, title) {
  store.saveGuard(message.guild.id, user.id, { [flag]: enabled });
  return reply(message, title, `${enabled ? "Enabled" : "Cleared"} **${flag}** for <@${user.id}>.`);
}

async function resolveVoiceChannel(message, argument) {
  const mentioned = message.mentions?.channels?.first?.();
  if (mentioned?.type === ChannelType.GuildVoice || mentioned?.type === ChannelType.GuildStageVoice) return mentioned;
  const id = String(argument || "").replace(/[<#>]/g, "");
  if (/^\d{17,20}$/.test(id)) {
    const channel = message.guild.channels.cache.get(id) || await message.guild.channels.fetch(id).catch(() => null);
    if (isVoiceChannel(channel)) return channel;
    return null;
  }
  const name = String(argument || "").trim().toLowerCase();
  if (!name) return null;
  return [...message.guild.channels.cache.values()].find((channel) => isVoiceChannel(channel) && channel.name?.toLowerCase() === name) || null;
}

async function unmuteChannel(message, channel) {
  const members = occupants(channel);
  let changed = 0;
  for (const member of members) {
    if (member.user?.bot) continue;
    const guard = store.getGuard(message.guild.id, member.id);
    if (guard?.stfu) continue;
    if (!member.voice?.serverMute) continue;
    if (typeof member.voice?.setMute !== "function") continue;
    await setMuteSafe(member, false, "Voice unmuteall");
    changed += 1;
  }
  return reply(message, "Channel Unmuted", `Unmuted **${changed}** member(s) in <#${channel.id}>.`);
}

async function muteChannel(message, muted, channelArgument) {
  const wait = cooldowns.consume(message.guild.id, message.author.id, muted ? "muteall" : "unmuteall");
  if (wait) return reply(message, "Please Wait", cooldowns.waitText(wait));
  if (!muted && channelArgument) {
    const selected = await resolveVoiceChannel(message, channelArgument);
    if (!selected) return replyUsage(message, "unmuteall");
    return unmuteChannel(message, selected);
  }
  const channel = currentChannel(message.member);
  if (!channel) return reply(message, "Join a Voice Channel", "Join the voice channel you want to mute.");
  const members = occupants(channel);
  let changed = 0;
  for (const member of members) {
    if (member.id === message.author.id || member.user?.bot) continue;
    const guard = store.getGuard(message.guild.id, member.id);
    if (guard?.shield || guard?.godmode || guard?.stfu) continue;
    if (typeof member.voice?.setMute !== "function") continue;
    await setMuteSafe(member, muted, muted ? "Voice muteall" : "Voice unmuteall");
    if (muted) stats.recordAction(message.guild.id, message.author.id, member.id, "mute", "Voice mute");
    changed += 1;
  }
  return reply(message, muted ? "Channel Muted" : "Channel Unmuted", `Updated **${changed}** member(s) in <#${channel.id}>. Protected members were left alone.`);
}

function usageKey(command) {
  if (command === "stfu" || command === "stsu") return "stsu";
  if (command === "unstfu" || command === "unstsu") return "unstsu";
  if (command === "chain") return "chain";
  return command;
}

async function follow(message, target, chain) {
  if (!target) return replyUsage(message, chain ? "chain" : "follow");
  if (target.id === message.author.id) return reply(message, "Invalid Target", "You cannot follow yourself.");
  store.setFollow(message.guild.id, message.author.id, target.id);
  const where = target.voice?.channelId;
  if (where && message.member.voice?.setChannel) {
    await message.member.voice.setChannel(where, "Voice follow").catch(() => null);
  }
  return reply(message, chain ? "Chain Follow" : "Following", `You are following <@${target.id}>.${chain ? " People following you move with you." : ""}`);
}

async function bring(message, target) {
  const channel = currentChannel(message.member);
  if (!channel) return reply(message, "Join a Voice Channel", "Join the voice channel you want to bring them to.");
  if (!target) return replyUsage(message, "bring");
  const guard = store.getGuard(message.guild.id, target.id);
  if (guard?.shield) return reply(message, "Shielded", "That member is shielded.");
  if (typeof target.voice?.setChannel !== "function") return reply(message, "Unable to Bring", "That member is not connected in a way I can move.");
  await target.voice.setChannel(channel, "Voice bring");
  return reply(message, "Brought", `<@${target.id}> was moved to <#${channel.id}>.`);
}

async function inspect(message, target) {
  const member = target || message.member;
  const guard = store.getGuard(message.guild.id, member.id);
  const rank = store.getRank(message.guild.id, member.id);
  const channelId = member.voice?.channelId;
  const lines = [
    `**Member:** <@${member.id}>`,
    `**Channel:** ${channelId ? `<#${channelId}>` : "not connected"}`,
    `**Server mute:** ${member.voice?.serverMute ? "yes" : "no"}`,
    `**Server deaf:** ${member.voice?.serverDeaf ? "yes" : "no"}`,
    `**VC rank:** ${access.rankByKey(rank?.rank_key)?.label || access.voiceRankLabel(member) || "none"}`,
    `**Assigned by:** ${rank?.set_by ? `<@${rank.set_by}>` : "not recorded"}`,
    `**Godmode access:** ${store.isGodmode(message.guild.id, member.id) ? "yes" : "no"}`,
    `**Voice godmode:** ${guard?.godmode ? "yes" : "no"}`,
    `**Shield:** ${guard?.shield ? "yes" : "no"}`,
    `**STSU:** ${guard?.stfu ? "yes" : "no"}`
  ];
  return reply(message, "Voice Inspect", lines.join("\n"));
}

async function stsu(message, target, enabled) {
  if (!target) return replyUsage(message, enabled ? "stsu" : "unstsu");
  const blocked = access.moderateRefusal(message.member, target);
  if (blocked) return reply(message, "Unable to Moderate", blocked);
  const wait = cooldowns.consume(message.guild.id, message.author.id, "stsu");
  if (wait) return reply(message, "Please Wait", cooldowns.waitText(wait));
  const guard = store.getGuard(message.guild.id, target.id);
  if (enabled && guard?.shield && !access.canUseRankCommand(message.member, "unshield")) {
    return reply(message, "Shielded", "That member is shielded.");
  }
  store.saveGuard(message.guild.id, target.id, { stfu: enabled, godmode: enabled ? false : undefined });
  if (enabled) stats.recordAction(message.guild.id, message.author.id, target.id, "mute", "Server mute");
  if (target.voice?.channelId) await setMuteSafe(target, enabled, enabled ? "STSU" : "STSU cleared");
  return reply(message, enabled ? "STSU" : "STSU Cleared", `<@${target.id}> ${enabled ? "stays server-muted until -unstsu" : "is no longer force-muted"}.`);
}

async function runRankCommand(message, command, target, channelArgument) {
  if (!access.canUseRankCommand(message.member, command)) return denyRank(message, command);
  const named = String(channelArgument || "").trim();
  const requiresUser = ["follow", "chain", "bring", "stsu", "stfu", "unstsu", "unstfu"].includes(command);
  const optionalUser = ["godmode", "ungodmode", "shield", "unshield", "inspect", "voicehistory"].includes(command);
  if (requiresUser && !target) return replyUsage(message, usageKey(command));
  if (named && optionalUser && !target) return replyUsage(message, usageKey(command));
  if (command === "forceownership") return takeOwnership(message, false);
  if (command === "forceclaim") return takeOwnership(message, true);
  if (command === "voiceoverride") return voiceOverride(message);
  if (command === "dragall") return dragAll(message, channelArgument);
  if (command === "vchistory") return channelHistory(message, channelArgument);
  if (command === "voicehistory") return voiceHistory(message, named ? target?.id : null);
  if (command === "godmode" || command === "ungodmode") {
    const user = target || message.member;
    return setVoiceFlag(message, user, "godmode", command === "godmode", command === "godmode" ? "Voice Godmode" : "Voice Godmode Cleared");
  }
  if (command === "shield" || command === "unshield") {
    const user = target || message.member;
    return setVoiceFlag(message, user, "shield", command === "shield", command === "shield" ? "Shielded" : "Shield Removed");
  }
  if (command === "muteall") return muteChannel(message, true);
  if (command === "unmuteall") return muteChannel(message, false, channelArgument);
  if (command === "follow") return follow(message, target, false);
  if (command === "chain") return follow(message, target, true);
  if (command === "unfollow") {
    const removed = store.clearFollow(message.guild.id, message.author.id);
    return reply(message, "Unfollowed", removed ? "You are no longer following anyone." : "You were not following anyone.");
  }
  if (command === "bring") return bring(message, target);
  if (command === "inspect") return inspect(message, target);
  if (command === "stsu" || command === "stfu") return stsu(message, target, true);
  if (command === "unstsu" || command === "unstfu") return stsu(message, target, false);
  return null;
}

async function moveFollowers(guild, targetId, channelId, seen) {
  if (seen.has(targetId)) return;
  seen.add(targetId);
  for (const followerId of store.followersOf(guild.id, targetId)) {
    const token = guardKey(guild.id, followerId);
    const member = guild.members.cache.get(followerId);
    if (!member?.voice?.setChannel || member.voice.channelId === channelId) continue;
    await withGuard(token, async () => {
      await member.voice.setChannel(channelId, "Voice follow");
      await moveFollowers(guild, followerId, channelId, seen);
    }).catch((error) => console.error(`[follow] ${guild.id}:${followerId}`, error));
  }
}

function noteMuteAttempt(guildId, actorId) {
  const key = `${guildId}:${actorId}`;
  const now = Date.now();
  const recent = (muteAttempts.get(key) || []).filter((time) => now - time < 60000);
  recent.push(now);
  muteAttempts.set(key, recent);
  return recent.length;
}

async function findMuteActor(guild, targetId) {
  if (typeof guild.fetchAuditLogs !== "function") return null;
  const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberUpdate, limit: 6 }).catch(() => null);
  if (!logs?.entries) return null;
  const now = Date.now();
  for (const entry of logs.entries.values()) {
    if (String(entry.targetId) !== String(targetId)) continue;
    if (now - (entry.createdTimestamp || 0) > 20000) continue;
    const executorId = entry.executorId || entry.executor?.id;
    if (!executorId || executorId === guild.client?.user?.id) continue;
    const change = (entry.changes || []).find((item) => item.key === "mute" || item.key === "deaf");
    if (change && (change.new === true || change.new === "true")) return executorId;
  }
  return null;
}

async function punishMuteSpam(guild, actorId) {
  const member = guild.members.cache.get(actorId) || await guild.members.fetch(actorId).catch(() => null);
  if (!member || member.user?.bot) return;
  if (access.isServerOwner(member) || access.isBotOwner(member.id) || access.hasStaff(member, "god")) return;
  const roles = [...(member.roles?.cache?.values?.() || [])].filter((role) => {
    if (!role?.permissions?.has || role.managed || role.id === guild.id) return false;
    return role.permissions.has(PermissionFlagsBits.MuteMembers) || role.permissions.has(PermissionFlagsBits.DeafenMembers);
  });
  for (const role of roles) {
    try {
      if (typeof member.roles?.remove === "function") {
        await member.roles.remove(role.id, "Spam server-mute against voice godmode");
        continue;
      }
    } catch (error) {
      const wait = Math.min(5000, Math.round((Number(error?.retryAfter) || 1) * 1000));
      await sleep(wait);
      const removed = await member.roles.remove(role.id, "Spam server-mute against voice godmode").catch(() => null);
      if (removed) continue;
    }
    if (typeof role.setPermissions !== "function" && typeof role.edit !== "function") continue;
    const next = role.permissions?.remove?.(PermissionFlagsBits.MuteMembers, PermissionFlagsBits.DeafenMembers);
    if (!next) continue;
    await role.edit({ permissions: next, reason: "Disabled mute permissions after spam against voice godmode" }).catch(() => null);
  }
}

async function enforceVoice(oldState, newState) {
  const member = newState.member || oldState.member;
  const guild = newState.guild || oldState.guild;
  if (!member || !guild || member.user?.bot) return;
  const channelId = newState.channelId || null;
  store.saveGuard(guild.id, member.id, { lastChannelId: channelId || oldState.channelId || null });
  const summary = describeVoice(oldState, newState);
  if (summary) store.addHistory(guild.id, member.id, summary);
  recordCall(guild.id, member.id, oldState, newState);
  const guard = store.getGuard(guild.id, member.id);
  const token = guardKey(guild.id, member.id);
  if (guard) {
    await withGuard(token, async () => {
      if (guard.stfu && channelId && !newState.serverMute) {
        await setMuteSafe(member, true, "STSU");
      } else if ((guard.godmode || guard.shield) && channelId) {
        if (newState.serverMute) await setMuteSafe(member, false, "Voice protection");
        if (newState.serverDeaf && member.voice?.setDeaf) {
          try {
            await member.voice.setDeaf(false, "Voice protection");
          } catch (error) {
            const wait = Math.min(5000, Math.round((Number(error?.retryAfter) || 0) * 1000));
            if (wait) {
              await sleep(wait);
              await member.voice.setDeaf(false, "Voice protection").catch(() => null);
            }
          }
        }
        if (guard.godmode && newState.serverMute && !oldState.serverMute) {
          const actorId = await findMuteActor(guild, member.id);
          if (actorId && noteMuteAttempt(guild.id, actorId) >= 5) await punishMuteSpam(guild, actorId);
        }
      }
      if (guard.shield && !channelId && oldState.channelId && member.voice?.setChannel) {
        await member.voice.setChannel(oldState.channelId, "Shield");
      }
    }).catch((error) => console.error(`[voice guard] ${guild.id}:${member.id}`, error));
  }
  if (oldState.channelId !== newState.channelId && newState.channelId) {
    const lobbyId = db.getConfig(guild.id)?.j2c_channel_id;
    if (!lobbyId || String(newState.channelId) !== String(lobbyId)) {
      await moveFollowers(guild, member.id, newState.channelId, new Set());
    }
  }
  if (channelId && require("../protect").memberHasGodmode(member)) {
    if (newState.serverMute) await setMuteSafe(member, false, "Protection godmode");
    if (newState.serverDeaf && member.voice?.setDeaf) {
      try {
        await member.voice.setDeaf(false, "Protection godmode");
      } catch (error) {
        const wait = Math.min(5000, Math.round((Number(error?.retryAfter) || 0) * 1000));
        if (wait) {
          await sleep(wait);
          await member.voice.setDeaf(false, "Protection godmode").catch(() => null);
        }
      }
    }
  }
}

function recordCall(guildId, userId, before, after) {
  const left = before.channelId || null;
  const joined = after.channelId || null;
  if (!left && joined) {
    store.addCallEvent(guildId, joined, userId, "join");
    return;
  }
  if (left && !joined) {
    store.addCallEvent(guildId, left, userId, "leave");
    return;
  }
  if (left && joined && String(left) !== String(joined)) {
    store.addCallEvent(guildId, left, userId, "leave");
    store.addCallEvent(guildId, joined, userId, "join");
  }
}

function describeVoice(before, after) {
  if (!before.channelId && after.channelId) return `joined <#${after.channelId}>`;
  if (before.channelId && !after.channelId) return `left <#${before.channelId}>`;
  if (before.channelId && after.channelId && before.channelId !== after.channelId) {
    return `moved <#${before.channelId}> → <#${after.channelId}>`;
  }
  if (before.serverMute !== after.serverMute) return after.serverMute ? "server muted" : "server unmuted";
  if (before.serverDeaf !== after.serverDeaf) return after.serverDeaf ? "server deafened" : "server undeafened";
  return null;
}

async function lockdown(message, enabled) {
  if (!access.canUseChannels(message.member, enabled ? "lockdown" : "unlockdown")) {
    return reply(message, "Access Denied", "Founders, Gods, and the server owner can lock the server.");
  }
  const wait = cooldowns.consume(message.guild.id, message.author.id, enabled ? "lockdown" : "unlockdown");
  if (wait) return reply(message, "Please Wait", cooldowns.waitText(wait));
  const me = message.guild.members.me;
  if (me?.permissions && !me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return reply(message, "Bot Missing Permission", "I need Manage Channels to lock or unlock the server.");
  }
  if (!enabled) {
    const rows = store.listLockdown(message.guild.id);
    for (const row of rows) {
      const channel = message.guild.channels.cache.get(row.channel_id);
      if (!channel?.permissionOverwrites?.edit) continue;
      const data = row.kind === "voice" ? { Connect: null } : { SendMessages: null };
      await channel.permissionOverwrites.edit(message.guild.roles.everyone, data).catch(() => null);
    }
    store.clearLockdown(message.guild.id);
    return reply(message, "Lockdown Cleared", `Restored **${rows.length}** channel(s).`);
  }
  let count = 0;
  for (const channel of message.guild.channels.cache.values()) {
    const voice = channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice;
    const text = typeof channel.isTextBased === "function" && channel.isTextBased() && !voice;
    if (!voice && !text) continue;
    if (!channel.permissionOverwrites?.edit) continue;
    await channel.permissionOverwrites.edit(message.guild.roles.everyone, voice ? { Connect: false } : { SendMessages: false }).catch(() => null);
    store.addLockdown(message.guild.id, channel.id, voice ? "voice" : "text");
    count += 1;
  }
  return reply(message, "Server Locked", `Locked **${count}** channel(s). Use \`-unlockdown\` to clear it.`);
}

module.exports = { runRankCommand, enforceVoice, lockdown, describeVoice };
