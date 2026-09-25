import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const json = (path) => JSON.parse(read(path));

const packageVersion = json('package.json').version;
const appManifest = json('src-tauri/tauri.conf.json');
const storeConfig = json('src-tauri/tauri.store.conf.json');
const extension = json('extension/manifest.json');
const compatibility = json('extension/app-compat.json');
const identity = json('evidence/official-public-key.json');
const extensionConfig = json('src-tauri/resources/extension/extension-config.json');
const publicId = 'aonppfnabjnicjjeoofkfjofolfibggp';
const hostName = 'lat.cacaplay.cacatools.downloadmanager';
const storeAppId = 'CacaPlay.CacaToolsDownloadManager_b9fexpwkvxe1m!CacaTools';
const sourceId = [...createHash('sha256').update(Buffer.from(identity.key, 'base64')).digest().subarray(0, 16)]
  .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');

assert.equal(identity.id, publicId, 'La identidad oficial de la extensión debe conservarse.');
assert.equal(sourceId, publicId, 'La clave de identidad debe derivar el mismo ID que la Store.');
assert.equal(extension.version, packageVersion, 'La fuente de la extensión debe estar sincronizada con la app.');
assert.equal(extensionConfig.chromiumExtensionIds?.[0], publicId, 'La app debe autorizar el ID oficial de Chrome.');
assert.equal(extensionConfig.storeAppUserModelId, storeAppId, 'El host de Store debe abrir el AUMID correcto.');
assert.ok(['chrome', 'edge', 'brave'].every((browser) => extensionConfig.browsers?.includes(browser)), 'El puente debe incluir navegadores Chromium de uso esperado.');
assert.equal(compatibility.maximumTestedAppVersion, '0.95.x', 'La extensión debe declarar compatibilidad con la versión publicada.');

const sdkCompatibility = read('extension/sdk/compatibility.js');
const desktopBridge = read('src-tauri/src/extension_bridge.rs');
const nativeHost = read('extension/native-host/src/main.rs');
const extensionManifest = read('extension/native-host/chromium-host.template.json');
assert.ok(sdkCompatibility.includes(`'${hostName}'`), 'Extensión y host deben compartir el mismo nombre Native Messaging.');
assert.match(sdkCompatibility, /PROTOCOL_VERSION\s*=\s*1/);
assert.match(desktopBridge, /BRIDGE_PROTOCOL_VERSION:\s*u32\s*=\s*1/);
assert.match(nativeHost, /"protocolVersion":\s*1/);
assert.ok(desktopBridge.includes('\\\\windowsapps\\\\'), 'La app debe detectar instalaciones MSIX para registrar el host adecuado.');
assert.ok(desktopBridge.includes('store-launch.json'), 'La instalación Store debe dar al host su AUMID de lanzamiento.');
assert.ok(nativeHost.includes('store_app_user_model_id()'), 'El host debe abrir la edición Store cuando corresponde.');
assert.ok(JSON.parse(extensionManifest).allowed_origins?.includes(`chrome-extension://${publicId}/`), 'El host Chromium debe permitir solo el ID publicado.');

const cargo = read('src-tauri/Cargo.toml');
const rustEntry = read('src-tauri/src/lib.rs');
const storeUpdater = read('src-tauri/src/store_update_manager.rs');
const githubUpdater = read('src-tauri/src/update_manager.rs');
assert.match(cargo, /default\s*=\s*\["github-updater"\]/, 'La edición normal debe conservar el updater de GitHub.');
assert.match(cargo, /github-updater\s*=\s*\["dep:tauri-plugin-updater"\]/, 'El plugin debe activarse por feature.');
assert.match(cargo, /tauri-plugin-updater\s*=\s*\{\s*version\s*=\s*"2\.10\.1",\s*optional\s*=\s*true\s*\}/, 'El plugin updater debe ser opcional para MSIX.');
assert.ok(rustEntry.includes('#[path = "store_update_manager.rs"]') && rustEntry.includes('#[cfg(not(feature = "microsoft-store"))]'), 'Rust debe seleccionar un gestor distinto por distribución.');
assert.ok(storeUpdater.includes('store_managed: true') && storeUpdater.includes('microsoft-store'), 'La edición Store debe declarar actualizaciones administradas por Store.');
assert.ok(githubUpdater.includes('store_managed: false'), 'La edición GitHub debe seguir exponiendo su propio actualizador.');

assert.equal(storeConfig.build.frontendDist, '../dist-store');
assert.deepEqual(storeConfig.bundle.resources, ['resources/bin/*', 'resources/licenses/*', 'resources/extension/*']);
assert.equal(storeConfig.bundle.createUpdaterArtifacts, false);
assert.deepEqual(storeConfig.plugins.updater.endpoints, [], 'El Store overlay no debe incluir endpoints del updater GitHub.');
assert.ok(appManifest.bundle.resources.includes('resources/updater/*'), 'El build GitHub debe conservar sus recursos updater.');
assert.ok(appManifest.plugins.updater.endpoints.some((endpoint) => endpoint.includes('clear-download-manager/releases/latest/download/latest.json')));

const storeBuild = read('scripts/build-store-msix.ps1');
assert.ok(storeBuild.includes('--features\', \'microsoft-store\''), 'El empaquetador MSIX debe compilar la feature Store.');
assert.ok(storeBuild.includes('--no-default-features'), 'El empaquetador MSIX debe excluir el feature updater de GitHub.');
assert.ok(storeBuild.includes('Copy-Item -LiteralPath $BuiltNativeHost'), 'El MSIX debe incluir el host nativo recién construido.');
assert.ok(storeBuild.includes('will not be overwritten') && !storeBuild.includes('Remove-Item'), 'El build Store debe preservar los paquetes existentes.');
assert.ok(storeBuild.includes('extension-config.json') && storeBuild.includes('storeAppUserModelId'), 'El paquete final debe comprobar la configuración de extensión de Store.');
assert.ok(!storeBuild.includes('$ExtensionZip'), 'El build de la app Store no debe depender de un ZIP de Chrome Web Store.');
assert.ok(storeBuild.includes('native-host-handshake.mjs'), 'El empaquetador debe probar el handshake del host que acaba de compilar.');

const frontend = read('app-ui/main.js');
const settings = read('app-ui/download-manager/view/shared.js');
const html = read('index.html');
const webBuilder = read('scripts/build.mjs');
assert.ok(html.includes('name="cdm-distribution"'), 'El frontend debe identificar la edición compilada.');
assert.ok(webBuilder.includes('CDM_BUILD_DISTRIBUTION') && webBuilder.includes('__CDM_BUILD_DISTRIBUTION__'), 'El build web debe escribir el flavor elegido.');
assert.ok(frontend.includes('storeManagedDistribution') && frontend.includes('appState.updaterStatus?.storeManaged'), 'El frontend Store debe bloquear comprobación e instalación GitHub.');
assert.ok(settings.includes('updater.storeManaged') && settings.includes('Actualizaciones de Microsoft Store'), 'La UI Store debe explicar que las actualizaciones se gestionan en Store.');

console.log('OK: separación estructural GitHub/MSIX y compatibilidad de identidad, AUMID y protocolo de la extensión verificadas. No sustituye una prueba real en Partner Center o Brave.');
