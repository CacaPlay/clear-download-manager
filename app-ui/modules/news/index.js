const MAX_READ_IDS = 128;
const MAX_DISMISSED_IDS = 64;
const MAX_RELEASES = 12;
const MAX_REMOTE_MESSAGES = 32;
const MAX_CACHE_BYTES = 256 * 1024;
const MAX_HISTORY = 32;
const MAX_SUMMARY_CHARS = 360;
const NEWS_FEED_URL = 'https://raw.githubusercontent.com/CacaPlay/clear-download-manager/main/news.json';
// This marker prevents an installation that previously cached the legacy
// CacaTools feed from treating that content as current after the repository
// migration. It is deliberately independent from the app version so a future
// feed can invalidate the cache without changing the desktop version.
export const NEWS_FEED_CACHE_KEY = 'clear-download-manager/news-v2';
const ALLOWED_THUMBNAIL_HOSTS = new Set([
  'raw.githubusercontent.com',
  'github.com',
  'user-images.githubusercontent.com',
  'objects.githubusercontent.com',
  'avatars.githubusercontent.com'
]);
const ALLOWED_TYPES = new Set(['release', 'update', 'manual', 'local', 'extension']);
const ALLOWED_ACTIONS = new Set(['open-update', 'open-extension', 'open-feedback', 'open-url']);

export const NEWS_LIMITS = Object.freeze({
  maxReadIds: MAX_READ_IDS,
  maxDismissedIds: MAX_DISMISSED_IDS,
  maxReleases: MAX_RELEASES,
  maxRemoteMessages: MAX_REMOTE_MESSAGES,
  maxCacheBytes: MAX_CACHE_BYTES,
  maxSummaryChars: MAX_SUMMARY_CHARS
});

export const DEFAULT_EXPERIENCE_SETTINGS = Object.freeze({
  clipboardAutoSuggest: true,
  receiveNews: true,
  automaticUpdateChecks: true,
  showExtensionRecommendation: true,
  extensionPromptDecision: '',
  newsReadIds: [],
  newsDismissedIds: [],
  updateSeenVersions: [],
  pendingUpdateVersion: '',
  newsCacheJson: '',
  newsCacheSource: '',
  newsCacheEtag: '',
  newsCacheLastModified: '',
  newsCacheFetchedAt: 0,
  lastUpdateCheckAt: 0,
  locale: 'system',
  installedUpdateHistory: [],
  dismissedHistoryIds: []
});

function boundedText(value, limit) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, limit);
}

function boundedIds(value, limit) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => boundedText(item, 120))
    .filter(Boolean))].slice(-limit);
}

function boundedHistory(value) {
  return (Array.isArray(value) ? value : []).map((item) => {
    if (!item || typeof item !== 'object') return null;
    const version = boundedText(item.version, 80);
    if (!version) return null;
    return { id: boundedText(item.id || `installed:v${version}`, 120), version, installedAt: normalizeDate(item.installedAt || item.installed_at || item.date) || new Date(0).toISOString(), summary: boundedText(item.summary || item.body, 600) };
  }).filter(Boolean).slice(-MAX_HISTORY);
}

function versionParts(value) {
  const match = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/);
  return match ? [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)] : null;
}

function versionCompare(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function isVersionInRange(version, min, max) {
  return (!min || versionCompare(version, min) >= 0) && (!max || versionCompare(version, max) <= 0);
}

export function safeRemoteThumbnail(value) {
  const source = boundedText(value, 1000);
  if (!source) return '';
  try {
    const url = new URL(source);
    const extension = url.pathname.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
    if (url.protocol !== 'https:' || !ALLOWED_THUMBNAIL_HOSTS.has(url.hostname.toLowerCase())) return '';
    if (!['png', 'jpg', 'jpeg', 'webp'].includes(extension)) return '';
    return url.toString();
  } catch {
    return '';
  }
}

export function normalizeExperienceSettings(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const result = {
    ...DEFAULT_EXPERIENCE_SETTINGS,
    ...source,
    clipboardAutoSuggest: source.clipboardAutoSuggest !== false,
    // News and the extension card are always enabled; these legacy fields are
    // retained only so older persisted settings remain schema-compatible.
    receiveNews: true,
    automaticUpdateChecks: source.automaticUpdateChecks !== false,
    showExtensionRecommendation: true,
    extensionPromptDecision: ['accepted', 'declined'].includes(source.extensionPromptDecision) ? source.extensionPromptDecision : '',
    newsReadIds: boundedIds(source.newsReadIds, MAX_READ_IDS),
    newsDismissedIds: boundedIds(source.newsDismissedIds, MAX_DISMISSED_IDS),
    updateSeenVersions: boundedIds(source.updateSeenVersions, MAX_RELEASES),
    pendingUpdateVersion: boundedText(source.pendingUpdateVersion, 80),
    newsCacheJson: boundedText(source.newsCacheJson, MAX_CACHE_BYTES),
    newsCacheSource: boundedText(source.newsCacheSource, 120),
    newsCacheEtag: boundedText(source.newsCacheEtag, 300),
    newsCacheLastModified: boundedText(source.newsCacheLastModified, 120),
    newsCacheFetchedAt: Math.max(0, Number(source.newsCacheFetchedAt) || 0),
    lastUpdateCheckAt: Math.max(0, Number(source.lastUpdateCheckAt) || 0),
    locale: ['system', 'es', 'en'].includes(String(source.locale || '').toLowerCase()) ? String(source.locale).toLowerCase() : 'system',
    installedUpdateHistory: boundedHistory(source.installedUpdateHistory),
    dismissedHistoryIds: boundedIds(source.dismissedHistoryIds, MAX_HISTORY)
  };
  return result;
}

function normalizeDate(value) {
  const source = boundedText(value, 80);
  if (!source) return '';
  const time = Date.parse(source);
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function normalizeAction(value, translation = {}, locale = 'es') {
  if (!value || typeof value !== 'object') return null;
  const type = boundedText(value.type || value.action, 40);
  if (!ALLOWED_ACTIONS.has(type)) return null;
  const url = boundedText(value.url, 1000);
  if (type === 'open-url') {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !['github.com', 'chromewebstore.google.com'].includes(parsed.hostname.toLowerCase())) return null;
    } catch {
      return null;
    }
  }
  const label = translation.actionLabel || translation.action_label || value.label || (locale === 'en' ? 'Open' : 'Abrir');
  return { type, label: boundedText(label, 60), url };
}

