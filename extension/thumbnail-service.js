const imageCache = new Map();
const inFlight = new Map();
const FALLBACK_THUMBNAIL = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="#1b2a3b"/><path d="M140 62h40v56h-40zM126 78h68v24h-68z" fill="#9aa9ba" opacity=".8"/><circle cx="160" cy="90" r="53" fill="none" stroke="#60758d" stroke-width="5"/></svg>');

function validUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return ['http:', 'https:', 'data:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function youtubeId(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.hostname.replace(/^www\./, '') === 'youtu.be') return url.pathname.slice(1).split('/')[0];
    return url.searchParams.get('v') || (/^\/shorts\/([^/]+)/i.exec(url.pathname)?.[1] || '');
  } catch { return ''; }
}

function youtubeCandidates(item) {
  const id = youtubeId(item?.canonicalUrl || item?.mediaUrl || item?.pageUrl);
  if (!id) return [];
  const encoded = encodeURIComponent(id);
  return [
    `https://i.ytimg.com/vi/${encoded}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${encoded}/sddefault.jpg`,
    `https://i.ytimg.com/vi/${encoded}/hqdefault.jpg`,
    `https://i.ytimg.com/vi/${encoded}/mqdefault.jpg`
  ];
}

export function thumbnailCandidates(item = {}) {
  const platform = String(item.platform || '').toLowerCase();
  const candidates = [];
  if (platform === 'youtube' || platform === 'youtube-music' || /(?:youtube\.com|youtu\.be)/i.test(String(item.canonicalUrl || item.pageUrl || ''))) {
    candidates.push(...youtubeCandidates(item));
  }
  candidates.push(...(Array.isArray(item.thumbnailCandidates) ? item.thumbnailCandidates : []));
  candidates.push(item.thumbnail, item.ogImage, item.twitterImage, item.poster, item.cacaThumbnail);
  const unique = [];
  for (const value of candidates) {
    const url = validUrl(value);
    if (url && !unique.includes(url)) unique.push(url);
  }
  return unique;
}

function loadImage(url, timeoutMs) {
  if (imageCache.has(url)) return Promise.resolve(imageCache.get(url));
  if (inFlight.has(url)) return inFlight.get(url);
  const promise = new Promise((resolve) => {
    const image = new Image();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      if (result.ok) imageCache.set(url, result);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, url, timedOut: true }), timeoutMs);
    image.onload = () => {
      const naturalWidth = Number(image.naturalWidth || 0);
      const naturalHeight = Number(image.naturalHeight || 0);
      finish({ ok: naturalWidth > 0 && naturalHeight > 0, url, naturalWidth, naturalHeight });
    };
    image.onerror = () => finish({ ok: false, url });
    image.src = url;
  }).finally(() => inFlight.delete(url));
  inFlight.set(url, promise);
  return promise;
}

export async function resolveThumbnail(item, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Math.min(2500,Number(options.timeoutMs)) : 2200;
  const minWidth = Number(options.minWidth) > 0 ? Number(options.minWidth) : 300;
  const candidates = thumbnailCandidates(item).slice(0,8);
  let best = null;
  // Bound the entire attempt, not each URL multiplied by long sequential retries.
  // A later refresh retries failed sources without changing signed URL parameters.
  const results=await Promise.all(candidates.map(url=>loadImage(url,timeoutMs)));
  for (const result of results) {
    if (!result.ok) continue;
    if (!best || result.naturalWidth * result.naturalHeight > best.naturalWidth * best.naturalHeight) best = result;
    if (result.naturalWidth >= minWidth && result.naturalHeight >= minWidth * .5) return result;
  }
  if (best) return best;
  return { ok: true, url: FALLBACK_THUMBNAIL, naturalWidth: 320, naturalHeight: 180, fallback: true };
}

export function fallbackThumbnail() { return FALLBACK_THUMBNAIL; }
