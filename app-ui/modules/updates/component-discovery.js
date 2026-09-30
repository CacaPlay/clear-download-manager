export function createComponentDiscoveryScheduler({
  check,
  isOnline = () => true,
  setIntervalFn = (callback, delay) => window.setInterval(callback, delay),
  clearIntervalFn = (handle) => window.clearInterval(handle),
  addOnlineListener = (listener) => window.addEventListener('online', listener),
  removeOnlineListener = (listener) => window.removeEventListener('online', listener),
  intervalMs = 15 * 60 * 1000,
  initialBackoffMs = 30 * 1000,
  maxBackoffMs = 15 * 60 * 1000,
  now = () => Date.now()
} = {}) {
  if (typeof check !== 'function') throw new TypeError('component catalog check is required');
  let timer = null;
  let inFlight = null;
  let disposed = false;
  let failures = 0;
  let retryAt = 0;

  function run({ force = false } = {}) {
    if (disposed || !isOnline()) return Promise.resolve(null);
    if (inFlight) return inFlight;
    if (!force && now() < retryAt) return Promise.resolve(null);
    let request;
    try { request = Promise.resolve(check()); }
    catch (error) { request = Promise.reject(error); }
    inFlight = request.then((value) => {
      failures = 0; retryAt = 0; return value;
    }).catch((error) => {
      failures += 1;
      retryAt = now() + Math.min(maxBackoffMs, initialBackoffMs * (2 ** Math.min(failures - 1, 8)));
      throw error;
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  const onOnline = () => run({ force: true }).catch(() => null);
  function start() {
    if (disposed || timer !== null) return false;
    addOnlineListener(onOnline);
    timer = setIntervalFn(() => { void run().catch(() => {}); }, intervalMs);
    void run().catch(() => {});
    return true;
  }
  function stop() {
    if (disposed) return;
    disposed = true;
    if (timer !== null) clearIntervalFn(timer);
    timer = null;
    removeOnlineListener(onOnline);
  }
  return Object.freeze({ start, stop, checkNow: () => run({ force: true }), isRunning: () => timer !== null && !disposed });
}
