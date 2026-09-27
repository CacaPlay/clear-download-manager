import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { invokeWithOptionalComponent } from '../../app-ui/modules/components/optional-install.js';
import { configureExtension, queueExtensionSourceInBackground } from '../../app-ui/modules/extension/index.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const mediaMissing = new Error('Media Tools is required for this download. Install the component from Settings > Components.');
const torrentMissing = new Error('Torrent Engine is required for this download. Install the component from Settings > Components.');

function withBrowser(overrides = {}) {
  const previous = globalThis.window;
  globalThis.window = overrides.window;
  return () => { globalThis.window = previous; };
}

test('missing Media Tools requires consent, installs the fixed catalog component, then retries once', async () => {
  const calls = [];
  let installed = false;
  const args = { url: 'https://example.test/video' };
  const result = await invokeWithOptionalComponent(async (command, payload) => {
    calls.push([command, payload]);
    if (command === 'install_component_from_catalog') { installed = true; return; }
    if (!installed) throw mediaMissing;
    return 'queued';
  }, 'queue_media_download_secure', args, { confirmInstall: () => true });
  assert.equal(result, 'queued');
  assert.deepEqual(calls.map(([command]) => command), [
    'queue_media_download_secure', 'install_component_from_catalog', 'queue_media_download_secure'
  ]);
  assert.deepEqual(calls[1][1], { id: 'media-tools' });
  assert.equal(calls[0][1], args);
  assert.equal(calls[2][1], args);
});

test('declining component installation does not install or retry', async () => {
  const calls = [];
  await assert.rejects(invokeWithOptionalComponent(async (command) => {
    calls.push(command);
    throw mediaMissing;
  }, 'queue_media_download_secure', {}, { confirmInstall: () => false }), error => {
    assert.match(error.message, /Ajustes > Componentes/);
    assert.equal(error.code, 'CDM_OPTIONAL_COMPONENT_FLOW_STOP');
    return true;
  });
  assert.deepEqual(calls, ['queue_media_download_secure']);
});

test('optional-component consent may be asynchronous', async () => {
  const calls = [];
  let installed = false;
  await invokeWithOptionalComponent(async command => {
    calls.push(command);
    if (command === 'install_component_from_catalog') { installed = true; return; }
    if (!installed) throw mediaMissing;
  }, 'analyze_media_url_with_session', {}, { confirmInstall: async () => true });
  assert.deepEqual(calls, [
    'analyze_media_url_with_session', 'install_component_from_catalog', 'analyze_media_url_with_session'
  ]);
});

test('torrent component detection never accepts a URL or component id from the failed request', async () => {
  const calls = [];
  let installed = false;
  await invokeWithOptionalComponent(async (command, args) => {
    calls.push([command, args]);
    if (command === 'install_component_from_catalog') { installed = true; return; }
    if (!installed) throw torrentMissing;
  }, 'queue_torrent_download', { source: 'magnet:?xt=urn:btih:example' }, { confirmInstall: () => true });
  assert.deepEqual(calls[1], ['install_component_from_catalog', { id: 'torrent-engine' }]);
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
        if (command === 'install_component_from_catalog') throw new Error('HTTP 500 https://private.example/secret');
        throw mediaMissing;
      }, 'queue_media_download_secure', {}, { confirmInstall: () => true });
    } catch (error) {
      userMessage = error.message;
      assert.equal(error.code, 'CDM_OPTIONAL_COMPONENT_FLOW_STOP');
    }
    assert.match(userMessage, /No se pudo verificar el catálogo/);
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
      if (command === 'install_component_from_catalog') {
        listener({ payload: { id: 'torrent-engine', state: 'downloading', progressPercent: 10 } });
        listener({ payload: { id: 'media-tools', state: 'downloading', progressPercent: 20 } });
        installed = true;
        return;
      }
      if (!installed) throw mediaMissing;
    }, 'queue_media_download_secure', {}, { confirmInstall: () => true, onProgress: value => progress.push(value) });
    assert.deepEqual(progress, [{ component: 'media-tools', state: 'downloading', progressPercent: 20 }]);
    assert.equal(unlistened, true);
  } finally {
    restoreWindow();
  }
});

test('media analysis and queue entry points use the consented optional-component flow', async () => {
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

test('extension background media download foregrounds for consent, installs, retries analysis, then queues', async () => {
  const calls = [];
  const originalConfirm = globalThis.confirm;
  const restoreWindow = withBrowser({ window: { setTimeout: (callback) => globalThis.setTimeout(callback, 0) } });
  let installed = false;
  let confirmations = 0;
  globalThis.confirm = async message => {
    confirmations += 1;
    assert.match(message, /Media Tools/);
    return true;
  };
  configureExtension({
    invoke: async (command, args) => {
      calls.push([command, args]);
      if (command === 'inspect_download_url') return { kind: 'generic_url', requires_media_resolver: true, normalized_url: 'https://example.test/video' };
      if (command === 'install_component_from_catalog') { installed = true; return; }
      if (command === 'analyze_media_url_with_session' && !installed) throw mediaMissing;
      if (command === 'analyze_media_url_with_session') return { title: 'Sample video', items: [] };
      if (command === 'queue_media_download_secure') return 'queued';
      return undefined;
    }
  });
  try {
    const result = await queueExtensionSourceInBackground('https://example.test/video');
    assert.equal(result, 'queued');
    assert.equal(confirmations, 1);
    assert.deepEqual(calls.map(([command]) => command), [
      'inspect_download_url', 'analyze_media_url_with_session', 'wake_main_window', 'wake_main_window',
      'install_component_from_catalog', 'analyze_media_url_with_session', 'queue_media_download_secure'
    ]);
    assert.deepEqual(calls[4][1], { id: 'media-tools' });
  } finally {
    configureExtension({});
    globalThis.confirm = originalConfirm;
    restoreWindow();
  }
});
