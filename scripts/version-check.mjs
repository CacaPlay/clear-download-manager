import fs from 'node:fs';

const read = (file) => fs.readFileSync(file, 'utf8');
const packageJson = JSON.parse(read('package.json'));
const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
const cargo = read('src-tauri/Cargo.toml');
// Cargo may write CRLF on Windows; normalize before checking the package stanza
// so line-ending style is not reported as a source inconsistency.
const lock = read('src-tauri/Cargo.lock').replace(/\r\n/g, '\n');
const main = read('app-ui/main.js');
const manifest = JSON.parse(read('extension/manifest.json'));
const extensionCompatibility = JSON.parse(read('extension/app-compat.json'));
const version = packageJson.version;
const errors = [];
const semver = (value) => String(value || '').split('.').map((part) => Number(part));
const compareSemver = (left, right) => {
  const a = semver(left); const b = semver(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
};
if (!/^\d+\.\d+\.\d+$/.test(version)) errors.push(`package.json no usa SemVer: ${version}`);
if (tauri.version !== version) errors.push(`tauri.conf.json usa ${tauri.version}, esperaba ${version}`);
if (!cargo.includes(`version = "${version}"`)) errors.push('Cargo.toml no coincide');
if (!lock.includes(`name = "cacatools-desktop"\nversion = "${version}"`)) errors.push('Cargo.lock no coincide');
if (!main.includes(`const APP_VERSION = '${version}'`)) errors.push('APP_VERSION no coincide');
if (!main.includes(`CDM-${version}-`)) errors.push('BUILD_ID no coincide');
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) errors.push(`manifest de extensión no usa SemVer: ${manifest.version}`);
if (Object.prototype.hasOwnProperty.call(manifest, 'minimumAppVersion') || Object.prototype.hasOwnProperty.call(manifest, 'maximumTestedAppVersion')) {
  errors.push('manifest de extensión contiene claves de compatibilidad no admitidas por Chrome');
}
if (!/^\d+\.\d+\.\d+$/.test(extensionCompatibility.minimumAppVersion)) errors.push(`app-compat.json minimumAppVersion no usa SemVer: ${extensionCompatibility.minimumAppVersion}`);
if (compareSemver(extensionCompatibility.minimumAppVersion, version) > 0) errors.push(`minimumAppVersion ${extensionCompatibility.minimumAppVersion} supera la aplicación ${version}`);
const pendingMaximum = '0.45.x';
const certifiedMaximum = `${version.split('.').slice(0, 2).join('.')} .x`.replace(' ', '');
if (![pendingMaximum, certifiedMaximum].includes(extensionCompatibility.maximumTestedAppVersion)) {
  errors.push(`maximumTestedAppVersion no reconocido: ${extensionCompatibility.maximumTestedAppVersion}`);
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
const compatibility = extensionCompatibility.maximumTestedAppVersion === pendingMaximum
  ? `compatibilidad de escritorio pendiente (${pendingMaximum})`
  : `compatibilidad certificada (${extensionCompatibility.maximumTestedAppVersion})`;
console.log(`OK: aplicación ${version}; extensión oficial ${manifest.version}; ${compatibility}; Build ID CDM-${version}-*`);
