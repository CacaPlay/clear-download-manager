const ICON_PATHS = Object.freeze({
  home: '<path d="M3.5 11.2 12 4l8.5 7.2"/><path d="M5.5 10.5V20h13v-9.5"/><path d="M9.5 20v-6h5v6"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 20h16"/>',
  queue: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  history: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 4v4.5h4.5M12 8v5l3 2"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
  heart: '<path d="M20.8 8.8c0 5.5-8.8 10.4-8.8 10.4S3.2 14.3 3.2 8.8A4.8 4.8 0 0 1 12 6.2a4.8 4.8 0 0 1 8.8 2.6Z"/>',
  folder: '<path d="M3 7h7l2 2h9v10H3z"/><path d="M3 7V5h7l2 2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16.5 8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21h-4v-.2A1.7 1.7 0 0 0 9 19.2a1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14v-4a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3h4a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9A1.7 1.7 0 0 0 21 10v4a1.7 1.7 0 0 0-1.6 1Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m16.2 16.2 4.3 4.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.1.1l2-2A5 5 0 0 0 12 4l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1"/>',
  clipboard: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4.5V3h6v1.5M9 8h6M9 12h6M9 16h4"/>',
  scissors: '<circle cx="6" cy="7" r="3"/><circle cx="6" cy="17" r="3"/><path d="m8.5 8.5 10 7M8.5 15.5l10-7"/>',
  magnet: '<path d="M6 4v8a6 6 0 0 0 12 0V4"/><path d="M6 8h4M14 8h4"/>',
  more: '<circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  play: '<path d="m9 6 9 6-9 6z"/>',
  x: '<path d="m7 7 10 10M17 7 7 17"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 4v16M8 10h13"/>',
  moon: '<path d="M20 15.5A8 8 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  collapse: '<path d="m9 8-4 4 4 4M15 8l4 4-4 4"/>',
  retry: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
  sparkles: '<path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2zM18.5 14l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8zM5.5 14l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12 16h5"/>',
  file: '<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5"/>',
  edit: '<path d="m4 16.5-.8 4.3 4.3-.8L19 8.5 15.5 5z"/><path d="m13.8 6.7 3.5 3.5"/>',
  eye: '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/>',
  shield: '<path d="M12 3 20 6v6c0 5-3.4 8.2-8 10-4.6-1.8-8-5-8-10V6z"/><path d="m8.5 12 2.2 2.2 4.8-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18h1.2a1.8 1.8 0 0 0 0-3.6h-.8a1.6 1.6 0 0 1 0-3.2H15a6 6 0 0 0 0-12z"/><circle cx="7.5" cy="10" r=".8" fill="currentColor"/><circle cx="9.5" cy="6.8" r=".8" fill="currentColor"/><circle cx="14" cy="6.5" r=".8" fill="currentColor"/><circle cx="17" cy="9.5" r=".8" fill="currentColor"/>',
  audio: '<path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>',
  playlist: '<path d="M16 5H3"/><path d="M11 12H3"/><path d="M11 19H3"/><path d="M21 16V5"/><circle cx="18" cy="16" r="3"/>',
  library: '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="16" rx="1"/><path d="m17 5 3-1 2 15-3 1z"/>',
  document: '<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5M9 11h6M9 15h6M9 19h4"/>',
  pdf: '<path d="M6 2.5h8l4 4v15H6z"/><path d="M14 2.5v4.5h4"/><path d="M9 11.5h6M9 15h6M9 18.5h4"/>',
  sheet: '<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5"/><path d="M9 11h6v7H9zM12 11v7M9 14.5h6"/>',
  presentation: '<path d="M4 4h16v12H4zM8 20l4-4 4 4M12 16v4"/><path d="m8 12 2-3 2 2 3-4 2 5"/>',
  archive: '<path d="M5 3h14v18H5zM9 3v3h3V3M12 6v3H9v3h3v3H9v3h3"/><path d="M9 18h3"/>',
  package: '<path d="m4 7 8-4 8 4-8 4z"/><path d="M4 7v10l8 4 8-4V7M12 11v10"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 20"/>',
  disc: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/><path d="M12 3v7M21 12h-7"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>'
});

