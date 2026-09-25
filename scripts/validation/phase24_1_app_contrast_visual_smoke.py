#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/screenshots/phase24-1-app-contrast'
REPORT = ROOT / 'docs/tests/phase24-1-app-contrast-visual-smoke.json'
OUT.mkdir(parents=True, exist_ok=True)
REPORT.parent.mkdir(parents=True, exist_ok=True)


def fixture(theme: str, accent: str) -> str:
    with tempfile.NamedTemporaryFile(suffix='.html', delete=False) as handle:
        output = Path(handle.name)
    try:
        subprocess.run(
            ['node', 'scripts/validation/phase19_render_fixture.mjs', 'zen-sidebar', theme, str(output), accent],
            cwd=ROOT, check=True, capture_output=True, text=True,
        )
        return output.read_text(encoding='utf-8')
    finally:
        output.unlink(missing_ok=True)


def parse_rgb(value: str) -> list[float]:
    import re
    text = value.strip()
    if re.fullmatch(r'#[0-9a-fA-F]{6}', text):
        return [int(text[index:index + 2], 16) for index in (1, 3, 5)]
    values = [float(item) for item in re.findall(r'[\d.]+', text)[:3]]
    if values and max(values) <= 1:
        values = [item * 255 for item in values]
    return values or [0, 0, 0]


def color_distance(a: str, b: str) -> float:
    left, right = parse_rgb(a), parse_rgb(b)
    return sum((x - y) ** 2 for x, y in zip(left, right)) ** 0.5


def contrast(page, foreground_selector: str, background_selector: str) -> float:
    return float(page.evaluate(r'''([fgSelector,bgSelector]) => {
      const parse = (value) => { const v=value.match(/[\d.]+/g)?.slice(0,3).map(Number)||[0,0,0]; return Math.max(...v)<=1?v.map(x=>x*255):v; };
      const lum = (rgb) => rgb.map(v => { v/=255; return v<=.04045?v/12.92:((v+.055)/1.055)**2.4; }).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
      const fg=getComputedStyle(document.querySelector(fgSelector)).color;
      const bg=getComputedStyle(document.querySelector(bgSelector)).backgroundColor;
      const a=lum(parse(fg)),b=lum(parse(bg)); return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
    }''', [foreground_selector, background_selector]))


cases = [('light-bright-green', 'light', '#58ff70'), ('dark-pale-yellow', 'dark', '#fff26a')]
results = []
with sync_playwright() as pw:
    executable = os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') or ('/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None)
    launch = {'headless': True, 'args': ['--disable-gpu', '--no-sandbox']}
    if executable:
        launch['executable_path'] = executable
    browser = pw.chromium.launch(**launch)
    for name, theme, accent in cases:
        failures: list[str] = []
        errors: list[str] = []
        page = browser.new_page(viewport={'width': 1180, 'height': 780}, reduced_motion='reduce')
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_content(fixture(theme, accent), wait_until='domcontentloaded', timeout=20_000)
        page.wait_for_selector('.dm-download-item', timeout=10_000)
        page.wait_for_timeout(250)
        metrics = page.evaluate('''() => {
          const style = (selector) => getComputedStyle(document.querySelector(selector));
          const host = style('.dm-host');
          const brand = style('.dm-brand-mark');
          const file = style('.dm-job-file');
          const filter = style('.dm-filter.is-active');
          const selected = style('.dm-download-item.is-selected');
          return {
            overflow: document.documentElement.scrollWidth-document.documentElement.clientWidth,
            hostAccent: host.getPropertyValue('--dm-accent').trim(),
            hostInk: host.getPropertyValue('--dm-accent-ink').trim(),
            brandBg: brand.backgroundColor, brandBorder: brand.borderColor, brandColor: brand.color,
            fileBg: file.backgroundColor, fileBorder: file.borderColor, fileColor: file.color,
            filterBg: filter.backgroundColor, filterBorder: filter.borderColor, filterColor: filter.color,
            selectedBg: selected.backgroundColor, selectedBorder: selected.borderColor,
          };
        }''')
        if errors:
            failures.append(f'Errores JS: {errors}')
        if metrics['overflow'] > 1:
            failures.append('Existe scroll horizontal general')
        if color_distance(metrics['brandBg'], accent) < 45:
            failures.append('El logo sigue rellenándose con el color principal')
        if color_distance(metrics['fileBg'], accent) < 45:
            failures.append('El marco de tipo de archivo sigue rellenándose con el color principal')
        if color_distance(metrics['selectedBg'], accent) < 45:
            failures.append('La fila seleccionada usa un relleno excesivo del color principal')
        filter_contrast = contrast(page, '.dm-filter.is-active', '.dm-filter.is-active')
        brand_contrast = contrast(page, '.dm-brand-mark', '.dm-brand-mark')
        file_contrast = contrast(page, '.dm-job-file', '.dm-job-file')
        if filter_contrast < 4.5:
            failures.append(f'Contraste insuficiente en categoría activa: {filter_contrast:.2f}')
        if brand_contrast < 4.5:
            failures.append(f'Contraste insuficiente en logo: {brand_contrast:.2f}')
        if file_contrast < 4.5:
            failures.append(f'Contraste insuficiente en icono de archivo: {file_contrast:.2f}')
        page.screenshot(path=str(OUT / f'{name}.png'), full_page=True, animations='disabled')
        results.append({
            'name': name, 'pass': not failures, 'failures': failures, 'metrics': metrics,
            'contrast': {'filter': filter_contrast, 'brand': brand_contrast, 'file': file_contrast},
            'pageErrors': errors,
        })
        page.close()
    browser.close()

REPORT.write_text(json.dumps({'passed': all(item['pass'] for item in results), 'cases': results}, ensure_ascii=False, indent=2), encoding='utf-8')
if not all(item['pass'] for item in results):
    print(json.dumps(results, ensure_ascii=False, indent=2))
    raise SystemExit(1)
print(f'OK: {len(results)} vistas de la app verificadas con acentos claros, marcos neutros y contraste legible.')
