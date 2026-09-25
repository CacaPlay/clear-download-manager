// Local Lucide icon subset (upstream ISC, with Feather-derived MIT exceptions).
// Keep preparation-window icon paths local and avoid Unicode/CSS drawings.
const PATHS = Object.freeze({
  // Lucide list-music.svg from upstream commit 66d8f9fc394b8530377e5f6112f0b8908ba01280.
  listMusic: '<path d="M16 5H3"/><path d="M11 12H3"/><path d="M11 19H3"/><path d="M21 16V5"/><circle cx="18" cy="16" r="3"/>',
  play: '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>',
  file: '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/>',
  settings: '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  minimize: '<path d="M5 12h14"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  restore: '<path d="M8 8h11a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2z"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  sparkles: '<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/><path d="M20 2v4M22 4h-4"/><circle cx="4" cy="20" r="2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  link: '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/>',
  download: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
  shield: '<path d="M12 3 20 6v6c0 5-3.4 8.2-8 10-4.6-1.8-8-5-8-10V6z"/><path d="m8.5 12 2.2 2.2 4.8-5"/>',
  document: '<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5M9 11h6M9 15h6M9 19h4"/>',
  pdf: '<path d="M6 2.5h8l4 4v15H6z"/><path d="M14 2.5v4.5h4M9 11.5h6M9 15h6M9 18.5h4"/>',
  presentation: '<path d="M4 4h16v12H4zM8 20l4-4 4 4M12 16v4"/><path d="m8 12 2-3 2 2 3-4 2 5"/>',
  archive: '<path d="M5 3h14v18H5zM9 3v3h3V3M12 6v3H9v3h3v3H9v3h3v3"/>',
  disc: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/><path d="M12 3v7M21 12h-7"/>',
  package: '<path d="m4 7 8-4 8 4-8 4z"/><path d="M4 7v10l8 4 8-4V7M12 11v10"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 20"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
  audio: '<path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>'
});

const ALIASES = Object.freeze({ playlist: 'listMusic', music: 'listMusic', http: 'link', close: 'x' });

export function playlistLogo(size = 32) {
  const safeHeight = Math.max(16, Math.min(96, Math.round(Number(size) || 32)));
  const safeWidth = Math.round(safeHeight * (961 / 643));
  return `<span class="playlist-logo" data-icon="playlist-logo" style="--playlist-logo-width:${safeWidth}px;--playlist-logo-height:${safeHeight}px"><img src="./assets/playlist-logo.png" alt="" decoding="async"><i aria-hidden="true"></i></span>`;
}

// Wide supplied mark used only by playlist preparation surfaces. The two
// layers keep the neutral artwork fixed while the musical accent follows the
// current interface color through CSS.
export function playlistPrepLogo(size = 28) {
  const safeHeight = Math.max(18, Math.min(64, Math.round(Number(size) || 28)));
  const safeWidth = Math.round(safeHeight * 1.5);
  const accentImage = "./assets/file-types/playlist-prep-accent.png";
  return `<span class="playlist-prep-logo" data-icon="playlist-prep-logo" style="--playlist-prep-logo-width:${safeWidth}px;--playlist-prep-logo-height:${safeHeight}px;--playlist-prep-accent-mask:url('${accentImage}')"><img class="playlist-prep-logo-neutral" src="./assets/file-types/playlist-prep-neutral.png" alt="" decoding="async"><i class="playlist-prep-logo-accent" style="-webkit-mask-image:url('${accentImage}');mask-image:url('${accentImage}')" aria-hidden="true"></i></span>`;
}

export function lucideIcon(name, size = 20) {
  const requested = String(name || 'file');
  const resolved = ALIASES[requested] || requested;
  const path = PATHS[resolved] || PATHS.file;
  const safeSize = Math.max(12, Math.min(96, Math.round(Number(size) || 20)));
  return `<svg class="icon" data-icon="${resolved}" width="${safeSize}" height="${safeSize}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

export const lucideIconNames = Object.freeze(Object.keys(PATHS));
