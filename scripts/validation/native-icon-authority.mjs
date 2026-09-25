import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const bootstrap = read('src-tauri/src/app/bootstrap.rs');
const appearance = read('app-ui/modules/appearance/index.js');
const main = read('app-ui/main.js');
const player = read('app-ui/player/player.js');
const subwindow = read('app-ui/subwindow.js');
const failures = [];
const check = (label, condition) => { if (!condition) failures.push(label); };

check('Rust no restringe el icono nativo al main', bootstrap.includes('get_webview_window("main")') && !bootstrap.includes('for window in app.webview_windows().values()'));
check('El main no delega el icono a renders normales', main.includes('applyAppearance(source, { updateNativeIcon: false, ...options })'));
check('Los cambios nativos se reservan al commit', main.includes('applyAppAppearance(appState.appearance, { updateNativeIcon: true })'));
check('El reproductor no posee el icono nativo', player.includes('applyBrandIconVariant(iconVariantForColor(stored.accent))') && !player.includes("set_application_icon"));
check('La subventana no actualiza el icono nativo', subwindow.includes('updateNativeIcon: false'));

if (failures.length) {
  console.error(failures.map((failure) => `FAIL: ${failure}`).join('\n'));
  process.exit(1);
}
console.log('OK: el main es la única autoridad del icono nativo; player y subventanas solo actualizan imagen interna.');
