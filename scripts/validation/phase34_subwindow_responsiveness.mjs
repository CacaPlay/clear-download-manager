import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const source = {
  lib: read('src-tauri/src/lib.rs'),
  process: read('src-tauri/src/app/process.rs'),
  state: read('src-tauri/src/app/state.rs'),
  playerWindow: read('src-tauri/src/windows/player.rs'),
  media: read('src-tauri/src/media/mod.rs'),
  resolver: read('src-tauri/src/media/resolver.rs'),
  extraction: read('src-tauri/src/media/extraction.rs'),
  playlist: read('src-tauri/src/media/playlist.rs'),
  mediaCommands: read('src-tauri/src/commands/media.rs'),
  runtime: read('app-ui/modules/runtime/index.js'),
  downloadCommands: read('src-tauri/src/commands/downloads.rs'),
  subwindows: read('src-tauri/src/subwindows.rs'),
  subwindowCommands: read('src-tauri/src/commands/subwindows.rs'),
  subwindowJs: read('app-ui/subwindow.js'),
  subwindowCss: read('app-ui/subwindow.css'),
  playerJs: read('app-ui/player/player.js')
};

const checks = [
  ['analysis commands are async', /pub\(crate\) async fn analyze_media_url[\s\S]*spawn_blocking/.test(source.mediaCommands)],
  ['HTTP inspection is async', /pub\(crate\) async fn inspect_download_url[\s\S]*spawn_blocking/.test(source.downloadCommands)],
  ['manager refreshes cold thumbnail fields periodically', /VISIBLE_FULL_SNAPSHOT_REFRESH_MS\s*=\s*5_000/.test(source.runtime) && /const fullSnapshotRefreshMs = managerVisible[\s\S]*needsFullSnapshot/.test(source.runtime)],
  ['single media analysis keeps playlist policy in current owners', /let likely_playlist\s*=/.test(source.resolver) && /run_analysis_attempt\([\s\S]*likely_playlist/.test(source.resolver) && /if likely_playlist[\s\S]*arg\("--flat-playlist"\)[\s\S]*arg\("--playlist-end"\)[\s\S]*else[\s\S]*arg\("--no-playlist"\)/.test(source.extraction) && /queue_playlist_selection/.test(source.playlist)],
  ['window analysis has an explicit owner operation', /analyze_media_url_with_session_for_window[\s\S]*window_label[\s\S]*current_window_operation/.test(source.mediaCommands)],
  ['owned external processes are registered and tree-killed', /command_output_with_timeout_cancelable_owned[\s\S]*register_window_process[\s\S]*kill_process_tree/.test(source.process)],
  ['owner cancellation has generation and late-work guards', /pub\(crate\) struct WindowOperation[\s\S]*generation:[\s\S]*closed:[\s\S]*window_operation_is_cancelled/.test(source.state)],
  ['preparation CloseRequested invalidates before native close', /WindowEvent::CloseRequested[\s\S]*invalidate_window_operation[\s\S]*WindowEvent::Destroyed/.test(source.subwindows)],
  ['player CloseRequested invalidates before native close', /build_media_player_window[\s\S]*WindowEvent::CloseRequested[\s\S]*invalidate_window_operation/.test(source.playerWindow)],
  ['all preparation windows expose native drag', /preparation_window_start_dragging/.test(source.subwindows) && /preparation_window_start_dragging/.test(source.subwindowCommands) && /preparation_window_start_dragging/.test(source.subwindowJs)],
  ['Player drag remains available during loading', /player_start_dragging/.test(source.playerJs) && /player_window_action/.test(source.playerJs)],
  ['preview has exactly one physical activation route', !source.subwindowJs.includes('node.onpointerup') && (source.subwindowJs.match(/node\.onclick = openMediaPreview/g) || []).length === 1],
  ['preview button geometry cannot translate on click', /\.preview-play\{[^}]*inset:0[^}]*margin:auto[^}]*transform:none/.test(source.subwindowCss)],
  ['content uses real vertical scrolling without global scaling', /\.content\{[^}]*overflow:auto/.test(source.subwindowCss) && !/transform\s*:\s*scale\s*\(/.test(source.subwindowCss)],
  ['scaled multimedia layout uses natural rows and bounded thumbnail sizing', /--multimedia-grid-height:\s*100%/.test(source.subwindowCss) && /--multimedia-grid-rows:\s*minmax\(0,1\.16fr\) minmax\(0,\.94fr\)/.test(source.subwindowCss) && /mediaThumbRatio/.test(source.subwindowJs) && /grid-template-rows:var\(--multimedia-grid-rows\)/.test(source.subwindowCss)],
  ['preparation titlebar no longer renders the C logo', /root\.querySelector\('\.app-dot'\)\?\.remove\(\)/.test(source.subwindowJs) && !source.subwindowCss.includes('.app-dot{')],
  ['generic source badge shows the host with a local link icon', /return \['http', host\.replace\(\/\^www\\\.\//.test(source.subwindowJs) && /icon\('link', 18\)/.test(source.subwindowJs) && !source.subwindowJs.includes('assets/platforms/')],
  ['media thumbnails remain 16:9', /\.media-thumb\{[^}]*aspect-ratio:16\/9/.test(source.subwindowCss)],
  ['playlist remains a two-column grid', /\.track-grid\{[^}]*grid-template-columns:1fr 1fr;/.test(source.subwindowCss)],
  ['HTTP keeps its two-zone layout', /\.http-layout\{[^}]*grid-template-columns:minmax\(0,1\.16fr\) minmax\(0,\.84fr\)/.test(source.subwindowCss)]
];

for (const [label, pass] of checks) {
  console.log(`${pass ? 'OK' : 'FAIL'}: ${label}`);
  assert.equal(pass, true, label);
}

console.log(`\nOK: subwindow responsiveness contracts validated (${checks.length} conditions).`);
