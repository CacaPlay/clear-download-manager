import assert from 'node:assert/strict';
import fs from 'node:fs';

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const tauriConfig = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));

assert.equal(
  packageJson.scripts['build:local'],
  'tauri build --no-bundle',
  'build:local must use Tauri build and skip installer bundling',
);
assert.equal(
  tauriConfig.build.beforeBuildCommand,
  'npm run build:web',
  'Tauri local builds must compile the frontend before the Rust app',
);
assert.equal(
  tauriConfig.build.frontendDist,
  '../dist',
  'Tauri local builds must embed the generated frontend directory',
);
assert.match(
  tauriConfig.build.devUrl,
  /^http:\/\/127\.0\.0\.1:4173\//,
  'The loopback URL is reserved for the configured development server',
);

console.log('PASS: local app builds use the Tauri CLI and embed dist without bundling an installer.');
