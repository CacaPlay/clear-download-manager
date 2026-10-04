import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const settingsCss = fs.readFileSync('app-ui/modules/settings/styles.css', 'utf8');
const downloadCss = fs.readFileSync('app-ui/download-manager/styles/03-components.css', 'utf8');
const bridgeRust = fs.readFileSync('src-tauri/src/extension_bridge.rs', 'utf8');
const cargoToml = fs.readFileSync('src-tauri/Cargo.toml', 'utf8');

function expectMatch(source, expression, message) {
  assert.ok(expression.test(source), message);
}

test('settings options use regular text weight while section headings stay bold', () => {
  expectMatch(settingsCss, /\.settings-control\s+b\s*\{[^}]*font-weight:\s*400\s*;/s, 'Las opciones de Ajustes deben tener peso regular.');
  expectMatch(settingsCss, /\.settings-section-heading\s+h3\s*\{[^}]*font-weight:\s*700\s*;/s, 'Los títulos de sección deben conservar la negrita.');
});

test('settings navigation uses 22px icons and theme-specific neutral colors', () => {
  expectMatch(settingsCss, /\.settings-nav-icon\s*\{[^}]*width:\s*22px\s*;[^}]*height:\s*22px\s*;/s, 'Los iconos de Ajustes deben medir 22 px.');
  expectMatch(settingsCss, /--settings-nav-item-ink:\s*#1f2b38\s*;/i, 'El texto claro debe usar #1f2b38.');
  expectMatch(settingsCss, /--settings-nav-item-ink:\s*#fff\s*;/i, 'El texto oscuro debe ser blanco.');
  expectMatch(settingsCss, /--ui-icon-neutral:\s*#1f2b38\s*;/i, 'La base del icono claro debe usar #1f2b38.');
  expectMatch(settingsCss, /--ui-icon-neutral:\s*#fff\s*;/i, 'La base del icono oscuro debe ser blanca.');
});

test('selected settings category uses a slim accent strip and neutral theme surface', () => {
  expectMatch(settingsCss, /\.settings-category-button\.is-active::before\s*\{[^}]*width:\s*4px\s*;/s, 'La selección debe tener una franja lateral de 4 px.');
  expectMatch(settingsCss, /#app\s+\.settings-workspace\s+\.settings-category-button\.is-active\s*\{[^}]*border-color:\s*transparent\s*!important;[^}]*background:\s*var\(--settings-nav-active-surface\)\s*!important;/s, 'La selección debe usar una superficie neutral sin borde completo.');
  expectMatch(settingsCss, /--settings-nav-active-surface:\s*#[0-9a-f]{6}\s*;/i, 'Cada tema debe definir un fondo neutral seleccionado.');
});

test('news release and dismiss actions stack vertically at the right', () => {
  expectMatch(downloadCss, /\.dm-news-actions\s*\{[^}]*display:\s*grid\s*!important;[^}]*grid-template-columns:\s*var\(--dm-news-action-width\)\s*!important;/s, 'Los botones de cada novedad deben apilarse en una sola columna a la derecha.');
  expectMatch(downloadCss, /\.dm-host\s+\.dm-news-actions\s*\{[^}]*grid-column:\s*4\s*!important;/s, 'Las acciones deben usar la última columna de cada tarjeta para alinear su borde derecho con Apoyar.');
  expectMatch(downloadCss, /@media\s*\(max-width:\s*820px\)[\s\S]*?\.dm-host\s+\.dm-news-actions\s*\{[^}]*grid-column:\s*2\s*!important;[^}]*justify-self:\s*end\s*!important;/s, 'En móvil, las acciones deben alinearse al mismo borde que Apoyar.');
  expectMatch(downloadCss, /\.dm-news-actions\s*>\s*button\s*\{[^}]*width:\s*var\(--dm-news-action-width\)\s*!important;/s, 'La acción y la X deben tener el mismo ancho.');
  expectMatch(downloadCss, /\.dm-news-actions\s*>\s*button:only-child\s*\{[^}]*grid-column:\s*1\s*!important;/s, 'Una acción única debe quedar alineada con la columna de acciones.');
  expectMatch(downloadCss, /\.dm-news-support\s*>\s*button\s*,[\s\S]{0,180}\.dm-news-component-update\s*>\s*button\s*,[\s\S]{0,180}\.dm-news-history-row\s*>\s*button\s*\{[^}]*width:\s*var\(--dm-news-action-width\)\s*!important;/s, 'Apoyar, componentes e historial deben compartir el ancho y la columna de acciones.');
});

test('screen and settings transitions return to the original vertical fades without blur', () => {
  const motionCss = fs.readFileSync('app-ui/styles/motion-tier2.css', 'utf8');
  for (const animation of ['cdm-motion-section-old', 'cdm-motion-section-new']) {
    const keyframes = motionCss.match(new RegExp('@keyframes ' + animation + '\\s*\\{([^}]*)\\}'))?.[1] || '';
    assert.ok(keyframes, 'Faltan keyframes para ' + animation + '.');
    assert.match(keyframes, /opacity:\s*[01]/i, animation + ' debe conservar el fundido original.');
    assert.match(keyframes, /transform:\s*translateY\(/, animation + ' debe conservar el desplazamiento vertical original.');
    assert.doesNotMatch(keyframes, /filter:\s*blur\(/i, animation + ' no debe desenfocar el contenido.');
  }
  assert.ok(motionCss.includes('cdm-settings-panel-old-down') && motionCss.includes('cdm-settings-panel-new-down'));
  assert.doesNotMatch(motionCss, /data-motion-fallback-enter|data-settings-motion-enter|cdm-motion-theme-expand/, 'No debe haber una segunda capa de transiciones.');
});
test('sidebar utility group and its divider move together by one pixel', () => {
  expectMatch(downloadCss, /\.dm-host\s+\.dm-zen-nav\s*>\s*footer\s*\{[^}]*transform:\s*translateY\(1px\)\s*!important;/s, 'Los tres iconos inferiores y su línea deben bajar un píxel como grupo.');
  expectMatch(downloadCss, /\.dm-host\[data-dm-theme="light"\]\s+\.dm-zen-nav[\s\S]{0,800}#1f2b38/i, 'Los iconos neutrales de navegación en modo claro deben mantener el gris elegido.');
});

test('isolated QA builds can enable the same V1 bridge without changing their host identity', () => {
  expectMatch(cargoToml, /^qa-extension-bridge\s*=\s*\["qa-component-manager"\]/m, 'Falta la opción para probar el puente V1 en la compilación QA.');
  expectMatch(bridgeRust, /#\[cfg\(all\(feature\s*=\s*"qa-component-manager",\s*not\(feature\s*=\s*"qa-extension-bridge"\)\)\)\][\s\S]*?pub fn initialize_app_bridge\(\)\s*->\s*Result<\(\),\s*String>\s*\{\s*Ok\(\(\)\)/, 'El puente debe seguir desactivado en QA por defecto y activarse solo con la opción explícita.');
  expectMatch(bridgeRust, /const BRIDGE_PROTOCOL_VERSION:\s*u32\s*=\s*1\s*;/, 'El host QA debe conservar el protocolo V1.');
});
