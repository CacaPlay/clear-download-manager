import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { invokeWithOptionalComponent, renderInlineOptionalComponentPrompt, requestComponentManagerInstall } from '../../app-ui/modules/components/optional-install.js';
import { configureExtension, queueExtensionSourceInBackground } from '../../app-ui/modules/extension/index.js';
import { videoSearchDialog } from '../../app-ui/download-manager/view/dialogs.js';
import { unifiedSuggestionPanelMarkup } from '../../app-ui/download-manager/view/unified.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('main capability grants dialog confirm without broader dialog permissions', async () => {
  const capability = JSON.parse(await readFile(path.join(repositoryRoot, 'src-tauri/capabilities/main-capability.json'), 'utf8'));
  const dialogPermissions = capability.permissions.filter(permission => permission.startsWith('dialog:'));
  assert.deepEqual(dialogPermissions, ['dialog:allow-confirm']);
});

const mediaMissing = new Error('CDM_MISSING_CAPABILITY:media-extraction');
const torrentMissing = new Error('CDM_MISSING_CAPABILITY:bittorrent');

function promptInfo(componentId, capability, installed = false, packageBytes = undefined) {
  return { componentId, label: componentId === 'media-tools' ? 'MediaTools' : 'Torrent Engine', capability, purpose: componentId === 'media-tools' ? 'Descarga y procesamiento de medios' : 'Descargas BitTorrent', installed, packageBytes };
}

function withBrowser(overrides = {}) {
  const previous = globalThis.window;
  globalThis.window = overrides.window;
  return () => { globalThis.window = previous; };
}

test('missing MediaTools requires consent, installs the fixed catalog component, then retries once', async () => {
  const calls = [];
  let installed = false;
  let presented;
  const args = { url: 'https://example.test/video' };
  const result = await invokeWithOptionalComponent(async (command, payload) => {
    calls.push([command, payload]);
    if (command === 'component_prompt_info') return promptInfo('media-tools', 'media-extraction', false, 88_670_040);
    if (command === 'install_component_from_catalog') { installed = true; return; }
    if (!installed) throw mediaMissing;
    return 'queued';
  }, 'queue_media_download_secure', args, { promptInstall: info => { presented = info; return true; } });
  assert.equal(result, 'queued');
  assert.deepEqual(calls.map(([command]) => command), [
    'queue_media_download_secure', 'component_prompt_info', 'install_component_from_catalog', 'queue_media_download_secure'
  ]);
  assert.deepEqual(calls[2][1], { id: 'media-tools' });
  assert.equal(calls[0][1], args);
  assert.equal(calls[3][1], args);
  assert.equal(presented.packageBytes, 88_670_040);
  assert.equal(presented.purpose, 'Descarga y procesamiento de medios');
});

test('free-text unified search shows the capability prompt inside video results', () => {
  const markup = unifiedSuggestionPanelMarkup({
    unifiedQuery: 'anime amv',
    unifiedFocused: true,
    unifiedSuggestionBusy: false,
    unifiedSuggestions: [],
    unifiedComponentPrompt: promptInfo('media-tools', 'media-extraction', false, 88_670_040)
  }, 'anime amv');
  assert.match(markup, /RESULTADOS DE VÍDEO/);
  assert.match(markup, /MediaTools/);
  assert.match(markup, /Descarga y procesamiento de medios/);
  assert.match(markup, /88\.7 MB/);
  assert.match(markup, /Descargar e instalar/);
  assert.match(markup, /Cancelar/);
});

test('free-text unified search omits the prompt when no missing component is reported', () => {
  const markup = unifiedSuggestionPanelMarkup({
    unifiedQuery: 'anime amv',
    unifiedFocused: true,
    unifiedSuggestionBusy: false,
    unifiedSuggestions: [],
    unifiedComponentPrompt: null
  }, 'anime amv');
  assert.match(markup, /RESULTADOS DE VÍDEO/);
  assert.doesNotMatch(markup, /Se necesita MediaTools/);
});

