const assert = require("node:assert/strict");
const test = require("node:test");
const { usageEmbed, SPECS } = require("../usage");

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
  assert.match(data.description, /^\*\*Command:\*\* ban\nBan a user from the server\.\n\n\*\*How To Use\*\*\n```ansi\n/);
  assert.match(data.description, /Syntax:\u001b\[0m \u001b\[2;32mban \(user\) \[\$days\] \[reason\] \[\$silent\]/);
  assert.match(data.description, /Example:\u001b\[0m \u001b\[2;32mban @user \$7 spamming in chat/);
  assert.doesNotMatch(data.description, /<:|confirm|error/);
});
