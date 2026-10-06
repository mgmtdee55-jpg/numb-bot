const recentErrors = new Map();
const ERROR_LOG_INTERVAL_MS = 30000;

function logThrottledError(key, label, error) {
  const now = Date.now();
  const recent = recentErrors.get(key);
  if (recent && now < recent.nextLogAt) {
    recent.suppressed += 1;
    return;
  }

  const suppressed = recent?.suppressed || 0;
  recentErrors.set(key, { nextLogAt: now + ERROR_LOG_INTERVAL_MS, suppressed: 0 });
  if (recentErrors.size > 1000) {
    const oldestKey = recentErrors.keys().next().value;
    recentErrors.delete(oldestKey);
  }
  if (suppressed) {
    console.error(label, error, `(suppressed ${suppressed} similar errors)`);
  } else {
    console.error(label, error);
  }
}

module.exports = { logThrottledError };
