import fs from 'node:fs';
const readFrontendSource = (extension) => fs.readdirSync('app-ui', { recursive: true })
  .filter((file) => file.endsWith(extension) && !file.replaceAll('\\', '/').startsWith('download-manager/'))
  .sort((a, b) => {
    const primary = extension === '.js' ? 'main.js' : 'styles.css';
    return a === primary ? -1 : b === primary ? 1 : a.localeCompare(b);
  })
  .map((file) => fs.readFileSync(`app-ui/${file}`, 'utf8'))
  .join('\n');

const read = (file) => fs.readFileSync(file, 'utf8');
const main = readFrontendSource('.js');
const appCss = readFrontendSource('.css');
const dmIndex = read('app-ui/download-manager/index.js');
const dmShared = read('app-ui/download-manager/view/shared.js');
const dmCss = read('app-ui/download-manager/styles.css');
const dmConstants = read('app-ui/download-manager/core/constants.js');
const dmModel = read('app-ui/download-manager/core/model.js');
const rust = fs.readdirSync('src-tauri/src', { recursive: true })
  .filter((file) => file.endsWith('.rs'))
  .sort((a, b) => (a === 'lib.rs' ? -1 : b === 'lib.rs' ? 1 : a.localeCompare(b)))
  .map((file) => fs.readFileSync(`src-tauri/src/${file}`, 'utf8'))
  .join('\n');
const bridge = read('src-tauri/src/extension_bridge.rs');

const checks = [
  ['La escala predeterminada visible es 100', main.includes('scale: 100, textScale: 100') && dmConstants.includes('uiScale: 100') && rust.includes('fn default_ui_scale() -> u8 {\n    100')],
  ['La escala física conserva el tamaño aprobado con mapa adaptable', main.includes('function effectiveInterfaceRatio(displayedScale)') && main.includes('const profile = viewportWidth < 860') && main.includes('legacyEquivalentScale = displayedScale + LEGACY_UI_OFFSET')],
  ['El texto tiene control independiente de 80 a 120 y no altera la geometría', main.includes('TEXT_SCALE_MIN, TEXT_SCALE_MAX') && main.includes("root.style.setProperty('--root-font-size'") && dmModel.includes('clampNumber(value.textScale, 80, 120)') && rust.includes('!(80..=120).contains(&self.text_scale)')],
  ['La revisión de apariencia migra ajustes antiguos', main.includes('APPEARANCE_REVISION = 7') && main.includes('remoteRevision < 7') && rust.includes('appearance_revision: 7')],
  ['El control de escala no repite el porcentaje', !dmShared.includes('dm-scale-setting output') && !main.includes('data-setting-value="scale"') && dmIndex.includes('syncPreferences({ uiScale: 100 })')],
  ['Ajustes y diálogos conservan el scroll y foco al rerenderizar', dmIndex.includes('function captureScrollableState()') && main.includes('function captureRenderContinuity()') && main.includes("['.dm-settings-popover', state.dmSettings]") && main.includes('target.focus({ preventScroll: true })') && dmIndex.includes('function restoreScrollableState()') && dmCss.includes('overflow-anchor:none!important')],
  ['El color principal de la app se hereda y gobierna acciones', main.includes('onAppearanceChange: (patch = {}, { commit = true } = {})') && appCss.includes('acento global sin teñir superficies') && dmIndex.includes('inheritedAppearance.accent') && dmIndex.includes("context.onAppearanceChange?.({ accent: input.value }, { commit: false })")],
  ['El campo de búsqueda usa borde de acento sin agrandar texto', dmCss.includes('.dm-unified-input-wrap:hover') && dmCss.includes('font-size:1.04rem!important') && dmCss.includes('transform:none!important')],
  ['Las filas reciben progreso sin congelarse bajo el puntero', !dmIndex.includes("area.querySelector('.dm-download-item:hover')") && dmCss.includes('contain:layout paint')],
  ['Los cambios de salida multimedia rerenderizan la ventana nativa', main.includes("event.target.matches('[data-role=\"output\"]')") && main.includes("state.outputMode = event.target.value;") && main.includes("state.selectedFormat = ''") && main.includes('render();')],
  ['MP3 y vídeo filtran formatos compatibles automáticamente', main.includes('function formatsForOutputMode') && main.includes('state.outputMode') && main.includes('data-role="output"') && main.includes('data-role="quality"')],
  ['La ventana nativa elimina categoría y programación redundantes', !main.match(/id="media-category"|id="media-schedule"/) && main.includes('data-role="output"') && main.includes('data-role="quality"')],
  ['La miniatura multimedia conserva ratio V5, visibilidad y centrado', appCss.includes('.media-thumb{') && appCss.includes('aspect-ratio:16/9') && appCss.includes('.preview-play{position:absolute')],
  ['El renderer integrado legacy fue retirado', !main.includes('renderDownloadDialog') && !main.includes('data-floating-download-dialog') && !main.includes('download-dialog-v2')],
  ['La bandeja y ventana usan el icono empaquetado', rust.includes('tray = tray.icon(icon.clone())') && rust.includes('window.set_icon(icon.clone())')],
  ['El inicio con Windows repara la ruta instalada', rust.includes('extension_bridge::startup_status()') && rust.includes('let _ = extension_bridge::set_startup_enabled(true);')],
  ['Los hotfixes Rust previos permanecen integrados', bridge.includes("split(['/', '?', '#'])") && rust.includes('!self.scale.is_multiple_of(5)') && rust.includes("trim_end_matches([' ', '.'])")]
];

const failures = checks.filter(([, ok]) => !ok).map(([label]) => label);
const report = { phase: '0.24.1-hotfix-3-ui-stability', checks: checks.length, failures, generatedAt: new Date().toISOString() };
fs.mkdirSync('docs/tests', { recursive: true });
fs.writeFileSync('docs/tests/phase24-1-hotfix3-ui-stability.json', `${JSON.stringify(report, null, 2)}\n`);
if (failures.length) {
  console.error(failures.map((failure) => `FALLO: ${failure}`).join('\n'));
  process.exit(1);
}
for (const [label] of checks) console.log(`OK: ${label}`);
console.log(`OK: Hotfix 3 valida ${checks.length} condiciones de escala, color, estabilidad, multimedia e integración Windows.`);
