/* One destination picker per application window. The native command also
   guards the process, while this layer keeps the current WebView inert until
   the Windows dialog returns. */
let destinationPickerRequest = null;
let destinationPickerLocked = false;

function pickerLockTarget() {
  return document.querySelector('#app')
    || document.querySelector('#subwindow-root')
    || document.body;
}

function setPickerLocked(locked) {
  destinationPickerLocked = Boolean(locked);
  const target = pickerLockTarget();
  if (!target) return;
  if (locked) {
    target.setAttribute('aria-busy', 'true');
    target.dataset.destinationPickerOpen = '1';
    target.inert = true;
    document.documentElement.dataset.destinationPickerOpen = '1';
  } else {
    target.removeAttribute('aria-busy');
    delete target.dataset.destinationPickerOpen;
    target.inert = false;
    delete document.documentElement.dataset.destinationPickerOpen;
  }
}

function broadcastPickerState(open) {
  const emit = globalThis.window?.__TAURI__?.event?.emit;
  if (typeof emit === 'function') {
    void emit('cacatools-destination-picker-changed', { open: Boolean(open) });
  }
}

export async function bindDestinationPickerState() {
  const listen = globalThis.window?.__TAURI__?.event?.listen;
  if (typeof listen !== 'function') return;
  try {
    await listen('cacatools-destination-picker-changed', (event) => {
      setPickerLocked(Boolean(event?.payload?.open));
    });
  } catch {}
}

export function chooseDestinationDirectory(invoke) {
  if (destinationPickerRequest) return destinationPickerRequest;
  if (destinationPickerLocked) return Promise.resolve(null);
  if (typeof invoke !== 'function') return Promise.reject(new Error('Selector de destino no disponible'));
  setPickerLocked(true);
  broadcastPickerState(true);
  destinationPickerRequest = Promise.resolve()
    .then(() => invoke('choose_download_directory'))
    .finally(() => {
      destinationPickerRequest = null;
      setPickerLocked(false);
      broadcastPickerState(false);
    });
  return destinationPickerRequest;
}
