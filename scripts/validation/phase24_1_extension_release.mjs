import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const read = (file) => fs.readFileSync(file, 'utf8');
const manifest = JSON.parse(read('extension/manifest.json'));
const worker = read('extension/service-worker.js');
const panel = read('extension/sidepanel.js');
const css = read('extension/sidepanel.css');
const html = read('extension/sidepanel.html');
const bridge = read('src-tauri/src/extension_bridge.rs');
const publishedId = 'aonppfnabjnicjjeoofkfjofolfibggp';
const expectedFiles = [
  'manifest.json','service-worker.js','sidepanel.html','sidepanel.css','sidepanel.js','thumbnail-service.js',
  'content/detector.js','icons/icon16.png','icons/icon32.png','icons/icon48.png','icons/icon128.png'
];
const checks = [
  ['Manifest V3', manifest.manifest_version === 3],
  ['Panel lateral declarado sin popup competidor', manifest.side_panel?.default_path === 'sidepanel.html' && !manifest.action?.default_popup],
  ['Permisos mínimos conocidos', JSON.stringify(manifest.permissions) === JSON.stringify(['activeTab','scripting','downloads','storage','sidePanel','nativeMessaging'])],
  ['CSP no permite código remoto', manifest.content_security_policy?.extension_pages === "script-src 'self'; object-src 'self'"],
  ['El ID oficial sigue fijado en el host', bridge.includes(`PUBLISHED_CHROMIUM_EXTENSION_ID: &str = "${publishedId}"`)],
  ['El icono abre por comportamiento nativo y respaldo explícito', worker.includes('openPanelOnActionClick: true') && worker.includes('chrome.action.onClicked.addListener') && worker.includes('chrome.sidePanel.open')],
  ['La apertura habilita el panel para la pestaña activa', worker.includes("setOptions({ tabId, path: 'sidepanel.html', enabled: true })")],
  ['El estado distingue disponible, app cerrada y puente ausente', panel.includes("connected ? 'Disponible' : sleeping ? 'App cerrada' : 'No disponible'") && css.includes('.status::before') && css.includes('data-state="sleeping"') && css.includes('@media(max-width:390px)')],
  ['El panel conserva descargas e enlaces ocultables', html.includes('data-toggle-panel="downloads"') && html.includes('data-toggle-panel="links"')],
  ['Actualización solo se muestra ante evento real', html.includes('id="extension-update"') && html.includes('hidden') && worker.includes('chrome.runtime.onUpdateAvailable')],
  ['No hay APIs de ejecución remota', !/eval\s*\(|new Function\s*\(|importScripts\s*\(\s*["']https?:/i.test(`${worker}\n${panel}`)],
  ['Todos los archivos de distribución existen', expectedFiles.every((file) => fs.existsSync(path.join('extension', file)))],
];
const syntaxFiles=['extension/service-worker.js','extension/sidepanel.js','extension/thumbnail-service.js','extension/content/detector.js','extension/sdk/cacatools-native-client.js'];
for (const file of syntaxFiles) {
  const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  checks.push([`Sintaxis válida: ${file}`,result.status===0]);
}
const failures=checks.filter(([,ok])=>!ok).map(([label])=>label);
fs.mkdirSync('docs/tests',{recursive:true});
fs.writeFileSync('docs/tests/phase24-1-extension-release.json',`${JSON.stringify({phase:'0.24.1-fase-8-extension',publishedId,manifestVersion:manifest.version,checks:checks.length,failures,generatedAt:new Date().toISOString()},null,2)}\n`);
if(failures.length){console.error(failures.map((failure)=>`FALLO: ${failure}`).join('\n'));process.exit(1);}
for(const [label] of checks) console.log(`OK: ${label}`);
console.log(`OK: Fase 8 valida ${checks.length} condiciones de Chrome Web Store y apertura del panel.`);
