#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/screenshots/phase24-1-extension'
REPORT = ROOT / 'docs/tests/phase24-1-extension-visual-smoke.json'
OUT.mkdir(parents=True, exist_ok=True)
REPORT.parent.mkdir(parents=True, exist_ok=True)


def fixture_html() -> str:
    html = (ROOT / 'extension/sidepanel.html').read_text(encoding='utf-8')
    css = (ROOT / 'extension/sidepanel.css').read_text(encoding='utf-8')
    sidepanel = (ROOT / 'extension/sidepanel.js').read_text(encoding='utf-8')
    thumbnail = (ROOT / 'extension/thumbnail-service.js').read_text(encoding='utf-8')
    thumbnail = thumbnail.replace('export function ', 'function ').replace('export async function ', 'async function ')
    sidepanel = sidepanel.replace("import { fallbackThumbnail, resolveThumbnail } from './thumbnail-service.js';", thumbnail)
    html = html.replace('<link rel="stylesheet" href="sidepanel.css">', f'<style>{css}</style>')
    html = html.replace('<script type="module" src="sidepanel.js"></script>', f'<script type="module">{sidepanel}</script>')
    return html


def mock_script(theme: str, accent: str) -> str:
    thumbnail = 'https://i.ytimg.com/vi/jSOLkn7q83Y/mqdefault.jpg'
    storage = {
        'browserCaptureMode': 'automatic', 'preferredQuality': 'auto', 'preferredFormat': 'auto',
        'extensionWindowMode': 'background', 'extensionAppearanceMode': 'follow-app',
        'extensionCustomTheme': 'dark', 'extensionCustomAccent': '#5f73ff',
        'extensionPanels': {'downloads': False, 'links': False},
        'manualLinkCollections': [{'id': 'collection-1', 'name': 'Mi playlist', 'createdAt': 1, 'links': [
            {'id': 'link-1', 'url': 'https://www.youtube.com/watch?v=jSOLkn7q83Y', 'title': 'La historia completa de CacaTools', 'author': 'Canal de prueba', 'thumbnail': thumbnail, 'selected': True, 'metadataResolved': True},
            {'id': 'link-2', 'url': 'https://www.youtube.com/watch?v=v1qMvCfpNc4', 'title': 'Segundo vídeo de la playlist', 'author': 'Canal de prueba', 'thumbnail': thumbnail, 'selected': True, 'metadataResolved': True}
        ]}],
        'activeManualCollectionId': 'collection-1', 'looseManualLinks': [],
        'extensionHistory': [{'title': 'Descarga anterior', 'count': 1}], 'pendingExtensionUpdate': None,
        'lastAppState': {'appearance': {'theme': theme, 'accent': accent, 'motion': False, 'intensity': 88, 'contrast': 108}, 'jobs': [
            {'id': 1, 'title': 'Vídeo largo descargándose desde YouTube', 'detail': 'Procesando fragmentos', 'progress': 47, 'status': 'running', 'kind': 'video', 'speedBps': 3250000, 'etaSeconds': 19, 'thumbnail': thumbnail},
            {'id': 2, 'title': 'Vídeo terminado', 'detail': 'Completado', 'progress': 100, 'status': 'completed', 'kind': 'video', 'speedBps': 0, 'etaSeconds': None, 'thumbnail': thumbnail}
        ], 'queue': {}, 'updatedAt': 1}
    }
    detections = [{'id': 'yt-video', 'type': 'video', 'title': 'Contenido detectado en la pestaña actual', 'author': 'Canal de prueba', 'duration': '12:34', 'platform': 'youtube.com', 'pageUrl': 'https://www.youtube.com/watch?v=test123', 'mediaUrl': 'https://www.youtube.com/watch?v=test123', 'canonicalUrl': 'https://www.youtube.com/watch?v=test123', 'thumbnail': thumbnail, 'thumbnailCandidates': [thumbnail], 'selected': True}]
    return f"""
(() => {{
  const storage = {json.dumps(storage)};
  const detections = {json.dumps(detections)};
  const portListeners = [];
  const port = {{ onMessage: {{ addListener(fn) {{ portListeners.push(fn); }} }}, onDisconnect: {{ addListener() {{}} }}, postMessage() {{}} }};
  const emit = (message) => portListeners.forEach((listener) => listener(message));
  window.chrome = {{
    runtime: {{
      connect() {{ return port; }}, getManifest() {{ return {{ version: '0.24.1' }}; }},
      sendMessage(message) {{
        if (message?.type === 'ANALYZE_ACTIVE') {{ queueMicrotask(() => emit({{ type: 'DETECTIONS', status: 'media_found', detections }})); return Promise.resolve({{ ok: true, detections }}); }}
        if (message?.type === 'GET_APP_STATUS') return Promise.resolve({{ ok: true, result: {{ appRunning: true, state: storage.lastAppState }} }});
        if (message?.type === 'RESOLVE_LINK_METADATA') return Promise.resolve({{ ok: true, metadata: {{ title: 'Vídeo resuelto', author: 'Canal', thumbnail: '{thumbnail}' }} }});
        return Promise.resolve({{ ok: true }});
      }}, onMessage: {{ addListener() {{}} }}, lastError: null
    }},
    storage: {{ local: {{ get(defaults) {{ return Promise.resolve({{ ...defaults, ...storage }}); }}, set(values) {{ Object.assign(storage, values); return Promise.resolve(); }}, remove(key) {{ delete storage[key]; return Promise.resolve(); }} }} }}
  }};
}})();
"""


