import { thumbnailUrl } from './core/model.js';
import { thumbnailState, MAX_CONCURRENT_THUMBNAILS, MAX_THUMBNAIL_CACHE_ENTRIES, THUMBNAIL_FAILURE_TTL_MS } from './state.js';
function thumbnailDebugUpdate(patch = {}) {
  const debug = globalThis.__CACATOOLS_THUMBNAIL_TEST__;
  if (!debug || typeof debug !== 'object') return;
  if (!debug.requestThumbnail) debug.requestThumbnail = (image, source, fallback = '') => subscribeThumbnailImage(image, source, fallback, true);
  debug.stats = {
    cacheHits: Number(debug.cacheHits || 0),
    cacheMisses: Number(debug.cacheMisses || 0),
    loads: Number(debug.loads || 0),
    failures: Number(debug.failures || 0),
    fallbacks: Number(debug.fallbacks || 0),
    cacheEntries: thumbnailState.cache.size,
    pendingEntries: Array.from(thumbnailState.cache.values()).filter((entry) => entry.state === 'pending').length,
    activeLoads: thumbnailState.activeLoads,
    ...patch,
  };
}


function normalizeThumbnailSource(value) {
  const source = String(value || '').trim();
  if (!source) return '';
  try {
    const url = new URL(source, document.baseURI);
    if (!/^https?:$/i.test(url.protocol)) return source;
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
    return url.toString();
  } catch {
    return source;
  }
}

function isRemoteThumbnail(source) {
  return /^https?:\/\//i.test(String(source || '').trim());
}

function touchThumbnailEntry(entry) {
  if (!entry) return;
  thumbnailState.cache.delete(entry.key);
  thumbnailState.cache.set(entry.key, entry);
}

function evictThumbnailCache() {
  while (thumbnailState.cache.size > MAX_THUMBNAIL_CACHE_ENTRIES) {
    const candidate = Array.from(thumbnailState.cache.values()).find((entry) => entry.state !== 'pending');
    if (!candidate) break;
    thumbnailState.cache.delete(candidate.key);
  }
  thumbnailDebugUpdate();
}

function getThumbnailEntry(key) {
  const entry = thumbnailState.cache.get(key);
  if (!entry) return null;
  if (entry.state === 'failed' && entry.failureExpiresAt <= Date.now()) {
    thumbnailState.cache.delete(key);
    thumbnailDebugUpdate();
    return null;
  }
  touchThumbnailEntry(entry);
  return entry;
}

function markThumbnailFailed(image) {
  if (!(image instanceof HTMLImageElement) || !image.isConnected) return;
  image.dataset.dmThumbnailState = 'failed';
  image.hidden = true;
  image.parentElement?.classList.add('dm-thumbnail-failed');
}

function applyThumbnailLoaded(image, entry) {
  if (!(image instanceof HTMLImageElement) || !image.isConnected) return;
  const currentSource = normalizeThumbnailSource(image.dataset.dmThumbnailSrc || '');
  if (image.dataset.dmThumbnailKey !== entry.key || currentSource !== entry.key) {
    const renderedSource = normalizeThumbnailSource(image.currentSrc || image.src || '');
    if (renderedSource === entry.key) image.removeAttribute('src');
    return;
  }
  image.dataset.dmThumbnailState = 'loaded';
  image.hidden = false;
  image.parentElement?.classList.remove('dm-thumbnail-failed');
  if (image.currentSrc !== entry.url && image.src !== entry.url) image.src = entry.url;
}

