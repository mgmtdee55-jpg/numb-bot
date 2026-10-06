const locks = new Map();

async function withChannelLock(channelId, operation) {
  const previous = locks.get(channelId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });

  locks.set(channelId, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(channelId) === current) locks.delete(channelId);
  }
}

module.exports = { withChannelLock };
