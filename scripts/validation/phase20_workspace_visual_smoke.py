#!/usr/bin/env python3
from __future__ import annotations
import json, os, subprocess, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'docs/screenshots/phase20-workspaces'; REPORT=ROOT/'docs/tests/phase20-workspace-visual-smoke.json'
CASES=[
 ('zen-dark-video-1180x780','zen-sidebar','dark','video','selection',1180,780),
 ('zen-light-playlist-selection-1180x780','zen-sidebar','light','playlist','selection',1180,780),
 ('zen-dark-playlist-queue-1180x780','zen-sidebar','dark','playlist','queue',1180,780),
]
OUT.mkdir(parents=True,exist_ok=True); REPORT.parent.mkdir(parents=True,exist_ok=True); results=[]
with sync_playwright() as pw:
 for name,layout,theme,dialog,stage,width,height in CASES:
  print(f'Checking {name}',flush=True)
  with tempfile.NamedTemporaryFile(suffix='.html',delete=False,dir=ROOT) as tmp: path=Path(tmp.name)
  errors=[]; failures=[]
  browser=None
  try:
   subprocess.run(['node','scripts/validation/phase19_dialog_fixture.mjs',layout,theme,dialog,stage,str(path)],cwd=ROOT,check=True,timeout=25)
   launch_options={'headless':True,'args':['--disable-gpu','--no-sandbox']}
   executable=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE')
   if not executable and Path('/usr/bin/chromium').exists(): executable='/usr/bin/chromium'
   if executable: launch_options['executable_path']=executable
   browser=pw.chromium.launch(**launch_options)
   page=browser.new_page(viewport={'width':width,'height':height},device_scale_factor=1,reduced_motion='reduce')
   page.on('pageerror',lambda e:errors.append(str(e))); page.set_content(path.read_text(encoding='utf-8'),wait_until='domcontentloaded',timeout=20000); page.wait_for_timeout(250)
   m=page.evaluate('''()=>{const q=s=>document.querySelector(s),r=e=>{const v=e?.getBoundingClientRect();return v?{left:v.left,right:v.right,top:v.top,bottom:v.bottom,width:v.width,height:v.height}:null},cs=e=>e?getComputedStyle(e):null;const host=q('.dm-host'),ws=q('.dm-integrated-workspace'),body=q('.dialog-body'),search=q('.dm-unified-input-wrap');return{host:r(host),workspace:r(ws),sameFont:cs(host)?.fontFamily===cs(ws)?.fontFamily,doc:[document.body.scrollWidth,document.body.scrollHeight],nested:document.querySelectorAll('button button').length,header:!!q('.dm-workspace-title'),sourcebar:!!q('.dm-workspace-sourcebar'),hero:!!q('.analysis-v2-hero,.playlist-v2-hero,.playlist-summary-card'),options:!!q('.analysis-v2-options,.playlist-v2-options'),selectionRows:document.querySelectorAll('.playlist-select-item').length,current:!!q('.playlist-current-card'),currentRect:r(q('.playlist-current-card')),upcomingRect:r(q('.playlist-upcoming-card')),upcoming:document.querySelectorAll('.playlist-upcoming-row').length,side:!!q('.playlist-queue-side'),footer:!!q('.dialog-footer'),theme:host?.dataset.dmTheme||'',layout:host?.dataset.dmLayout||'',searchHeight:r(search)?.height||0,headerHeight:r(q('.dialog-header'))?.height||0,bodyOverflow:body?{sw:body.scrollWidth,cw:body.clientWidth}:null,playlistIcons:ws?.querySelectorAll('[data-icon="playlist"]').length||0,libraryIcons:ws?.querySelectorAll('[data-icon="library"]').length||0,iconFallbacks:document.querySelectorAll('[data-icon-fallback]').length}}''')
   if errors: failures.append('JS: '+str(errors))
   if not m['workspace'] or not m['host']: failures.append('workspace/host missing')
   elif not (m['workspace']['left']>=m['host']['left']-1 and m['workspace']['right']<=m['host']['right']+1): failures.append('workspace not integrated')
   if not m['sameFont']: failures.append('font mismatch')
   if m['doc'][0]>width+1 or m['doc'][1]>height+1: failures.append('document overflow')
   if m['nested']: failures.append('nested buttons')
   if not m['header'] or not m['footer'] or (stage!='queue' and not m['hero']) or (stage=='queue' and not m['current']): failures.append('workspace hierarchy incomplete')
   if (dialog!='playlist' or stage!='queue') and not m['sourcebar']: failures.append('sourcebar missing')
   if dialog=='video' and not m['options']: failures.append('video options missing')
   if m['iconFallbacks']:
    failures.append(f'unknown icon fallback rendered: {m["iconFallbacks"]}')
   if dialog=='playlist' and m['libraryIcons']:
    failures.append('playlist workspace rendered the Library icon')
   if dialog=='playlist' and m['playlistIcons'] < (1 if stage=='queue' else 2):
    failures.append('playlist workspace is missing dedicated Playlist icons')
   if dialog=='playlist' and stage=='selection' and (m['selectionRows']<6 or not m['options']): failures.append('selection workspace incomplete')
   if dialog=='playlist' and stage=='queue':
    if not m['current'] or m['upcoming']<3: failures.append('queue workspace incomplete')
    elif not m['currentRect'] or not m['upcomingRect'] or m['currentRect']['top'] >= m['upcomingRect']['top']: failures.append('current playlist item is not placed before upcoming queue')
    elif m['currentRect']['width'] < 420 or m['currentRect']['height'] < 180: failures.append('current playlist item is not large/readable')
   if m['theme'] != theme: failures.append(f'expected {theme} theme, got {m["theme"]}')
   if m['layout'] != layout: failures.append(f'expected {layout} layout, got {m["layout"]}')
   if m['searchHeight']<50 or m['headerHeight']<50: failures.append('scale too small')
   if m['bodyOverflow'] and m['bodyOverflow']['sw']>m['bodyOverflow']['cw']+2: failures.append('horizontal workspace overflow')
   page.screenshot(path=str(OUT/f'{name}.png'),full_page=False,animations='disabled',timeout=15000); page.close()
   results.append({'name':name,'pass':not failures,'failures':failures,'metrics':m,'page_errors':errors})
  finally:
   if browser is not None: browser.close()
   path.unlink(missing_ok=True)
REPORT.write_text(json.dumps({'passed':all(x['pass'] for x in results),'cases':results},indent=2,ensure_ascii=False),encoding='utf-8')
if not all(x['pass'] for x in results): print(json.dumps(results,indent=2,ensure_ascii=False)); raise SystemExit(1)
print(f'OK: {len(results)} workspaces Phase 20 integrados, temáticos y legibles')
