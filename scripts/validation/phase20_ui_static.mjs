import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const cssImportPattern = /@import\s+(?:(url)\(\s*)?(['"])([^'"]+)\2(?:\s*\))?\s*;?/gi;
const resolveCssImports = (entrypoint, {
  readFile = (file) => fs.readFileSync(file, 'utf8'),
  resolvePath = (parent, child) => path.resolve(path.dirname(parent), child),
  stack = [],
  seen = new Set(),
} = {}) => {
  const current = path.normalize(entrypoint);
  if (stack.includes(current)) {
    throw new Error(`CSS import cycle: ${[...stack, current].join(' -> ')}`);
  }
  const content = readFile(current);
  const nextStack = [...stack, current];
  const nextSeen = new Set(seen);
  nextSeen.add(current);
  return content.replace(cssImportPattern, (full, _urlFunction, _quote, specifier) => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(specifier)) return full;
    const localSpecifier = specifier.split(/[?#]/, 1)[0];
    const child = path.normalize(resolvePath(current, localSpecifier));
    if (nextStack.includes(child)) {
      throw new Error(`CSS import cycle: ${[...nextStack, child].join(' -> ')}`);
    }
    if (nextSeen.has(child)) {
      throw new Error(`Duplicate CSS import: ${child}`);
    }
    nextSeen.add(child);
    return resolveCssImports(child, { readFile, resolvePath, stack: nextStack, seen: nextSeen });
  });
};

const resolveRealCssImports = (entrypoint) => resolveCssImports(path.resolve(entrypoint));

const verifyCssImportLoader = () => {
  const fixture = new Map([
    ['root.css', '@import url("./first.css");\n@import "./second.css";\nROOT'],
    ['first.css', '@import url("./nested.css?v=1");\nFIRST'],
    ['nested.css', 'NESTED'],
    ['second.css', 'SECOND'],
  ]);
  const readFixture = (file) => {
    if (!fixture.has(file)) throw new Error(`CSS file not found: ${file}`);
    return fixture.get(file);
  };
  const resolveFixture = (parent, child) => path.posix.normalize(path.posix.join(path.posix.dirname(parent), child));
  assert.equal(
    resolveCssImports('root.css', { readFile: readFixture, resolvePath: resolveFixture }),
    'NESTED\nFIRST\nSECOND\nROOT',
  );
  fixture.set('cycle.css', '@import "./cycle-child.css";');
  fixture.set('cycle-child.css', '@import "./cycle.css";');
  assert.throws(
    () => resolveCssImports('cycle.css', { readFile: readFixture, resolvePath: resolveFixture }),
    /CSS import cycle/,
  );
  fixture.set('duplicate.css', '@import "./second.css";\n@import "./second.css";');
  assert.throws(
    () => resolveCssImports('duplicate.css', { readFile: readFixture, resolvePath: resolveFixture }),
    /Duplicate CSS import/,
  );
  assert.throws(
    () => resolveCssImports('missing.css', { readFile: readFixture, resolvePath: resolveFixture }),
    /CSS file not found/,
  );
};

verifyCssImportLoader();

const readFrontendSource = (extension) => fs.readdirSync('app-ui', { recursive: true })
  .filter((file) => file.endsWith(extension) && !file.replaceAll('\\', '/').startsWith('download-manager/'))
  .sort((a, b) => {
    const primary = extension === '.js' ? 'main.js' : 'styles.css';
    return a === primary ? -1 : b === primary ? 1 : a.localeCompare(b);
  })
  .map((file) => fs.readFileSync(`app-ui/${file}`, 'utf8'))
  .join('\n');
const read=(file)=>fs.readFileSync(file,'utf8');
const packageJson=JSON.parse(read('package.json'));
const tauri=JSON.parse(read('src-tauri/tauri.conf.json'));
const expectedVersion = String(packageJson.version || '').trim();
const files={
 main:readFrontendSource('.js'),
 cssEntry:read('app-ui/download-manager/styles.css'),
 appCssEntry:read('app-ui/styles.css'),
 css:resolveRealCssImports('app-ui/download-manager/styles.css'),
 appCss:resolveRealCssImports('app-ui/styles.css'),
 constants:read('app-ui/download-manager/core/constants.js'), model:read('app-ui/download-manager/core/model.js'),
 index:read('app-ui/download-manager/index.js'), state:read('app-ui/download-manager/state.js'), search:read('app-ui/download-manager/search.js'), live:read('app-ui/download-manager/live.js'), events:read('app-ui/download-manager/events.js'), thumbnails:read('app-ui/download-manager/thumbnails.js'), unified:read('app-ui/download-manager/view/unified.js'), dialogs:read('app-ui/download-manager/view/dialogs.js'),
 zen:read('app-ui/download-manager/view/zen-sidebar.js'), icons:read('app-ui/download-manager/view/icons.js'), shared:read('app-ui/download-manager/view/shared.js'), sections:read('app-ui/download-manager/view/sections.js'),
 subwindowCss:read('app-ui/subwindow.css'),
 rust:fs.readdirSync('src-tauri/src',{recursive:true}).filter((file)=>file.endsWith('.rs')).sort((a,b)=>a==='lib.rs'?-1:b==='lib.rs'?1:a.localeCompare(b)).map((file)=>fs.readFileSync(`src-tauri/src/${file}`,'utf8')).join('\n'), bridge:read('src-tauri/src/extension_bridge.rs'), updater:read('src-tauri/src/update_manager.rs'),
 cargo:read('src-tauri/Cargo.toml'), size:read('scripts/report-windows-size.ps1'), smoke:read('scripts/smoke-test-installed-beta.ps1')
};
const assertions=[
  [`version ${expectedVersion}`,Boolean(expectedVersion)&&tauri.version===expectedVersion&&files.cargo.includes(`version = "${expectedVersion}"`)],
  [`CDM ${expectedVersion} UI build id`,files.main.includes(`const BUILD_ID = 'CDM-${expectedVersion}-`)],
 ['Empty download CTA opens unified workspace',files.unified.includes('data-dm-focus-unified')&&files.events.includes('context.onNewDownload?.()')&&files.events.includes("document.querySelector('#download-url')?.focus()")],
 ['Zen default and normalized scale 100',files.constants.includes("layout: 'zen-sidebar'")&&files.constants.includes('uiScale: 100')&&files.rust.includes('fn default_ui_scale() -> u8 {\n    100')],
 ['Command Center removed',!files.model.includes("value.layout === 'command-center'")&&!files.index.includes('renderCommandCenter')&&!files.shared.includes('Command Center')],
 ['Zen settings not duplicated',!files.constants.includes("['settings', 'Ajustes', 'settings']")&&files.zen.includes("data-dm-open-settings")],
 ['native preparation windows and one dedicated player window',!files.main.includes('data-floating-download-dialog')&&!files.main.includes('FLOATING_WORKSPACE_STORAGE_KEY')&&files.main.includes("invoke('open_preparation_window'")&&files.rust.includes('WebviewWindowBuilder::new(&app, "player"')&&files.rust.includes('MEDIA_PREPARATION_LABEL')&&files.rust.includes('PLAYLIST_PREPARATION_LABEL')&&files.rust.includes('HTTP_PREPARATION_LABEL')&&(files.rust.match(/WebviewWindowBuilder::new/g)||[]).length>=2],
 ['integrated workspace tokens',files.appCss.includes('Phase 20 · Download Center and Playlist Manager share the exact Download Manager shell')&&files.appCss.includes('--dl-bg:var(--dm-window)')&&files.appCss.includes('grid-area:auto!important')],
 ['playlist selection uses V5 compact two-column cards',files.main.includes('track-card')&&files.main.includes('track-grid')&&files.main.includes('data-role="item-check"')&&!files.main.includes('sp-playlist-row')&&!files.main.includes('playlist-selection-scroll')&&!files.main.includes('playlist-option-summary')],
 ['playlist folder named after playlist',files.rust.includes('playlist_destination_dir(&current_downloads_dir(&state)?, title)')&&files.rust.includes('downloads_dir.join(sanitize_filename(playlist_title.trim()))')&&files.rust.includes('playlist_dir.to_string_lossy().to_string(), item.expected_duration_seconds')],
 ['playlist queue rebuilt',files.main.includes('playlist-upcoming-row')&&files.main.includes('data-playlist-upcoming-index')&&files.appCss.includes('.playlist-upcoming-row')],
 ['playlist runtime upcoming Rust',files.rust.includes('upcoming: Vec<PlaylistRuntimeItem>')&&files.rust.includes('read_playlist_runtime_items')&&files.rust.includes('LIMIT 8')&&files.rust.includes("status IN ('running','paused')")],
 ['live 500 ms snapshot polling',files.main.includes('}, 500);')&&files.main.includes('patchDownloadManagerLive')],
 ['live patch preserves search shell',files.index.includes('export function patchDownloadManagerLive')&&files.live.includes('const area = root.querySelector(\'.dm-download-area\')')&&!files.live.includes('context.workspaceActive')&&!files.live.includes("root.innerHTML = downloadAreaMarkup")],
 ['search suggestions with thumbnails',files.rust.includes('async fn search_video_suggestions')&&files.rust.includes('Result<Vec<MediaSearchResult>, String>')&&files.rust.includes('Duration::from_secs(7)')&&files.unified.includes('Cargando más resultados')],
 ['full media search off UI thread',files.rust.includes('tauri::async_runtime::spawn_blocking')],
 ['paced debounce and bounded in-flight cache',files.state.includes('UNIFIED_SUGGESTION_DEBOUNCE_MS = 120')&&files.state.includes('UNIFIED_SUGGESTION_TIMEOUT_MS = 7200')&&files.state.includes('UNIFIED_SUGGESTION_CACHE_LIMIT = 32')&&files.state.includes('UNIFIED_SUGGESTION_CACHE_TTL_MS')&&files.state.includes('cache: new Map()')&&files.search.includes('searchState.cache.set(cacheKey, { value: request')&&files.search.includes('searchState.cache.size > UNIFIED_SUGGESTION_CACHE_LIMIT')],
 ['stale suggestion response blocked',files.search.includes('requestId !== runtimeState.unifiedRequestId')],
 ['YouTube keyboard interaction',files.events.includes("event.key === 'ArrowDown'")&&files.events.includes("event.key === 'ArrowUp'")&&files.unified.includes('role="combobox"')],
 ['semantic suggestion icons',files.search.includes('function suggestionIconForTitle')&&files.search.includes('suggestionIconForTitle(item, true)')&&files.unified.includes("item.icon || (item.sourceUrl ? 'video' : 'search')")],
 ['playlist fallback uses source logo',files.unified.includes('dmPlaylistLogo(large ? 20 : 16)')&&!files.unified.includes("dmIcon('playlist', large ? 24 : 18)")],
 ['single search border',files.css.includes('.dm-unified-input-wrap input:focus-visible')&&files.css.includes('box-shadow:none!important')],
 ['focus/selection interaction test included',fs.existsSync('scripts/validation/phase20_live_interaction_smoke.py')&&fs.existsSync('scripts/validation/phase20_live_fixture.mjs')&&files.index.includes('runtimeState.preferences.selectedJobId')],
 ['blank download surface clears selection',files.events.includes('hadSelection')&&files.events.includes('syncPreferences({ selectedJobId: null })')&&files.events.includes('runtimeState.selectedJobIds.clear()')],
 ['context menu and explicit row menu remain compatible',files.events.includes("root.addEventListener('contextmenu'")&&files.shared.includes('export function rowMenu(job, rowMenuJobId)')&&files.shared.includes('data-dm-row-menu=')&&files.shared.includes('data-dm-open-path')&&files.events.includes("target.closest('[data-dm-row-menu]')")],
 ['folder reveal accepts directories',files.rust.includes('if file_path.is_dir()')&&files.rust.includes('.open_path(file_path.to_string_lossy().to_string()')],
 ['exact normalized scale uses real tokens',files.shared.includes('type="number" min="50" max="130" step="5"')&&files.main.includes('function displayedScalePercent')&&files.main.includes('function internalScalePercent')&&files.main.includes('function internalScalePercent(scale) { return displayedScalePercent(scale); }')],
 ['native token scaling avoids global zoom',!files.css.match(/\.dm-root\s*\{[^}]*\bzoom\s*:/s)&&!files.appCss.match(/\.app-shell\s*\{[^}]*transform\s*:\s*scale/s)&&files.css.includes('font-size:15px!important')],
 ['Zen-only workspace',files.index.includes("renderZenSidebar(sharedContext)")&&files.model.includes("const layout = 'zen-sidebar'")],
 ['workspace visual test included',fs.existsSync('scripts/validation/phase20_workspace_visual_smoke.py')],
 ['video thumbnails persisted',files.rust.includes("thumbnail TEXT NOT NULL DEFAULT ''")&&files.rust.includes('NULLIF(media_jobs.thumbnail')],
 ['updater guarded',files.rust.includes('if update_manager::updater_plugin_is_configured()')&&files.updater.includes('pub fn updater_plugin_is_configured()')],
 ['extension bridge preserved',(files.bridge.match(/\.truncate\(false\)/g)||[]).length===2&&files.bridge.includes('ensure_extension_host_registration')],
 ['stable release profile',files.cargo.includes('lto = true')&&files.cargo.includes('opt-level = "s"')&&files.cargo.includes('strip = true')&&!files.cargo.includes('trim-paths')],
 ['PowerShell size report safe',files.size.includes('Get-FileHash -LiteralPath')&&files.size.includes('Sort-Object -Property bytes -Descending')],
 ['startup diagnostics preserved',files.smoke.includes('RedirectStandardError')&&files.smoke.includes('RUST_BACKTRACE')],
 ['dedicated playlist and file-type logos',files.icons.includes('data-icon="playlist-logo"')&&files.main.includes('playlist-prep-logo')&&files.unified.includes('dmPlaylistLogo(11)')&&files.unified.includes('dmFileAsset(type.visualType')&&files.main.includes('playlistPrepLogo(24)')&&files.main.includes('./assets/file-types/playlist-prep-neutral.png')&&files.subwindowCss.includes('.header-icon .playlist-prep-logo{width:calc(40px * var(--ui-scale))!important;height:calc(27px * var(--ui-scale))!important}')&&files.subwindowCss.includes('.playlist-cover .playlist-prep-logo{width:calc(52px * var(--ui-scale))!important;height:calc(35px * var(--ui-scale))!important}')&&files.main.includes('./assets/playlist-logo.png')],
 ['playlist workspaces avoid library icon',!files.main.includes("isPlaylistQueue ? 'library'")&&!files.main.includes("mode === 'playlist' ? 'library'")],
  ['archive resources use archive icon',files.main.includes('archive:')&&files.icons.includes('archive:')],
 ['search icon registered',files.main.includes(`search: '<circle cx="11"`)&&files.icons.includes(`search: '<circle cx="11"`)],
  ['semantic resource icons',files.main.includes('video:')&&files.main.includes('doc:')&&files.main.includes('app:')&&files.icons.includes('video:')&&files.icons.includes('archive:')],
  ['specific file icons',files.unified.includes("pdf: ['pdf', 'pdf']")&&files.unified.includes("ebook: ['ebook', 'ebook']")&&files.unified.includes("code: ['file', 'code']")&&files.unified.includes("presentation: ['presentation', 'presentation']")&&files.model.includes("const codeExtensions")&&files.model.includes("const fontExtensions")],
 ['download manager footer removed',!files.unified.includes('<footer class="dm-minimal-footer">')],
 ['actual library icon retained',files.sections.includes("dmIcon('library', 30)")],
 ['icon markup cached',files.main.includes('iconMarkupCache')&&files.icons.includes('iconMarkupCache')],
 ['icon fallback diagnosable',files.main.includes('data-icon-fallback')&&files.icons.includes('data-icon-fallback')]
];
const failed=assertions.filter(([,pass])=>!pass).map(([name])=>name);
if(failed.length){console.error(`Phase 20 static gate failed: ${failed.join(', ')}`);process.exit(1)}
console.log(`OK: ${assertions.length} comprobaciones Phase 20.`);
