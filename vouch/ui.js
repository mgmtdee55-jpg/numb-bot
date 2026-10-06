const { EmbedBuilder } = require("discord.js");
const { ACCENT } = require("./constants");
const { present } = require("../feedback");

function embed(title, description, options) {
  const plain = options === true || options?.plain;
  const body = plain
    ? String(description || "").slice(0, 4000)
    : present(title, description, { guild: options?.guild, tone: options?.tone });
  return new EmbedBuilder().setColor(ACCENT).setTitle(title).setDescription(body);
}

function reply(message, title, description, tone) {
  return message.reply({ embeds: [embed(title, description, { guild: message.guild, tone })] });
}

function result(ok, title, description) {
  return { ok, title, description };
}

module.exports = { embed, reply, result };
