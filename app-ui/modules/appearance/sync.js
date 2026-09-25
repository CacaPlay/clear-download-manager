const APPEARANCE_EVENT = 'appearance-changed';

export async function bindAppearanceSync({ getAppearance, onAppearance, onSystemTheme } = {}) {
  const media = window.matchMedia?.('(prefers-color-scheme: light)');
  const handleSystemTheme = () => {
    if (getAppearance?.()?.theme === 'system') onSystemTheme?.();
  };
  media?.addEventListener?.('change', handleSystemTheme);

  let releaseEvent = null;
  const listen = window.__TAURI__?.event?.listen;
  if (listen) {
    releaseEvent = await listen(APPEARANCE_EVENT, (event) => {
      const payload = event?.payload || {};
      const next = payload.appearance;
      if (!next || typeof next !== 'object') return;
      const currentRevision = Number(getAppearance?.()?.revision || 0);
      const revision = Number(payload.revision ?? next.revision ?? 0);
      if (revision > 0 && revision <= currentRevision) return;
      onAppearance?.(next, payload);
    });
  }

  return () => {
    media?.removeEventListener?.('change', handleSystemTheme);
    releaseEvent?.();
  };
}

export { APPEARANCE_EVENT };
