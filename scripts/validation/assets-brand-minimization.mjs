import fs from 'node:fs';

const read = (file) => fs.readFileSync(file, 'utf8');
const subwindow = read('app-ui/subwindow.js');
const build = read('scripts/build.mjs');
const readme = read('README.md');
const notice = read('NOTICE.md');
const audit = read('docs/ASSET-MARKS-AUDIT.md');
const windowsBuild = read('scripts/build-windows-beta.ps1');
const resolvedAssets = [
  'app-ui/assets/platforms/YouTube_23392.ico',
  'app-ui/assets/platforms/youtube.ico',
  'app-ui/assets/platforms/twitter.ico',
  'app-ui/assets/platforms/tiktok.png',
  'app-ui/assets/platforms/spotify_logo_icon_170709.ico',
  'app-ui/assets/platforms/spotify.ico',
  'app-ui/assets/platforms/pinterest_19134.ico',
  'app-ui/assets/platforms/pinterest.ico',
  'app-ui/assets/platforms/media_social_tiktok_icon_124256.ico',
  'app-ui/assets/platforms/instagram_logo_icon_168715.ico',
  'app-ui/assets/platforms/instagram.ico',
  'app-ui/assets/platforms/facebook.ico',
  'app-ui/assets/platforms/4202110facebooklogosocialsocialmedia-115707_115594.ico',
  'app-ui/assets/file-types/docs.png',
  'app-ui/assets/file-types/powerpoint.png',
  'app-ui/assets/file-types/pdf.png',
  'docs/assets/chrome-web-store.png',
  'docs/assets/microsoft-store.png',
  'docs/assets/windows-11-logo.png',
  'docs/assets/download-buttons/chrome-web-store-light.png',
  'docs/assets/download-buttons/chrome-web-store-dark.png',
  'docs/assets/download-buttons/microsoft-store-light.png',
  'docs/assets/download-buttons/microsoft-store-dark.png',
  'docs/assets/download-buttons/windows-light.png',
  'docs/assets/download-buttons/windows-dark.png',
  'docs/assets/download-cards/chrome-web-store.svg',
  'docs/assets/download-cards/microsoft-store.svg',
  'docs/assets/download-cards/windows.svg',
  'src-tauri/icons/64x64.png',
  'src-tauri/icons/icon.icns',
  'src-tauri/icons/Square30x30Logo.png',
  'src-tauri/icons/Square310x310Logo.png',
  'src-tauri/icons/app-icon.svg',
  'app-ui/favicon.svg',
  'app-ui/media-preview.svg',
  'src-tauri/icons/Square71x71Logo.png',
  'src-tauri/icons/Square89x89Logo.png',
  'src-tauri/icons/Square107x107Logo.png',
  'src-tauri/icons/Square142x142Logo.png',
  'src-tauri/icons/Square284x284Logo.png',
];
const retainedReadmeButtons = [
  'docs/assets/download-buttons/chrome-web-store-light.png',
  'docs/assets/download-buttons/chrome-web-store-dark.png',
  'docs/assets/download-buttons/microsoft-store-light.png',
  'docs/assets/download-buttons/microsoft-store-dark.png',
  'docs/assets/download-buttons/windows-light.png',
  'docs/assets/download-buttons/windows-dark.png',
];
const retiredAssets = resolvedAssets.filter((file) => !retainedReadmeButtons.includes(file));
const legacyMobileIconDirectories = ['src-tauri/icons/android', 'src-tauri/icons/ios'];
const currentWindowsIcons = [
  'src-tauri/icons/32x32.png',
  'src-tauri/icons/128x128.png',
  'src-tauri/icons/128x128@2x.png',
  'src-tauri/icons/icon.ico',
];
const currentStoreIcons = ['StoreLogo.png', 'Square44x44Logo.png', 'Square150x150Logo.png'];
const uiFallbackSources = [
  ['app-ui/main.js', './app-ui/assets/brand/clear-download-manager-celeste.webp'],
  ['app-ui/subwindow.js', './assets/brand/clear-download-manager-celeste.webp'],
  ['app-ui/player/index.html', '../assets/brand/clear-download-manager-celeste.webp'],
  ['app-ui/player/player.js', '../assets/brand/clear-download-manager-celeste.webp'],
];
const fallbackLogo = 'app-ui/assets/brand/clear-download-manager-celeste.webp';
const tauriConfig = JSON.parse(read('src-tauri/tauri.conf.json'));
const checks = [
  ['La ventana de preparación usa el icono genérico local y muestra el host', !subwindow.includes('assets/platforms/') && /return \['http', host\.replace\(\/\^www\\\.\//.test(subwindow) && subwindow.includes("icon('link', 18)")],
  ['La compilación excluye los logos de servicios, los iconos obsoletos y las copias PNG con pareja WebP', build.includes("assetPath === 'platforms'") && ['file-types/docs.png', 'file-types/powerpoint.png', 'file-types/pdf.png'].every((file) => build.includes(`'${file}'`)) && build.includes("entry.name.toLowerCase().endsWith('.png')") && build.includes("from.replace(/\\.png$/i, '.webp')")],
  ['El build Windows ya no exige logos retirados del paquete web', !windowsBuild.includes('app-ui\\assets\\platforms\\') && !windowsBuild.includes('platformLogos')],
  ['El README enlaza cada tienda/instalador con sus seis variantes de botón autorizadas', retainedReadmeButtons.every((file) => readme.includes(file) && fs.existsSync(file) && audit.split('\n').some((line) => line.includes(`\`${file}\``) && line.endsWith('| KEEP_WITH_DOCUMENTED_RIGHTS |'))) && readme.includes('Microsoft Store') && readme.includes('Chrome Web Store')],
  ['El aviso separa marcas de terceros de la licencia del código', notice.includes('app-ui/assets/brand/') && notice.includes('Third-party components')],
  ['Los assets retirados siguen ausentes y los medios del README están separados del inventario histórico', retiredAssets.every((file) => !fs.existsSync(file)) && retiredAssets.every((file) => audit.includes(`\`${file}\``)) && retainedReadmeButtons.every((file) => fs.existsSync(file)) && /238 iniciales[\s\S]*67 retiradas[\s\S]*175 imágenes actuales/.test(audit)],
  ['Las carpetas Android/iOS marcadas se retiraron completas', legacyMobileIconDirectories.every((directory) => !fs.existsSync(directory)) && legacyMobileIconDirectories.every((directory) => audit.includes(`\`${directory}/\``))],
  ['Tauri Windows y MSIX conservan sus iconos actuales sin tachar', currentWindowsIcons.every((file) => fs.existsSync(file)) && currentWindowsIcons.every((file) => tauriConfig.bundle.icon.includes(file.replace('src-tauri/', ''))) && currentStoreIcons.every((file) => fs.existsSync(`src-tauri/icons/${file}`)) && currentStoreIcons.every((file) => read('scripts/build-store-msix.ps1').includes(`'${file}'`))],
  ['La app y el player conservan el fallback usando el logo Clear', fs.existsSync(fallbackLogo) && uiFallbackSources.every(([file, source]) => read(file).includes(source) && !read(file).includes('media-preview.svg'))]
];

for (const [label, pass] of checks) console.log(`${pass ? 'OK' : 'FAIL'}: ${label}`);
if (checks.some(([, pass]) => !pass)) process.exit(1);
console.log(`OK: ${checks.length} condiciones de assets, marcas y empaquetado.`);
