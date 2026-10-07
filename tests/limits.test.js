const assert = require("node:assert/strict");
const test = require("node:test");

const cooldowns = require("../systems/cooldowns");
const profiles = require("../profiles");

const PAGE = `{"xig_user_by_igid_v2":{"full_name":"slimeballa","username":"igotblue100s","biography":"hi","follower_count":921,"following_count":152,"profile_pic_url":"https://cdn.example/a.jpg","is_private":true}}`;

function message(id) {
  return {
    guild: { id: "limits-guild" },
    author: { id },
    replies: [],
    async reply(payload) {
      this.replies.push(payload);
      return payload;
    }
  };
}

function titleOf(record) {
  const data = record.replies.at(-1).embeds[0].data;
  if (data.title) return data.title;
  const match = String(data.description || "").match(/\*\*([^*]+)\*\*/);
  return match ? match[1] : "";
}

test("everyday commands wait 2 seconds and longer staff cooldowns stay in charge", () => {
  cooldowns.clear();
  assert.equal(cooldowns.commandPause("g", "u", "nuke", 1000), 0);
  assert.equal(cooldowns.commandPause("g", "u", "help", 1000), 0);
  assert.ok(cooldowns.commandPause("g", "u", "help", 1500) >= 1000);
  assert.equal(cooldowns.commandPause("g", "u", "avatar", 1500), 0);
  assert.equal(cooldowns.commandPause("g", "owner", "help", 1500), 0);
});

test("profile lookups keep the longer 10 second gap and reuse a cached profile", () => {
  cooldowns.clear();
  assert.equal(cooldowns.lookupPause("g", "u", "ig", false, 0), 0);
  const again = cooldowns.lookupPause("g", "u", "instagram", false, 1000);
  assert.ok(again >= 8000);
  assert.equal(cooldowns.lookupPause("g", "u", "tiktok", true, 3000), 0);
  assert.ok(cooldowns.lookupPause("g", "u", "tiktok", true, 3500) > 0);
});

test("instagram downloads once at a time, retries one slowdown, and remembers the profile", async () => {
  profiles.resetLookups();
  const original = global.fetch;
  let active = 0;
  let max = 0;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    active += 1;
    max = Math.max(max, active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active -= 1;
    if (calls === 1) {
      return { ok: false, status: 429, headers: { get: () => "0.05" }, text: async () => "" };
    }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => PAGE };
  };
  try {
    const first = message("user-a");
    const second = message("user-b");
    await Promise.all([
      profiles.instagram(first, "igotblue100s"),
      profiles.instagram(second, "igotblue100s")
    ]);
    assert.equal(titleOf(first), "slimeballa");
    assert.equal(titleOf(second), "slimeballa");
    assert.match(first.replies[0].embeds[0].data.description, /Private/);
    assert.equal(max, 1);
    assert.equal(calls, 2);

    const before = calls;
    cooldowns.clear();
    const repeat = message("user-a");
    await profiles.instagram(repeat, "igotblue100s");
    assert.equal(calls, before);
    assert.equal(titleOf(repeat), "slimeballa");
  } finally {
    global.fetch = original;
    profiles.resetLookups();
  }
});

test("roblox lookups run four at a time and the rest wait", async () => {
  profiles.resetLookups();
  let active = 0;
  let max = 0;
  await Promise.all(Array.from({ length: 6 }, () => profiles.schedule("roblox", async () => {
    active += 1;
    max = Math.max(max, active);
    await new Promise((resolve) => setTimeout(resolve, 40));
    active -= 1;
    return true;
  })));
  assert.equal(max, 4);
  profiles.resetLookups();
});
