import { runtimeState, searchState, UNIFIED_SUGGESTION_CACHE_LIMIT, UNIFIED_SUGGESTION_CACHE_TTL_MS, UNIFIED_SUGGESTION_DEBOUNCE_MS, UNIFIED_SUGGESTION_TIMEOUT_MS } from './state.js';
import { bindDownloadManagerThumbnailFallbacks } from './thumbnails.js';
import { loadLocale, resolveLocale } from '../modules/i18n/index.js';
import { localizeDom } from '../modules/i18n/runtime.js';
import { invokeWithOptionalComponent, requestComponentManagerInstall } from '../modules/components/optional-install.js';
import { unifiedDetectionMarkup, unifiedSuggestionPanelMarkup } from './view/unified.js?v=0.45.1-runtime-20260903';
function looksLikeUnifiedSource(value = '') {
  const input = String(value || '').trim();
  return /^(?:https?:\/\/|magnet:)/i.test(input) || /\.torrent(?:$|[?#])/i.test(input);
}

function resolveUnifiedInputTarget(rawValue = runtimeState.unifiedQuery) {
  const value = String(rawValue || '').trim();
  if (!value) return { kind: 'empty', value: '' };
  if (looksLikeUnifiedSource(value)) return { kind: 'source', value };
  const suggestion = runtimeState.unifiedSuggestions[runtimeState.unifiedActiveIndex];
  if (suggestion) return { kind: 'suggestion', value: String(suggestion.title || '').trim(), suggestion };
  return { kind: 'search-text', value };
}


function suggestionIconForTitle(title = '', remote = false) {
  const value = String(title || '').toLocaleLowerCase('es');
  if (/\b(?:playlist|lista de reproducci[oó]n|mix|[aá]lbum)\b/.test(value)) return 'playlist';
  if (/\b(?:audio|mp3|m[uú]sica|music|song|lyrics|letra)\b/.test(value)) return 'audio';
  if (/\b(?:v[ií]deo|video|oficial|official|live|visualizer)\b/.test(value)) return 'video';
  return remote ? 'video' : 'search';
}

export function localUnifiedSuggestions(query = '') {
  // No se muestran tarjetas ficticias mientras llega la búsqueda real.
  return [];
}

function normalizeUnifiedSuggestions(results = [], query = '') {
  const remote = (Array.isArray(results) ? results : []).map((item) => {
    if (typeof item === 'string') {
      return { title: item, subtitle: 'Sugerencia de YouTube', sourceUrl: '', duration: '', similarity: 0, thumbnail: '', icon: suggestionIconForTitle(item, true), remote: true };
    }
    return {
      title: String(item?.title || query || 'Resultado multimedia'),
      subtitle: String(item?.creator || item?.uploader || item?.extractor || 'Resultado de vídeo'),
      sourceUrl: String(item?.source_url || item?.url || ''),
      duration: String(item?.duration_label || item?.duration || ''),
      similarity: Number(item?.similarity || 0),
      thumbnail: String(item?.thumbnail || ''),
      icon: String(item?.kind || '').toLowerCase() === 'playlist' ? 'playlist' : suggestionIconForTitle(item?.title || query, true),
      remote: true
    };
  }).filter((item) => item.title);
  const seen = new Set();
  return remote.filter((item) => item.sourceUrl).filter((item) => {
    const key = item.title.toLocaleLowerCase('es');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 20);
}

function unifiedRenderContext(context) {
  return {
    ...context,
    unifiedQuery: runtimeState.unifiedQuery,
    unifiedFocused: runtimeState.unifiedFocused,
    unifiedSuggestionBusy: runtimeState.unifiedSuggestionBusy,
    unifiedSuggestions: runtimeState.unifiedSuggestions,
    unifiedActiveIndex: runtimeState.unifiedActiveIndex,
    unifiedComponentPrompt: runtimeState.unifiedComponentPrompt,
    unifiedComponentPromptAccepted: runtimeState.unifiedComponentPromptAccepted,
    unifiedComponentProgress: runtimeState.unifiedComponentProgress,
    unifiedComponentError: runtimeState.unifiedComponentError
  };
}

export function paintUnifiedSearch(context, input) {
  const search = input?.closest?.('.dm-unified-search');
  if (!search) return;
  const query = String(input.value || '').slice(0, 240);
  const wrapper = search.querySelector('.dm-unified-input-wrap');
  wrapper?.classList.toggle('has-value', Boolean(query));
  const clear = search.querySelector('[data-dm-unified-clear]');
  if (clear) clear.hidden = !query;
  const detection = search.querySelector('.dm-unified-detection');
  const detectionHtml = unifiedDetectionMarkup(query);
  if (detection) detection.outerHTML = detectionHtml;
  else search.insertAdjacentHTML('beforeend', detectionHtml);
  const existingPanel = search.querySelector('.dm-unified-suggestions');
  const panelHtml = unifiedSuggestionPanelMarkup(unifiedRenderContext(context), query);
  if (!panelHtml) existingPanel?.remove();
  else if (existingPanel) existingPanel.outerHTML = panelHtml;
  else search.insertAdjacentHTML('beforeend', panelHtml);
  search.querySelector('.dm-unified-suggestions [data-action="install-optional-component"]')?.addEventListener('click', () => {
    const resolve = runtimeState.unifiedComponentPromptResolve;
    if (!resolve) return;
    runtimeState.unifiedComponentPromptAccepted = true;
    runtimeState.unifiedComponentPromptResolve = null;
    paintUnifiedSearch(context, input);
    resolve(true);
  });
  search.querySelector('.dm-unified-suggestions [data-action="dismiss-optional-component"]')?.addEventListener('click', () => {
    const resolve = runtimeState.unifiedComponentPromptResolve;
    runtimeState.unifiedComponentPromptResolve = null;
    runtimeState.unifiedComponentPrompt = null;
    runtimeState.unifiedComponentPromptAccepted = false;
    runtimeState.unifiedComponentPromptDeclined = true;
    runtimeState.unifiedComponentProgress = null;
    runtimeState.unifiedComponentError = '';
    paintUnifiedSearch(context, input);
    resolve?.(false);
  });
  search.querySelector('.dm-unified-suggestions [data-dm-unified-retry-component]')?.addEventListener('click', () => {
    runtimeState.unifiedComponentError = '';
    runtimeState.unifiedComponentProgress = null;
    scheduleUnifiedSuggestions(context, input);
  });
  bindDownloadManagerThumbnailFallbacks(search);
  // Suggestions are painted incrementally while the main surface remains
  // mounted, so apply the same runtime locale pass used by full renders.
  localizeDom(search, resolveLocale(loadLocale()));
}

async function invokeSuggestionSearch(context, query, requestId = 0, limit = 10, offset = 0) {
  const cacheKey = `${String(query || '').trim().toLocaleLowerCase('es')}|${offset}|${limit}`;
  const cached = searchState.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
  if (cached) searchState.cache.delete(cacheKey);
  const timeout = new Promise((_, reject) => window.setTimeout(() => reject(new Error('suggestion-timeout')), UNIFIED_SUGGESTION_TIMEOUT_MS));
  const isCurrent = () => requestId === runtimeState.unifiedRequestId && query === runtimeState.unifiedQuery;
  const invokePage = () => invokeWithOptionalComponent(
    (command, args) => context.invoke?.(command, args),
    'search_video_suggestions_page',
    { query, limit, offset },
    {
      beforePrompt: info => {
        if (!isCurrent()) return;
        runtimeState.unifiedComponentPrompt = info;
        runtimeState.unifiedComponentPromptAccepted = false;
        runtimeState.unifiedComponentPromptDeclined = false;
        runtimeState.unifiedComponentProgress = null;
        runtimeState.unifiedComponentError = '';
        runtimeState.unifiedSuggestionBusy = false;
        const input = document.querySelector('[data-dm-unified-input]');
        if (input && input.value === runtimeState.unifiedQuery) paintUnifiedSearch(context, input);
      },
      promptInstall: () => isCurrent()
        ? new Promise(resolve => {
          runtimeState.unifiedComponentPromptResolve = accepted => {
            runtimeState.unifiedComponentPromptDeclined = !accepted;
            resolve(accepted);
          };
        })
        : false,
      onInstallRequested: info => {
        runtimeState.unifiedRequestId += 1;
        runtimeState.unifiedComponentPromptResolve = null;
        runtimeState.unifiedComponentPrompt = null;
        runtimeState.unifiedComponentPromptAccepted = false;
        runtimeState.unifiedComponentPromptDeclined = false;
        runtimeState.unifiedComponentProgress = null;
        runtimeState.unifiedComponentError = '';
        return requestComponentManagerInstall(info.componentId);
      },
      onProgress: progress => {
        if (!isCurrent()) return;
        runtimeState.unifiedComponentPrompt = null;
        runtimeState.unifiedComponentProgress = { ...progress };
        runtimeState.unifiedComponentError = '';
        runtimeState.unifiedSuggestionBusy = !['done', 'error', 'cancelled'].includes(progress?.phase);
        const input = document.querySelector('[data-dm-unified-input]');
        if (input && input.value === runtimeState.unifiedQuery) paintUnifiedSearch(context, input);
      }
    }
  );
  const request = Promise.race([
    Promise.resolve(invokePage()).then(result => result || []),
    timeout
  ]);
  searchState.cache.set(cacheKey, { value: request, expiresAt: Date.now() + UNIFIED_SUGGESTION_TIMEOUT_MS });
  let result;
  try {
    result = await request;
  } catch (error) {
    if (searchState.cache.get(cacheKey)?.value === request) searchState.cache.delete(cacheKey);
    throw error;
  }
  searchState.cache.delete(cacheKey);
  searchState.cache.set(cacheKey, { value: result, expiresAt: Date.now() + UNIFIED_SUGGESTION_CACHE_TTL_MS });
  while (searchState.cache.size > UNIFIED_SUGGESTION_CACHE_LIMIT) searchState.cache.delete(searchState.cache.keys().next().value);
  return result;
}

function normalizedUnifiedQuery(value = '') {
  return String(value || '').trim().toLocaleLowerCase('es');
}

function reusableUnifiedRemoteResults(query) {
  const target = normalizedUnifiedQuery(query);
  const base = normalizedUnifiedQuery(searchState.remoteQuery);
  if (!target || !base || !searchState.remoteResults.length || searchState.remoteExpiresAt <= Date.now()) return null;
  if (!target.startsWith(base) && !base.startsWith(target)) return null;
  const filtered = searchState.remoteResults.filter((item) => {
    const text = [item?.title, item?.creator, item?.uploader].filter(Boolean).join(' ').toLocaleLowerCase('es');
    return text.includes(target);
  });
  return filtered.length ? filtered : null;
}

async function drainUnifiedSuggestionRequest(request) {
  const { context, query, requestId } = request;
  if (requestId !== runtimeState.unifiedRequestId || query !== runtimeState.unifiedQuery) return;
  let firstDisplayed = false;
  try {
    const reused = reusableUnifiedRemoteResults(query);
    const first = reused || await invokeSuggestionSearch(context, query.trim(), requestId, 10, 0);
    let combined = Array.isArray(first) ? first : [];
    let stale = requestId !== runtimeState.unifiedRequestId || query !== runtimeState.unifiedQuery;
    if (!stale) {
      runtimeState.unifiedSuggestions = normalizeUnifiedSuggestions(combined, query);
      firstDisplayed = true;
      const liveInput = document.querySelector('[data-dm-unified-input]');
      if (liveInput && liveInput.value === query) paintUnifiedSearch(context, liveInput);
    }
    if (!reused && requestId === runtimeState.unifiedRequestId && query === runtimeState.unifiedQuery) {
      let second = [];
      try {
        second = await invokeSuggestionSearch(context, query.trim(), requestId, 10, 10);
      } catch (error) {
        if (!/search_cancelled/i.test(String(error?.message || error || ''))) second = [];
      }
      combined = combined.concat(Array.isArray(second) ? second : []);
    }
    stale = requestId !== runtimeState.unifiedRequestId || query !== runtimeState.unifiedQuery;
    if (!stale) {
      searchState.remoteQuery = query;
      searchState.remoteResults = combined;
      searchState.remoteExpiresAt = Date.now() + UNIFIED_SUGGESTION_CACHE_TTL_MS;
      runtimeState.unifiedSuggestions = normalizeUnifiedSuggestions(combined, query);
    }
  } catch (error) {
    const stale = requestId !== runtimeState.unifiedRequestId || query !== runtimeState.unifiedQuery;
    if (!stale && !firstDisplayed && !/search_cancelled/i.test(String(error?.message || error || ''))) {
      runtimeState.unifiedSuggestions = [];
      if (error?.code === 'CDM_OPTIONAL_COMPONENT_FLOW_STOP' && !runtimeState.unifiedComponentPromptDeclined) {
        const terminal = ['error', 'cancelled'].includes(runtimeState.unifiedComponentProgress?.phase);
        if (!terminal) {
          runtimeState.unifiedComponentError = runtimeState.unifiedComponentPromptAccepted
            ? 'No se pudo instalar MediaTools. Reintenta la búsqueda.'
            : 'No se pudo comprobar la disponibilidad de MediaTools. Reintenta la búsqueda.';
          runtimeState.unifiedComponentProgress = null;
          runtimeState.unifiedComponentPrompt = null;
        }
        runtimeState.unifiedComponentPromptAccepted = false;
      }
    }
  } finally {
    const stale = requestId !== runtimeState.unifiedRequestId || query !== runtimeState.unifiedQuery;
    if (!stale) {
      runtimeState.unifiedSuggestionBusy = false;
      runtimeState.unifiedComponentPromptAccepted = false;
      const liveInput = document.querySelector('[data-dm-unified-input]');
      if (liveInput && liveInput.value === query) paintUnifiedSearch(context, liveInput);
    }
  }
}

export function scheduleUnifiedSuggestions(context, input) {
  const query = String(input.value || '').slice(0, 240);
  runtimeState.unifiedComponentPromptResolve?.(false);
  runtimeState.unifiedComponentPromptResolve = null;
  runtimeState.unifiedComponentPrompt = null;
  runtimeState.unifiedComponentPromptAccepted = false;
  runtimeState.unifiedComponentPromptDeclined = false;
  runtimeState.unifiedComponentProgress = null;
  runtimeState.unifiedComponentError = '';
  runtimeState.unifiedQuery = query;
  runtimeState.unifiedFocused = true;
  runtimeState.unifiedActiveIndex = -1;
  runtimeState.unifiedSuggestions = [];
  runtimeState.unifiedSuggestionBusy = query.trim().length >= 2 && !looksLikeUnifiedSource(query);
  runtimeState.unifiedSuggestionQuery = query;
  window.clearTimeout(searchState.timer);
  const requestId = ++runtimeState.unifiedRequestId;
  paintUnifiedSearch(context, input);
  // Invalidate an obsolete backend flight as soon as the input changes. The
  // empty, validated Search request is an existing IPC path and never spawns
  // yt-dlp; it only advances cancellation for work no longer relevant.
  void Promise.resolve(context.invoke?.('search_video_suggestions', { query: '', limit: 1 })).catch(() => {});
  if (!runtimeState.unifiedSuggestionBusy) {
    // Avanza el token nativo para detener un yt-dlp que siga resolviendo la
    // consulta anterior al borrar el texto o cambiar a una URL.
    void Promise.resolve(context.invoke?.('search_video_suggestions', { query: '', limit: 1 })).catch(() => {});
    return;
  }
  searchState.timer = window.setTimeout(() => {
    void drainUnifiedSuggestionRequest({ context, query, requestId });
  }, UNIFIED_SUGGESTION_DEBOUNCE_MS);
}

export function moveUnifiedSuggestion(context, input, direction) {
  const count = runtimeState.unifiedSuggestions.length;
  if (!count) return;
  runtimeState.unifiedActiveIndex = (runtimeState.unifiedActiveIndex + direction + count) % count;
  paintUnifiedSearch(context, input);
  document.querySelector(`#dm-suggestion-${runtimeState.unifiedActiveIndex}`)?.scrollIntoView({ block: 'nearest' });
}

export async function submitUnifiedInput(context, rawValue = runtimeState.unifiedQuery, rerenderFn = null) {
  const rerender = rerenderFn || ((nextContext) => nextContext.onRerender?.());
  const target = resolveUnifiedInputTarget(rawValue);
  if (runtimeState.unifiedBusy) return;
  if (target.kind === 'empty') {
    context.onToast?.('Pega un enlace o selecciona un video primero.', 'info');
    return;
  }
  if (target.kind === 'search-text') {
    context.onToast?.('Selecciona un video primero.', 'info');
    return;
  }
  if (target.kind === 'suggestion' && !target.suggestion.sourceUrl) {
    context.onToast?.('Selecciona un video primero.', 'info');
    return;
  }
  const value = target.kind === 'suggestion' ? target.suggestion.sourceUrl : target.value;
  window.clearTimeout(searchState.timer);
  runtimeState.unifiedRequestId += 1;
  runtimeState.unifiedSuggestionBusy = false;
  if (/^magnet:/i.test(value) || /\.torrent(?:$|[?#])/i.test(value)) {
    runtimeState.modal = 'torrent';
    runtimeState.torrentSource = value;
    runtimeState.torrentBusy = false;
    runtimeState.unifiedFocused = false;
    rerender(context);
    return;
  }
  runtimeState.unifiedBusy = true;
  if (target.kind === 'suggestion') {
    runtimeState.unifiedQuery = target.suggestion.title;
    runtimeState.unifiedActiveIndex = -1;
  }
  runtimeState.unifiedFocused = false;
  rerender(context);
  try {
    if (target.kind === 'source' || target.kind === 'suggestion') {
      await context.onAnalyzeSource?.(value, { query: target.kind === 'suggestion' ? target.suggestion.title : value, alternatives: target.kind === 'suggestion' ? runtimeState.unifiedSuggestions : [] });
      runtimeState.unifiedQuery = '';
      runtimeState.unifiedSuggestions = [];
      return;
    }
    throw new Error('Entrada multimedia no válida');
  } catch (error) {
    context.onToast?.(String(error), 'error');
    runtimeState.unifiedFocused = true;
  } finally {
    runtimeState.unifiedBusy = false;
    rerender(context);
  }
}