test('primary free-text suggestion requests use capability-aware install and retry', async () => {
  const source = await readFile(path.join(repositoryRoot, 'app-ui/download-manager/search.js'), 'utf8');
  assert.match(source, /invokeWithOptionalComponent\([\s\S]*?search_video_suggestions_page/);
  assert.doesNotMatch(source, /context\.invoke\?\.\(\s*'search_video_suggestions_page'/);
});

test('inline MediaTools prompt omits size when no validated package size exists', () => {
  const markup = renderInlineOptionalComponentPrompt({
    label: 'MediaTools', purpose: 'Descarga y procesamiento de medios', packageBytes: undefined
  });
  assert.match(markup, /MediaTools/);
  assert.doesNotMatch(markup, /MB|KB|bytes/i);
});

test('video search results show the missing MediaTools invitation inline', () => {
  const markup = videoSearchDialog({
    videoSearchBusy: false,
    videoSearchQuery: 'sample query',
    videoSearchResults: [],
    videoSearchComponentPrompt: {
      label: 'MediaTools', purpose: 'Descarga y procesamiento de medios', packageBytes: 88_670_040
    }
  });
  assert.match(markup, /class="dm-search-results"[^>]*>[\s\S]*MediaTools/);
  assert.match(markup, /Descarga y procesamiento de medios/);
  assert.match(markup, /88\.7 MB/);
  assert.match(markup, /Descargar e instalar/);
  assert.match(markup, /Cancelar/);
});

test('video search progress displays only measured bytes, ratio, and speed', () => {
  const markup = videoSearchDialog({
    videoSearchBusy: true,
    videoSearchQuery: 'anime amv',
    videoSearchResults: [],
    videoSearchProgress: {
      componentId: 'media-tools', phase: 'download', bytesDownloaded: 42_300_000,
      totalBytes: 88_700_000, progressRatio: 0.477, bytesPerSecond: 2_000_000
    }
  });
  assert.match(markup, /Descargando MediaTools/);
  assert.match(markup, /42\.3 MB \/ 88\.7 MB/);
  assert.match(markup, /48%/);
  assert.match(markup, /2\.0 MB\/s/);
  assert.doesNotMatch(markup, /NaN/);
});

test('unknown component download size shows bytes without a fabricated percentage', () => {
  const markup = videoSearchDialog({
    videoSearchBusy: true,
    videoSearchResults: [],
    videoSearchProgress: { componentId: 'torrent-engine', phase: 'download', bytesDownloaded: 1234 }
  });
  assert.match(markup, /1\.2 KB descargados/);
  assert.doesNotMatch(markup, /%|<progress[^>]+value=/);
});

test('verify install and activate phases stay factual and do not inherit download progress', () => {
  const cases = [
    ['verify', 'Verificando integridad MediaTools'],
    ['install', 'Instalando MediaTools'],
    ['activate', 'Activando componente MediaTools']
  ];
  for (const [phase, label] of cases) {
    const markup = videoSearchDialog({
      videoSearchBusy: true,
      videoSearchResults: [],
      videoSearchProgress: {
        componentId: 'media-tools', phase, bytesDownloaded: 88_700_000,
        totalBytes: 88_700_000, progressRatio: 1, bytesPerSecond: 2_000_000
      }
    });
    assert.match(markup, new RegExp(label));
    assert.doesNotMatch(markup, /<progress|100%|MB \/|MB\/s/);
    assert.doesNotMatch(markup, /NaN/);
  }
});

test('completion shows 100 percent only when the backend reports the real completed ratio', () => {
  const markup = videoSearchDialog({
    videoSearchBusy: true,
    videoSearchResults: [],
    videoSearchProgress: {
      componentId: 'media-tools', phase: 'done', bytesDownloaded: 88_700_000,
      totalBytes: 88_700_000, progressRatio: 1
    }
  });
  assert.match(markup, /Instalado MediaTools/);
  assert.match(markup, /100%/);
  assert.match(markup, /88\.7 MB \/ 88\.7 MB/);
});

test('invalid overrun data never renders a completed transfer percentage', () => {
  const markup = videoSearchDialog({
    videoSearchBusy: true,
    videoSearchResults: [],
    videoSearchProgress: {
      componentId: 'media-tools', phase: 'download', bytesDownloaded: 88_700_001,
      totalBytes: 88_700_000, progressRatio: 1
    }
  });
  assert.match(markup, /88\.7 MB \/ 88\.7 MB/);
  assert.doesNotMatch(markup, /100%/);
});

test('invalid oversized speed data does not produce an empty speed suffix', () => {
  const markup = videoSearchDialog({
    videoSearchBusy: true,
    videoSearchResults: [],
    videoSearchProgress: {
      componentId: 'media-tools', phase: 'download', bytesDownloaded: 1,
      bytesPerSecond: Number.MAX_SAFE_INTEGER * 2
    }
  });
  assert.doesNotMatch(markup, /<span>\/s<\/span>/);
  assert.doesNotMatch(markup, /NaN/);
});

test('terminal component install failure stops progress and leaves search retry available', () => {
  const markup = videoSearchDialog({
    videoSearchBusy: false,
    videoSearchQuery: 'anime amv',
    videoSearchResults: [],
    videoSearchProgress: { componentId: 'media-tools', phase: 'error', error: 'network failure' }
  });
  assert.match(markup, /No se pudo instalar MediaTools/);
  assert.match(markup, /data-dm-retry-video-search/);
  assert.doesNotMatch(markup, /<progress/);
  assert.match(markup, /Buscar/);
});

test('installed MediaTools does not invoke the inline prompt callback', async () => {
  let inlinePrompts = 0;
  await assert.rejects(invokeWithOptionalComponent(async command => {
    if (command === 'component_prompt_info') return promptInfo('media-tools', 'media-extraction', true);
    throw mediaMissing;
  }, 'analyze_media_url_with_session_for_window', {}, {
    beforePrompt: () => { inlinePrompts += 1; },
    promptInstall: () => { inlinePrompts += 1; return true; }
  }), error => error === mediaMissing);
  assert.equal(inlinePrompts, 0);
});

test('MediaTools modal is a centered native modal with a moderate backdrop and solid raised surface', async () => {
  const css = await readFile(path.join(repositoryRoot, 'app-ui/modules/settings/styles.css'), 'utf8');
  const prompt = await readFile(path.join(repositoryRoot, 'app-ui/modules/components/optional-install.js'), 'utf8');
  const dialogRule = css.match(/\.optional-component-dialog\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(dialogRule, /border:\s*1px solid var\(--border-subtle/);
  assert.match(dialogRule, /background:\s*var\(--surface-elevated/);
  assert.match(dialogRule, /box-shadow:/);
  assert.match(dialogRule, /position:\s*fixed/);
  assert.match(dialogRule, /inset:\s*0/);
  assert.match(dialogRule, /margin:\s*auto/);
  assert.match(css, /\.optional-component-dialog::backdrop\s*\{[^}]*background:\s*rgba\(0,\s*0,\s*0,\s*\.5\)/);
  assert.doesNotMatch(css, /optional-component-dialog::backdrop[^}]*\.78/);
  assert.match(prompt, /dialog\.showModal\(\)/);
  assert.match(prompt, /cancel\.focus\(/);
  assert.match(prompt, /aria-modal/);
  assert.doesNotMatch(prompt, /dialog\.addEventListener\(['"]click['"]/);
});

test('URL analysis uses the shared modal prompt instead of an inline state card', async () => {
  const source = await readFile(path.join(repositoryRoot, 'app-ui/subwindow.js'), 'utf8');
  const entry = source.match(/async function invokeMediaAnalysisWithRetry\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(entry, /invokeWithOptionalComponent\(/);
  assert.match(entry, /onPromptCancelled\s*:/);
  assert.match(entry, /onInstallRequested\s*:/);
  assert.match(source, /preparation_window_action['"],\s*\{\s*label:\s*windowLabel,\s*action:\s*['"]close/);
  assert.match(source, /emitTo\(['"]main['"],\s*['"]component-manager-install-request/);
  assert.doesNotMatch(source, /optionalComponentPromptResolve|optional-component-inline-state/);
});

test('accepted prompt can hand off to the existing Component Manager without starting a second install', async () => {
  const calls = [];
  let requested;
  const result = await invokeWithOptionalComponent(async command => {
    calls.push(command);
    if (command === 'component_prompt_info') return promptInfo('media-tools', 'media-extraction');
    throw mediaMissing;
  }, 'analyze_media_url_with_session_for_window', {}, {
    promptInstall: () => true,
    onInstallRequested: info => { requested = info; return true; }
  });
  assert.equal(result, undefined);
  assert.equal(requested.componentId, 'media-tools');
  assert.deepEqual(calls, ['analyze_media_url_with_session_for_window', 'component_prompt_info']);
});

test('Component Manager handoff validates the component and dispatches only a local navigation request', () => {
  const events = [];
  const restoreWindow = withBrowser({ window: { dispatchEvent: event => events.push(event) } });
  try {
    assert.equal(requestComponentManagerInstall('media-tools'), true);
    assert.equal(requestComponentManagerInstall('unknown-component'), false);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'cdm:component-manager-install-request');
    assert.deepEqual(events[0].detail, { componentId: 'media-tools' });
  } finally {
    restoreWindow();
  }
});

test('failed Component Manager handoff never falls back to a second installation path', async () => {
  const calls = [];
  await assert.rejects(invokeWithOptionalComponent(async command => {
    calls.push(command);
    if (command === 'component_prompt_info') return promptInfo('media-tools', 'media-extraction');
    throw mediaMissing;
  }, 'analyze_media_url_with_session_for_window', {}, {
    promptInstall: () => true,
    onInstallRequested: () => false
  }), error => error.code === 'CDM_OPTIONAL_COMPONENT_FLOW_STOP' && /No se pudo abrir Complementos/.test(error.message));
  assert.deepEqual(calls, ['analyze_media_url_with_session_for_window', 'component_prompt_info']);
});

test('declining the subwindow modal closes preparation and returns to main', async () => {
  const calls = [];
  await assert.rejects(invokeWithOptionalComponent(async command => {
    calls.push(command);
    if (command === 'component_prompt_info') return promptInfo('media-tools', 'media-extraction');
    throw mediaMissing;
  }, 'analyze_media_url_with_session_for_window', {}, {
    promptInstall: () => false,
    onPromptCancelled: () => { calls.push('return-to-main'); }
  }), error => error.code === 'CDM_OPTIONAL_COMPONENT_FLOW_STOP');
  assert.deepEqual(calls, ['analyze_media_url_with_session_for_window', 'component_prompt_info', 'return-to-main']);
});

test('inline invitation remains a full-width result row with quiet framing and grouped actions', async () => {
  const css = await readFile(path.join(repositoryRoot, 'app-ui/download-manager/styles/01-base.css'), 'utf8');
  const rule = css.match(/\.dm-search-results \.optional-component-inline-prompt[^}]*\{([^}]+)\}/)?.[1] || '';
  assert.match(rule, /width:\s*100%/);
  assert.match(rule, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/);
  assert.match(rule, /border:\s*1px solid var\(--dm-border-soft\)/);
  assert.doesNotMatch(rule, /var\(--dm-accent\)/);
  assert.doesNotMatch(rule, /box-shadow:(?!none)/);
  assert.match(css, /optional-component-inline-copy h2[^}]*font-size:\s*1\.(?:0[2-9]|1)rem/);
  assert.match(css, /optional-component-inline-copy p[^}]*font-size:\s*\.8[5-9]rem/);
  assert.match(css, /optional-component-inline-actions[^}]*display:\s*flex/);
});

test('inline Cancel only clears the invitation and never closes the main surface', async () => {
  const source = await readFile(path.join(repositoryRoot, 'app-ui/download-manager/search.js'), 'utf8');
  const dismiss = source.match(/\[data-action="dismiss-optional-component"\][\s\S]*?\n\s*\}\);/)?.[0] || '';
  assert.match(dismiss, /unifiedComponentPrompt = null/);
  assert.match(dismiss, /resolve\?\.\(false\)/);
  assert.doesNotMatch(dismiss, /activeSection|preparation_window_action|window\.close/);
});

test('main Component Manager opens the requested component without focusing its row and starts install', async () => {
  const main = await readFile(path.join(repositoryRoot, 'app-ui/main.js'), 'utf8');
  const settings = await readFile(path.join(repositoryRoot, 'app-ui/modules/settings/index.js'), 'utf8');
  assert.match(main, /component-manager-install-request/);
  assert.match(main, /settingsCategory\s*=\s*['"]components['"]/);
  assert.match(main, /data-component-action=['"]install['"]/);
  assert.match(main, /\.click\(\)/);
  assert.match(main, /row\.scrollIntoView\?\./);
  assert.doesNotMatch(main, /row\.focus\(/);
  assert.match(settings, /data-component-row="\$\{id\}"/);
  assert.doesNotMatch(settings, /data-component-row="\$\{id\}" tabindex=/);
});

test('component progress events patch the current page without full-screen renders', async () => {
  const main = await readFile(path.join(repositoryRoot, 'app-ui/main.js'), 'utf8');
  const handler = main.match(/async function bindComponentDownloadProgress\(\)[\s\S]*?\n\}/)?.[0] || '';

  assert.match(handler, /patchComponentDownloadProgress/);
  assert.doesNotMatch(handler, /render\(|componentProgressRenderTimer|setTimeout\(/);
});

test('subwindow consumes the current component progress payload without legacy percent fields', async () => {
  const source = await readFile(path.join(repositoryRoot, 'app-ui/subwindow.js'), 'utf8');
  assert.match(source, /renderOptionalComponentProgress\(state\.componentProgress\)/);
  const updater = source.match(/function updateComponentInstallProgress\(progress[\s\S]*?\n\}/)?.[0] || '';
  assert.match(updater, /optionalComponentProgressLabel\(progress\)/);
  assert.match(updater, /state\.componentProgress = \{ \.\.\.progress \}/);
  assert.doesNotMatch(source, /progressPercent|state: phase/);
});

test('declining component installation does not install or retry', async () => {
  const calls = [];
  await assert.rejects(invokeWithOptionalComponent(async (command) => {
    calls.push(command);
    if (command === 'component_prompt_info') return promptInfo('media-tools', 'media-extraction');
    throw mediaMissing;
  }, 'queue_media_download_secure', {}, { confirmInstall: () => false }), error => {
    assert.match(error.message, /Ajustes > Complementos/);
    assert.equal(error.code, 'CDM_OPTIONAL_COMPONENT_FLOW_STOP');
    return true;
  });
  assert.deepEqual(calls, ['queue_media_download_secure', 'component_prompt_info']);
});

test('optional-component consent may be asynchronous', async () => {
  const calls = [];
  let installed = false;
  await invokeWithOptionalComponent(async command => {
    calls.push(command);
    if (command === 'component_prompt_info') return promptInfo('media-tools', 'media-extraction');
    if (command === 'install_component_from_catalog') { installed = true; return; }
    if (!installed) throw mediaMissing;
  }, 'analyze_media_url_with_session', {}, { confirmInstall: async () => true });
  assert.deepEqual(calls, [
    'analyze_media_url_with_session', 'component_prompt_info', 'install_component_from_catalog', 'analyze_media_url_with_session'
  ]);
});

test('torrent component detection never accepts a URL or component id from the failed request', async () => {
  const calls = [];
  let installed = false;
  let presented;
  await invokeWithOptionalComponent(async (command, args) => {
    calls.push([command, args]);
    if (command === 'component_prompt_info') return promptInfo('torrent-engine', 'bittorrent');
    if (command === 'install_component_from_catalog') { installed = true; return; }
    if (!installed) throw torrentMissing;
  }, 'queue_torrent_download', { source: 'magnet:?xt=urn:btih:example' }, { promptInstall: info => { presented = info; return true; } });
  assert.deepEqual(calls[2], ['install_component_from_catalog', { id: 'torrent-engine' }]);
  assert.equal(presented.componentId, 'torrent-engine');
  assert.equal(presented.purpose, 'Descargas BitTorrent');
});

test('uninstall leaves capability absent and the next action offers contextual reinstall', async () => {
  let installed = true;
  let prompts = 0;
  const calls = [];
  await Promise.resolve().then(() => {
    calls.push(['remove_component', { id: 'media-tools' }]);
    installed = false;
  });
  const result = await invokeWithOptionalComponent(async (command, payload) => {
    calls.push([command, payload]);
    if (command === 'remove_component') { installed = false; return; }
    if (command === 'component_prompt_info') return promptInfo('media-tools', 'media-extraction', installed);
    if (command === 'install_component_from_catalog') { installed = true; return; }
    if (!installed) throw mediaMissing;
    return 'retried';
  }, 'queue_media_download_secure', { url: 'https://example.test/video' }, {
    promptInstall: () => { prompts += 1; return true; }
  });
  assert.equal(result, 'retried');
  assert.equal(prompts, 1);
  assert.equal(installed, true);
  assert.deepEqual(calls.map(([command]) => command), [
    'remove_component', 'queue_media_download_secure', 'component_prompt_info', 'install_component_from_catalog', 'queue_media_download_secure'
  ]);
});

test('installed capability bypasses contextual prompt', async () => {
  let prompts = 0;
  await assert.rejects(invokeWithOptionalComponent(async command => {
    if (command === 'component_prompt_info') return promptInfo('media-tools', 'media-extraction', true);
    throw mediaMissing;
  }, 'queue_media_download_secure', {}, { promptInstall: () => { prompts += 1; return true; } }), error => error === mediaMissing);
  assert.equal(prompts, 0);
});

test('unrelated failures are returned without triggering component installation', async () => {
  const calls = [];
  const failure = new Error('network unrelated to component distribution');
  await assert.rejects(invokeWithOptionalComponent(async (command) => { calls.push(command); throw failure; }, 'queue_media_download_secure', {}, { confirmInstall: () => true }), error => error === failure);
  assert.deepEqual(calls, ['queue_media_download_secure']);
});

test('installation errors are logged internally and shown as a safe message', async () => {
  const restoreWindow = withBrowser();
  const errors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    let userMessage = '';
    try {
      await invokeWithOptionalComponent(async command => {
        if (command === 'component_prompt_info') return promptInfo('media-tools', 'media-extraction');
        if (command === 'install_component_from_catalog') throw new Error('HTTP 500 https://private.example/secret');
        throw mediaMissing;
      }, 'queue_media_download_secure', {}, { confirmInstall: () => true });
    } catch (error) {
      userMessage = error.message;
      assert.equal(error.code, 'CDM_OPTIONAL_COMPONENT_FLOW_STOP');
    }
    assert.match(userMessage, /No se pudo verificar o instalar MediaTools/);
    assert.doesNotMatch(userMessage, /secret|HTTP|https/);
    assert.equal(errors.length, 1);
    assert.match(errors[0].at(-1).message, /secret/);
  } finally {
    console.error = originalConsoleError;
    restoreWindow();
  }
});

test('installation progress is limited to the selected component and listener is removed', async () => {
  let listener;
  let unlistened = false;
  const progress = [];
  const restoreWindow = withBrowser({ window: { __TAURI__: { event: { listen: async (name, callback) => {
    assert.equal(name, 'component-download-progress');
    listener = callback;
    return () => { unlistened = true; };
  } } } } });
  try {
    let installed = false;
    await invokeWithOptionalComponent(async command => {
      if (command === 'component_prompt_info') return promptInfo('media-tools', 'media-extraction');
      if (command === 'install_component_from_catalog') {
        listener({ payload: { componentId: 'torrent-engine', phase: 'download', progressRatio: 0.1 } });
        listener({ payload: { componentId: 'media-tools', phase: 'download', progressRatio: 0.2 } });
        installed = true;
        return;
      }
      if (!installed) throw mediaMissing;
    }, 'queue_media_download_secure', {}, { confirmInstall: () => true, onProgress: value => progress.push(value) });
    assert.deepEqual(progress, [{ componentId: 'media-tools', phase: 'download', progressRatio: 0.2 }]);
    assert.equal(unlistened, true);
  } finally {
    restoreWindow();
  }
});

test('analysis and queue entry points use the consented optional-component flow', async () => {
  const expectations = [
    ['app-ui/subwindow.js', 'analyze_media_url_with_session_for_window'],
    ['app-ui/modules/extension/index.js', 'analyze_media_url_with_session'],
    ['app-ui/modules/extension/index.js', 'queue_playlist_selection'],
    ['app-ui/modules/extension/index.js', 'queue_media_download_secure']
  ];
  for (const [relativePath, command] of expectations) {
    const source = await readFile(path.join(repositoryRoot, relativePath), 'utf8');
    assert.match(
      source,
      new RegExp(`invokeWithOptionalComponent\\(\\s*invoke\\s*,\\s*['"]${command}['"]`),
      `${relativePath} must route ${command} through the consented installer`
    );
    assert.doesNotMatch(
      source,
      new RegExp(`invoke\\(\\s*['"]${command}['"]`),
      `${relativePath} must not bypass the consented installer for ${command}`
    );
  }
});

test('video title search uses capability-aware inline installation instead of bypassing it', async () => {
  const source = await readFile(path.join(repositoryRoot, 'app-ui/download-manager/events.js'), 'utf8');
  assert.match(source, /invokeWithOptionalComponent\([\s\S]{0,240}['"]search_media_by_title_page['"]/);
  assert.doesNotMatch(source, /context\.invoke\?\.\(\s*['"]search_media_by_title_page['"]/);
});

test('extension media download routes missing MediaTools to Settings without a progress toast or duplicate install', async () => {
  const calls = [];
  const events = [];
  const toasts = [];
  let progressListenerCount = 0;
  const originalConfirm = globalThis.confirm;
  const restoreWindow = withBrowser({ window: {
    setTimeout: (callback) => globalThis.setTimeout(callback, 0),
    dispatchEvent: event => events.push(event),
    __TAURI__: { event: { listen: async () => { progressListenerCount += 1; return () => {}; } } }
  } });
  let confirmations = 0;
  globalThis.confirm = async message => {
    confirmations += 1;
    assert.match(message, /MediaTools/);
    return true;
  };
  configureExtension({
    showToast: (...args) => toasts.push(args),
    invoke: async (command, args) => {
      calls.push([command, args]);
      if (command === 'inspect_download_url') return { kind: 'generic_url', requires_media_resolver: true, normalized_url: 'https://example.test/video' };
      if (command === 'component_prompt_info') return promptInfo('media-tools', 'media-extraction');
      if (command === 'analyze_media_url_with_session') return { title: 'Sample video', items: [] };
      if (command === 'queue_media_download_secure') throw mediaMissing;
      return undefined;
    }
  });
  try {
    await queueExtensionSourceInBackground('https://example.test/video');
    assert.equal(confirmations, 1);
    assert.deepEqual(calls.map(([command]) => command), [
      'inspect_download_url', 'analyze_media_url_with_session', 'queue_media_download_secure',
      'component_prompt_info', 'wake_main_window', 'wake_main_window'
    ]);
    assert.equal(calls.some(([command]) => command === 'install_component_from_catalog'), false);
    assert.equal(progressListenerCount, 0);
    assert.deepEqual(toasts, []);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'cdm:component-manager-install-request');
    assert.deepEqual(events[0].detail, { componentId: 'media-tools' });
  } finally {
    configureExtension({});
    globalThis.confirm = originalConfirm;
    restoreWindow();
  }
});
