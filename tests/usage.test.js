const assert = require("node:assert/strict");
const test = require("node:test");
const { usageEmbed, usagePayload, handleInteraction, GROUPS, SPECS } = require("../usage");

test("ban usage matches the command card", () => {
  const message = {
    author: {
      username: "y.dm",
      displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/0.png"
    }
  };
  const data = usageEmbed(message, SPECS.ban).data;
  assert.equal(data.color, 0x2b2d31);
  assert.equal(data.author.name, "y.dm");
  assert.equal(data.author.icon_url, "https://cdn.discordapp.com/embed/avatars/0.png");
  assert.equal(data.title, undefined);
  assert.match(data.description, /^\*\*Command:\*\* ban\nBan a user from the server\.\n\n\*\*Permissions\*\*\nBan Members\n\n\*\*How To Use\*\*\n```ansi\n/);
  assert.match(data.description, /Syntax:\u001b\[0m \u001b\[2;32mban \(user\) \[\$days\] \[reason\] \[\$silent\]/);
  assert.match(data.description, /Example:\u001b\[0m \u001b\[2;32mban @user \$7 spamming in chat/);
  assert.equal(data.footer.text, "Command 1/9");
  assert.doesNotMatch(data.description, /<:|confirm|error/);
});

test("usage buttons page only the selected command and stay with who opened them", async () => {
  const message = { author: { id: "111", username: "y.dm" } };
  const first = usagePayload(message, "godmode", "111");
  assert.match(first.embeds[0].data.description, /\*\*Command:\*\* godmode/);
  assert.equal(first.embeds[0].data.footer.text, "Command 1/2");
  const nextId = first.components[0].components[1].data.custom_id;
  const interaction = {
    customId: nextId,
    user: { id: "111", username: "y.dm" },
    async update(payload) { this.updated = payload; }
  };
  assert.equal(await handleInteraction(interaction), true);
  assert.match(interaction.updated.embeds[0].data.description, /\*\*Command:\*\* ungodmode/);
  assert.equal(interaction.updated.embeds[0].data.footer.text, "Command 2/2");

  const stranger = {
    customId: nextId,
    user: { id: "222", username: "other" },
    async reply(payload) { this.repliedWith = payload; },
    async update(payload) { this.updated = payload; }
  };
  assert.equal(await handleInteraction(stranger), true);
  assert.equal(stranger.updated, undefined);
  assert.match(stranger.repliedWith.embeds[0].data.description, /Not Yours/);

  assert.equal(GROUPS.antinukevouch.length, 13);
  const vouch = usagePayload(message, "antinukevouch", "111");
  assert.equal(vouch.embeds[0].data.footer.text, "Command 1/13");
  assert.equal(vouch.components[0].components.length, 3);
});
