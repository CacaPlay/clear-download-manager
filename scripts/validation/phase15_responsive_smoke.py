from playwright.sync_api import sync_playwright
from pathlib import Path
import json, base64
root=Path(__file__).resolve().parents[2]
css=(root/'app-ui/styles.css').read_text(); js0=(root/'app-ui/main.js').read_text()
brand='data:image/png;base64,'+base64.b64encode((root/'app-ui/assets/brand/clear-download-manager-celeste.png').read_bytes()).decode()
def html(query):
  js=js0.replace("const qs = new URLSearchParams(window.location.search);", f"const qs = new URLSearchParams({query!r});",1).replace('./app-ui/assets/brand/clear-download-manager-celeste.png',brand)
  return f'<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>{css}</style></head><body><div id="app"></div><script>{js}</script></body></html>'
views=[(1920,1080),(1536,864),(1366,768),(1100,720),(900,700)]
pages=['?preview=1&view=home','?preview=1&view=downloads','?preview=1&view=currency','?preview=1&view=home&dialog=playlist&playlist=queue']
report=[]
with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'])
  for w,h in views:
    ctx=browser.new_context(viewport={'width':w,'height':h})
    for q in pages:
      page=ctx.new_page(); errs=[]; page.on('pageerror',lambda e,x=errs:x.append(str(e)))
      page.set_content(html(q),wait_until='load'); page.wait_for_selector('.desktop-shell')
      m=page.evaluate('''() => { const de=document.documentElement, shell=document.querySelector('.desktop-shell'), ws=document.querySelector('.workspace'); return {docW:de.scrollWidth,clientW:de.clientWidth,docH:de.scrollHeight,clientH:de.clientHeight,shellW:shell?.getBoundingClientRect().width,workspaceW:ws?.getBoundingClientRect().width,buttons:[...document.querySelectorAll('button')].filter(b=>{const r=b.getBoundingClientRect(); return r.width>0&&r.height>0}).every(b=>{const r=b.getBoundingClientRect(); return r.right>=0&&r.left<=innerWidth&&r.bottom>=0})}; }''')
      report.append({'viewport':f'{w}x{h}','query':q,'metrics':m,'errors':errs,'pass':m['docW']<=m['clientW']+1 and not errs})
      page.close()
    ctx.close()
  browser.close()
(root/'docs/tests/phase15-responsive-smoke.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'passed':all(r['pass'] for r in report),'cases':len(report),'failed':[r for r in report if not r['pass']]},ensure_ascii=False,indent=2))