export function normalizeNewsMessage(value, { appVersion = '0.45.4', platform = 'windows', locale = 'es' } = {}) {
  if (!value || typeof value !== 'object') return null;
  const id = boundedText(value.id, 120);
  const type = boundedText(value.type || 'manual', 30).toLowerCase();
  const translation = value.translations && typeof value.translations === 'object'
    ? (value.translations[locale] || value.translations[String(locale).split('-')[0]] || {}) : {};
  const title = boundedText(translation.title || value.title, 180);
  const body = boundedText(translation.summary || value.summary || value.body || value.description, MAX_SUMMARY_CHARS);
  if (!id || !title || !body || !ALLOWED_TYPES.has(type)) return null;
  const targetPlatform = boundedText(value.platform || 'windows', 30).toLowerCase();
  const targetLocale = boundedText(value.locale || '', 20).toLowerCase();
  if (targetPlatform !== 'all' && targetPlatform !== platform) return null;
  if (targetLocale && targetLocale !== 'all' && !targetLocale.startsWith(locale.toLowerCase().split('-')[0])) return null;
  if (!isVersionInRange(appVersion, boundedText(value.min_app_version || value.minAppVersion, 40), boundedText(value.max_app_version || value.maxAppVersion, 40))) return null;
  const expiresAt = normalizeDate(value.expires_at || value.expiresAt);
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) return null;
  const publishedAt = normalizeDate(value.published_at || value.publishedAt) || new Date(0).toISOString();
  const detailsSource = translation.details || value.details || value.changelog || [];
  const details = (Array.isArray(detailsSource) ? detailsSource : String(detailsSource || '').split(/\r?\n/)).map((entry) => boundedText(entry, 400)).filter(Boolean).slice(0, 32);
  return {
    id,
    type,
    title,
    body,
    summary: body,
    details,
    publishedAt,
    thumbnail: safeRemoteThumbnail(value.image || value.thumbnail),
    image: safeRemoteThumbnail(value.image || value.thumbnail),
    translations: value.translations && typeof value.translations === 'object' ? value.translations : null,
    priority: Math.max(0, Math.min(100, Number(value.priority) || 0)),
    dismissible: value.dismissible !== false,
    actionRequired: Boolean(value.action_required ?? value.actionRequired),
    expiresAt,
    action: normalizeAction(value.action, translation, String(locale || 'es').split('-')[0]),
    source: boundedText(value.source || 'remote', 30)
  };
}

export function validateRemoteNewsFeed(payload, options = {}) {
  const values = Array.isArray(payload) ? payload : payload?.messages;
  if (!Array.isArray(values)) throw new Error('El feed de novedades no contiene una lista válida');
  if (values.length > MAX_REMOTE_MESSAGES) throw new Error('El feed de novedades excede el límite permitido');
  const messages = values.map((item) => normalizeNewsMessage(item, options)).filter(Boolean);
  if (values.length && !messages.length) throw new Error('El feed de novedades no contiene mensajes válidos');
  return messages;
}

export function parseCachedNews(experience, options = {}) {
  if (String(experience?.newsCacheSource || '') !== NEWS_FEED_CACHE_KEY) return [];
  const raw = String(experience?.newsCacheJson || '');
  if (!raw || raw.length > MAX_CACHE_BYTES) return [];
  try { return validateRemoteNewsFeed(JSON.parse(raw), options); } catch { return []; }
}

