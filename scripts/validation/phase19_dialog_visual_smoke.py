#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs' / 'screenshots' / 'phase19-dialogs'
REPORT = ROOT / 'docs' / 'tests' / 'phase19-dialog-visual-smoke.json'
CASES = [
    ('command-dark-video-1180x780', 'command-center', 'dark', 'video', 'selection', 1180, 780),
    ('command-light-video-1180x780', 'command-center', 'light', 'video', 'selection', 1180, 780),
    ('command-dark-playlist-selection-1180x780', 'command-center', 'dark', 'playlist', 'selection', 1180, 780),
    ('command-dark-playlist-queue-1180x780', 'command-center', 'dark', 'playlist', 'queue', 1180, 780),
    ('zen-dark-video-1180x780', 'zen-sidebar', 'dark', 'video', 'selection', 1180, 780),
    ('zen-light-playlist-selection-1180x780', 'zen-sidebar', 'light', 'playlist', 'selection', 1180, 780),
    ('zen-dark-playlist-queue-1180x780', 'zen-sidebar', 'dark', 'playlist', 'queue', 1180, 780),
    ('command-light-direct-1180x780', 'command-center', 'light', 'direct', 'selection', 1180, 780),
]

OUT.mkdir(parents=True, exist_ok=True)
REPORT.parent.mkdir(parents=True, exist_ok=True)


def evaluate_case(browser, index: int) -> dict:
    name, layout, theme, dialog, stage, width, height = CASES[index]
    with tempfile.NamedTemporaryFile(suffix='.html', delete=False, dir=ROOT) as tmp:
        html_path = Path(tmp.name)
    try:
        subprocess.run(
            ['node', 'scripts/validation/phase19_dialog_fixture.mjs', layout, theme, dialog, stage, str(html_path)],
            cwd=ROOT,
            check=True,
            timeout=20,
        )
        page = browser.new_page(
            viewport={'width': width, 'height': height},
            device_scale_factor=1,
            reduced_motion='reduce',
        )
        errors: list[str] = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_content(
            html_path.read_text(encoding='utf-8'),
            wait_until='domcontentloaded',
            timeout=10000,
        )
        page.wait_for_timeout(250)
        metrics = page.evaluate(
            '''({width,height})=>{const q=s=>document.querySelector(s),r=e=>{const v=e?.getBoundingClientRect();return v?{left:v.left,right:v.right,top:v.top,bottom:v.bottom,width:v.width,height:v.height}:null};const host=q('.dm-host');const dialog=q('.dm-integrated-workspace,.download-dialog-v2');const body=q('.dialog-body');const dr=r(dialog),hr=r(host);return {dialog:dr,host:hr,integrated:!!q('.dm-integrated-workspace'),document:[document.body.scrollWidth,document.body.scrollHeight],nested:document.querySelectorAll('button button').length,entry:!!q('.dm-workspace-sourcebar,.dialog-unified-entry'),hero:!!q('.analysis-v2-hero,.direct-hero,.playlist-v2-hero,.playlist-summary-card'),alternatives:document.querySelectorAll('.analysis-alternative,.playlist-side-alternatives>button,.playlist-alternative-row').length,playlistSide:!!q('.playlist-queue-side'),footer:!!q('.dialog-footer'),overflow:body?{sw:body.scrollWidth,cw:body.clientWidth,sh:body.scrollHeight,ch:body.clientHeight}:null,outside:[...document.querySelectorAll('.dm-integrated-workspace button,.dm-integrated-workspace input,.dm-integrated-workspace select')].filter(e=>{const x=r(e),st=getComputedStyle(e);return x&&st.display!=='none'&&(x.right>width+1||x.left<-1||x.top<-1||x.bottom>height+1)&&!e.closest('.dialog-body')}).length,contained:!!(dr&&hr&&dr.left>=hr.left-1&&dr.right<=hr.right+1&&dr.top>=hr.top-1&&dr.bottom<=hr.bottom+1)}}''',
            {'width': width, 'height': height},
        )
        failures: list[str] = []
        if errors:
            failures.append('JS: ' + str(errors))
        if not metrics['dialog'] or metrics['dialog']['width'] < 700:
            failures.append('workspace missing or too small')
        if not metrics['integrated'] or not metrics['contained']:
            failures.append('workspace is not integrated in the Download Manager shell')
        if metrics['document'][0] > width + 1 or metrics['document'][1] > height + 1:
            failures.append('document overflow')
        if metrics['nested']:
            failures.append('nested buttons')
        if not metrics['hero']:
            failures.append('analysis/playlist hero missing')
        if not metrics['footer']:
            failures.append('workspace footer missing')
        if dialog == 'playlist' and stage == 'queue' and (
            not metrics['playlistSide'] or metrics['alternatives'] < 3
        ):
            failures.append('playlist alternatives/history panel missing')
        if dialog != 'playlist' or stage != 'queue':
            if not metrics['entry']:
                failures.append('unified workspace entry missing')
        if metrics['overflow'] and metrics['overflow']['sw'] > metrics['overflow']['cw'] + 2:
            failures.append('horizontal workspace overflow')
        if metrics['outside']:
            failures.append(f"{metrics['outside']} fixed controls outside viewport")

        page.screenshot(
            path=str(OUT / f'{name}.png'),
            full_page=False,
            animations='disabled',
            timeout=10000,
        )
        page.close()
        return {
            'name': name,
            'layout': layout,
            'theme': theme,
            'dialog': dialog,
            'stage': stage,
            'viewport': [width, height],
            'metrics': metrics,
            'page_errors': errors,
            'failures': failures,
            'pass': not failures,
        }
    finally:
        html_path.unlink(missing_ok=True)


