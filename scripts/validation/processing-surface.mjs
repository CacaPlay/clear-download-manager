import assert from 'node:assert/strict';
import fs from 'node:fs';

const unified = fs.readFileSync('app-ui/download-manager/view/unified.js', 'utf8');
const styles = fs.readFileSync('app-ui/download-manager/styles/03-components.css', 'utf8');
assert.match(unified, /dm-item-progress\$\{processing \? ' is-processing'/);
assert.match(unified, /dm-progress-processing is-indeterminate/);
assert.doesNotMatch(unified, /dm-processing-indicator/);
assert.match(unified, /processing \? '' : `<strong>\$\{escapeHtml\(transferPrimary\)\}/);
assert.match(styles, /\.dm-item-transfer\.is-processing \{ display: none/);
assert.match(styles, /\.dm-item-progress\.is-processing \.dm-progress-processing/);
assert.match(styles, /@keyframes cdm-processing-travel/);
assert.match(styles, /animation: cdm-processing-travel \.9s linear infinite/);
assert.match(styles, /22%\s*\{\s*transform: translateX\(0\)/);
assert.match(styles, /78%\s*\{\s*transform: translateX\(100%\)/);
assert.match(styles, /data-motion-mode="reduced"/);
assert.doesNotMatch(styles, /\.dm-processing-indicator/);
console.log('PASS: processing/finalizing uses one indeterminate progress track and never overlays a transfer bar or spinner.');