function subscribeThumbnailImage(image, preferred, fallback = '', allowFallback = true) {
  if (!(image instanceof HTMLImageElement) || !image.isConnected) return;
  const source = normalizeThumbnailSource(preferred);
  if (!source) return;
  const key = source;
  image.dataset.dmThumbnailSrc = source;
  image.dataset.dmThumbnailKey = key;
  image.dataset.dmThumbnailState = 'pending';
  if (allowFallback) delete image.dataset.dmThumbnailFallback;
  else image.dataset.dmThumbnailFallback = '1';

  if (!isRemoteThumbnail(source)) {
    image.dataset.dmThumbnailState = 'loaded';
    image.hidden = false;
    image.onerror = () => {
      const original = normalizeThumbnailSource(image.dataset.originalThumbnail || '');
      if (allowFallback && original && original !== key) subscribeThumbnailImage(image, original, '', false);
      else markThumbnailFailed(image);
    };
    image.src = source;
    return;
  }

  const fallbackSource = normalizeThumbnailSource(fallback);
  let entry = getThumbnailEntry(key);
  if (!entry) {
    entry = {
      key,
      url: source,
      state: 'pending',
      fallbackUrl: allowFallback && fallbackSource && fallbackSource !== key ? fallbackSource : '',
      fallbackAttempted: false,
      failureExpiresAt: 0,
      queued: false,
      loading: false,
      subscribers: new Set(),
    };
    thumbnailState.cache.set(key, entry);
    const debug = globalThis.__CACATOOLS_THUMBNAIL_TEST__;
    if (debug && typeof debug === 'object') debug.cacheMisses = Number(debug.cacheMisses || 0) + 1;
  } else {
    const debug = globalThis.__CACATOOLS_THUMBNAIL_TEST__;
    if (debug && typeof debug === 'object') debug.cacheHits = Number(debug.cacheHits || 0) + 1;
    if (!entry.fallbackUrl && allowFallback && fallbackSource && fallbackSource !== key) entry.fallbackUrl = fallbackSource;
  }
  touchThumbnailEntry(entry);

  if (entry.state === 'loaded') {
    applyThumbnailLoaded(image, entry);
    return;
  }
  if (entry.state === 'failed') {
    if (allowFallback && entry.fallbackUrl && !entry.fallbackAttempted) {
      entry.fallbackAttempted = true;
      const debug = globalThis.__CACATOOLS_THUMBNAIL_TEST__;
      if (debug && typeof debug === 'object') debug.fallbacks = Number(debug.fallbacks || 0) + 1;
      subscribeThumbnailImage(image, entry.fallbackUrl, '', false);
    } else if (allowFallback && entry.fallbackUrl && entry.fallbackAttempted) {
      subscribeThumbnailImage(image, entry.fallbackUrl, '', false);
    } else {
      markThumbnailFailed(image);
    }
    return;
  }
  entry.subscribers.add(image);
  if (!entry.queued && !entry.loading) {
    entry.queued = true;
    thumbnailState.loadQueue.push(key);
  }
  pumpThumbnailQueue();
  thumbnailDebugUpdate();
}

function settleThumbnailEntry(entry, state) {
  if (!entry || entry.state !== 'pending') return;
  entry.state = state;
  entry.loading = false;
  entry.queued = false;
  entry.failureExpiresAt = state === 'failed' ? Date.now() + THUMBNAIL_FAILURE_TTL_MS : 0;
  thumbnailState.activeLoads = Math.max(0, thumbnailState.activeLoads - 1);
  const subscribers = Array.from(entry.subscribers);
  entry.subscribers.clear();
  touchThumbnailEntry(entry);
  if (state === 'loaded') subscribers.forEach((image) => applyThumbnailLoaded(image, entry));
  else subscribers.forEach((image) => {
    if (entry.fallbackUrl && !entry.fallbackAttempted) {
      entry.fallbackAttempted = true;
      const debug = globalThis.__CACATOOLS_THUMBNAIL_TEST__;
      if (debug && typeof debug === 'object') debug.fallbacks = Number(debug.fallbacks || 0) + 1;
      subscribeThumbnailImage(image, entry.fallbackUrl, '', false);
    } else if (entry.fallbackUrl && entry.fallbackAttempted) {
      subscribeThumbnailImage(image, entry.fallbackUrl, '', false);
    } else markThumbnailFailed(image);
  });
  const debug = globalThis.__CACATOOLS_THUMBNAIL_TEST__;
  if (debug && typeof debug === 'object') {
    debug.loads = Number(debug.loads || 0) + (state === 'loaded' ? 1 : 0);
    debug.failures = Number(debug.failures || 0) + (state === 'failed' ? 1 : 0);
  }
  evictThumbnailCache();
  pumpThumbnailQueue();
  thumbnailDebugUpdate();
}