def contrast_ratio(page, foreground_selector: str, background_selector: str) -> float:
    return float(page.evaluate(r"""([fgSelector,bgSelector]) => {
      const parse = (value) => { const values=value.match(/[\d.]+/g)?.slice(0,3).map(Number)||[0,0,0]; return Math.max(...values)<=1?values.map(v=>v*255):values; };
      const lum = (rgb) => rgb.map(v => { v/=255; return v<=.04045?v/12.92:((v+.055)/1.055)**2.4; }).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
      const fg = getComputedStyle(document.querySelector(fgSelector)).color;
      const bg = getComputedStyle(document.querySelector(bgSelector)).backgroundColor;
      const a=lum(parse(fg)), b=lum(parse(bg)); return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
    }""", [foreground_selector, background_selector]))


results = []
html = fixture_html()
with sync_playwright() as pw:
    executable = os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') or ('/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None)
    launch = {'headless': True, 'args': ['--disable-gpu', '--no-sandbox']}
    if executable: launch['executable_path'] = executable
    browser = pw.chromium.launch(**launch)
    for name, theme, accent, width in [('light-bright-green', 'light', '#58ff70', 640), ('dark-blue', 'dark', '#5f73ff', 640), ('dark-narrow-status-dot', 'dark', '#5f73ff', 360)]:
        failures: list[str] = []
        errors: list[str] = []
        page = browser.new_page(viewport={'width': width, 'height': 1100}, reduced_motion='reduce')
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.evaluate(mock_script(theme, accent))
        page.set_content(html, wait_until='domcontentloaded', timeout=20_000)
        page.wait_for_selector('.item', timeout=10_000)
        page.wait_for_timeout(600)
        metrics = page.evaluate("""() => {
          const rect = (selector) => { const r=document.querySelector(selector)?.getBoundingClientRect(); return r?{top:r.top,bottom:r.bottom,width:r.width,height:r.height}:null; };
          return { detected:rect('.primary-section'),downloads:rect('[data-panel="downloads"]'),links:rect('[data-panel="links"]'),manualThumb:rect('.manual-link-thumb'),downloadThumb:rect('.download-thumb'),overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,updateHidden:document.querySelector('#extension-update')?.hidden,theme:document.body.dataset.theme,primaryInk:getComputedStyle(document.querySelector('.primary')).color,primaryBg:getComputedStyle(document.querySelector('.primary')).backgroundColor,brandBg:getComputedStyle(document.querySelector('.brand-mark')).backgroundColor,brandBorder:getComputedStyle(document.querySelector('.brand-mark')).borderColor,statusColor:getComputedStyle(document.querySelector('#connection')).color,statusFontSize:parseFloat(getComputedStyle(document.querySelector('#connection')).fontSize),statusDotWidth:parseFloat(getComputedStyle(document.querySelector('#connection'),'::before').width),statusDotColor:getComputedStyle(document.querySelector('#connection'),'::before').backgroundColor,topbarBg:getComputedStyle(document.querySelector('.topbar')).backgroundColor};
        }""")
        if errors: failures.append(f'Errores JS: {errors}')
        detected_limit = 500 if width <= 390 else 360
        if not metrics['detected'] or metrics['detected']['top'] > detected_limit: failures.append('Contenido detectado no queda visible como sección principal')
        if not (metrics['detected']['top'] < metrics['downloads']['top'] < metrics['links']['top']): failures.append('Jerarquía visual incorrecta')
        if metrics['overflow'] > 1: failures.append('Existe scroll horizontal')
        if not metrics['updateHidden']: failures.append('Actualizador visible sin evento real')
        if not metrics['manualThumb'] or metrics['manualThumb']['width'] > 54 or metrics['manualThumb']['height'] > 36: failures.append('Miniatura manual no es compacta')
        if not metrics['downloadThumb'] or metrics['downloadThumb']['width'] > 70: failures.append('Miniatura de descarga demasiado grande')
        primary_contrast = contrast_ratio(page, '.primary', '.primary')
        status_contrast = contrast_ratio(page, '#connection', '.topbar')
        if primary_contrast < 4.5: failures.append(f'Contraste botón primario insuficiente: {primary_contrast:.2f}')
        if status_contrast < 4.5: failures.append(f'Contraste de estado insuficiente: {status_contrast:.2f}')
        if width <= 390:
            if metrics['statusFontSize'] != 0: failures.append('El texto de estado no se ocultó en panel estrecho')
            if metrics['statusDotWidth'] < 8: failures.append('El punto de estado no permanece visible')
        elif metrics['statusFontSize'] < 10:
            failures.append('Disponible dejó de mostrarse en ancho normal')
        page.screenshot(path=str(OUT / f'{name}.png'), full_page=True, animations='disabled')
        results.append({'name': name, 'pass': not failures, 'failures': failures, 'metrics': metrics, 'contrast': {'primary': primary_contrast, 'status': status_contrast}, 'pageErrors': errors})
        page.close()
    browser.close()

REPORT.write_text(json.dumps({'passed': all(item['pass'] for item in results), 'cases': results}, ensure_ascii=False, indent=2), encoding='utf-8')
if not all(item['pass'] for item in results):
    print(json.dumps(results, ensure_ascii=False, indent=2))
    raise SystemExit(1)
print(f'OK: {len(results)} vistas de extensión verificadas con contraste, jerarquía y tamaño compacto.')
