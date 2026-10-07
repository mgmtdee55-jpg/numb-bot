const db = require("./db");
const access = require("./systems/access");
const { reply } = require("./vouch/ui");

function canPlace(member) {
  return access.isServerOwner(member) || access.isBotOwner(member?.id) || access.isGod(member);
}

function canLift(member, record) {
  if (!record) return true;
  if (access.isServerOwner(member)) return true;
  return String(record.banner_id) === String(member?.id);
}

function discordReason(record) {
  return `Personal ban from ${record.banner_id}. Contact them to unban them.`.slice(0, 500);
}

function publicReason(record) {
  return `Personal ban from <@${record.banner_id}>. Contact <@${record.banner_id}> to unban them.`;
}

async function place(message, userId, user) {
  if (!canPlace(message.member)) {
    return reply(message, "Access Denied", "Only Gods and the server owner can place a personal ban.");
  }
  if (!userId) return reply(message, "Usage", "`-pban @user`");
  if (userId === message.guild.ownerId) {
    return reply(message, "Unable to Ban", "The server owner cannot be personally banned.");
  }
  if (userId === message.author.id) {
    return reply(message, "Unable to Ban", "You cannot personally ban yourself.");
  }
  const record = {
    guild_id: message.guild.id,
    user_id: userId,
    banner_id: message.author.id,
    created_at: Date.now(),
    username: user?.username || user?.user?.username || null
  };
  db.addPersonalBan(record);
  try {
    await message.guild.members.ban(userId, { deleteMessageSeconds: 0, reason: discordReason(record) });
  } catch (error) {
    db.removePersonalBan(message.guild.id, userId);
    return reply(message, "Unable to Ban", "Discord rejected that ban. I need the Ban Members permission.");
  }
  return reply(message, "Personal Ban", `<@${userId}> is personally banned.\n${publicReason(record)}\n\nOnly <@${message.author.id}> or the server owner can lift it. Any other unban is put back.`);
}

async function restore(ban) {
  const record = db.getPersonalBan(ban.guild.id, ban.user.id);
  if (!record) return;
  await ban.guild.members.ban(ban.user.id, {
    deleteMessageSeconds: 0,
    reason: discordReason(record)
  }).catch((error) => {
    console.error(`[personal ban restore] ${ban.guild.id}:${ban.user.id}`, error);
  });
}

async function enforce(member) {
  const record = db.getPersonalBan(member.guild.id, member.id);
  if (!record) return;
  await member.guild.members.ban(member.id, {
    deleteMessageSeconds: 0,
    reason: discordReason(record)
  }).catch((error) => {
    console.error(`[personal ban join] ${member.guild.id}:${member.id}`, error);
  });
}

function refusal(message, userId) {
  const record = db.getPersonalBan(message.guild.id, userId);
  if (!record || canLift(message.member, record)) return null;
  return reply(
    message,
    "Personal Ban",
    `${publicReason(record)}\n\nOnly the person who banned them or the server owner can lift it.`
  );
}

function liftIfAllowed(message, userId) {
  const record = db.getPersonalBan(message.guild.id, userId);
  if (!record) return true;
  if (!canLift(message.member, record)) return false;
  db.removePersonalBan(message.guild.id, userId);
  return true;
}

module.exports = {
  canPlace,
  canLift,
  publicReason,
  place,
  restore,
  enforce,
  refusal,
  liftIfAllowed
};
