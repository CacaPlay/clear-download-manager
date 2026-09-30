import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { updateProgressMarkup } from '../../app-ui/download-manager/view/shared.js';
import * as updateView from '../../app-ui/download-manager/view/shared.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('update progress shows measured throughput only when the backend provides it', () => {
  const measured = updateProgressMarkup({
    updaterInstallBusy: true,
    updaterProgress: {
      phase: 'download', downloadedBytes: 43 * 1024 * 1024,
      contentLength: 100 * 1024 * 1024, percent: 43,
      bytesPerSecond: 2 * 1024 * 1024
    }
  });
  assert.match(measured, /2\.00 MB\/s/);

  const unknownRate = updateProgressMarkup({
    updaterInstallBusy: true,
    updaterProgress: { phase: 'download', downloadedBytes: 1024, contentLength: null }
  });
  assert.doesNotMatch(unknownRate, /MB\/s/);
  assert.doesNotMatch(updateProgressMarkup({
    updaterInstallBusy: true,
    updaterProgress: { phase: 'install', bytesPerSecond: 2 * 1024 * 1024 }
  }), /MB\/s/);
});

test('determinate progress animates measured width changes and respects reduced motion', async () => {
  const styles = await readFile(path.join(root, 'app-ui/download-manager/styles/03-components.css'), 'utf8');
  assert.match(styles, /\.dm-update-progress-track i\{[^}]*transition:width \.18s linear/);
  assert.match(styles, /prefers-reduced-motion:reduce\)\{\.dm-update-progress-track i\{transition:none\}/);
});

test('installing an update leaves its modal mounted while the install callback runs', async () => {
  const source = await readFile(path.join(root, 'app-ui/download-manager/events.js'), 'utf8');
  const actionStart = source.indexOf("if (action === 'install-update') {");
  const actionEnd = source.indexOf('\n    }', actionStart);
  assert.notEqual(actionStart, -1);
  assert.notEqual(actionEnd, -1);
  const handler = source.slice(actionStart, actionEnd);
  assert.doesNotMatch(handler, /runtimeState\.modal\s*=\s*''/);
  assert.doesNotMatch(handler, /rerenderNow\(\)/);
  assert.match(handler, /await context\.onInstallUpdate\?\.\(\)/);
});

test('updater progress patches its mounted slot while the modal blocks full rerenders', () => {
  assert.equal(typeof updateView.patchUpdateProgressSlots, 'function');

  const classes = new Set();
  const attributes = {};
  const fill = { style: { width: '28%' } };
  const track = {
    classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } },
    setAttribute(name, value) { attributes[name] = value; },
    removeAttribute(name) { delete attributes[name]; }
  };
  const detail = { textContent: 'Preparando descarga' };
  const details = { textContent: '', hidden: true };
  const progress = {
    querySelector(selector) {
      return ({
        '[data-dm-update-progress-track]': track,
        '[data-dm-update-progress-fill]': fill,
        '[data-dm-update-progress-detail]': detail,
        '[data-dm-update-progress-details]': details
      })[selector] || null;
    }
  };
  const slot = {
    innerHTML: '<existing progress node>',
    querySelector(selector) { return selector === '[data-dm-update-progress]' ? progress : null; }
  };
  const installButton = { disabled: false, textContent: 'Instalar ahora', dataset: { dmUpdateIdleLabel: 'Instalar ahora' } };
  const closeButton = { disabled: false };
  const modal = { querySelectorAll: () => [closeButton] };
  const root = {
    querySelectorAll(selector) {
      if (selector === '[data-dm-update-progress-slot]') return [slot];
      if (selector === '[data-dm-install-update], [data-dm-modal-action="install-update"]') return [installButton];
      return [];
    },
    querySelector: () => modal
  };
  const originalMarkup = slot.innerHTML;
  const patched = updateView.patchUpdateProgressSlots(root, {
    updaterInstallBusy: true,
    updaterProgress: {
      phase: 'download', downloadedBytes: 42_300_000,
      contentLength: 88_700_000, percent: 47.69,
      bytesPerSecond: 6_000_000
    }
  });

  assert.equal(patched, 1);
  assert.equal(slot.innerHTML, originalMarkup, 'the live progress node is preserved for its width transition');
  assert.equal(fill.style.width, '48%');
  assert.equal(attributes['aria-valuenow'], '48');
  assert.match(detail.textContent, /Descargando la actualización firmada \(48%\)/);
  assert.equal(details.textContent, '40.3 MB / 84.6 MB · 48% · 5.72 MB/s');
  assert.equal(details.hidden, false);
  assert.equal(installButton.disabled, true);
  assert.equal(installButton.textContent, 'Descargando…');
  assert.equal(closeButton.disabled, true);
  assert.equal(classes.has('is-indeterminate'), false);

  updateView.patchUpdateProgressSlots(root, {
    updaterInstallBusy: true,
    updaterProgress: { phase: 'install', percent: 100 }
  });
  assert.equal(fill.style.width, '100%');
  assert.equal(attributes['aria-label'], 'Instalando actualización');
  assert.match(detail.textContent, /Verificando e instalando/);
  assert.equal(details.hidden, true, 'download speed is not carried into install phase');
  assert.equal(installButton.textContent, 'Instalando…');
});

