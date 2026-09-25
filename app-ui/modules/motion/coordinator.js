/* Minimal document-motion coordinator.
 *
 * Motion is an enhancement around an already-synchronous UI update.  The
 * coordinator never owns application state, never queues interactions and
 * never changes a floating positioning root.  A second interaction simply
 * finishes the current visual transition and applies its update immediately.
 */

let activeTransition = null;
let transitionSequence = 0;
const themeTransitionLocks = new Map();

function root() {
  return document.documentElement;
}

export function motionMode() {
  return String(root()?.dataset?.motionMode || root()?.dataset?.motion || 'system').toLowerCase();
}

export function motionIsReduced() {
  const mode = motionMode();
  if (mode === 'off' || mode === 'reduced') return true;
  return mode === 'system' && (root()?.dataset?.reducedMotion === 'true'
    || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true);
}

export function motionIsEnabled() {
  return !motionIsReduced();
}

export function viewTransitionsSupported() {
  return typeof document?.startViewTransition === 'function';
}

function finishActiveTransition() {
  const current = activeTransition;
  if (!current) return;
  activeTransition = null;
  try { current.skipTransition?.(); } catch { /* WebView may reject a stale transition. */ }
}

/**
 * Runs a synchronous UI update through the View Transition API when present.
 * The update is always applied, even when the API is missing, rejects or is
 * already busy.  CSS state attributes remain the fallback authority.
 */
export function runDocumentTransition(update, { onFallback = null } = {}) {
  if (typeof update !== 'function') return Promise.resolve({ used: false, reason: 'invalid-update' });
  if (!motionIsEnabled() || !viewTransitionsSupported()) {
    try { update(); } finally { onFallback?.(); }
    return Promise.resolve({ used: false, reason: motionIsReduced() ? 'reduced' : 'unsupported' });
  }
  if (activeTransition) finishActiveTransition();
  const sequence = ++transitionSequence;
  let transition;
  try {
    transition = document.startViewTransition(() => update());
  } catch (error) {
    try { update(); } finally { onFallback?.(); }
    return Promise.resolve({ used: false, reason: 'exception', error });
  }
  activeTransition = transition;
  // WebView2 can reject any of these promises when a fast rerender or test
  // fixture skips a transition.  Attach handlers to every exposed promise so
  // a visual cancellation never becomes an unhandled page error.
  Promise.resolve(transition.updateCallbackDone).catch(() => {});
  Promise.resolve(transition.ready).catch(() => {});
  const settle = (reason) => {
    if (activeTransition === transition) activeTransition = null;
    return { used: true, sequence, reason };
  };
  return Promise.resolve(transition.finished)
    .then(() => settle('finished'))
    .catch((error) => {
      if (activeTransition === transition) activeTransition = null;
      // The DOM update already happened; a failed visual transition must not
      // roll it back or leave input blocked.
      onFallback?.();
      return { used: false, sequence, reason: 'rejected', error };
    });
}

let activeSettingsTransition = null;

/**
 * Settings category navigation has its own named surface so it cannot borrow
 * the document-level Main/Settings transition. The DOM update remains
 * synchronous from the application's point of view; this helper only wraps
 * the already-completed render in an interruptible visual transition.
 */
export function runSettingsCategoryTransition(update, direction = 'down') {
  if (typeof update !== 'function') return Promise.resolve({ used: false, reason: 'invalid-update' });
  const rootNode = root();
  const app = document.querySelector('#app');
  if (!motionIsEnabled() || !viewTransitionsSupported()) {
    try { update(); } finally {
      rootNode?.removeAttribute('data-settings-direction');
      rootNode?.removeAttribute('data-settings-transitioning');
    }
    return Promise.resolve({ used: false, reason: motionIsReduced() ? 'reduced' : 'unsupported' });
  }
  if (activeSettingsTransition) {
    try { activeSettingsTransition.skipTransition?.(); } catch { /* stale WebView transition */ }
    activeSettingsTransition = null;
  }
  rootNode.dataset.settingsDirection = direction === 'up' ? 'up' : 'down';
  rootNode.dataset.settingsTransitioning = 'true';
  let transition;
  try {
    transition = document.startViewTransition(() => update());
  } catch (error) {
    try { update(); } finally {
      rootNode.removeAttribute('data-settings-direction');
      rootNode.removeAttribute('data-settings-transitioning');
    }
    return Promise.resolve({ used: false, reason: 'exception', error });
  }
  activeSettingsTransition = transition;
  Promise.resolve(transition.updateCallbackDone).catch(() => {});
  Promise.resolve(transition.ready).catch(() => {});
  const cleanup = () => {
    if (activeSettingsTransition === transition) activeSettingsTransition = null;
    rootNode.removeAttribute('data-settings-direction');
    rootNode.removeAttribute('data-settings-transitioning');
    app?.removeAttribute('data-settings-transitioning');
  };
  return Promise.resolve(transition.finished)
    .then(() => { cleanup(); return { used: true, reason: 'finished' }; })
    .catch((error) => { cleanup(); return { used: false, reason: 'rejected', error }; });
}

