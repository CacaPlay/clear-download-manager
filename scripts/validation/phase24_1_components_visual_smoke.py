#!/usr/bin/env python3
from __future__ import annotations
import json, os, subprocess, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'docs/screenshots/phase24-1-components'
REPORT=ROOT/'docs/tests/phase24-1-components-visual-smoke.json'
OUT.mkdir(parents=True,exist_ok=True); REPORT.parent.mkdir(parents=True,exist_ok=True)
CASES=[('minimum-800x620',800,620),('compact-1024x720',1024,720),('normal-1180x780',1180,780)]
results=[]
with sync_playwright() as pw:
  launch={'headless':True,'args':['--disable-gpu','--no-sandbox']}
  executable=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') or ('/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None)
  if executable: launch['executable_path']=executable
  browser=pw.chromium.launch(**launch)
  for name,width,height in CASES:
    with tempfile.NamedTemporaryFile(suffix='.html',delete=False,dir=ROOT) as handle: path=Path(handle.name)
    failures=[]; errors=[]
    try:
      subprocess.run(['node','scripts/validation/phase19_render_fixture.mjs','zen-sidebar','dark',str(path),'#fff26a'],cwd=ROOT,check=True,capture_output=True,text=True)
      page=browser.new_page(viewport={'width':width,'height':height},reduced_motion='reduce')
      page.on('pageerror',lambda error: errors.append(str(error)))
      page.set_content(path.read_text(encoding='utf-8'),wait_until='domcontentloaded',timeout=20000)
      page.wait_for_selector('.dm-download-item',timeout=10000); page.wait_for_timeout(200)
      metrics=page.evaluate('''()=>{const r=e=>{const v=e?.getBoundingClientRect();return v?{l:v.left,r:v.right,t:v.top,b:v.bottom,w:v.width,h:v.height}:null};const rows=[...document.querySelectorAll('.dm-download-item')];const first=rows[0];const thumb=first?.querySelector('.dm-job-thumb,.dm-job-file,.dm-playlist-stack');const actions=first?.querySelector('.dm-item-actions');const itemStyle=first?getComputedStyle(first):null;const actionRects=[...first.querySelectorAll('.dm-item-actions button')].map(r);return{docOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,scrollOverflow:document.querySelector('.dm-download-scroll').scrollWidth-document.querySelector('.dm-download-scroll').clientWidth,rowCount:rows.length,rowHeights:rows.slice(0,5).map(x=>r(x).h),first:r(first),thumb:r(thumb),actions:r(actions),actionRects,bg:itemStyle?.backgroundColor,border:itemStyle?.borderColor,actionDisplay:actions?getComputedStyle(actions).display:'none',footer:document.querySelector('.dm-footer-beta')?.textContent||''}}''')
      if errors: failures.append(f'Errores JS: {errors}')
      if metrics['docOverflow']>1 or metrics['scrollOverflow']>1: failures.append('scroll horizontal')
      if metrics['rowCount']<4: failures.append('faltan filas de prueba')
      if any(value>118 for value in metrics['rowHeights']): failures.append(f'fila demasiado alta: {metrics["rowHeights"]}')
      if not metrics['thumb'] or not metrics['actions'] or metrics['actions']['l'] <= metrics['thumb']['r']: failures.append('acciones no están a la derecha de la miniatura')
      if metrics['actionDisplay']=='none' or not metrics['actionRects']: failures.append('acciones ocultas')
      if metrics['footer']!='Beta 0.30.1': failures.append('pie beta ausente')
      page.screenshot(path=str(OUT/f'{name}.png'),full_page=False,animations='disabled')
      results.append({'name':name,'pass':not failures,'failures':failures,'metrics':metrics,'pageErrors':errors})
      page.close()
    finally:
      path.unlink(missing_ok=True)
  browser.close()
REPORT.write_text(json.dumps({'passed':all(x['pass'] for x in results),'cases':results},ensure_ascii=False,indent=2),encoding='utf-8')
if not all(x['pass'] for x in results):
  print(json.dumps(results,ensure_ascii=False,indent=2)); raise SystemExit(1)
print(f'OK: {len(results)} anchos de Fase 6 sin overflow, acciones desplazadas ni filas infladas.')
