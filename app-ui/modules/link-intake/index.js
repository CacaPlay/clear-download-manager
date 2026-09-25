/* Unified link intake primitives. No clipboard polling is used here: the
   watcher is driven only by a reasonable focus/visibility event. */

const PROMPT_PRIORITY = Object.freeze({ explicit: 100, clipboard: 70, update: 50, extension: 30, informational: 10 });

function promptPriority(value) {
  return typeof value === 'number' ? value : PROMPT_PRIORITY[String(value || 'informational')] || 0;
}

export function createPromptCoordinator({ onPresent } = {}) {
  const queue = [];
  const dismissedCurrentSession = new Set();
  let active = null;
  let presenting = false;

  const presentNext = async () => {
    if (presenting || active || !queue.length) return;
    queue.sort((left, right) => right.priority - left.priority || left.createdAt - right.createdAt);
    active = queue.shift();
    presenting = true;
    try {
      await onPresent?.(active);
    } finally {
      presenting = false;
      active = null;
      void presentNext();
    }
  };

  return {
    enqueue(request = {}) {
      const dedupeKey = String(request.dedupeKey || `${request.kind || 'prompt'}:${request.id || ''}`);
      if (dismissedCurrentSession.has(dedupeKey) || active?.dedupeKey === dedupeKey || queue.some((item) => item.dedupeKey === dedupeKey)) return false;
      queue.push({ ...request, dedupeKey, priority: promptPriority(request.priority), createdAt: Date.now() });
      void presentNext();
      return true;
    },
    dismissCurrent() {
      if (active?.dedupeKey) dismissedCurrentSession.add(active.dedupeKey);
      active = null;
    },
    dismiss(dedupeKey) {
      const key = String(dedupeKey || '');
      if (key) dismissedCurrentSession.add(key);
      for (let index = queue.length - 1; index >= 0; index -= 1) if (queue[index].dedupeKey === key) queue.splice(index, 1);
      if (active?.dedupeKey === key) active = null;
    },
    clear() {
      queue.splice(0, queue.length);
      active = null;
    },
    getState() {
      return { active: active ? { ...active } : null, queued: queue.map((item) => ({ ...item })), presenting };
    }
  };
}

export function createClipboardFocusWatcher({
  enabled = () => true,
  onUrl,
  coordinator = createPromptCoordinator(),
  readClipboard = async () => '',
  focusDebounceMs = 140
} = {}) {
  let focusTimer = 0;
  let pending = false;
  let lastSuggestedUrl = '';
  let lastObservedUrl = '';
  let started = false;

  const checkClipboard = async () => {
    if (pending || !enabled() || document.hidden || typeof readClipboard !== 'function') return;
    pending = true;
    try {
      const value = String(await readClipboard()).trim();
      if (!/^https?:\/\//i.test(value) || value === lastObservedUrl) return;
      // The app-level router may handle a direct HTTP file immediately. A
      // false result means there is deliberately no preview modal to enqueue.
      const routeResult = await onUrl?.(value);
      // Suppress this clipboard value even when another automatic prompt is
      // occupying the coordinator. A focus bounce must not replay it.
      lastObservedUrl = value;
      if (routeResult === false) {
        lastSuggestedUrl = value;
        return;
      }
      const accepted = coordinator.enqueue({
        kind: 'clipboard-link',
        priority: 'clipboard',
        dedupeKey: `clipboard:${value}`,
        payload: { url: value, ...(routeResult && typeof routeResult === 'object' ? routeResult : {}) },
        onDismiss: () => {}
      });
      // A URL is consumed only after the coordinator accepted the request.
      // If a prompt is already active/queued or the session dismissed it,
      // keep the value available for the next valid presentation opportunity.
      if (accepted) lastSuggestedUrl = value;
    } catch {
      // Clipboard access is optional and may be denied by WebView2 focus rules.
    } finally {
      pending = false;
    }
  };

  const onFocus = () => {
    window.clearTimeout(focusTimer);
    focusTimer = window.setTimeout(() => { void checkClipboard(); }, focusDebounceMs);
  };

  return {
    start() {
      if (started) return;
      started = true;
      window.addEventListener('focus', onFocus);
      document.addEventListener('visibilitychange', onFocus);
    },
    stop() {
      if (!started) return;
      started = false;
      window.clearTimeout(focusTimer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    },
    checkNow: checkClipboard,
    notifyFocus: onFocus,
    coordinator,
    getState: () => ({ pending, lastSuggestedUrl, lastObservedUrl })
  };
}
