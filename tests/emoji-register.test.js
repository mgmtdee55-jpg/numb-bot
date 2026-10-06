const assert = require("node:assert/strict");
const test = require("node:test");
const { confirm, errorMark, loadEmojis } = require("../feedback");

test("startup copies the source images onto this bot and reuses them", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => Buffer.from("png")
  });
  const created = [];
  const client = {
    guilds: { cache: { values: () => [] } },
    application: {
      async fetch() {},
      emojis: {
        async fetch() {
          return new Map(created.map((emoji) => [emoji.id, emoji]));
        },
        async create({ name }) {
          const emoji = {
            id: name === "confirm" ? "9001" : "9002",
            name,
            toString() {
              return `<:${this.name}:${this.id}>`;
            }
          };
          created.push(emoji);
          return emoji;
        }
      }
    }
  };

  try {
    await loadEmojis(client);
    assert.equal(confirm(), "<:confirm:9001>");
    assert.equal(errorMark(), "<:error:9002>");
    await loadEmojis(client);
    assert.equal(created.length, 2);
  } finally {
    global.fetch = originalFetch;
  }
});