const ICON_ALIASES = Object.freeze({ doc: 'document', app: 'package', software: 'package', disk: 'disc', torrent: 'magnet', list: 'queue' });
const FILE_TYPE_ASSETS = Object.freeze({
  archive: { neutral: './app-ui/assets/file-types/archive-neutral.png', accent: './app-ui/assets/file-types/archive-accent.png' },
  document: { neutral: './app-ui/assets/file-types/document-neutral.png', accent: './app-ui/assets/file-types/document-accent.png' },
  ebook: { neutral: './app-ui/assets/file-types/ebook-neutral.png', accent: './app-ui/assets/file-types/ebook-accent.png' },
  package: { neutral: './app-ui/assets/file-types/package-neutral.png', accent: './app-ui/assets/file-types/package-accent.png' },
  torrent: { neutral: './app-ui/assets/file-types/torrent-neutral.png', accent: './app-ui/assets/file-types/torrent-accent.png' },
  font: { neutral: './app-ui/assets/file-types/font-neutral.png', accent: './app-ui/assets/file-types/font-accent.png' },
  text: { neutral: './app-ui/assets/file-types/text-neutral.png', accent: './app-ui/assets/file-types/text-accent.png' },
  sheet: { neutral: './app-ui/assets/file-types/sheet-neutral.png', accent: './app-ui/assets/file-types/sheet-accent.png' },
  code: { neutral: './app-ui/assets/file-types/code-neutral.png', accent: './app-ui/assets/file-types/code-accent.png' },
  image: { neutral: './app-ui/assets/file-types/image-neutral.png', accent: './app-ui/assets/file-types/image-accent.png' },
  disk: { neutral: './app-ui/assets/file-types/disk-neutral.png', accent: './app-ui/assets/file-types/disk-accent.png' },
  audio: { neutral: './app-ui/assets/file-types/audio-neutral.png', accent: './app-ui/assets/file-types/audio-accent.png', flat: './app-ui/assets/file-types/audio-flat.png' },
  video: { neutral: './app-ui/assets/file-types/video-neutral.png', accent: './app-ui/assets/file-types/video-accent.png' },
  pdf: { neutral: './app-ui/assets/file-types/pdf-neutral.png', accent: './app-ui/assets/file-types/pdf-accent.png' },
  presentation: { neutral: './app-ui/assets/file-types/presentation-neutral.png', accent: './app-ui/assets/file-types/presentation-accent.png' },
  // Unknown files use the supplied rounded image geometry instead of the old
  // generic document glyph.  Real image thumbnails still take precedence in
  // fileGlyph and are not replaced by this fallback.
  generic: { neutral: './app-ui/assets/file-types/generic-neutral.png', accent: './app-ui/assets/file-types/generic-accent.png' },
  'playlist-prep': { neutral: './app-ui/assets/file-types/playlist-prep-neutral.png', accent: './app-ui/assets/file-types/playlist-prep-accent.png' }
});
const iconMarkupCache = new Map();
const unknownIconNames = new Set();

export const dmIconNames = Object.freeze(Object.keys(ICON_PATHS));

export function dmFileAsset(type, className = '') {
  const normalizedType = String(type || '').toLowerCase();
  const asset = FILE_TYPE_ASSETS[normalizedType] || FILE_TYPE_ASSETS.generic;
  const safeClass = String(className || '').replace(/[^a-z0-9_-]/gi, '');
  const accentStyle = `--dm-file-accent-mask:url('${asset.accent}')`;
  const flatMarkup = asset.flat ? `<i class="dm-file-asset-flat" style="-webkit-mask-image:url('${asset.flat}');mask-image:url('${asset.flat}')"></i>` : '';
  const flatStyle = asset.flat ? `;--dm-file-flat-mask:url('${asset.flat}')` : '';
  return `<span class="dm-file-asset${safeClass ? ` ${safeClass}` : ''}" data-file-asset="${normalizedType || 'generic'}" style="${accentStyle}${flatStyle}" aria-hidden="true"><img class="dm-file-asset-neutral" src="${asset.neutral}" alt="" decoding="async"><i class="dm-file-asset-accent" style="-webkit-mask-image:url('${asset.accent}');mask-image:url('${asset.accent}')"></i>${flatMarkup}</span>`;
}

export function dmPlaylistLogo(size = 22) {
  const safeHeight = Math.max(10, Math.min(48, Math.round(Number(size) || 22)));
  const safeWidth = Math.round(safeHeight * (961 / 643));
  return `<span class="dm-playlist-logo" data-icon="playlist-logo" style="--playlist-logo-width:${safeWidth}px;--playlist-logo-height:${safeHeight}px"><img src="./app-ui/assets/playlist-logo.png" alt="" decoding="async"><i aria-hidden="true"></i></span>`;
}

export function dmIcon(name, size = 20) {
  const requestedName = String(name || 'file');
  const resolvedName = ICON_ALIASES[requestedName] || requestedName;
  const known = Object.hasOwn(ICON_PATHS, resolvedName);
  const safeName = known ? resolvedName : 'file';
  if (!known && !unknownIconNames.has(requestedName)) {
    unknownIconNames.add(requestedName);
    console.warn(`[CacaTools Download Manager] Icono no registrado: ${requestedName}`);
  }
  const safeSize = Math.max(12, Math.min(96, Math.round(Number(size) || 20)));
  const cacheKey = `${safeName}:${safeSize}:${known ? 'known' : requestedName}`;
  if (!iconMarkupCache.has(cacheKey)) {
    iconMarkupCache.set(cacheKey, `<svg class="dm-icon" data-icon="${safeName}"${known ? '' : ` data-icon-fallback="${requestedName.replace(/[^a-z0-9_-]/gi, '')}"`} width="${safeSize}" height="${safeSize}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" shape-rendering="geometricPrecision" aria-hidden="true">${ICON_PATHS[safeName]}</svg>`);
  }
  return iconMarkupCache.get(cacheKey);
}
