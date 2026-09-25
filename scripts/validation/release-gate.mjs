import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Current release gate for the 0.95.x line.
 *
 * `npm run check` is intentionally not called here: it is a historical
 * aggregator that still contains 0.24/0.25 fixtures and visual reports which
 * are not part of the current release contract. Those failures remain useful
 * baseline evidence, but must not block a release that has passed the current
 * focused contracts below.
 */
export const releaseGateIds = [
  'version:check',
  'check:licenses',
  'check:rights',
  'check:gpl-source',
  'check:asset-rights',
  'check:asset-provenance',
  'check:encoding',
  'check:download-order',
  'check:floating-menu-placement',
  'check:motion-tier1',
  'check:motion-tier2',
  'check:speed-limit-ui',
  'check:quality-selection',
  'check:file-type-labels',
  'check:local-player-cmp',
  'check:native-icon-authority',
  'check:icons',
  'check:functional-optimization',
  'check:subwindows',
  'check:http-resume-integrity',
  'check:http-finalization',
  'check:http-single-writer',
  'check:catalog-safety',
  'check:extension',
  'check:extension-modules',
  'check:browser-capture',
  'check:video-detector',
  'check:extension-sync',
  'check:extension-ui',
  'check:extension-management',
  'check:extension-brand-sync',
];

const windows = process.platform === 'win32';
const npm = windows ? (process.env.ComSpec || 'cmd.exe') : 'npm';
const scriptPath = fileURLToPath(import.meta.url);

function runReleaseGate() {
  const failures = [];

  for (const gate of releaseGateIds) {
    console.log(`\n== release gate: ${gate} ==`);
    const args = windows
      ? ['/d', '/s', '/c', `npm.cmd run ${gate} --silent`]
      : ['run', gate, '--silent'];
    const result = spawnSync(npm, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
      windowsHide: windows,
    });
    if (result.error) {
      failures.push(`${gate}: ${result.error.message}`);
    } else if (result.status !== 0) {
      failures.push(`${gate}: exit ${result.status}`);
    }
  }

  if (failures.length > 0) {
    console.error('\nRELEASE GATE FAILED');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nRELEASE GATE PASSED: ${releaseGateIds.length} current-contract checks`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) runReleaseGate();
