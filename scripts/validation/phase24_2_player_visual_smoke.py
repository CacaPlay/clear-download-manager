#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/screenshots/phase24-2-player'
REPORT = ROOT / 'docs/tests/phase24-2-player-visual-smoke.json'
OUT.mkdir(parents=True, exist_ok=True)
REPORT.parent.mkdir(parents=True, exist_ok=True)
SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='

base_html = (ROOT / 'app-ui/player/index.html').read_text(encoding='utf-8')
player_css = (ROOT / 'app-ui/player/player.css').read_text(encoding='utf-8')
player_js = (ROOT / 'app-ui/player/player.js').read_text(encoding='utf-8')
player_js = player_js.replace(
    "let activeJobId = Number(params.get('job') || 0);",
    'let activeJobId = 44;',
)

cases = [
    {
        'name': 'desktop-audio-dark',
        'width': 760,
        'height': 470,
        'theme': 'dark',
        'snapshot': {
            'job_id': 44,
            'title': 'Audio original de prueba',
            'status': 'completed',
            'detail': 'Archivo local final',
            'progress': 100,
            'thumbnail': '',
            'output_mode': 'audio_best',
            'kind': 'audio',
            'playable': True,
            'local_path': 'C:/Downloads/audio-original.webm',
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
    {
        'name': 'minimum-video-light-waiting',
        'width': 560,
        'height': 380,
        'theme': 'light',
        'snapshot': {
            'job_id': 44,
            'title': 'Vídeo todavía descargándose con un título largo para validar dos áreas',
            'status': 'running',
            'detail': 'Combinando vídeo y audio',
            'progress': 78,
            'thumbnail': '',
            'output_mode': 'video_mp4',
            'kind': 'video',
            'playable': False,
            'local_path': '',
            'state_title': 'Descarga todavía en curso',
            'message': 'CacaTools no reproduce archivos .part ni flujos separados.',
            'converted': None,
            'technical': None,
        },
    },
]

results = []
with sync_playwright() as pw:
    executable = os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') or ('/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None)
    launch = {'headless': True, 'args': ['--disable-gpu', '--no-sandbox']}
    if executable:
        launch['executable_path'] = executable
    browser = pw.chromium.launch(**launch)
    for case in cases:
        page_errors: list[str] = []
        failures: list[str] = []
        page = browser.new_page(viewport={'width': case['width'], 'height': case['height']}, reduced_motion='reduce')
        page.on('pageerror', lambda error: page_errors.append(str(error)))
        payload = json.dumps({'snapshot': case['snapshot'], 'theme': case['theme'], 'mediaUrl': SILENT_WAV}, ensure_ascii=False)
        mock_script = f'''<script>
          const fixturePayload = {payload};
          Object.defineProperty(window, 'localStorage', {{ value: {{
            getItem: () => JSON.stringify({{theme:fixturePayload.theme, accent:'#4f75ff'}}),
            setItem: () => undefined
          }} }});
          window.__TAURI__ = {{ core: {{
            invoke: async (command) => command === 'player_media_snapshot' ? fixturePayload.snapshot : null,
            convertFileSrc: () => fixturePayload.mediaUrl
          }} }};
          Object.defineProperty(navigator, 'locks', {{ value: {{ request: async () => undefined }}, configurable: true }});
        </script>'''
        fixture = re.sub(r'<link rel="stylesheet" href="\./player\.css[^"]*">', f'<style>{player_css}</style>', base_html)
        fixture = re.sub(r'<script type="module" src="\./player\.js[^"]*"></script>', f'{mock_script}<script>{player_js}</script>', fixture)
        page.set_content(fixture, wait_until='domcontentloaded', timeout=20_000)
        page.wait_for_selector('.player-shell', timeout=10_000)
        page.wait_for_timeout(350)
        metrics = page.evaluate('''() => {
          const shell=document.querySelector('.player-shell');
          const stage=document.querySelector('.player-stage');
          const titlebar=document.querySelector('.player-titlebar');
          const controls=document.querySelector('.player-controls');
          const info=document.querySelector('.player-info');
          return {
            state:shell.dataset.playerState,
            kind:shell.dataset.mediaKind,
            width:shell.getBoundingClientRect().width,
            height:shell.getBoundingClientRect().height,
            documentOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
            bodyOverflow:document.body.scrollWidth-document.body.clientWidth,
            stageVisible:stage.getBoundingClientRect().height>100,
            titlebarVisible:titlebar.getBoundingClientRect().height>30,
            controlsVisible:controls.getBoundingClientRect().height>60,
            infoHidden:info.getAttribute('aria-hidden')==='true' && getComputedStyle(info).visibility==='hidden',
            technicalRows:document.querySelectorAll('.player-technical>div').length,
            windowButtons:document.querySelectorAll('[data-window-action]').length,
            actionButtons:document.querySelectorAll('[data-player-action]').length,
            background:getComputedStyle(document.documentElement).getPropertyValue('--player-bg').trim()
          };
        }''')
        if page_errors:
            failures.append(f'Errores JavaScript: {page_errors}')
        if metrics['documentOverflow'] > 1 or metrics['bodyOverflow'] > 1:
            failures.append('El reproductor produjo scroll horizontal global')
        if not all([metrics['stageVisible'], metrics['titlebarVisible'], metrics['controlsVisible'], metrics['infoHidden']]):
            failures.append('Una región principal quedó recortada')
        if metrics['technicalRows'] != 6 or metrics['windowButtons'] != 3 or metrics['actionButtons'] != 14:
            failures.append('Faltan controles o datos técnicos')
        expected_state = 'ready' if case['snapshot']['playable'] else 'waiting'
        if metrics['state'] != expected_state:
            failures.append(f"Estado esperado {expected_state}, obtenido {metrics['state']}")
        if metrics['background'] != '#020406':
            failures.append('El reproductor no conserva el tema oscuro aprobado')
        page.click('[data-player-action="info"]')
        page.wait_for_timeout(120)
        info_open = page.evaluate("() => document.querySelector('.player-shell').classList.contains('is-info-open') && document.querySelector('.player-info').getAttribute('aria-hidden') === 'false'")
        if not info_open:
            failures.append('El panel técnico no se abre desde su control')
        page.screenshot(path=str(OUT / f"{case['name']}.png"), full_page=True, animations='disabled')
        results.append({'name': case['name'], 'pass': not failures, 'failures': failures, 'metrics': metrics, 'pageErrors': page_errors})
        page.close()
    browser.close()

passed = all(item['pass'] for item in results)
REPORT.write_text(json.dumps({'passed': passed, 'cases': results}, ensure_ascii=False, indent=2), encoding='utf-8')
if not passed:
    print(json.dumps(results, ensure_ascii=False, indent=2))
    raise SystemExit(1)
print('OK: Reproductor validado en escritorio oscuro y tamaño mínimo claro, listo y en espera.')
