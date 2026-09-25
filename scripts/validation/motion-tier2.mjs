import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const tier1 = read('app-ui/styles/motion-tier1.css');
const tier2 = read('app-ui/styles/motion-tier2.css');
const styles = read('app-ui/styles.css');
const coordinator = read('app-ui/modules/motion/coordinator.js');
const composition = read('app-ui/modules/composition/index.js');
const sidebar = read('app-ui/download-manager/view/zen-sidebar.js');
const shared = read('app-ui/download-manager/view/shared.js');
const unified = read('app-ui/download-manager/view/unified.js');
const live = read('app-ui/download-manager/live.js');
const dmOverrides = read('app-ui/download-manager/styles/05-overrides.css');
const dmComponents = read('app-ui/download-manager/styles/03-components.css');
const downloadsStyles = read('app-ui/modules/downloads/styles.css');
const subwindow = read('app-ui/subwindow.js');
const player = read('app-ui/player/player.js');
const playerStyles = read('app-ui/player/player.css');
const failures = [];
const check = (label, value) => { if (!value) failures.push(label); };

check('Tier 2 se importa después de Tier 1', styles.indexOf("./styles/motion-tier1.css") < styles.indexOf("./styles/motion-tier2.css"));
check('coordinador usa feature detection real', coordinator.includes("typeof document?.startViewTransition === 'function'"));
check('coordinador limita transición document-level activa', coordinator.includes('if (activeTransition) finishActiveTransition()') && coordinator.includes('activeTransition = transition'));
check('coordinador aplica update aunque falle la transición', coordinator.includes('try { update(); } finally { onFallback?.(); }'));
check('navbar no tiene indicador compartido', !sidebar.includes('dm-nav-selection-indicator') && !composition.includes('syncNavSelectionIndicator') && !tier2.includes('view-transition-name: cdm-nav-indicator;'));
check('navbar usa activación local dentro de 72px', tier2.includes('.dm-zen-nav > nav > button::before') && tier2.includes('width: 72px !important;') && tier2.includes('left: 0;') && tier2.includes('width: 3px;') && tier2.includes('height: 68%;'));
check('section tiene nombre View Transition único por superficie', tier2.includes('view-transition-name: cdm-section-surface;'));
check('settings usa una superficie direccional separada', composition.includes('runSettingsCategoryTransition') && composition.includes('settingsCategoryChanged') && tier2.includes('cdm-settings-panel'));
check('theme usa origen del control y fallback', coordinator.includes('themeOrigin') && coordinator.includes('motion-theme-fallback-overlay'));
check('theme no toca la autoridad del icono nativo', !coordinator.includes('setIcon') && !coordinator.includes('applyNativeApplicationIcon'));
check('progress tiene ratio compositor-friendly', shared.includes('--dm-progress-ratio') && tier2.includes('transform: scaleX(var(--dm-progress-ratio, 1));'));
check('live patch sincroniza ratio sin reemplazar la fila', live.includes("getPropertyValue('--dm-progress-ratio')") && live.includes('patchProgressContent'));
check('processing queda en una única barra localizada', unified.includes('dm-progress-processing is-indeterminate') && unified.includes("processing ? ' is-processing'") && !unified.includes('dm-processing-indicator') && !tier2.includes('is-analyzing'));
check('Tier 1 no anima la fila completa al completar/error', !/\.dm-download-item\[data-status-transition="(?:completed|error)"\]\s*,[\s\S]{0,180}?\banimation\s*:/.test(tier1));
check('Tier 2 no declara transition: all', !/transition\s*:\s*all\b/i.test(tier2));
check('Tier 2 no declara will-change', !/\bwill-change\s*:/i.test(tier2));
check('theme tiene collapse circular y fallback', tier2.includes('--motion-theme-duration: 350ms;') && tier2.includes('cdm-motion-theme-collapse') && tier2.includes('cdm-motion-theme-fallback-collapse') && tier2.includes('clip-path: circle(150vmax'));
check('theme separa navegación y protege la geometría', composition.includes('themeTransitioning') && /data-theme-transitioning="true"\]\s+#app\[data-motion-navigation="true"\]/.test(tier2) && tier2.includes('transform: none !important;'));
check('navbar no conserva rails/superficies legacy', !tier2.includes('dm-nav-selection-indicator') && tier2.includes('button.is-active::before'));
check('botones tienen press/release explícitos', tier2.includes('--motion-button-press-duration: 105ms;') && tier2.includes('--motion-button-release-duration: 145ms;') && tier2.includes('translateY(1.5px) scale(.985)'));
check('selección queda entre 140 y 190 ms', tier2.includes('--motion-selection-duration: 170ms;') && tier2.includes('transition-duration: var(--motion-selection-duration);'));
check('shine antiguo eliminado', !dmOverrides.includes('dm-update-attention') && !downloadsStyles.includes('progress-shimmer'));
check('processing usa ciclo lineal de dos endpoints', dmComponents.includes('animation: cdm-processing-travel .9s linear infinite !important;') && /@keyframes cdm-processing-travel[\s\S]*from\s*\{\s*transform:\s*translateX\(-100%\);\s*\}[\s\S]*to\s*\{\s*transform:\s*translateX\(357\.142857%\);/.test(dmComponents) && !/cdm-processing-travel[\s\S]*22%/.test(dmComponents));
check('floating roots permanecen sin transform', tier2.includes('.floating-position-root,') && tier2.includes('transform: none !important;') && tier2.includes('floating-position-root > .motion-inner'));
check('preparación y player comparten press/release', tier2.includes('data-subwindow') && playerStyles.includes('Final motion pass for the player WebView controls') && playerStyles.includes('transition-duration: 145ms;') && playerStyles.includes('transition-duration: 105ms;'));
check('reduced/off tiene autoridad final', tier2.includes('data-motion-mode="reduced"') && tier2.includes('data-motion-mode="off"') && tier2.includes('animation: none'));
check('subwindow revela solo WebView tras render', subwindow.includes("document.body.classList.add('subwindow-ready')") && tier2.includes('subwindow-ready'));
check('player conserva entrada WebView-only', player.includes("document.body.classList.add('player-ready')"));

if (failures.length) {
  console.error(failures.map((failure) => `FAIL: ${failure}`).join('\n'));
  process.exit(1);
}
console.log('OK: Motion Tier 2 static gate passed (coordinator, three signatures, continuity, cleanup, reduced/off).');
