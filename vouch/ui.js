const { EmbedBuilder } = require("discord.js");
const { ACCENT } = require("./constants");

function embed(title, description) {
  return new EmbedBuilder().setColor(ACCENT).setTitle(title).setDescription(String(description || "").slice(0, 4000));
}

function reply(message, title, description) {
  return message.reply({ embeds: [embed(title, description)] });
}

function result(ok, title, description) {
  return { ok, title, description };
}

module.exports = { embed, reply, result };
