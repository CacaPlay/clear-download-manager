const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export const DEFAULT_ACCENT = '#24b8e8';
export const DEFAULT_ICON_COLOR = '#596574';
export const DEFAULT_PROGRESS = Object.freeze({
  progressActive: '#00ff2a',
  progressCompleted: '#00ff2a',
  progressPaused: '#e2a93f',
  progressError: '#ef6674'
});

export const ICON_VARIANTS = Object.freeze(['rojo', 'naranja', 'verde', 'celeste', 'azul', 'morado']);

export function isHexColor(value) {
  return HEX_COLOR.test(String(value || ''));
}

function hexRgb(value, fallback = DEFAULT_ACCENT) {
  const source = isHexColor(value) ? String(value) : fallback;
  const clean = source.slice(1);
  return [0, 2, 4].map((index) => Number.parseInt(clean.slice(index, index + 2), 16));
}

export function relativeLuminance(value) {
  return hexRgb(value).map((channel) => {
    const normalized = channel / 255;
    return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

export function contrastRatio(first, second) {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

export function blendHex(first, second, amount) {
  const a = hexRgb(first);
  const b = hexRgb(second);
  const ratio = Math.max(0, Math.min(1, Number(amount) || 0));
  return `#${a.map((channel, index) => Math.round(channel * (1 - ratio) + b[index] * ratio).toString(16).padStart(2, '0')).join('')}`;
}

export function accentPresentation(accent, theme = 'dark') {
  const luminance = relativeLuminance(accent);
  const ink = contrastRatio(accent, '#07111d') >= contrastRatio(accent, '#ffffff') ? '#07111d' : '#ffffff';
  const detail = theme === 'light' && luminance > .34
    ? blendHex(accent, '#07111d', .58)
    : theme === 'dark' && luminance < .12
      ? blendHex(accent, '#ffffff', .46)
      : accent;
  return { ink, detail };
}

export function effectiveAccent(accent, intensity, theme = 'dark') {
  return blendHex(theme === 'light' ? '#ffffff' : '#07111d', accent, Math.max(0, Math.min(100, Number(intensity) || 82)) / 100);
}

function hueForColor(value) {
  const [red, green, blue] = hexRgb(value).map((channel) => channel / 255);
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  if (!delta) return 0;
  let hue = maximum === red
    ? 60 * (((green - blue) / delta) % 6)
    : maximum === green
      ? 60 * ((blue - red) / delta + 2)
      : 60 * ((red - green) / delta + 4);
  if (hue < 0) hue += 360;
  return hue;
}

export function iconVariantForColor(value) {
  const hue = hueForColor(value);
  if (hue < 20 || hue >= 335) return 'rojo';
  if (hue < 75) return 'naranja';
  if (hue < 170) return 'verde';
  if (hue < 205) return 'celeste';
  if (hue < 245) return 'azul';
  return 'morado';
}

export function iconAccentForAppearance(appearance = {}, theme = 'dark') {
  const accent = effectiveAccent(appearance.accent || DEFAULT_ACCENT, appearance.intensity, theme);
  return appearance.iconColorMode === 'custom' && isHexColor(appearance.iconColor)
    ? String(appearance.iconColor)
    : accent;
}

export function progressPalette(appearance = {}) {
  const values = {};
  for (const [key, fallback] of Object.entries(DEFAULT_PROGRESS)) {
    values[key] = isHexColor(appearance[key]) ? String(appearance[key]) : fallback;
  }
  return { ...values, synced: Object.keys(DEFAULT_PROGRESS).every((key) => isHexColor(appearance[key])) };
}

export function brandAssetPath(variant = 'celeste') {
  const safeVariant = ICON_VARIANTS.includes(String(variant)) ? String(variant) : 'celeste';
  return `assets/brand/clear-download-manager-${safeVariant}.png`;
}

