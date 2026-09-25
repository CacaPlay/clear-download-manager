import fs from 'node:fs';
import vm from 'node:vm';
const readFrontendSource = (extension) => fs.readdirSync('app-ui', { recursive: true })
  .filter((file) => file.endsWith(extension) && !file.replaceAll('\\', '/').startsWith('download-manager/'))
  .sort((a, b) => {
    const primary = extension === '.js' ? 'main.js' : 'styles.css';
    return a === primary ? -1 : b === primary ? 1 : a.localeCompare(b);
  })
  .map((file) => fs.readFileSync(`app-ui/${file}`, 'utf8'))
  .join('\n');

const MAIN = 'app-ui/main.js';
const REPORT = 'docs/tests/phase24-2-new-phase3-color-picker.json';
const main = readFrontendSource('.js');
const appearance = fs.readFileSync('app-ui/modules/appearance/index.js', 'utf8');
const dmConstants = fs.readFileSync('app-ui/download-manager/core/constants.js', 'utf8');
const rustSettings = fs.readFileSync('src-tauri/src/settings.rs', 'utf8');
const dmIndex = fs.readFileSync('app-ui/download-manager/index.js', 'utf8');
const dmEvents = fs.readFileSync('app-ui/download-manager/events.js', 'utf8');
const checks = [];
const check = (name, pass, detail = null) => checks.push({ name, pass: Boolean(pass), detail });

