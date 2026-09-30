import { loadLocale, resolveLocale } from '../i18n/index.js';
import { localizeDom } from '../i18n/runtime.js';

const COMPONENTS = {
  'media-extraction': {
    id: 'media-tools',
    label: 'MediaTools',
    purpose: 'Descarga y procesamiento de medios'
  },
  'media-merge': {
    id: 'media-tools',
    label: 'MediaTools',
    purpose: 'Descarga y procesamiento de medios'
  },
  'media-probe': {
    id: 'media-tools',
    label: 'MediaTools',
    purpose: 'Descarga y procesamiento de medios'
  },
  'media-transcode': {
    id: 'media-tools',
    label: 'MediaTools',
    purpose: 'Descarga y procesamiento de medios'
  },
  'js-runtime': {
    id: 'media-tools',
    label: 'MediaTools',
    purpose: 'Descarga y procesamiento de medios'
  },
  bittorrent: {
    id: 'torrent-engine',
    label: 'Torrent Engine',
    purpose: 'Descargas BitTorrent'
  }
};

function missingCapability(error) {
  const message = String(error?.message || error || '');
  const match = message.match(/(?:^|\s)CDM_MISSING_CAPABILITY:([a-z-]+)(?:$|\s)/);
  return match ? COMPONENTS[match[1]] && { ...COMPONENTS[match[1]], capability: match[1] } : null;
}

function terminalFlowError(message) {
  const error = new Error(message);
  error.code = 'CDM_OPTIONAL_COMPONENT_FLOW_STOP';
  return error;
}

function formatBytes(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1000 && unit < units.length - 1) {
    amount /= 1000;
    unit += 1;
  }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

export function renderInlineOptionalComponentPrompt(info, { accepted = false } = {}) {
  const label = escapeHtml(info?.label || 'complemento');
  const purpose = escapeHtml(info?.purpose || 'Descarga y procesamiento de medios');
  const size = formatBytes(info?.packageBytes);
  return `<section class="optional-component-inline-prompt" aria-labelledby="optional-component-inline-title">
    <div class="optional-component-inline-copy"><span>COMPLEMENTO NECESARIO</span><h2 id="optional-component-inline-title">Se necesita ${label}</h2><p>${purpose}${size ? ` · Descarga aproximada: ${size}` : ''}.</p></div>
    ${accepted ? '<div class="optional-component-inline-status" role="status">Solicitud aceptada. Esperando el estado del componente.</div>' : '<div class="optional-component-inline-actions"><button type="button" class="primary" data-action="install-optional-component">Descargar e instalar</button><button type="button" data-action="dismiss-optional-component">Cancelar</button></div>'}
  </section>`;
}

const COMPONENT_LABELS = {
  'media-tools': 'MediaTools',
  'torrent-engine': 'Torrent Engine'
};

const COMPONENT_PHASE_LABELS = {
  preparing: 'Preparando descarga',
  download: 'Descargando',
  verify: 'Verificando integridad',
  install: 'Instalando',
  activate: 'Activando componente',
  done: 'Instalado',
  error: 'No se pudo instalar',
  cancelled: 'Descarga cancelada'
};

function formatProgressBytes(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return '';
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes;
  let unit = -1;
  do {
    amount /= 1000;
    unit += 1;
  } while (amount >= 1000 && unit < units.length - 1);
  return `${amount.toFixed(1)} ${units[unit]}`;
}

export function optionalComponentProgressLabel(progress = {}) {
  const component = COMPONENT_LABELS[progress?.componentId] || 'Complemento';
  const phase = COMPONENT_PHASE_LABELS[progress?.phase];
  return phase ? `${phase} ${component}` : '';
}

export function renderOptionalComponentProgress(progress = {}) {
  const phase = COMPONENT_PHASE_LABELS[progress?.phase];
  if (!phase) return '';
  const component = COMPONENT_LABELS[progress?.componentId] || 'Complemento';
  const downloaded = Number.isSafeInteger(progress?.bytesDownloaded) && progress.bytesDownloaded >= 0
    ? progress.bytesDownloaded
    : null;
  const total = Number.isSafeInteger(progress?.totalBytes) && progress.totalBytes > 0
    ? progress.totalBytes
    : null;
  const suppliedRatio = typeof progress?.progressRatio === 'number'
    && Number.isFinite(progress.progressRatio)
    && progress.progressRatio >= 0
    && progress.progressRatio <= 1
    ? progress.progressRatio
    : null;
  const invalidOverrun = downloaded !== null && total !== null && downloaded > total;
  const ratio = invalidOverrun ? null : suppliedRatio ?? (downloaded !== null && total ? downloaded / total : null);
  const showTransfer = progress.phase === 'download' || progress.phase === 'done';
  const showBar = showTransfer && ratio !== null;
  const bytesText = downloaded === null
    ? ''
    : total
      ? `${formatProgressBytes(downloaded)} / ${formatProgressBytes(total)}`
      : `${formatProgressBytes(downloaded)} descargados`;
  const roundedSpeed = typeof progress?.bytesPerSecond === 'number'
    && Number.isFinite(progress.bytesPerSecond)
    && progress.bytesPerSecond > 0
    ? Math.round(progress.bytesPerSecond)
    : null;
  const speedText = Number.isSafeInteger(roundedSpeed) && roundedSpeed > 0
    ? `${formatProgressBytes(roundedSpeed)}/s`
    : '';
  const percentText = showBar ? `${Math.round(ratio * 100)}%` : '';
  const transferDetails = showTransfer && (bytesText || speedText || percentText)
    ? `<div class="optional-component-progress-details">${percentText ? `<strong>${percentText}</strong>` : ''}${bytesText ? `<span>${escapeHtml(bytesText)}</span>` : ''}${speedText ? `<span>${escapeHtml(speedText)}</span>` : ''}</div>`
    : '';
  const progressBar = showTransfer
    ? `<progress aria-label="Progreso de ${escapeHtml(component)}" max="1"${showBar ? ` value="${ratio}"` : ''}></progress>`
    : '';
  const terminal = ['error', 'cancelled'].includes(progress.phase);
  return `<section class="optional-component-progress${terminal ? ' is-terminal' : ''}" data-component-progress-phase="${escapeHtml(progress.phase)}" role="status" aria-live="polite">
    <strong>${escapeHtml(optionalComponentProgressLabel(progress))}</strong>
    ${progressBar}${transferDetails}
  </section>`;
}

