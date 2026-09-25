import fs from 'node:fs';

const css = fs.readFileSync('app-ui/styles/motion-tier1.css', 'utf8');
const base = fs.readFileSync('app-ui/styles/01-base.css', 'utf8');
const main = fs.readFileSync('app-ui/main.js', 'utf8');
const shared = fs.readFileSync('app-ui/download-manager/view/shared.js', 'utf8');
const unified = fs.readFileSync('app-ui/download-manager/view/unified.js', 'utf8');
const live = fs.readFileSync('app-ui/download-manager/live.js', 'utf8');
const composition = fs.readFileSync('app-ui/modules/composition/index.js', 'utf8');
const failures = [];
const check = (label, value) => { if (!value) failures.push(label); };

for (const [name, value] of [
  ['--motion-duration-fast', '140ms'],
  ['--motion-duration-standard', '205ms'],
  ['--motion-duration-emphasis', '250ms'],
  ['--motion-ease-standard', 'cubic-bezier(.2, .8, .2, 1)'],
  ['--motion-ease-enter', 'cubic-bezier(.16, 1, .3, 1)'],
  ['--motion-ease-exit', 'cubic-bezier(.4, 0, 1, 1)'],
  ['--motion-ease-emphasis', 'cubic-bezier(.16, 1, .3, 1)'],
  ['--motion-distance-sm', '4px'],
  ['--motion-distance-md', '8px'],
  ['--motion-delay-xs', '25ms'],
  ['--motion-delay-sm', '45ms'],
  ['--motion-press-scale', '.988']
]) check(`token ${name}=${value}`, css.includes(`${name}: ${value};`));

check('no transition: all in the Tier 1 stylesheet', !/transition\s*:\s*all\b/i.test(css));
check('no permanent will-change in the Tier 1 stylesheet', !/will-change\s*:/i.test(css));
check('legacy button ripple is removed', !base.includes('button-ripple') && !main.includes('button-ripple'));
check('floating roots are explicitly non-transforming', css.includes('.floating-position-root') && css.includes('transform: none !important;'));
check('floating visuals use motion-inner', shared.includes('floating-position-root') && shared.includes('motion-inner'));
check('dialogs keep backdrop root separate from visual inner', shared.includes('dm-modal-backdrop floating-position-root') && shared.includes('dm-modal motion-inner'));
check('download rows expose a stable state attribute', unified.includes('data-dm-state="${escapeHtml(job.status)}"'));
check('download rows expose visual state and transition contract', unified.includes('data-dm-visual-state="${escapeHtml(visualState)}"') && live.includes('data-status-transition') && live.includes('previousVisualStateByJobId'));
check('live patches keep state attributes in sync', live.includes('function syncVisualStateAttributes') && live.includes('row.dataset.dmState = next.dataset.dmState') && live.includes('row.dataset.dmVisualState = next.dataset.dmVisualState') && live.includes('row.dataset.dmProcessing = next.dataset.dmProcessing'));
check('state transitions only trigger after a real visual-state change', live.includes('if (previous !== nextVisualState) triggerStatusTransition'));
check('navigation entry is gated by section changes', composition.includes('dataset.motionNavigation') && composition.includes('lastRenderedSection'));
check('section entry targets the current DOM', css.includes('.dm-zen-content') && css.includes('.settings-view'));
check('final polish pattern set exists', ['motion-fade', 'motion-reveal', 'motion-slide-fade', 'motion-crossfade', 'motion-press', 'motion-status-enter', 'motion-status-complete', 'motion-status-error'].every((name) => css.includes(`.${name}`)));
check('status transition keyframes cover required states', ['queued', 'downloading', 'paused', 'resumed', 'finalizing', 'completed', 'error', 'retry'].every((state) => css.includes(`data-status-transition="${state}"`)));
check('reduced motion preserves state but disables animation', css.includes('data-motion-mode="reduced"') && css.includes('animation: none !important;'));

if (failures.length) {
  console.error(failures.map((failure) => `FAIL: ${failure}`).join('\n'));
  process.exit(1);
}
console.log('OK: Tier 1 CSS/markup gate passed (tokens, floating roots, state gating, reduced motion).');
