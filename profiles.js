const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");
const { ACCENT } = require("./vouch/constants");
const { reply } = require("./vouch/ui");

function cleanInstagram(value) {
  return String(value || "").trim().replace(/^@/, "").replace(/\/+$/, "");
}

function cleanRoblox(value) {
  return String(value || "").trim().replace(/^@/, "");
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

function profileButton(url, label) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url)
  );
}

function instagramEmbed(profile) {
  const url = `https://instagram.com/${profile.username}`;
  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(profile.name || profile.username)
    .setURL(url)
    .setDescription([
      `@${profile.username}`,
      "",
      "**Social**",
      `Followers: ${profile.followers}`,
      `Following: ${profile.following}`,
      profile.posts == null ? null : `Posts: ${profile.posts}`,
      profile.bio ? `\n${profile.bio}` : null
    ].filter((line) => line != null).join("\n").slice(0, 4000));
  if (profile.avatar) embed.setThumbnail(profile.avatar);
  return { embeds: [embed], components: [profileButton(url, "View Profile")] };
}

function robloxEmbed(profile) {
  const url = `https://www.roblox.com/users/${profile.id}/profile`;
  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(`${profile.display} (@${profile.username})`)
    .setURL(url)
    .setDescription([
      `Created ${profile.createdLabel} (${profile.ago})`,
      "",
      "**Information**",
      `Display: ${profile.display}`,
      `Username: @${profile.username}`,
      `Status: ${profile.status}`,
      "",
      "**Social**",
      `Friends: ${profile.friends}`,
      `Followers: ${profile.followers}`,
      `Following: ${profile.following}`,
      `Groups: ${profile.groups}`,
      "",
      `User ID: ${profile.id}`
    ].join("\n"));
  if (profile.avatar) embed.setThumbnail(profile.avatar);
  return { embeds: [embed], components: [profileButton(url, "View Profile")] };
}

async function readJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

async function loadInstagram(username) {
  const data = await readJson(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "X-IG-App-ID": "936619743392459"
    }
  });
  const user = data?.data?.user;
  if (!user) throw new Error("missing");
  return {
    username: user.username || username,
    name: user.full_name || user.username || username,
    followers: user.edge_followed_by?.count ?? 0,
    following: user.edge_follow?.count ?? 0,
    posts: user.edge_owner_to_timeline_media?.count ?? null,
    bio: user.biography || "",
    avatar: user.profile_pic_url_hd || user.profile_pic_url || null
  };
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
  try {
    const profile = await loadInstagram(username);
    return message.reply(instagramEmbed(profile));
  } catch (error) {
    return reply(message, "Instagram Unavailable", `I could not load **@${username}**. The profile may be private, missing, or blocked.`);
  }
}

async function roblox(message, raw) {
  const username = cleanRoblox(raw);
  if (!/^[A-Za-z0-9_]{2,20}$/.test(username)) {
    return reply(message, "Usage", "`-roblox <username>`");
  }
  try {
    const profile = await loadRoblox(username);
    return message.reply(robloxEmbed(profile));
  } catch (error) {
    return reply(message, "Roblox Unavailable", `I could not load **${username}**.`);
  }
}

module.exports = {
  instagram,
  roblox,
  instagramEmbed,
  robloxEmbed,
  yearsAgo,
  formatDate,
  cleanInstagram,
  cleanRoblox
};