function promptWithDialog(info) {
  const document = globalThis.document;
  if (!document?.body || typeof document.createElement !== 'function') {
    return globalThis.confirm?.(`Se necesita ${info.label} (${info.purpose}). ¿Descargar e instalar ahora?`) ?? false;
  }

  const dialog = document.createElement('dialog');
  dialog.className = 'optional-component-dialog';
  dialog.setAttribute('aria-labelledby', 'optional-component-title');
  dialog.setAttribute('aria-describedby', 'optional-component-description');
  dialog.setAttribute('aria-modal', 'true');
  const title = document.createElement('h2');
  title.id = 'optional-component-title';
  title.textContent = `Se necesita ${info.label}`;
  const description = document.createElement('p');
  description.id = 'optional-component-description';
  const size = formatBytes(info.packageBytes);
  description.textContent = `${info.purpose}${size ? ` · Descarga aproximada: ${size}` : ''}.`;
  const actions = document.createElement('div');
  actions.className = 'optional-component-dialog-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancelar';
  const install = document.createElement('button');
  install.type = 'button';
  install.textContent = 'Descargar e instalar';
  install.className = 'primary';
  actions.append(cancel, install);
  dialog.append(title, description, actions);
  document.body.append(dialog);
  localizeDom(dialog, resolveLocale(loadLocale()));

  return new Promise(resolve => {
    const finish = value => {
      dialog.close?.();
      dialog.remove();
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(false), { once: true });
    install.addEventListener('click', () => finish(true), { once: true });
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); }, { once: true });
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
      cancel.focus({ preventScroll: true });
    }
    else finish(globalThis.confirm?.(`${title.textContent}. ${description.textContent}`) ?? false);
  });
}

export function requestComponentManagerInstall(componentId) {
  const id = String(componentId || '');
  const view = globalThis.window;
  if (!['media-tools', 'torrent-engine'].includes(id) || typeof view?.dispatchEvent !== 'function' || typeof globalThis.CustomEvent !== 'function') return false;
  view.dispatchEvent(new CustomEvent('cdm:component-manager-install-request', { detail: { componentId: id } }));
  return true;
}

export async function invokeWithOptionalComponent(invoke, command, args, options = {}) {
  try {
    return await invoke(command, args);
  } catch (initialError) {
    const required = missingCapability(initialError);
    if (!required) throw initialError;

    let info;
    try {
      info = await invoke('component_prompt_info', { capability: required.capability });
    } catch (error) {
      console.error('Could not resolve optional component prompt details.', error);
      throw terminalFlowError('No se pudo consultar el estado del componente. Inténtalo desde Ajustes > Complementos.');
    }
    if (info?.installed) throw initialError;

    const promptInfo = {
      ...required,
      componentId: info?.componentId || required.id,
      purpose: info?.purpose || required.purpose,
      packageBytes: Number.isSafeInteger(info?.packageBytes) && info.packageBytes > 0 ? info.packageBytes : undefined
    };
    await options.beforePrompt?.(promptInfo);
    const promptInstall = options.promptInstall || options.confirmInstall || promptWithDialog;
    if (!await promptInstall(promptInfo)) {
      await options.onPromptCancelled?.(promptInfo);
      throw terminalFlowError(`Para continuar, instala ${required.label} desde Ajustes > Complementos.`);
    }

    if (typeof options.onInstallRequested === 'function') {
      if (await options.onInstallRequested(promptInfo)) return undefined;
      throw terminalFlowError(`No se pudo abrir Complementos para instalar ${required.label}. Inténtalo de nuevo.`);
    }

    let unlisten;
    try {
      const listen = globalThis.window?.__TAURI__?.event?.listen;
      if (typeof listen === 'function') {
        unlisten = await listen('component-download-progress', event => {
          const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
          if (payload.componentId !== required.id) return;
          options.onProgress?.({ ...payload });
        });
      }
      await invoke('install_component_from_catalog', { id: required.id });
    } catch (installError) {
      console.error(`Optional component installation failed (${required.id}).`, installError);
      throw terminalFlowError(`No se pudo verificar o instalar ${required.label}. Inténtalo desde Ajustes > Complementos.`);
    } finally {
      try { await unlisten?.(); } catch (error) { console.warn('Could not stop component progress listener.', error); }
    }

    return invoke(command, args);
  }
}
