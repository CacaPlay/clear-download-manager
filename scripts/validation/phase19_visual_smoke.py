#!/usr/bin/env python3
from __future__ import annotations
import json, subprocess, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs' / 'screenshots' / 'phase19'
REPORT = ROOT / 'docs' / 'tests' / 'phase19-visual-smoke.json'
CASES = [
  ('command-center-dark-1180x780','command-center','dark',1180,780),
  ('command-center-light-1180x780','command-center','light',1180,780),
  ('zen-sidebar-dark-1180x780','zen-sidebar','dark',1180,780),
  ('zen-sidebar-light-1180x780','zen-sidebar','light',1180,780),
  ('command-center-dark-1260x820','command-center','dark',1260,820),
  ('command-center-light-1260x820','command-center','light',1260,820),
  ('zen-sidebar-dark-1260x820','zen-sidebar','dark',1260,820),
  ('zen-sidebar-light-1260x820','zen-sidebar','light',1260,820),
  ('command-center-dark-1024x720','command-center','dark',1024,720),
  ('zen-sidebar-dark-800x620','zen-sidebar','dark',800,620),
]
OUT.mkdir(parents=True, exist_ok=True); REPORT.parent.mkdir(parents=True, exist_ok=True)
results=[]
with sync_playwright() as pw:
  browser=pw.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--disable-gpu','--no-sandbox'])
  for name,layout,theme,width,height in CASES:
    with tempfile.NamedTemporaryFile(suffix='.html', delete=False, dir=ROOT) as tmp: html=Path(tmp.name)
    subprocess.run(['node','scripts/validation/phase19_render_fixture.mjs',layout,theme,str(html)],cwd=ROOT,check=True)
    page=browser.new_page(viewport={'width':width,'height':height}, device_scale_factor=1)
    errors=[]; page.on('pageerror',lambda error: errors.append(str(error)))
    page.set_content(html.read_text(encoding='utf-8'), wait_until='load'); page.wait_for_timeout(250)
    metrics=page.evaluate('''({width,height})=>{const q=s=>document.querySelector(s),r=e=>e?.getBoundingClientRect();const root=q('.dm-root'),side=q('.dm-command-sidebar,.dm-zen-nav'),search=q('.dm-unified-input-wrap'),area=q('.dm-download-area'),detect=q('.dm-unified-detection');const dr=r(detect);const overlap=dr&&getComputedStyle(detect).display!=='none'&&[...document.querySelectorAll('.dm-helper-chips button')].some(button=>{const hr=r(button);return hr&&!(dr.right<=hr.left||dr.left>=hr.right||dr.bottom<=hr.top||dr.top>=hr.bottom)});const zenFooterBright=[...document.querySelectorAll('.dm-zen-nav>footer button')].filter(e=>{const c=getComputedStyle(e).backgroundColor.match(/[0-9]+/g)?.map(Number)||[];return c.length>=3&&c[3]!==0&&c[0]>220&&c[1]>220&&c[2]>220}).length;return {body:[document.body.scrollWidth,document.body.scrollHeight],root:r(root),side:r(side),search:r(search),area:r(area),old:document.querySelectorAll('.dm-command-lower,.dm-zen-engines').length,playlist:document.querySelectorAll('.dm-playlist-stack').length,nested:document.querySelectorAll('button button').length,footer:!!q('.dm-minimal-footer'),input:!!q('[data-dm-unified-input]'),detectionHelperOverlap:!!overlap,zenFooterBright,filterClipped:[...document.querySelectorAll('.dm-filter')].filter(e=>e.scrollWidth>e.clientWidth+1).length,downloadHeaderDisplay:getComputedStyle(q('.dm-download-area>header')).display,rowRadius:parseFloat(getComputedStyle(q('.dm-download-item')).borderRadius)||0,thumbs:document.querySelectorAll('.dm-job-thumb img').length,fileDocuments:document.querySelectorAll('.dm-job-file.file-document,.dm-job-file.file-pdf,.dm-job-file.file-sheet,.dm-job-file.file-presentation').length,filePdf:document.querySelectorAll('.dm-job-file.file-pdf').length,fileSoftware:document.querySelectorAll('.dm-job-file.file-software').length,iconFallbacks:document.querySelectorAll('[data-icon-fallback]').length,overflow:[...document.querySelectorAll('button,input,select')].filter(e=>{const x=r(e),style=getComputedStyle(e);if(!x||style.display==='none'||style.visibility==='hidden')return false;const hiddenRail=e.closest('.dm-command-sidebar,.dm-zen-nav,.dm-inspector');if(hiddenRail){const a=r(hiddenRail);if(a&&(a.right<=0||a.left>=width))return false}const scroller=e.closest('.dm-download-scroll,.dm-filter-row,.dm-helper-chips,.dm-unified-suggestions');if(scroller){const a=r(scroller);if(a&&(x.right>a.right+1||x.left<a.left-1))return false}return x.right>width+1||x.left<-1}).length}}''', {'width':width,'height':height})
    failures=[]
    if errors: failures.append('JS: '+str(errors))
    if metrics['body'][0]>width+1: failures.append(f"horizontal overflow {metrics['body'][0]}/{width}")
    if not metrics['input'] or not metrics['search'] or metrics['search']['height']<38: failures.append('unified input missing/small')
    if not metrics['area'] or metrics['area']['height']<220: failures.append('download area not primary')
    if metrics['old']: failures.append('old technical blocks visible')
    if not metrics['playlist']: failures.append('playlist identity missing')
    if metrics['nested']: failures.append('nested buttons')
    if not metrics['footer']: failures.append('minimal footer missing')
    if width>=900 and (not metrics['side'] or metrics['side']['width']>100): failures.append('sidebar not collapsed')
    if metrics['filterClipped']: failures.append(f"{metrics['filterClipped']} filter labels clipped")
    if metrics['detectionHelperOverlap']: failures.append('detection badge overlaps helper actions')
    if metrics['zenFooterBright']: failures.append('Zen footer controls lost theme styling')
    if metrics['overflow']: failures.append(f"{metrics['overflow']} controls overflow")
    if metrics['thumbs'] < 1: failures.append('video thumbnail missing')
    if metrics['fileDocuments'] < 1 or metrics['filePdf'] < 1 or metrics['fileSoftware'] < 1: failures.append('extension-specific file art missing')
    if metrics['iconFallbacks']: failures.append(f"unknown icon fallbacks rendered: {metrics['iconFallbacks']}")
    if layout == 'command-center' and metrics['downloadHeaderDisplay'] == 'none': failures.append('Command Center lost table header')
    if layout == 'zen-sidebar' and metrics['downloadHeaderDisplay'] != 'none': failures.append('Zen still looks like Command table')
    if layout == 'zen-sidebar' and metrics['rowRadius'] < 12: failures.append('Zen rows are not calm cards')
    page.screenshot(path=str(OUT/f'{name}.png'), full_page=False)
    results.append({'name':name,'layout':layout,'theme':theme,'viewport':[width,height],'metrics':metrics,'page_errors':errors,'failures':failures,'pass':not failures})
    page.close(); html.unlink(missing_ok=True)
  browser.close()
REPORT.write_text(json.dumps({'passed':all(x['pass'] for x in results),'cases':results},indent=2,ensure_ascii=False),encoding='utf-8')
if not all(x['pass'] for x in results):
  print(json.dumps(results,indent=2,ensure_ascii=False)); raise SystemExit(1)
print(f'OK: {len(results)} visual cases Phase 19')