function pumpThumbnailQueue() {
  while (thumbnailState.activeLoads < MAX_CONCURRENT_THUMBNAILS && thumbnailState.loadQueue.length) {
    const key = thumbnailState.loadQueue.shift();
    const entry = thumbnailState.cache.get(key);
    if (!entry || entry.state !== 'pending' || entry.loading || !entry.subscribers.size) continue;
    entry.queued = false;
    entry.loading = true;
    thumbnailState.activeLoads += 1;
    const connectedSubscribers = Array.from(entry.subscribers).filter((image) => image instanceof HTMLImageElement && image.isConnected);
    entry.subscribers.clear();
    connectedSubscribers.forEach((image) => entry.subscribers.add(image));
    const loader = connectedSubscribers[0];
    if (!loader) {
      entry.loading = false;
      entry.queued = false;
      thumbnailState.activeLoads = Math.max(0, thumbnailState.activeLoads - 1);
      continue;
    }
    entry.loader = loader;
    let settled = false;
    const finish = (state) => {
      if (settled) return;
      settled = true;
      entry.loader = null;
      settleThumbnailEntry(entry, state);
    };
    loader.loading = 'eager';
    loader.decoding = 'async';
    loader.referrerPolicy = 'no-referrer';
    loader.onload = () => finish('loaded');
    loader.onerror = () => finish('failed');
    loader.src = entry.url;
    thumbnailDebugUpdate();
  }
}

function enqueueThumbnail(image) {
  if (!(image instanceof HTMLImageElement)) return;
  const source = String(image.dataset.dmThumbnailSrc || '').trim();
  if (!source) return;
  const raw = String(image.dataset.originalThumbnail || '').trim();
  const fallback = raw && normalizeThumbnailSource(raw) !== normalizeThumbnailSource(source) ? thumbnailUrl(raw) : '';
  subscribeThumbnailImage(image, source, fallback, image.dataset.dmThumbnailFallback !== '1');
}

function thumbnailIsVisible(image) {
  if (!(image instanceof HTMLImageElement)) return false;
  const rect = image.getBoundingClientRect();
  return rect.width > 0
    && rect.height > 0
    && rect.bottom >= -220
    && rect.top <= (window.innerHeight || document.documentElement.clientHeight) + 220;
}

export function bindDownloadManagerThumbnailFallbacks(root) {
  if (!thumbnailState.observer && 'IntersectionObserver' in window) {
    thumbnailState.observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        thumbnailState.observer.unobserve(entry.target);
        enqueueThumbnail(entry.target);
      });
    }, { rootMargin: '220px 0px', threshold: 0.01 });
  }
  root.querySelectorAll('[data-dm-thumbnail]').forEach((image) => {
    if (image.dataset.dmThumbnailBound === '1') return;
    image.dataset.dmThumbnailBound = '1';
    if (image.dataset.dmThumbnailSrc) {
      if (image.dataset.dmThumbnailEager === '1' || thumbnailIsVisible(image) || !thumbnailState.observer) enqueueThumbnail(image);
      else thumbnailState.observer.observe(image);
      return;
    }
    const fallback = () => {
      const original = String(image.dataset.originalThumbnail || '').trim();
      const source = String(image.currentSrc || image.src || '');
      if (original && normalizeThumbnailSource(original) !== normalizeThumbnailSource(source) && image.dataset.dmThumbnailFallback !== '1') {
        image.dataset.dmThumbnailFallback = '1';
        image.hidden = false;
        image.parentElement?.classList.remove('dm-thumbnail-failed');
        image.src = original;
        return;
      }
      markThumbnailFailed(image);
    };
    if (image.complete && image.naturalWidth === 0) fallback();
    else image.addEventListener('error', fallback, { once: true });
  });
  evictThumbnailCache();
  thumbnailDebugUpdate();
}