function updateMessage(update, releaseMetadata = null) {
  const version = boundedText(update?.version, 80);
  if (!version) return null;
  const metadata = releaseMetadata && typeof releaseMetadata === 'object' ? releaseMetadata : {};
  return {
    id: `release:v${version.replace(/^v/i, '')}`,
    type: 'update',
    title: boundedText(metadata.name || `Clear Download Manager ${version} disponible`, 180),
    body: boundedText(metadata.body || update.notes || 'Nueva versión firmada disponible para Clear Download Manager.', 1200),
    publishedAt: normalizeDate(metadata.publishedAt || metadata.published_at || update.date) || new Date().toISOString(),
    thumbnail: safeRemoteThumbnail(metadata.thumbnail),
    priority: 100,
    dismissible: false,
    actionRequired: true,
    pending: true,
    version,
    action: { type: 'open-update', label: 'Actualizar' },
    source: 'signed-updater'
  };
}

function extensionMessage() {
  return {
    id: 'local:extension-invitation',
    type: 'extension',
    title: 'Extensión de Clear Download Manager',
    body: 'Envía enlaces, vídeos y playlists del navegador directamente a CDM.',
    summary: 'Envía enlaces, vídeos y playlists del navegador directamente a CDM.',
    details: [],
    publishedAt: new Date().toISOString(),
    thumbnail: '',
    priority: 30,
    dismissible: false,
    actionRequired: false,
    action: { type: 'open-url', url: 'https://chromewebstore.google.com/detail/aonppfnabjnicjjeoofkfjofolfibggp?utm_source=item-share-cb', label: 'Ir a la extensión' },
    source: 'local'
  };
}

export function buildNewsInbox({ update = null, releaseMetadata = null, remoteMessages = [], experience = {}, appVersion = '0.45.4', includeExtension = true, locale = 'es' } = {}) {
  const settings = normalizeExperienceSettings(experience);
  const candidates = [
    updateMessage(update, releaseMetadata),
    ...(Array.isArray(remoteMessages) ? remoteMessages : []),
    ...(includeExtension ? [extensionMessage()] : [])
  ].filter(Boolean);
  const seen = new Set();
  const normalizedCandidates = candidates
    .map((message) => normalizeNewsMessage(message, { appVersion, locale: String(locale || 'es').split('-')[0] }) || message)
    .filter((message) => {
      if (!message?.id || seen.has(message.id)) return false;
      seen.add(message.id);
      return true;
    });
  const releases = normalizedCandidates.filter((message) => message.type === 'release');
  releases.sort((left, right) => {
    const versionOrder = versionCompare(releaseVersion(right), releaseVersion(left));
    if (versionOrder) return versionOrder;
    return Date.parse(right.publishedAt || 0) - Date.parse(left.publishedAt || 0);
  });
  const protectedReleaseId = releases[0]?.id || '';
  return normalizedCandidates
    .filter((message) => !settings.newsDismissedIds.includes(message.id) || message.id === protectedReleaseId)
    .map((message) => ({
      ...message,
      dismissible: !message.actionRequired && message.dismissible !== false && message.id !== protectedReleaseId,
      read: settings.newsReadIds.includes(message.id),
      pending: Boolean(message.pending || (message.type === 'update' && message.version && settings.pendingUpdateVersion === message.version))
    }))
    .sort((left, right) => Number(right.actionRequired) - Number(left.actionRequired)
      || Number(right.priority || 0) - Number(left.priority || 0)
      || Date.parse(right.publishedAt || 0) - Date.parse(left.publishedAt || 0));
}

export function recordInstalledUpdate(experience = {}, version, summary = '') {
  const settings = normalizeExperienceSettings(experience);
  const normalized = boundedText(version, 80);
  if (!normalized) return settings;
  const history = settings.installedUpdateHistory.filter((entry) => entry.version !== normalized);
  history.push({ id: `installed:v${normalized.replace(/^v/i, '')}`, version: normalized, installedAt: new Date().toISOString(), summary: boundedText(summary, 600) });
  return normalizeExperienceSettings({ ...settings, installedUpdateHistory: history });
}

function releaseVersion(message) {
  const value = `${message?.id || ''} ${message?.title || ''}`;
  return value.match(/\bv?(\d+(?:\.\d+){1,2})\b/i)?.[1] || '';
}

export function newsAttention(messages = [], experience = {}) {
  const settings = normalizeExperienceSettings(experience);
  return messages.some((message) => message.actionRequired || (settings.receiveNews !== false && !message.read));
}

export function markNewsViewed(experience = {}, messages = []) {
  const settings = normalizeExperienceSettings(experience);
  const ids = messages.filter((message) => !message.actionRequired).map((message) => message.id);
  return normalizeExperienceSettings({ ...settings, newsReadIds: boundedIds([...settings.newsReadIds, ...ids], MAX_READ_IDS) });
}

export function newsCachePatch(response, messages = []) {
  const json = JSON.stringify({ messages: messages.slice(0, MAX_REMOTE_MESSAGES) });
  if (json.length > MAX_CACHE_BYTES) return {};
  return {
    newsCacheJson: json,
    newsCacheSource: NEWS_FEED_CACHE_KEY,
    newsCacheEtag: boundedText(response?.etag, 300),
    newsCacheLastModified: boundedText(response?.lastModified || response?.last_modified, 120),
    newsCacheFetchedAt: Date.now()
  };
}

export function newsFeedUrl() { return NEWS_FEED_URL; }
