import fs from 'node:fs';
import assert from 'node:assert/strict';

const html = fs.readFileSync('extension/sidepanel.html', 'utf8');
const css = fs.readFileSync('extension/sidepanel.css', 'utf8');
const panel = fs.readFileSync('extension/sidepanel.js', 'utf8');
const worker = fs.readFileSync('extension/service-worker.js', 'utf8');
const sdk = fs.readFileSync('extension/sdk/cacatools-native-client.js', 'utf8');
const app = fs.readFileSync('app-ui/modules/extension/index.js', 'utf8');

assert.match(html, /data-download-action="play"/);
for (const action of ['pause', 'resume', 'retry', 'cancel', 'reveal_file', 'open_file', 'delete_history', 'delete_file']) assert.match(html, new RegExp(`data-download-action="${action}"`));
assert.match(panel, /addEventListener\('contextmenu'/);
assert.match(panel, /data-download-menu/);
assert.match(panel, /type: 'JOB_ACTION'/);
assert.match(css, /grid-template-areas:"thumb copy state action"/);
assert.match(css, /\.download-row-action\{grid-area:action/);
assert.match(worker, /cacaToolsNative\.openPlayer/);
assert.match(worker, /cacaToolsNative\.jobAction/);
assert.match(sdk, /sendCacaToolsNativeMessage\('open_player'/);
assert.match(sdk, /sendCacaToolsNativeMessage\('job_action'/);
assert.match(app, /request\.action === 'open_player'/);
assert.match(app, /invoke\('open_media_player'/);
assert.doesNotMatch(panel, /wake_main_window/);

console.log('OK: menú único, botón de opciones a la derecha y reproducción interna tienen hooks consistentes.');