def run_group(group_index: int) -> list[dict]:
    indices = range(0, 4) if group_index == 0 else range(4, 8)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            executable_path='/usr/bin/chromium',
            args=['--disable-gpu', '--no-sandbox'],
        )
        results = [evaluate_case(browser, index) for index in indices]
        browser.close()
    return results


GROUP_REPORTS = [
    ROOT / 'docs' / 'tests' / 'phase19-dialog-visual-group-0.json',
    ROOT / 'docs' / 'tests' / 'phase19-dialog-visual-group-1.json',
]

if len(sys.argv) >= 3 and sys.argv[1] == '--group':
    group_index = int(sys.argv[2])
    group_results = run_group(group_index)
    output = Path(sys.argv[3]) if len(sys.argv) >= 4 else GROUP_REPORTS[group_index]
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(group_results, indent=2, ensure_ascii=False), encoding='utf-8')
    if not all(item['pass'] for item in group_results):
        print(json.dumps(group_results, indent=2, ensure_ascii=False))
        raise SystemExit(1)
    print(f'OK: grupo {group_index} de diálogos Phase 19')
    raise SystemExit(0)

if len(sys.argv) >= 2 and sys.argv[1] == '--aggregate':
    results = []
    for group_report in GROUP_REPORTS:
        if not group_report.exists():
            raise FileNotFoundError(f'Missing dialog visual group report: {group_report}')
        results.extend(json.loads(group_report.read_text(encoding='utf-8')))
else:
    raise SystemExit(
        'Run --group 0, --group 1 and then --aggregate. '
        'This split avoids a Chromium compositor stall after multiple zoomed fixtures.'
    )

REPORT.write_text(
    json.dumps({'passed': all(item['pass'] for item in results), 'cases': results}, indent=2, ensure_ascii=False),
    encoding='utf-8',
)
if not all(item['pass'] for item in results):
    print(json.dumps(results, indent=2, ensure_ascii=False))
    raise SystemExit(1)
print(f'OK: {len(results)} visual cases de diálogos Phase 19')
