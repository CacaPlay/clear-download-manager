import { HOST_NAME, verifyHandshake } from './compatibility.js';
export const CACATOOLS_NATIVE_HOST = HOST_NAME;

function runtimeApi() {
  return globalThis.browser?.runtime || globalThis.chrome?.runtime;
}

function enqueuePayload(url, metadata = {}) {
  const firstItem = Array.isArray(metadata.items) ? metadata.items[0] : null;
  const filename = String(metadata.filename || metadata.suggestedFilename || firstItem?.title || '').trim().slice(0, 1024);
  return {
    url,
    ...metadata,
    ...(filename ? { filename } : {})
  };
}

function commandId(prefix = 'extension') {
  const random = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${random || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`.slice(0, 160);
}

function rawMessage(action, payload = {}) {
  const runtime = runtimeApi();
  if (!runtime?.sendNativeMessage) {
    return Promise.reject(new Error('Native Messaging no esta disponible en este contexto.'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('El puente no respondió. Comprueba Clear Download Manager antes de reenviar.')), 8000);
    const finish = (error, response) => { clearTimeout(timer); error ? reject(error) : resolve(response); };
    try {
      if (globalThis.browser?.runtime) {
        runtime.sendNativeMessage(CACATOOLS_NATIVE_HOST, { action, payload }).then(r => finish(null,r),e => finish(e));
      } else {
        runtime.sendNativeMessage(CACATOOLS_NATIVE_HOST, { action, payload }, response => {
          const error = globalThis.chrome?.runtime?.lastError;
          finish(error ? new Error(error.message) : null, response);
        });
      }
    } catch (error) { finish(error); }
  });
}

let handshake;
let handshakeAt = 0;
let handshakePending;
export function resetHandshake() { handshake = undefined; handshakeAt = 0; }
export async function nativeHandshake({ force = false } = {}) {
  if (!force && handshake && Date.now() - handshakeAt < 10000) return handshake;
  if (handshakePending) return handshakePending;
  handshakePending = Promise.all([rawMessage('ping'), rawMessage('capabilities')])
    .then(([ping,capabilities]) => {
      handshake = verifyHandshake(ping,capabilities);
      handshakeAt = Date.now();
      return handshake;
    }).catch(error => { resetHandshake(); throw error; })
    .finally(() => { handshakePending = undefined; });
  return handshakePending;
}
export async function sendCacaToolsNativeMessage(action, payload = {}) {
  if (action === 'ping' || action === 'capabilities') return rawMessage(action,payload);
  const bridge = await nativeHandshake();
  if (!bridge.actions.includes(action) || action === 'set_job_options') {
    throw new Error('Esta función requiere un puente más reciente. Puedes realizarla desde Clear Download Manager.');
  }
  if (['delete_file','delete_history'].includes(payload.action) && payload.confirmed !== true) {
    throw new Error('La eliminación requiere confirmación.');
  }
  try { return await rawMessage(action,payload); }
  catch (error) { resetHandshake(); throw error; }
}

export const cacaToolsNative = Object.freeze({
  ping: () => sendCacaToolsNativeMessage('ping'),
  capabilities: () => sendCacaToolsNativeMessage('capabilities'),
  status: () => sendCacaToolsNativeMessage('get_status'),
  open: () => sendCacaToolsNativeMessage('open_app'),
  openJob: (jobId, mode = 'open') => sendCacaToolsNativeMessage('open_job', {
    jobId: Number(jobId),
    mode: mode === 'play' ? 'play' : 'open',
    windowMode: 'foreground',
    commandId: commandId('open-job'),
    idempotencyKey: commandId('open-job-key')
  }),
  openPlayer: (jobId) => sendCacaToolsNativeMessage('open_player', {
    jobId: Number(jobId),
    mode: 'play',
    windowMode: 'foreground',
    commandId: commandId('open-player'),
    idempotencyKey: commandId('open-player-key')
  }),
  listJobs: () => sendCacaToolsNativeMessage('list_jobs'),
  jobAction: (jobId, action, options = {}) => sendCacaToolsNativeMessage('job_action', {
    jobId: Number(jobId),
    action: String(action || '').toLowerCase(),
    confirmed: options.confirmed === true,
    windowMode: 'background',
    commandId: commandId('job-action'),
    idempotencyKey: commandId('job-action-key')
  }),
  setJobOptions: (jobId, options = {}) => sendCacaToolsNativeMessage('set_job_options', {
    jobId: Number(jobId),
    options,
    windowMode: 'background',
    commandId: commandId('job-options'),
    idempotencyKey: commandId('job-options-key')
  }),
  analyze: (url, metadata = {}) => sendCacaToolsNativeMessage('analyze', { url, ...metadata }),
  enqueue: (url, metadata = {}) => sendCacaToolsNativeMessage('enqueue', enqueuePayload(url, metadata)),
  captureDownload: (capture) => sendCacaToolsNativeMessage('browser_download_capture', capture)
});
