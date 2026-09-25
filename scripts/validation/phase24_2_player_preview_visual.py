#!/usr/bin/env python3
from __future__ import annotations

import base64
import json
import os
import re
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/screenshots/phase24-2-player-preview'
REPORT = ROOT / 'docs/tests/phase24-2-player-preview-visual.json'
OUT.mkdir(parents=True, exist_ok=True)
REPORT.parent.mkdir(parents=True, exist_ok=True)

base_html = (ROOT / 'app-ui/player/index.html').read_text(encoding='utf-8')
player_css = (ROOT / 'app-ui/player/player.css').read_text(encoding='utf-8')
player_js = (ROOT / 'app-ui/player/player.js').read_text(encoding='utf-8')
mp4_bytes = (ROOT / 'docs/tests/media-fixtures/short-2s.mp4').read_bytes()
video_data = 'data:video/mp4;base64,' + base64.b64encode(mp4_bytes).decode('ascii')
silent_wav = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='

cases = [
    {
        'name': 'online-preview-dark',
        'width': 854,
        'height': 516,
        'mode': 'preview',
        'theme': 'dark',
        'media_url': video_data,
        'snapshot': {
            'title': 'Vista previa de prueba',
            'creator': 'Canal de prueba',
            'thumbnail': '',
            'stream_url': video_data,
            'width': 640,
            'height': 360,
            'max_height': 2160,
            'quality_limited': True,
            'technical': {
                'container': 'mp4',
                'bitrate_kbps': 1200,
                'audio': {'codec': 'aac', 'bitrate_kbps': 128, 'sample_rate_hz': 48000, 'channels': 2},
                'video': {'codec': 'h264', 'bitrate_kbps': 1200, 'sample_rate_hz': None, 'channels': None},
            },
        },
    },
    {
        'name': 'audio-bar-light',
        'width': 640,
        'height': 148,
        'mode': 'local',
        'theme': 'light',
        'media_url': silent_wav,
        'snapshot': {
            'job_id': 44,
            'title': 'Audio original',
            'status': 'completed',
            'detail': 'Archivo local final',
            'progress': 100,
            'thumbnail': '',
            'output_mode': 'audio_best',
            'kind': 'audio',
            'playable': True,
            'local_path': 'C:/Downloads/audio.webm',
            'state_title': 'Listo para reproducir',
            'message': 'Archivo local final',
            'converted': False,
            'technical': {
                'container': 'webm',
                'bitrate_kbps': 160,
                'audio': {'codec': 'opus', 'bitrate_kbps': 160, 'sample_rate_hz': 48000, 'channels': 2},
                'video': None,
            },
        },
    },
]

