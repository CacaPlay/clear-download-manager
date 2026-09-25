// Shared visual preference tokens. Keep these values free of DOM/runtime side
// effects so the main appearance surface and the download manager normalize
// the same persisted schema.
export const APPEARANCE_REVISION = 12;
export const ICON_COLOR_MODE_ACCENT = 'accent';
export const ICON_COLOR_MODE_CUSTOM = 'custom';
export const ICON_COLOR_MODES = Object.freeze([ICON_COLOR_MODE_ACCENT, ICON_COLOR_MODE_CUSTOM]);
export const DEFAULT_ICON_COLOR = '#596574';
export const PREVIOUS_DEFAULT_ICON_COLOR = '#596574';
export const DEFAULT_ICON_COLOR_MODE = ICON_COLOR_MODE_ACCENT;
export const DEFAULT_PROGRESS_ACTIVE_COLOR = '#00ff2a';
export const DEFAULT_PROGRESS_COMPLETED_COLOR = '#00ff2a';
export const DEFAULT_PROGRESS_PAUSED_COLOR = '#e2a93f';
export const DEFAULT_PROGRESS_ERROR_COLOR = '#ef6674';

export function isHexColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || ''));
}

export function normalizeIconColorMode(value) {
  return ICON_COLOR_MODES.includes(String(value || '')) ? String(value) : DEFAULT_ICON_COLOR_MODE;
}
