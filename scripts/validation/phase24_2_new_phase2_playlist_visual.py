#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/screenshots/phase24-2-new-phase2-playlist'
REPORT = ROOT / 'docs/tests/phase24-2-new-phase2-playlist-visual.json'
OUT.mkdir(parents=True, exist_ok=True)
REPORT.parent.mkdir(parents=True, exist_ok=True)


def browser_executable() -> str | None:
    configured = os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE')
    if configured and Path(configured).exists():
        return configured
    candidates = (
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
    )
    for candidate in candidates:
        if Path(candidate).exists():
            return candidate
    return shutil.which('chromium') or shutil.which('google-chrome')


def fixture(stage: str) -> str:
    with tempfile.NamedTemporaryFile(suffix='.html', delete=False, dir=ROOT) as tmp:
        path = Path(tmp.name)
    try:
        subprocess.run(
            [
                'node',
                'scripts/validation/phase19_dialog_fixture.mjs',
                'zen-sidebar',
                'dark',
                'playlist',
                stage,
                str(path),
            ],
            cwd=ROOT,
            check=True,
            timeout=30,
        )
        return path.read_text(encoding='utf-8')
    finally:
        path.unlink(missing_ok=True)


def inspect_main_shell(page, width: int, height: int) -> tuple[dict, bool]:
    metrics = page.evaluate(
        '''()=>{
          const q = (selector) => document.querySelector(selector);
          const rect = (element) => element?.getBoundingClientRect()?.toJSON();
          const host = q('.dm-host');
          const box = rect(host);
          return {
            mainShell: Boolean(host),
            host: box,
            document: [document.body.scrollWidth, document.body.scrollHeight],
            legacyPreparation: Boolean(q('.dialog-backdrop,.playlist-backdrop,.dm-floating-workspace,.download-dialog-v2,.playlist-dialog')),
            legacyPlaylist: Boolean(q('.playlist-select-item,.playlist-current-card,.playlist-upcoming-row,.playlist-selection-scroll')),
            legacyText: document.body.innerText.includes('Preparar contenido multimedia')
              || document.body.innerText.includes('Preparar playlist')
          };
        }'''
    )
    passed = (
        metrics['mainShell']
        and metrics['host']
        and metrics['host']['width'] > 0
        and metrics['host']['height'] > 0
        and not metrics['legacyPreparation']
        and not metrics['legacyPlaylist']
        and not metrics['legacyText']
        and metrics['document'][0] <= width + 1
        and metrics['document'][1] <= height + 1
    )
    return metrics, bool(passed)


results = []
with sync_playwright() as playwright:
    executable = browser_executable()
    if not executable:
        raise SystemExit('No se encontro Chrome, Edge o Chromium para la validacion visual')
    browser = playwright.chromium.launch(
        headless=True,
        executable_path=executable,
        args=['--no-sandbox', '--disable-dev-shm-usage'],
    )
    for stage in ('selection', 'queue'):
        html = fixture(stage)
        for width, height in ((1180, 780), (800, 620)):
            page = browser.new_page(
                viewport={'width': width, 'height': height},
                device_scale_factor=1,
                reduced_motion='reduce',
            )
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.set_content(html, wait_until='domcontentloaded', timeout=20000)
            page.wait_for_timeout(160)
            metrics, passed = inspect_main_shell(page, width, height)
            page.screenshot(
                path=str(OUT / f'{stage}-{width}x{height}.png'),
                full_page=False,
                animations='disabled',
            )
            results.append({
                'stage': stage,
                'width': width,
                'height': height,
                'passed': bool(not errors and passed),
                'metrics': metrics,
                'errors': errors,
            })
            page.close()
    browser.close()

report = {'passed': all(case['passed'] for case in results), 'cases': results}
REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
if not report['passed']:
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(1)
print(f'OK: Nueva Fase 2 visual validada ({len(results)} casos de playlist).')
