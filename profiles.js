const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");
const { ACCENT } = require("./vouch/constants");
const { reply } = require("./vouch/ui");
const cooldowns = require("./systems/cooldowns");

const CACHE_MS = 120_000;
const LANES = { instagram: 1, tiktok: 1, roblox: 4 };
const cache = new Map();
const inflight = new Map();
const lanes = {
  instagram: { active: 0, queue: [] },
  tiktok: { active: 0, queue: [] },
  roblox: { active: 0, queue: [] }
};

const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const CRAWLER = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

function cleanInstagram(value) {
  return cleanHandle(value).replace(/^(instagram\.com|instagr\.am)\//i, "");
}

function cleanTikTok(value) {
  return cleanHandle(value).replace(/^tiktok\.com\//i, "");
}

function cleanRoblox(value) {
  return String(value || "").trim().replace(/^@/, "");
}

function cleanHandle(value) {
  let text = String(value || "").trim();
  text = text.replace(/^https?:\/\/(www\.)?/i, "");
  text = text.replace(/^@/, "");
  return text.split(/[/?#]/)[0];
}

function yearsAgo(date) {
  const created = new Date(date);
  if (Number.isNaN(created.getTime())) return "unknown";
  const days = Math.max(0, Math.floor((Date.now() - created.getTime()) / 86400000));
  const years = Math.floor(days / 365);
  if (years >= 1) return `${years} year${years === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months >= 1) return `${months} month${months === 1 ? "" : "s"} ago`;
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function formatDate(date) {
  const created = new Date(date);
  if (Number.isNaN(created.getTime())) return "Unknown";
  return created.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function count(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number.toLocaleString("en-US");
}

function profileButton(url) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("View Profile").setURL(url)
  );
}

function compactEmbed(profile, url, lines) {
  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(String(profile.name || profile.username).slice(0, 256))
    .setURL(url)
    .setDescription(lines.filter(Boolean).join("\n").slice(0, 500));
  if (profile.avatar) embed.setThumbnail(profile.avatar);
  return { embeds: [embed], components: [profileButton(url)] };
}

function instagramEmbed(profile) {
  const url = `https://www.instagram.com/${profile.username}/`;
  const marks = [profile.verified ? "Verified" : null, profile.private ? "Private" : null].filter(Boolean).join(" · ");
  const stats = [
    profile.followers == null ? null : `${count(profile.followers)} followers`,
    profile.following == null ? null : `${count(profile.following)} following`,
    profile.posts == null ? null : `${count(profile.posts)} posts`
  ].filter(Boolean).join(" · ");
  return compactEmbed(profile, url, [
    `@${profile.username}${marks ? ` · ${marks}` : ""}`,
    stats,
    profile.bio ? String(profile.bio).slice(0, 180) : null
  ]);
}

function tiktokEmbed(profile) {
  const url = `https://www.tiktok.com/@${profile.username}`;
  const marks = [profile.verified ? "Verified" : null, profile.private ? "Private" : null].filter(Boolean).join(" · ");
  const stats = [
    profile.followers == null ? null : `${count(profile.followers)} followers`,
    profile.following == null ? null : `${count(profile.following)} following`,
    profile.likes == null ? null : `${count(profile.likes)} likes`,
    profile.videos == null ? null : `${count(profile.videos)} videos`
  ].filter(Boolean).join(" · ");
  return compactEmbed(profile, url, [
    `@${profile.username}${marks ? ` · ${marks}` : ""}`,
    stats,
    profile.bio ? String(profile.bio).slice(0, 180) : null
  ]);
}

function robloxEmbed(profile) {
  const url = `https://www.roblox.com/users/${profile.id}/profile`;
  return compactEmbed(
    { ...profile, name: `${profile.display} (@${profile.username})` },
    url,
    [
      `Created ${profile.createdLabel} (${profile.ago}) · ${profile.status}`,
      `Friends ${count(profile.friends)} · Followers ${count(profile.followers)} · Following ${count(profile.following)} · Groups ${count(profile.groups)}`,
      `ID ${profile.id}`
    ]
  );
}

function extractObject(text, marker) {
  const at = String(text || "").indexOf(marker);
  if (at < 0) return null;
  const start = text.indexOf("{", at + marker.length - 1);
  if (start < 0) return null;
  let depth = 0;
  let quote = false;
  let escape = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === "\"") quote = false;
      continue;
    }
    if (char === "\"") quote = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function metaContent(html, property) {
  const match = String(html || "").match(new RegExp(`property="${property}" content="([^"]*)"`));
  if (!match) return "";
  return match[1]
    .replace(/&#064;/g, "@")
    .replace(/&#x2022;/g, "•")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function numbered(text, label) {
  const match = String(text || "").match(new RegExp(`([\\d,]+)\\s+${label}`, "i"));
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

function finite(value) {
  if (value == null || value === "") return null;
  const number = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}

function parseInstagramHtml(html, username) {
  const user = extractObject(html, "\"xig_user_by_igid_v2\":");
  const description = metaContent(html, "og:description");
  if (user?.username) {
    return {
      username: user.username,
      name: user.full_name || user.username,
      followers: finite(user.follower_count),
      following: finite(user.following_count),
      posts: numbered(description, "Posts"),
      bio: user.biography || "",
      avatar: user.profile_pic_url || metaContent(html, "og:image") || null,
      verified: !!user.is_verified,
      private: !!user.is_private
    };
  }
  const title = metaContent(html, "og:title");
  const followers = numbered(description, "Followers");
  if (followers == null && !title.toLowerCase().includes(String(username || "").toLowerCase())) return null;
  return {
    username,
    name: title.split("(")[0].trim() || username,
    followers,
    following: numbered(description, "Following"),
    posts: numbered(description, "Posts"),
    bio: "",
    avatar: metaContent(html, "og:image") || null,
    verified: false,
    private: /private/i.test(description)
  };
}

function parseTikTokHtml(html) {
  const info = extractObject(html, "\"userInfo\":");
  const user = info?.user;
  if (!user?.uniqueId) return null;
  const stats = info.stats || info.statsV2 || {};
  return {
    username: user.uniqueId,
    name: user.nickname || user.uniqueId,
    followers: finite(stats.followerCount),
    following: finite(stats.followingCount),
    likes: finite(stats.heartCount ?? stats.heart),
    videos: finite(stats.videoCount),
    bio: user.signature || "",
    avatar: user.avatarLarger || user.avatarMedium || user.avatarThumb || null,
    verified: !!user.verified,
    private: !!user.privateAccount || !!user.secret
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function retryDelay(response) {
  const header = response.headers?.get?.("retry-after");
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(15000, Math.ceil(seconds * 1000));
  return 2000;
}

async function request(url, options, retried = false) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
  if (response.status === 429 && !retried) {
    await sleep(retryDelay(response));
    return request(url, options, true);
  }
  if (!response.ok) {
    const error = new Error(String(response.status));
    error.status = response.status;
    throw error;
  }
  return response;
}

async function readText(url, userAgent) {
  const response = await request(url, {
    headers: { "User-Agent": userAgent, "Accept-Language": "en-US,en;q=0.9" }
  });
  return response.text();
}

async function readJson(url, options) {
  const response = await request(url, options || {});
  return response.json();
}

function cacheKey(site, username) {
  return `${site}:${String(username || "").toLowerCase()}`;
}

function cachedProfile(site, username) {
  const row = cache.get(cacheKey(site, username));
  if (!row) return null;
  if (row.expires <= Date.now()) {
    cache.delete(cacheKey(site, username));
    return null;
  }
  return row.profile;
}

function rememberProfile(site, username, profile) {
  cache.set(cacheKey(site, username), { expires: Date.now() + CACHE_MS, profile });
  if (cache.size <= 500) return;
  const now = Date.now();
  for (const [key, row] of cache) {
    if (row.expires <= now) cache.delete(key);
  }
}

function pump(site) {
  const lane = lanes[site];
  const limit = LANES[site];
  while (lane.active < limit && lane.queue.length) {
    const item = lane.queue.shift();
    lane.active += 1;
    Promise.resolve()
      .then(item.job)
      .then(item.resolve, item.reject)
      .finally(() => {
        lane.active -= 1;
        pump(site);
      });
  }
}

function schedule(site, job) {
  return new Promise((resolve, reject) => {
    lanes[site].queue.push({ job, resolve, reject });
    pump(site);
  });
}

function loadThrough(site, username, job) {
  const key = cacheKey(site, username);
  const saved = cachedProfile(site, username);
  if (saved) return Promise.resolve(saved);
  const pending = inflight.get(key);
  if (pending) return pending;
  const promise = schedule(site, async () => {
    const again = cachedProfile(site, username);
    if (again) return again;
    const profile = await job();
    rememberProfile(site, username, profile);
    return profile;
  }).finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

async function guarded(message, commandName, site, username, loader, present) {
  const wait = cooldowns.lookupPause(
    message.guild.id,
    message.author.id,
    commandName,
    !!cachedProfile(site, username) || inflight.has(cacheKey(site, username))
  );
  if (wait) return reply(message, "Please Wait", cooldowns.waitText(wait));
  try {
    const profile = await loadThrough(site, username, () => loader(username));
    return message.reply(present(profile));
  } catch {
    const label = site === "roblox" ? username : `@${username}`;
    const title = site === "instagram" ? "Instagram Unavailable" : site === "tiktok" ? "TikTok Unavailable" : "Roblox Unavailable";
    return reply(message, title, `I could not load **${label}**.`);
  }
}

async function loadInstagram(username) {
  let fallback = null;
  let slowed = false;
  for (const agent of [CRAWLER, BROWSER]) {
    if (slowed) break;
    try {
      const html = await readText(`https://www.instagram.com/${encodeURIComponent(username)}/`, agent);
      const profile = parseInstagramHtml(html, username);
      if (profile?.avatar || profile?.followers != null || profile?.bio) return profile;
      if (profile) fallback = profile;
    } catch (error) {
      if (error.status === 429) slowed = true;
    }
  }
  if (fallback) return fallback;
  throw new Error("missing");
}

async function loadTikTok(username) {
  const html = await readText(`https://www.tiktok.com/@${encodeURIComponent(username)}`, BROWSER);
  const profile = parseTikTokHtml(html);
  if (!profile) throw new Error("missing");
  return profile;
}

const ROBLOX_STATUS = { 0: "Offline", 1: "Online", 2: "In Game", 3: "In Studio" };

async function loadRoblox(username) {
  const search = await readJson(`https://users.roblox.com/v1/users/search?keyword=${encodeURIComponent(username)}&limit=10`);
  const match = (search.data || []).find((user) => user.name?.toLowerCase() === username.toLowerCase()) || search.data?.[0];
  if (!match?.id) throw new Error("missing");
  const [user, avatar, friends, followers, following, groups, presence] = await Promise.all([
    readJson(`https://users.roblox.com/v1/users/${match.id}`),
    readJson(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${match.id}&size=420x420&format=Png&isCircular=false`),
    readJson(`https://friends.roblox.com/v1/users/${match.id}/friends/count`).catch(() => ({ count: 0 })),
    readJson(`https://friends.roblox.com/v1/users/${match.id}/followers/count`).catch(() => ({ count: 0 })),
    readJson(`https://friends.roblox.com/v1/users/${match.id}/followings/count`).catch(() => ({ count: 0 })),
    readJson(`https://groups.roblox.com/v1/users/${match.id}/groups/roles`).catch(() => ({ data: [] })),
    readJson("https://presence.roblox.com/v1/presence/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userIds: [match.id] })
    }).catch(() => null)
  ]);
  const statusCode = presence?.userPresences?.[0]?.userPresenceType;
  return {
    id: user.id,
    display: user.displayName || user.name,
    username: user.name,
    createdLabel: formatDate(user.created),
    ago: yearsAgo(user.created),
    status: ROBLOX_STATUS[statusCode] || "Offline",
    friends: friends.count ?? 0,
    followers: followers.count ?? 0,
    following: following.count ?? 0,
    groups: Array.isArray(groups.data) ? groups.data.length : 0,
    avatar: avatar.data?.[0]?.imageUrl || null
  };
}

async function instagram(message, raw) {
  const username = cleanInstagram(raw);
  if (!/^[A-Za-z0-9._]{1,30}$/.test(username)) {
    return reply(message, "Usage", "`-instagram <username>`\nAliases: `-ig` and `-insta`.");
  }
  return guarded(message, "instagram", "instagram", username, loadInstagram, instagramEmbed);
}

async function tiktok(message, raw) {
  const username = cleanTikTok(raw);
  if (!/^[A-Za-z0-9._]{2,24}$/.test(username)) {
    return reply(message, "Usage", "`-tiktok <username>`");
  }
  return guarded(message, "tiktok", "tiktok", username, loadTikTok, tiktokEmbed);
}

async function roblox(message, raw) {
  const username = cleanRoblox(raw);
  if (!/^[A-Za-z0-9_]{2,20}$/.test(username)) {
    return reply(message, "Usage", "`-roblox <username>`");
  }
  return guarded(message, "roblox", "roblox", username, loadRoblox, robloxEmbed);
}

module.exports = {
  instagram,
  tiktok,
  roblox,
  instagramEmbed,
  tiktokEmbed,
  robloxEmbed,
  parseInstagramHtml,
  parseTikTokHtml,
  yearsAgo,
  formatDate,
  cleanInstagram,
  cleanTikTok,
  cleanRoblox,
  schedule,
  laneActive: (site) => lanes[site].active,
  resetLookups() {
    cache.clear();
    inflight.clear();
    for (const lane of Object.values(lanes)) {
      lane.active = 0;
      lane.queue = [];
    }
    cooldowns.clear();
  }
};
