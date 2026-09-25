#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/screenshots/phase24-2-settings'
REPORT = ROOT / 'docs/tests/phase24-2-settings-visual-smoke.json'
OUT.mkdir(parents=True, exist_ok=True)
REPORT.parent.mkdir(parents=True, exist_ok=True)

with tempfile.NamedTemporaryFile(suffix='.html', delete=False) as handle:
    fixture_path = Path(handle.name)
try:
    subprocess.run(['node', 'scripts/validation/phase24_2_settings_fixture.mjs', str(fixture_path)], cwd=ROOT, check=True)
    html = fixture_path.read_text(encoding='utf-8')
finally:
    fixture_path.unlink(missing_ok=True)

cases = [
    ('desktop-dark', 1180, 780, 'dark'),
    ('minimum-light', 800, 620, 'light'),
]
sections = ['general', 'downloads', 'multimedia', 'appearance', 'integrations', 'diagnostics']
results = []
with sync_playwright() as pw:
    executable = os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') or ('/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None)
    launch = {'headless': True, 'args': ['--disable-gpu', '--no-sandbox']}
    if executable:
        launch['executable_path'] = executable
    browser = pw.chromium.launch(**launch)
    for name, width, height, theme in cases:
        page_errors: list[str] = []
        failures: list[str] = []
        page = browser.new_page(viewport={'width': width, 'height': height}, reduced_motion='reduce')
        page.on('pageerror', lambda error: page_errors.append(str(error)))
        page.set_content(html, wait_until='domcontentloaded', timeout=20_000)
        page.wait_for_selector('[data-dm-open-settings]', timeout=10_000)
        page.locator('[data-dm-open-settings]').first.click()
        page.wait_for_selector('.dm-settings-popover:not([hidden])', timeout=10_000)
        if theme == 'light':
            page.locator('[data-dm-settings-section="appearance"]').click()
            page.select_option('[data-dm-setting="theme"]', 'light')
            page.wait_for_timeout(100)
        for section in sections:
            page.locator(f'[data-dm-settings-section="{section}"]').click()
            page.wait_for_timeout(35)
            panel = page.locator(f'[data-dm-settings-panel="{section}"]')
            if panel.count() != 1 or not panel.is_visible():
                failures.append(f'La sección {section} no quedó visible como panel único')
            if page.locator('.dm-settings-panel').count() != 1:
                failures.append(f'La sección {section} coexistió con otros paneles')
        page.locator('[data-dm-settings-section="appearance"]').click()
        metrics = page.evaluate('''() => {
          const popover=document.querySelector('.dm-settings-popover');
          const shell=document.querySelector('.dm-settings-shell');
          const headerText=document.querySelector('.dm-settings-popover>header>div');
          const panelTitle=document.querySelector('.dm-settings-panel-title');
          const rect=popover.getBoundingClientRect();
          const shellRect=shell.getBoundingClientRect();
          const headerRect=headerText.getBoundingClientRect();
          const titleRect=panelTitle.getBoundingClientRect();
          const visibleAtHeader=document.elementFromPoint(
            Math.max(rect.left+4,headerRect.left+2),
            headerRect.top+Math.min(8,headerRect.height/2)
          );
          return {
            documentOverflow: document.documentElement.scrollWidth-document.documentElement.clientWidth,
            bodyOverflow: document.body.scrollWidth-document.body.clientWidth,
            left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
            width: rect.width, height: rect.height,
            shellLeft:shellRect.left,shellRight:shellRect.right,shellTop:shellRect.top,shellBottom:shellRect.bottom,
            headerLeft:headerRect.left,panelTitleLeft:titleRect.left,
            headerCovered:!visibleAtHeader?.closest('.dm-settings-popover'),
            navOverflow: document.querySelector('.dm-settings-nav').scrollWidth-document.querySelector('.dm-settings-nav').clientWidth,
            theme: document.querySelector('.dm-host').dataset.dmTheme,
            buttons: document.querySelectorAll('[data-dm-settings-section]').length
          };
        }''')
        if page_errors:
            failures.append(f'Errores JavaScript: {page_errors}')
        if metrics['documentOverflow'] > 1 or metrics['bodyOverflow'] > 1:
            failures.append('La ventana produjo scroll horizontal global')
        if metrics['left'] < -1 or metrics['top'] < -1 or metrics['right'] > width + 1 or metrics['bottom'] > height + 1:
            failures.append('El panel de Ajustes salió de la ventana')
        if metrics['shellLeft'] < metrics['left'] - 1 or metrics['shellRight'] > metrics['right'] + 1 or metrics['shellBottom'] > metrics['bottom'] + 1:
            failures.append('El contenido interno de Ajustes excedió el modal en lugar de desplazarse dentro')
        if metrics['headerLeft'] < metrics['left'] + 4 or metrics['panelTitleLeft'] < metrics['left'] + 4 or metrics['headerCovered']:
            failures.append('La barra lateral u otra capa recortó el contenido izquierdo de Ajustes')
        if metrics['buttons'] != 6:
            failures.append(f"Se esperaban 6 secciones y aparecieron {metrics['buttons']}")
        if metrics['theme'] != theme:
            failures.append(f"El tema esperado era {theme} y quedó {metrics['theme']}")
        page.screenshot(path=str(OUT / f'{name}.png'), full_page=True, animations='disabled')
        results.append({'name': name, 'pass': not failures, 'failures': failures, 'metrics': metrics, 'pageErrors': page_errors})
        page.close()
    browser.close()

passed = all(item['pass'] for item in results)
REPORT.write_text(json.dumps({'passed': passed, 'cases': results}, ensure_ascii=False, indent=2), encoding='utf-8')
if not passed:
    print(json.dumps(results, ensure_ascii=False, indent=2))
    raise SystemExit(1)
print('OK: Ajustes validado en escritorio oscuro y tamaño mínimo claro con seis paneles exclusivos.')