results = []
with sync_playwright() as pw:
    executable = os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') or ('/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None)
    launch = {'headless': True, 'args': ['--disable-gpu', '--no-sandbox', '--autoplay-policy=no-user-gesture-required']}
    if executable:
        launch['executable_path'] = executable
    browser = pw.chromium.launch(**launch)
    for case in cases:
        page_errors: list[str] = []
        failures: list[str] = []
        page = browser.new_page(viewport={'width': case['width'], 'height': case['height']}, reduced_motion='reduce')
        page.on('pageerror', lambda error: page_errors.append(str(error)))
        script = player_js
        if case['mode'] == 'preview':
            script = script.replace("let activePreviewUrl = params.get('preview') || '';", "let activePreviewUrl = 'https://example.com/watch?v=preview';")
        else:
            script = script.replace("let activeJobId = Number(params.get('job') || 0);", 'let activeJobId = 44;')
        payload = json.dumps({'snapshot': case['snapshot'], 'theme': case['theme'], 'mediaUrl': case['media_url'], 'mode': case['mode']}, ensure_ascii=False)
        mock_script = f'''<script>
          const fixturePayload = {payload};
          const fixtureStorage = new Map();
          Object.defineProperty(window, 'localStorage', {{ value: {{
            getItem: (key) => key === 'cacatools.desktop.appearance.v1' ? JSON.stringify({{theme:fixturePayload.theme, accent:'#35f56f'}}) : (fixtureStorage.get(key) || null),
            setItem: (key, value) => fixtureStorage.set(key, String(value)),
            removeItem: (key) => fixtureStorage.delete(key)
          }} }});
          window.__TAURI__ = {{ core: {{
            invoke: async (command) => {{
              if (command === 'player_online_preview_snapshot' && fixturePayload.mode === 'preview') return fixturePayload.snapshot;
              if (command === 'player_media_snapshot' && fixturePayload.mode === 'local') return fixturePayload.snapshot;
              return null;
            }},
            convertFileSrc: () => fixturePayload.mediaUrl
          }} }};
          Object.defineProperty(navigator, 'locks', {{ value: {{ request: async () => undefined }}, configurable: true }});
        </script>'''
        fixture = re.sub(r'<link rel="stylesheet" href="\./player\.css[^"]*">', f'<style>{player_css}</style>', base_html)
        fixture = re.sub(r'<script type="module" src="\./player\.js[^"]*"></script>', f'{mock_script}<script>{script}</script>', fixture)
        page.set_content(fixture, wait_until='domcontentloaded', timeout=20_000)
        page.wait_for_selector('.player-shell', timeout=10_000)
        page.wait_for_timeout(650)
        if case['mode'] == 'preview':
            page.hover('.player-stage')
            page.wait_for_timeout(180)
        metrics = page.evaluate('''() => {
          const shell=document.querySelector('.player-shell');
          const stage=document.querySelector('.player-stage');
          const controls=document.querySelector('.player-controls');
          const wrap=document.querySelector('.player-media-wrap');
          const notice=document.querySelector('[data-preview-notice]');
          const play=document.querySelector('[data-player-action="play"]');
          const settings=document.querySelector('[data-player-action="info"]');
          const video=document.querySelector('.player-video');
          return {
            state:shell.dataset.playerState,
            kind:shell.dataset.mediaKind,
            source:shell.dataset.playerSource,
            documentOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
            stageBottom:Math.round(stage.getBoundingClientRect().bottom),
            shellBottom:Math.round(shell.getBoundingClientRect().bottom),
            controlsPosition:getComputedStyle(controls).position,
            controlsOpacity:Number(getComputedStyle(controls).opacity),
            mediaWrapDisplay:getComputedStyle(wrap).display,
            noticeVisible:!notice.hidden && getComputedStyle(notice).display !== 'none',
            settingsText:(settings.textContent || '').trim(),
            settingsHasSvg:Boolean(settings.querySelector('svg')),
            playHasSvg:Boolean(play.querySelector('svg')),
            videoPaused:video.paused,
            windowButtons:document.querySelectorAll('[data-window-action]').length
          };
        }''')
        if page_errors:
            failures.append(f'Errores JavaScript: {page_errors}')
        if metrics['documentOverflow'] > 1:
            failures.append('El reproductor produce scroll horizontal')
        if metrics['windowButtons'] != 3 or not metrics['settingsHasSvg'] or metrics['settingsText']:
            failures.append('Los controles de ventana o engranaje no son minimalistas')
        if not metrics['playHasSvg']:
            failures.append('Play/pausa no usa icono SVG')
        if case['mode'] == 'preview':
            if metrics['state'] != 'ready' or metrics['source'] != 'preview' or metrics['kind'] != 'video':
                failures.append('La vista previa online no llegó al estado listo')
            if not metrics['noticeVisible']:
                failures.append('No apareció el aviso único en un caso de calidad extremadamente baja')
            if metrics['controlsPosition'] != 'absolute' or metrics['stageBottom'] != metrics['shellBottom']:
                failures.append('Los controles no están superpuestos al video o queda un pie exterior')
            if metrics['controlsOpacity'] < 0.9:
                failures.append('Los controles no aparecen al pasar el cursor sobre el video')
        else:
            if metrics['state'] != 'ready' or metrics['kind'] != 'audio':
                failures.append('El audio no llegó al estado listo')
            if metrics['mediaWrapDisplay'] != 'none' or metrics['controlsPosition'] != 'absolute':
                failures.append('El modo audio conserva un lienzo de video innecesario')
        page.screenshot(path=str(OUT / f"{case['name']}.png"), full_page=True, animations='disabled')
        results.append({'name': case['name'], 'pass': not failures, 'failures': failures, 'metrics': metrics, 'pageErrors': page_errors})
        page.close()
    browser.close()

passed = all(item['pass'] for item in results)
REPORT.write_text(json.dumps({'passed': passed, 'cases': results}, ensure_ascii=False, indent=2), encoding='utf-8')
if not passed:
    print(json.dumps(results, ensure_ascii=False, indent=2))
    raise SystemExit(1)
print('OK: preview online y barra compacta de audio validados visualmente.')