test('native progress events update the mounted updater UI without going through the modal render guard', async () => {
  const source = await readFile(path.join(root, 'app-ui/main.js'), 'utf8');
  const listenerStart = source.indexOf('async function bindAppUpdateProgress()');
  const listenerEnd = source.indexOf('async function bindComponentDownloadProgress()', listenerStart);
  const listener = source.slice(listenerStart, listenerEnd);
  assert.notEqual(listenerStart, -1);
  assert.notEqual(listenerEnd, -1);
  assert.match(listener, /patchCurrentAppUpdateProgress\(\)/);
  assert.doesNotMatch(listener, /requestDownloadManagerRender/);
});

test('updater progress stays indeterminate until the backend reports a total', () => {
  const nullRatioMarkup = updateProgressMarkup({
    updaterInstallBusy: true,
    updaterProgress: { phase: 'download', downloadedBytes: 1_048_576, contentLength: null, percent: null }
  });
  assert.match(nullRatioMarkup, /is-indeterminate/);
  assert.doesNotMatch(nullRatioMarkup, /aria-valuenow=/);

  const attributes = {};
  const classes = new Set();
  const fill = { style: { width: '48%' } };
  const track = {
    classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } },
    setAttribute(name, value) { attributes[name] = value; },
    removeAttribute(name) { delete attributes[name]; }
  };
  const detail = { textContent: '' };
  const details = { textContent: '', hidden: true };
  const progress = { querySelector(selector) { return ({
    '[data-dm-update-progress-track]': track,
    '[data-dm-update-progress-fill]': fill,
    '[data-dm-update-progress-detail]': detail,
    '[data-dm-update-progress-details]': details
  })[selector] || null; } };
  const slot = { innerHTML: '<mounted>', querySelector: () => progress };
  const root = {
    querySelectorAll(selector) { return selector === '[data-dm-update-progress-slot]' ? [slot] : []; },
    querySelector: () => null
  };

  updateView.patchUpdateProgressSlots(root, {
    updaterInstallBusy: true,
    updaterProgress: { phase: 'download', downloadedBytes: 1_048_576, contentLength: null, percent: null }
  });

  assert.equal(classes.has('is-indeterminate'), true);
  assert.equal(Object.hasOwn(attributes, 'aria-valuenow'), false);
  assert.equal(attributes['aria-valuetext'], 'Descargando actualización');
  assert.equal(fill.style.width, '28%');
  assert.match(details.textContent, /^1\.00 MB$/);
  assert.equal(details.hidden, false);
  assert.match(detail.textContent, /Descargando la actualización firmada/);
});