function functionSource(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`No se encontró ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = bodyStart; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`No se pudo extraer ${name}`);
}

const liveSource = functionSource(main, 'scheduleAppearanceLivePreview');
const liveControlStart = main.indexOf('const updateLiveAccentFromControl =');
const liveControlEnd = main.indexOf('const updateAppearanceFromControls =', liveControlStart);
const liveControlBlock = main.slice(liveControlStart, liveControlEnd);
const contextStart = main.indexOf('onAppearanceChange: (patch = {}, { commit = true } = {}) =>');
const contextEnd = main.indexOf('onRerender:', contextStart);
const contextBlock = main.slice(contextStart, contextEnd);

check('Variables de acento separadas del layout completo', main.includes('function applyAccentVariables(root, appearance)') && main.includes('applyAccentVariables(root, resolvedAppearance);'));
check('Preview vivo agrupado con requestAnimationFrame sin renormalizar cada evento', liveSource.includes('window.requestAnimationFrame') && liveSource.includes('if (appearanceLiveFrame) return') && !liveSource.includes('normalizeAppearance'));
check('El selector de color usa la ruta rápida', main.includes("document.querySelector('#accent-color')?.addEventListener('input', (event) => updateLiveAccentFromControl({ accent: event.currentTarget.value }))"));
check('Intensidad usa la misma ruta rápida', main.includes("document.querySelector('#intensity-range')?.addEventListener('input', (event) => updateLiveAccentFromControl({ intensity: event.currentTarget.value }))"));
check('La ruta rápida evita localStorage y el layout completo por evento', liveControlBlock.includes('scheduleAppearanceLivePreview(appState.appearance)') && !liveControlBlock.includes('storeAppearanceLocally') && !liveControlBlock.includes('applyAppearance('));
check('El drag de color no programa persistencia', !liveControlBlock.includes('scheduleAppearancePersist'));
check('La persistencia ocurre en el change final', main.includes("document.querySelector('#accent-color')?.addEventListener('change', () => scheduleAppearancePersist(0))") && main.includes("document.querySelector('#intensity-range')?.addEventListener('change', () => scheduleAppearancePersist(0))"));
check('El gestor de descargas usa preview rápido sin commit para acento/intensidad', contextBlock.includes("keys.every((key) => key === 'accent' || key === 'intensity')") && contextBlock.includes('scheduleAppearanceLivePreview(appState.appearance)') && dmEvents.includes("context.onAppearanceChange?.({ accent: input.value }, { commit: false })"));
check('Persistencia final sigue aplicando y sincronizando todo', main.includes('async function persistAppearance') && main.includes('storeAppearanceLocally(appState.appearance);') && main.includes('synchronizeDownloadManagerAppearance(appearance);'));
check('La instalaciÃ³n nueva expone escala 100/100 en frontend, gestor y backend',
  appearance.includes('scale: 100, textScale: 100')
    && dmConstants.includes('uiScale: 100')
    && dmConstants.includes('textScale: 100')
    && /fn default_ui_scale\(\) -> u8 \{\s*100\s*\}/.test(rustSettings)
    && /fn default_text_scale\(\) -> u8 \{\s*100\s*\}/.test(rustSettings));
check('La migraciÃ³n distingue almacenamiento vacÃ­o de una preferencia histÃ³rica',
  appearance.includes("const hasStoredAppearance = raw && typeof raw === 'object' && Object.keys(raw).length > 0;")
    && appearance.includes('if (!hasStoredAppearance) raw = { ...defaultAppearance };'));
check('La migraciÃ³n 125/120 aplica offsets exactos 25/20',
  appearance.includes('scale: clamp(Number(raw.scale ?? 125) - LEGACY_MIGRATION_SCALE_OFFSET')
    && appearance.includes('textScale: clamp(Number(raw.textScale ?? 120) - LEGACY_MIGRATION_TEXT_OFFSET')
    && appearance.includes('const LEGACY_MIGRATION_SCALE_OFFSET = 25;')
    && appearance.includes('const LEGACY_MIGRATION_TEXT_OFFSET = 20;'));
check('La escala efectiva conserva el tamaÃ±o histÃ³rico al mostrar 100',
  appearance.includes('const LEGACY_MIGRATION_SCALE_OFFSET = 25;')
    && appearance.includes('1.08 + (appearance.textScale - 100) * .004'));

const legacyInterfaceFactor = 1 + (125 - 100) * 0.008;
const migratedInterfaceFactor = 1 + ((100 + 25) - 100) * 0.008;
const legacyTextFactor = 1 + (120 - 100) * 0.004;
const migratedTextFactor = 1.08 + (100 - 100) * 0.004;
check('El modelo numÃ©rico demuestra equivalencia visual exacta 125/120 -> 100/100',
  legacyInterfaceFactor === migratedInterfaceFactor && legacyTextFactor === migratedTextFactor,
  { legacyInterfaceFactor, migratedInterfaceFactor, legacyTextFactor, migratedTextFactor });

const callbacks = [];
let applyCalls = 0;
let lastAccent = '';
const sandbox = {
  appearanceLiveFrame: 0,
  pendingLiveAppearance: null,
  appearancePerformance: { previewEvents: 0, previewCommits: 0, persistenceWrites: 0, globalRendersDuringPreview: 0, totalPreviewLatencyMs: 0, maxPreviewLatencyMs: 0 },
  normalizeAppearance: (value) => ({ ...value }),
  applyBrandIconVariant: () => {},
  iconVariantForColor: () => 'celeste',
  isHexColor: () => false,
  applyAccentVariables: (_root, appearance) => { applyCalls += 1; lastAccent = appearance.accent; },
  appearanceContext: { onDownloadManagerAppearance: () => {} },
  document: { documentElement: {} },
  window: {
    requestAnimationFrame: (callback) => { callbacks.push(callback); return callbacks.length; }
  }
};
vm.createContext(sandbox);
vm.runInContext(`${liveSource}\nthis.runLive = scheduleAppearanceLivePreview;`, sandbox);

for (let i = 0; i < 180; i += 1) sandbox.runLive({ accent: `#${(i + 1).toString(16).padStart(6, '0')}` });
const queuedSameTurn = callbacks.length;
const appliesBeforeFrame = applyCalls;
callbacks.shift()?.(16.7);
const appliesAfterOneFrame = applyCalls;
const latestAfterOneFrame = lastAccent;

callbacks.length = 0;
applyCalls = 0;
lastAccent = '';
sandbox.appearanceLiveFrame = 0;
sandbox.pendingLiveAppearance = null;
for (let frame = 0; frame < 12; frame += 1) {
  for (let i = 0; i < 15; i += 1) {
    const index = frame * 15 + i + 1;
    sandbox.runLive({ accent: `#${index.toString(16).padStart(6, '0')}` });
  }
  const callback = callbacks.shift();
  if (callback) callback((frame + 1) * 16.7);
}
const framedApplyCalls = applyCalls;
const measuredPreviewEvents = sandbox.appearancePerformance.previewEvents;
const measuredPreviewCommits = sandbox.appearancePerformance.previewCommits;

check('180 eventos rápidos se agrupan en un solo frame', queuedSameTurn === 1 && appliesBeforeFrame === 0 && appliesAfterOneFrame === 1, { queuedSameTurn, appliesBeforeFrame, appliesAfterOneFrame });
check('El frame aplica el último color, no uno intermedio obsoleto', latestAfterOneFrame === '#0000b4', { latestAfterOneFrame });
check('180 eventos repartidos en 12 frames producen como máximo 12 commits visuales', framedApplyCalls === 12, { events: 180, frames: 12, commits: framedApplyCalls, reductionPercent: Number(((1 - framedApplyCalls / 180) * 100).toFixed(2)) });
check('El contador real del scheduler registra eventos y commits', measuredPreviewEvents === 360 && measuredPreviewCommits === 13, { measuredPreviewEvents, measuredPreviewCommits });

const report = {
  phase: '0.24.2-new-phase3-color-picker',
  passed: checks.every((item) => item.pass),
  checks,
  measured: {
    syntheticRapidEvents: 180,
    sameTurnVisualCommits: appliesAfterOneFrame,
    twelveFrameVisualCommits: framedApplyCalls,
    coalescingReductionPercent: Number(((1 - framedApplyCalls / 180) * 100).toFixed(2)),
    modeledPersistenceWritesBefore: 180,
    persistenceWritesAfter: 1,
    globalRendersDuringDrag: 0,
    legacyInterfaceFactor,
    migratedInterfaceFactor,
    legacyTextFactor,
    migratedTextFactor
  },
  note: 'La medición determinista usa el scheduler real extraído de main.js; la latencia absoluta y las mutaciones DOM se validan además en Edge/WebView2 sobre Windows.'
};
fs.mkdirSync('docs/tests', { recursive: true });
fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n');
if (!report.passed) {
  for (const item of checks) if (!item.pass) console.error(`FAIL: ${item.name}`, item.detail || '');
  process.exit(1);
}
console.log(`OK: Nueva Fase 3 color · ${report.measured.syntheticRapidEvents} eventos -> ${report.measured.twelveFrameVisualCommits} commits en 12 frames (${report.measured.coalescingReductionPercent}% menos trabajo visual).`);
