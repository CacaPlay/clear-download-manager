export const HOST_NAME = 'lat.cacaplay.cacatools.downloadmanager';
export const PROTOCOL_VERSION = 1;

export function verifyHandshake(ping, capabilities) {
  if (ping?.ok !== true || capabilities?.ok !== true || ping.host !== HOST_NAME) {
    throw new Error('El puente no se identificó como Clear Download Manager. Revisa la vinculación.');
  }
  if (ping.protocolVersion !== PROTOCOL_VERSION || capabilities.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('El protocolo del puente no es compatible con esta extensión.');
  }
  if (!Array.isArray(capabilities.actions) || !capabilities.actions.includes('get_status')) {
    throw new Error('El puente no ofrece las funciones básicas de conexión.');
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    actions: capabilities.actions.filter(a => typeof a === 'string'),
    sourceTypes: Array.isArray(capabilities.sourceTypes) ? capabilities.sourceTypes : [],
    // Legacy hosts expose their crate version as appVersion. Do not label it as the app version.
    hostReportedVersion: String(ping.hostVersion || ping.appVersion || ''),
    appVersion: typeof ping.desktopAppVersion === 'string' ? ping.desktopAppVersion : null
  };
}

export function canUseJobAction(bridge, action, job, fresh = true) {
  const actions = bridge?.actions || [];
  if (!fresh || !job) return false;
  if (action === 'open') return actions.includes('open_job');
  if (action === 'play') return actions.includes('open_player') && job.status === 'completed';
  if (!actions.includes('job_action')) return false;
  const states = {
    pause: ['running'], resume: ['paused'], retry: ['failed'],
    cancel: ['running', 'queued', 'paused'],
    reveal_file: ['completed'], open_file: ['completed'],
    delete_history: ['completed', 'failed', 'cancelled'], delete_file: ['completed']
  };
  return Boolean(states[action]?.includes(job.status));
}