function themeOrigin(trigger) {
  const rect = trigger?.getBoundingClientRect?.();
  if (!rect || rect.width <= 0 || rect.height <= 0 || !Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return null;
  return {
    x: `${Math.round(rect.left + rect.width / 2)}px`,
    y: `${Math.round(rect.top + rect.height / 2)}px`
  };
}

function lockThemeDescendantTransitions() {
  // The download workspace is mounted outside the legacy #app node and some
  // of its card rules carry their own important declarations. Inline locks
  // make the atomic phase authoritative for both existing and newly-rendered
  // descendants without changing their ordinary styles permanently.
  document.querySelectorAll('body *').forEach((node) => {
    if (!node?.style || themeTransitionLocks.has(node)) return;
    const previous = ['transition-property', 'transition-duration', 'transition-delay']
      .map((property) => ({
        property,
        value: node.style.getPropertyValue(property),
        priority: node.style.getPropertyPriority(property)
      }));
    themeTransitionLocks.set(node, previous);
    node.style.setProperty('transition-property', 'none', 'important');
    node.style.setProperty('transition-duration', '0s', 'important');
    node.style.setProperty('transition-delay', '0s', 'important');
  });
}

function restoreThemeDescendantTransitions() {
  themeTransitionLocks.forEach((previous, node) => {
    previous.forEach(({ property, value, priority }) => {
      if (value) node.style.setProperty(property, value, priority);
      else node.style.removeProperty(property);
    });
  });
  themeTransitionLocks.clear();
}

function cleanupTheme(rootNode, overlay) {
  restoreThemeDescendantTransitions();
  rootNode?.removeAttribute('data-theme-transitioning');
  rootNode?.removeAttribute('data-motion-theme-transition');
  rootNode?.style.removeProperty('--motion-theme-x');
  rootNode?.style.removeProperty('--motion-theme-y');
  overlay?.remove();
}

/**
 * Applies a theme update immediately and masks the multi-surface repaint with
 * a root View Transition or a short old-surface crossfade fallback.
 */
export function runThemeTransition(update, trigger = null) {
  if (typeof update !== 'function') return Promise.resolve({ used: false, reason: 'invalid-update' });
  const rootNode = root();
  if (!motionIsEnabled()) {
    update();
    return Promise.resolve({ used: false, reason: motionIsReduced() ? 'reduced' : 'disabled' });
  }
  const origin = themeOrigin(trigger);
  if (origin) {
    rootNode.style.setProperty('--motion-theme-x', origin.x);
    rootNode.style.setProperty('--motion-theme-y', origin.y);
  } else {
    rootNode.style.removeProperty('--motion-theme-x');
    rootNode.style.removeProperty('--motion-theme-y');
  }
  if (origin && viewTransitionsSupported() && !activeTransition) {
    // Set the suppression authority before View Transition captures its old
    // snapshot.  The previous implementation set it inside the update
    // callback, allowing descendant theme transitions to leak mixed frames
    // into the old snapshot.
    rootNode.dataset.themeTransitioning = 'true';
    lockThemeDescendantTransitions();
    let transition;
    try {
      transition = document.startViewTransition(() => {
        update();
        // A rerender may have replaced part of the workspace; lock those new
        // nodes before the new snapshot is presented.
        lockThemeDescendantTransitions();
      });
    } catch {
      // Fall through to the same opaque fallback used when the API is absent.
      // Updating without a cover would expose the descendant repaint.
      cleanupTheme(rootNode);
      transition = null;
    }
    if (transition) {
      activeTransition = transition;
      Promise.resolve(transition.updateCallbackDone).catch(() => {});
      Promise.resolve(transition.ready).catch(() => {});
      return Promise.resolve(transition.finished)
        .then(() => {
          if (activeTransition !== transition) return { used: true, reason: 'superseded' };
          activeTransition = null;
          cleanupTheme(rootNode);
          return { used: true, reason: 'finished' };
        })
        .catch((error) => {
          if (activeTransition !== transition) return { used: false, reason: 'superseded', error };
          activeTransition = null;
          cleanupTheme(rootNode);
          return { used: false, reason: 'rejected', error };
        });
    }
  }

  if (activeTransition) finishActiveTransition();
  let overlay = null;
  try {
    const bodyStyle = getComputedStyle(document.body);
    const rootStyle = getComputedStyle(rootNode);
    const bodyBackground = bodyStyle.backgroundColor;
    const oldBackground = bodyBackground && bodyBackground !== 'rgba(0, 0, 0, 0)'
      ? bodyBackground
      : rootStyle.getPropertyValue('--bg').trim() || '#07111f';
    overlay = document.createElement('div');
    overlay.className = `motion-theme-fallback-overlay ${origin ? 'is-radial' : 'is-crossfade'}`;
    overlay.style.background = oldBackground;
    if (origin) {
      overlay.style.setProperty('--motion-theme-x', origin.x);
      overlay.style.setProperty('--motion-theme-y', origin.y);
    }
    document.body.append(overlay);
    // Keep descendants frozen for the complete synchronous mutation phase.
    // The overlay owns the old surface while the DOM commits the new one.
    rootNode.dataset.themeTransitioning = 'true';
    lockThemeDescendantTransitions();
    update();
    lockThemeDescendantTransitions();
    requestAnimationFrame(() => overlay?.classList.add('is-revealing'));
  } catch {
    cleanupTheme(rootNode, overlay);
    update();
    return Promise.resolve({ used: false, reason: 'fallback-exception' });
  }
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      cleanupTheme(rootNode, overlay);
      resolve({ used: false, reason: 'fallback' });
    };
    overlay?.addEventListener('animationend', settle, { once: true });
    window.setTimeout(settle, 480);
  });
}

export function activeViewTransition() {
  return activeTransition;
}
