const REQUIRED_COMPONENTS = [
  {
    id: 'media-tools',
    label: 'Media Tools',
    requiredMessage: 'Media Tools is required for this download. Install the component from Settings > Components.',
    prompt: 'Este enlace necesita Media Tools. ¿Descargar e instalar ahora el paquete opcional verificado y reintentar?',
    declined: 'Para continuar, instala Media Tools desde Ajustes > Componentes.',
    installFailed: 'No se pudo verificar el catálogo o instalar Media Tools. No se activó una versión nueva; inténtalo desde Ajustes > Componentes más tarde.'
  },
  {
    id: 'torrent-engine',
    label: 'Torrent Engine',
    requiredMessage: 'Torrent Engine is required for this download. Install the component from Settings > Components.',
    prompt: 'Esta descarga necesita Torrent Engine. ¿Descargar e instalar ahora el paquete opcional verificado y reintentar?',
    declined: 'Para continuar, instala Torrent Engine desde Ajustes > Componentes.',
    installFailed: 'No se pudo verificar el catálogo o instalar Torrent Engine. No se activó una versión nueva; inténtalo desde Ajustes > Componentes más tarde.'
  }
];

function requiredComponent(error) {
  const message = String(error?.message || error || '');
  return REQUIRED_COMPONENTS.find((component) => message.includes(component.requiredMessage)) || null;
}

function terminalComponentFlowError(message) {
  const error = new Error(message);
  error.code = 'CDM_OPTIONAL_COMPONENT_FLOW_STOP';
  return error;
}

export async function invokeWithOptionalComponent(invoke, command, args, options = {}) {
  try {
    return await invoke(command, args);
  } catch (initialError) {
    const component = requiredComponent(initialError);
    if (!component) throw initialError;
    const confirmInstall = options.confirmInstall || ((message) => globalThis.confirm?.call(globalThis, message));
    if (typeof confirmInstall !== 'function' || !await confirmInstall(component.prompt)) {
      throw terminalComponentFlowError(component.declined);
    }

    let unlisten;
    try {
      const listen = globalThis.window?.__TAURI__?.event?.listen;
      if (typeof listen === 'function') {
        let lastState = '';
        let lastPercent = -10;
        unlisten = await listen('component-download-progress', (event) => {
          const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
          if (payload.id !== component.id) return;
          const state = String(payload.state || 'downloading');
          const percent = Number(payload.progressPercent);
          if (!Number.isFinite(percent)) return;
          if (state !== lastState || percent >= 100 || percent - lastPercent >= 10) {
            lastState = state;
            lastPercent = percent;
            options.onProgress?.({ component: component.id, state, progressPercent: Math.max(0, Math.min(100, percent)) });
          }
        });
      }
      await invoke('install_component_from_catalog', { id: component.id });
    } catch (installError) {
      console.error(`Optional component installation failed (${component.id}).`, installError);
      throw terminalComponentFlowError(component.installFailed);
    } finally {
      try { await unlisten?.(); } catch (error) { console.warn('Could not stop component progress listener.', error); }
    }

    return invoke(command, args);
  }
}
