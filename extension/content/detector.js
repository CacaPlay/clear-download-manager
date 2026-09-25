(function installCacaToolsDetector() {
  if (globalThis.__cacatoolsDetectorInstalled) return;
  globalThis.__cacatoolsDetectorInstalled = true;

  const MAX_DETECTIONS = 20;
  const MIN_CONFIDENCE = 60;
  const MEDIA_EXTENSIONS = /\.(?:mp3|m4a|aac|wav|flac|ogg|opus|mp4|webm|mkv|mov|avi|m3u8)(?:$|[?#])/i;
  const DIRECT_FILE_EXTENSIONS = /\.(?:zip|7z|rar|tar|gz|bz2|xz|zst|cab|jar|exe|msi|msix|appx|apk|deb|rpm|dmg|iso|img|vhd|vhdx|pdf|csv|json|xml)(?:$|[?#])/i;
  const BLOB_SCHEME = 'blob:';
  const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
  const AUDIO_EXTENSIONS = /\.(?:mp3|m4a|aac|wav|flac|ogg|opus)(?:$|[?#])/i;
  const seen = new Set();
  let lastSignature = '';
  let publishTimer = 0;
  let lastUrl = location.href;

  const cleanText = (value, limit = 300) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const safeUrl = (value) => {
    try {
      const url = new URL(String(value || '').trim(), location.href);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch { return ''; }
  };
  const meta = (...selectors) => {
    for (const selector of selectors) {
      const value = cleanText(document.querySelector(selector)?.getAttribute('content'));
      if (value) return value;
    }
    return '';
  };
  const pageTitle = () => cleanText(meta('meta[property="og:title"]', 'meta[name="twitter:title"]', 'meta[itemprop="name"]') || document.title);
  const pageAuthor = () => cleanText(meta('meta[property="og:site_name"]', 'meta[name="author"]', 'meta[itemprop="author"]'));
  const imageMeta = () => [
    meta('meta[property="og:image"]'),
    meta('meta[name="twitter:image"]'),
    meta('meta[itemprop="thumbnailUrl"]')
  ].map(safeUrl).filter(Boolean);
  const pageImage = () => imageMeta()[0] || '';
  const hostName = () => location.hostname.toLowerCase().replace(/^www\./, '');
  const isYouTube = () => YOUTUBE_HOSTS.has(hostName());
  const providerName = () => {
    const host = hostName();
    if (YOUTUBE_HOSTS.has(host)) return 'youtube';
    if (/(^|\.)tiktok\.com$/i.test(host)) return 'tiktok';
    if (/(^|\.)pinterest\.com$/i.test(host)) return 'pinterest';
    return 'generic';
  };
  const mediaKindFromUrl = (value) => AUDIO_EXTENSIONS.test(String(value || ''))
    ? 'audio'
    : MEDIA_EXTENSIONS.test(String(value || '')) ? 'video' : 'file';
  const durationLabel = (seconds) => {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 1) return '';
    const total = Math.round(value);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  };

  function firstText(...selectors) {
    for (const selector of selectors) {
      const value = cleanText(document.querySelector(selector)?.textContent);
      if (value) return value;
    }
    return '';
  }

  function youtubeDetails(identity = canonicalYouTube()) {
    const player = globalThis.ytInitialPlayerResponse;
    const details = player?.videoDetails || {};
    const thumbs = Array.isArray(details.thumbnail?.thumbnails) ? details.thumbnail.thumbnails : [];
    const ordered = [...thumbs].sort((a, b) => (Number(b?.width || 0) * Number(b?.height || 0)) - (Number(a?.width || 0) * Number(a?.height || 0)));
    const video = document.querySelector('video');
    const title = cleanText(details.title)
      || firstText('ytd-watch-metadata h1 yt-formatted-string', '#title h1', 'h1.title', 'meta[itemprop="name"]')
      || cleanText(meta('meta[property="og:title"]', 'meta[name="twitter:title"]'));
    const author = cleanText(details.author)
      || firstText('ytd-channel-name a', '#owner-name a', '#upload-info a', '[itemprop="author"] [itemprop="name"]')
      || pageAuthor();
    const id = identity?.id || '';
    const generatedThumbnail = id ? `https://i.ytimg.com/vi/${encodeURIComponent(id)}/maxresdefault.jpg` : '';
    return {
      title: title && title.toLowerCase() !== 'youtube' ? title : '',
      author,
      duration: durationLabel(details.lengthSeconds || video?.duration),
      thumbnail: safeUrl(ordered[0]?.url || generatedThumbnail || pageImage()),
      thumbnailCandidates: [generatedThumbnail, id ? `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg` : '', ...imageMeta()].map(safeUrl).filter(Boolean)
    };
  }

  function canonicalYouTube() {
    const url = new URL(location.href);
    const idFromPath = url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/i)?.[1] || '';
    const id = url.searchParams.get('v') || idFromPath || (hostName() === 'youtu.be' ? url.pathname.slice(1) : '');
    const list = url.searchParams.get('list') || '';
    if (/^\/playlist$/i.test(url.pathname) && list) return { type: 'playlist', id: list, url: `https://www.youtube.com/playlist?list=${encodeURIComponent(list)}` };
    if (/^\/shorts\//i.test(url.pathname) && id) return { type: 'video', id, url: `https://www.youtube.com/shorts/${encodeURIComponent(id)}` };
    if (id) return { type: 'video', id, url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` };
    return null;
  }

  function canonicalGeneric(value) {
    const url = safeUrl(value);
    if (!url) return '';
    try {
      const parsed = new URL(url);
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'si', 'feature'].forEach((key) => parsed.searchParams.delete(key));
      parsed.hash = '';
      return parsed.href;
    } catch { return url; }
  }

  function candidateKey(candidate) {
    const type = candidate.type || 'unknown_media';
    const canonical = candidate.canonicalUrl || candidate.mediaUrl || candidate.pageUrl;
    let id = canonical;
    try {
      const parsed = new URL(canonical);
      id = `${parsed.hostname}${parsed.pathname}${parsed.search}`.toLowerCase();
    } catch { /* URL already normalized above. */ }
    return `${hostName()}|${type}|${id}`;
  }

  function add(list, raw = {}, context = {}) {
    const original = String(raw.mediaUrl || '').trim();
    const pageUrl = safeUrl(location.href);
    const isBlob = original.toLowerCase().startsWith(BLOB_SCHEME) || /^data:/i.test(original);
    const mediaUrl = safeUrl(isBlob ? pageUrl : (original || raw.canonicalUrl || pageUrl));
    if (!mediaUrl) return;
    const type = String(raw.type || context.type || 'unknown_media').toLowerCase();
    if (type === 'image' || type === 'unknown_media') return;
    const confidence = Number(raw.confidence ?? context.confidence ?? 0);
    if (confidence < MIN_CONFIDENCE) return;
    const canonicalUrl = canonicalGeneric(raw.canonicalUrl || mediaUrl);
    const candidate = {
      id: candidateKey({ type, canonicalUrl, mediaUrl, pageUrl }),
      type,
      mediaKind: cleanText(raw.mediaKind || context.mediaKind),
      pageUrl,
      mediaUrl,
      canonicalUrl,
      title: cleanText(raw.title || context.title || pageTitle()),
      author: cleanText(raw.author || context.author || pageAuthor()),
      duration: cleanText(raw.duration || context.duration),
      thumbnail: safeUrl(raw.thumbnail || context.thumbnail || pageImage()),
      thumbnailCandidates: [...new Set([...(raw.thumbnailCandidates || []), ...imageMeta()])].slice(0, 8),
      platform: hostName(),
      playlistTitle: cleanText(raw.playlistTitle),
      playlistItemCount: Number(raw.playlistItemCount || 0) || undefined,
      playlistId: cleanText(raw.playlistId || context.playlistId),
      sourceKind: cleanText(raw.sourceKind || context.sourceKind || (type === 'direct_file' ? 'direct_file' : type === 'playlist' ? 'playlist' : 'page')),
      provider: cleanText(raw.provider || context.provider || providerName()),
      confidence,
      requiresDesktopAnalysis: true
    };
    const key = candidateKey(candidate);
    if (seen.has(key)) return;
    seen.add(key);
    candidate.id = key;
    list.push(candidate);
  }

  function youtubeAdapter() {
    if (!isYouTube()) return null;
    const identity = canonicalYouTube();
    if (!identity) return [];
    const details = youtubeDetails(identity);
    const list = [];
    if (identity.type === 'playlist') return list;
    add(list, { type: 'video', canonicalUrl: identity.url, mediaUrl: identity.url, sourceKind: 'provider_page', provider: 'youtube', title: details.title || 'Vídeo de YouTube', author: details.author, duration: details.duration, thumbnail: details.thumbnail, thumbnailCandidates: details.thumbnailCandidates, confidence: 99 }, details);
    return list;
  }

  function parseJsonLd() {
    const values = [];
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent || '');
        values.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      } catch { /* JSON-LD incompleto durante la carga: se ignora y continúa el fallback. */ }
    }
    return values;
  }

  function genericAdapter() {
    const list = [];
    const title = pageTitle();
    const author = pageAuthor();
    const thumbnail = pageImage();
    const structured = parseJsonLd();
    for (const entry of structured) {
      const type = String(entry?.['@type'] || '').toLowerCase();
      if (['videoobject', 'audioobject'].includes(type)) {
        const mediaUrl = entry.contentUrl || entry.embedUrl || entry.url;
        if (!mediaUrl) continue;
        add(list, { type: type === 'audioobject' ? 'audio' : 'video', mediaUrl, sourceKind: entry.contentUrl ? 'structured_media' : 'structured_page', canonicalUrl: entry.url || mediaUrl, title: entry.name || title, author: entry.author?.name || entry.author || author, thumbnail: entry.thumbnailUrl || entry.image || thumbnail, duration: entry.duration, confidence: 90 });
      }
    }
    const ogVideo = meta('meta[property="og:video:url"]', 'meta[property="og:video"]', 'meta[property="twitter:player:stream"]');
    const ogAudio = meta('meta[property="og:audio:url"]', 'meta[property="og:audio"]');
    if (ogVideo) add(list, { type: 'video', mediaUrl: ogVideo, title, author, thumbnail, confidence: 92 });
    if (ogAudio) add(list, { type: 'audio', mediaUrl: ogAudio, title, author, thumbnail, confidence: 92 });
    for (const element of document.querySelectorAll('video, audio')) {
      const source = element.currentSrc || element.src || element.querySelector?.('source')?.src || '';
      if (!source) continue;
      const type = element.tagName.toLowerCase();
      add(list, { type, mediaUrl: source, sourceKind: 'dom_media', title, author, thumbnail, duration: durationLabel(element.duration), confidence: 96 }, { title, author, thumbnail });
    }
    for (const source of document.querySelectorAll('video source, audio source')) {
      const url = safeUrl(source.src || source.getAttribute?.('src'));
      if (!url) continue;
       add(list, { type: /audio/i.test(source.type || '') ? 'audio' : 'video', mediaUrl: url, sourceKind: 'dom_source', title, author, thumbnail, confidence: 94 });
    }
    for (const element of document.querySelectorAll('[data-video],[data-video-url],[data-media-url],[data-audio-url],[data-src]')) {
      const url = safeUrl(element.getAttribute('data-video') || element.getAttribute('data-video-url') || element.getAttribute('data-media-url') || element.getAttribute('data-audio-url') || element.getAttribute('data-src'));
      if (!url) continue;
      const audio = /audio|\.mp3(?:$|[?#])|\.m4a(?:$|[?#])/i.test(`${element.tagName} ${element.getAttribute('data-audio-url') || ''} ${url}`);
      add(list, { type: audio ? 'audio' : 'video', mediaUrl: url, sourceKind: 'data_media', title: cleanText(element.getAttribute('aria-label') || element.textContent) || title, author, thumbnail, confidence: 88 });
    }
    for (const link of document.querySelectorAll('link[rel="video_src"], link[rel="alternate"][type^="video/"]')) {
      const url = safeUrl(link.href || link.getAttribute('href'));
      if (url) add(list, { type: 'video', mediaUrl: url, sourceKind: 'link_media', title, author, thumbnail, confidence: 88 });
    }
    for (const link of document.querySelectorAll('a[href]')) {
      const url = safeUrl(link.href);
       if (!url || (!MEDIA_EXTENSIONS.test(url) && !DIRECT_FILE_EXTENSIONS.test(url))) continue;
       add(list, { type: 'direct_file', mediaKind: mediaKindFromUrl(url), sourceKind: 'direct_file', mediaUrl: url, title: cleanText(link.textContent) || title, author, thumbnail, confidence: 95 });
    }
    return list;
  }

  function collect() {
    seen.clear();
    const platformResults = youtubeAdapter();
    // Automatic capture is intentionally item-oriented. Playlist/Mix objects
    // are kept out of the detector so they can only be created from the
    // user's manual playlist flow.
    const detections = (platformResults === null ? genericAdapter() : platformResults)
      .filter((item) => item?.type !== 'playlist')
      .slice(0, MAX_DETECTIONS);
    return {
      status: detections.length ? 'media_found' : (location.protocol === 'chrome:' ? 'restricted_page' : 'no_media'),
      detections
    };
  }

  const publish = (force = false) => {
    clearTimeout(publishTimer);
    publishTimer = setTimeout(() => {
      const result = collect();
      const signature = JSON.stringify(result.detections.map(({ id, title, mediaUrl, thumbnail, duration }) => ({ id, title, mediaUrl, thumbnail, duration })));
      if (!force && signature === lastSignature && location.href === lastUrl) return;
      lastSignature = signature;
      lastUrl = location.href;
      chrome.runtime.sendMessage({ type: 'CONTENT_DETECTIONS', pageUrl: location.href, status: result.status, detections: result.detections }).catch(() => {});
    }, 180);
  };

  globalThis.__cacatoolsCollectDetections = () => collect();
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'CACATOOLS_COLLECT') sendResponse(globalThis.__cacatoolsCollectDetections());
    return false;
  });

  const observer = new MutationObserver(() => publish(false));
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'poster', 'href'] });
  window.addEventListener('popstate', () => publish(true), { passive: true });
  window.addEventListener('hashchange', () => publish(true), { passive: true });
  document.addEventListener?.('yt-navigate-finish', () => publish(true), { passive: true });
  document.addEventListener?.('yt-page-data-updated', () => publish(true), { passive: true });
  document.addEventListener?.('loadedmetadata', () => publish(true), { capture: true, passive: true });
  window.setInterval(() => { if (location.href !== lastUrl) publish(true); }, 800);
  publish(true);
})();
