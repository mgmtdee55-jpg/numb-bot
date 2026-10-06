const { EmbedBuilder } = require("discord.js");
const { ACCENT } = require("./constants");
const { card } = require("../feedback");

function embed(title, description, options) {
  const plain = options === true || options?.plain;
  if (plain) {
    return new EmbedBuilder().setColor(ACCENT).setTitle(title).setDescription(String(description || "").slice(0, 4000));
  }
  return card(title, description, { guild: options?.guild, tone: options?.tone });
}

function reply(message, title, description, tone) {
  return message.reply({ embeds: [embed(title, description, { guild: message.guild, tone })] });
}

function result(ok, title, description) {
  return { ok, title, description };
}

module.exports = { embed, reply, result };
