#!/usr/bin/env python3
from __future__ import annotations
import json, os, subprocess, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/screenshots/phase24-1-responsive'
REPORT = ROOT / 'docs/tests/phase24-1-responsive-visual-smoke.json'
OUT.mkdir(parents=True, exist_ok=True)
REPORT.parent.mkdir(parents=True, exist_ok=True)
CASES = [
    ('800x620-dark-compact', 800, 620, 'dark', 'compact', 'expanded', 'collapsed'),
    ('1024x720-light-normal', 1024, 720, 'light', 'normal', 'expanded', 'collapsed'),
    ('1180x780-dark-normal', 1180, 780, 'dark', 'normal', 'collapsed', 'collapsed'),
    ('1366x768-light-balanced', 1366, 768, 'light', 'balanced', 'expanded', 'collapsed'),
    ('1600x900-dark-spacious', 1600, 900, 'dark', 'spacious', 'expanded', 'collapsed'),
    ('1920x1080-light-normal', 1920, 1080, 'light', 'normal', 'expanded', 'expanded'),
    ('2560x1440-dark-spacious', 2560, 1440, 'dark', 'spacious', 'expanded', 'expanded'),
]

def render_fixture(path: Path, theme: str, density: str, sidebar: str, inspector: str) -> None:
    subprocess.run([
        'node', 'scripts/validation/phase19_render_fixture.mjs', 'zen-sidebar', theme,
        str(path), '#fff26a', density, sidebar, inspector
    ], cwd=ROOT, check=True, capture_output=True, text=True)

results = []
with sync_playwright() as pw:
    launch = {'headless': True, 'args': ['--disable-gpu', '--no-sandbox']}
    executable = os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') or ('/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None)
    if executable: launch['executable_path'] = executable
    browser = pw.chromium.launch(**launch)
    for name, width, height, theme, density, sidebar, inspector in CASES:
        failures, errors = [], []
        with tempfile.NamedTemporaryFile(suffix='.html', delete=False, dir=ROOT) as handle:
            path = Path(handle.name)
        try:
            render_fixture(path, theme, density, sidebar, inspector)
            page = browser.new_page(viewport={'width': width, 'height': height}, reduced_motion='reduce')
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.set_content(path.read_text(encoding='utf-8'), wait_until='domcontentloaded', timeout=20_000)
            page.wait_for_selector('.dm-download-item', timeout=10_000)
            page.wait_for_timeout(180)
            metrics = page.evaluate('''() => {
              const rect = (node) => { const r=node?.getBoundingClientRect(); return r?{l:r.left,r:r.right,t:r.top,b:r.bottom,w:r.width,h:r.height}:null; };
              const scroll=document.querySelector('.dm-download-scroll');
              const rows=[...document.querySelectorAll('.dm-download-item')];
              const first=rows[0];
              const progress=first?.querySelector('.dm-item-progress');
              const actions=first?.querySelector('.dm-item-actions');
              const status=first?.querySelector('.dm-item-status');
              const statusText=status?.querySelector('span');
              const body=first?.querySelector('.dm-item-body');
              const title=first?.querySelector('.dm-item-name>strong');
              const s=status?getComputedStyle(status):null;
              const st=statusText?getComputedStyle(statusText):null;
              return {
                docOverflow: document.documentElement.scrollWidth-document.documentElement.clientWidth,
                bodyOverflow: document.body.scrollWidth-document.body.clientWidth,
                scrollOverflow: scroll.scrollWidth-scroll.clientWidth,
                rowCount: rows.length,
                rowHeights: rows.slice(0,5).map((row)=>rect(row).h),
                first: rect(first), progress: rect(progress), actions: rect(actions), body: rect(body), title: rect(title),
                rowTopBreathing: Math.min(rect(body)?.t??Infinity,rect(title)?.t??Infinity)-rect(first).t,
                rowBottomBreathing: rect(first).b-Math.max(rect(progress)?.b||0, rect(body)?.b||0),
                statusTextVisible: st ? !(st.position==='absolute' && st.width==='1px') : false,
                statusDotVisible: Boolean(status?.querySelector('i') && rect(status.querySelector('i')).w >= 5),
                footerBottom: rect(document.querySelector('.dm-minimal-footer'))?.b || 0,
                viewportHeight: innerHeight,
                density: document.querySelector('.dm-host')?.dataset.dmDensity || '',
                sidebarWidth: rect(document.querySelector('.dm-zen-nav'))?.w || 0,
                inspectorWidth: rect(document.querySelector('.dm-inspector'))?.w || 0,
              };
            }''')
            if errors: failures.append(f'Errores JS: {errors}')
            if metrics['docOverflow'] > 1 or metrics['bodyOverflow'] > 1 or metrics['scrollOverflow'] > 1: failures.append('scroll horizontal')
            if metrics['rowCount'] < 4: failures.append('faltan filas')
            if not metrics['actions'] or metrics['actions']['r'] > width + 1: failures.append('acciones fuera de la ventana')
            if metrics['rowTopBreathing'] < 2: failures.append(f'contenido recortado en el borde superior: {metrics["rowTopBreathing"]:.1f}px')
            if metrics['rowBottomBreathing'] < 8: failures.append(f'barra demasiado pegada al borde inferior: {metrics["rowBottomBreathing"]:.1f}px')
            if metrics['footerBottom'] > height + 1: failures.append('pie fuera de la ventana')
            if not metrics['statusDotVisible']: failures.append('punto de estado no visible')
            if metrics['density'] != density: failures.append(f'densidad no aplicada: {metrics["density"]}')
            page.screenshot(path=str(OUT/f'{name}.png'), full_page=False, animations='disabled')
            results.append({'name':name,'pass':not failures,'failures':failures,'metrics':metrics,'pageErrors':errors})
            page.close()
        finally:
            path.unlink(missing_ok=True)

    density_heights = {}
    for density in ('compact','normal','balanced','spacious'):
        with tempfile.NamedTemporaryFile(suffix='.html', delete=False, dir=ROOT) as handle:
            path=Path(handle.name)
        try:
            render_fixture(path, 'dark', density, 'collapsed', 'collapsed')
            page=browser.new_page(viewport={'width':1180,'height':780}, reduced_motion='reduce')
            page.set_content(path.read_text(encoding='utf-8'), wait_until='domcontentloaded')
            page.wait_for_selector('.dm-download-item')
            density_heights[density]=page.evaluate('''()=>({gap:parseFloat(getComputedStyle(document.querySelector('.dm-download-scroll')).rowGap),height:document.querySelector('.dm-download-item').getBoundingClientRect().height})''')
            page.close()
        finally:
            path.unlink(missing_ok=True)
    order=['compact','normal','balanced','spacious']
    density_ok=all(density_heights[order[i]]['gap'] < density_heights[order[i+1]]['gap'] for i in range(3))
    results.append({'name':'density-order','pass':density_ok,'failures':[] if density_ok else ['las densidades no aumentan progresivamente'], 'metrics':density_heights})
    browser.close()

REPORT.write_text(json.dumps({'passed':all(item['pass'] for item in results),'cases':results},ensure_ascii=False,indent=2),encoding='utf-8')
if not all(item['pass'] for item in results):
    print(json.dumps(results,ensure_ascii=False,indent=2)); raise SystemExit(1)
print(f'OK: {len(CASES)} resoluciones y 4 densidades verificadas sin overflow ni barras pegadas al borde.')
