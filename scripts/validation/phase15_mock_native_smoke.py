from playwright.sync_api import sync_playwright
from pathlib import Path
import json, base64
root=Path(__file__).resolve().parents[2]
css=(root/'app-ui/styles.css').read_text(); js=(root/'app-ui/main.js').read_text()
brand='data:image/png;base64,'+base64.b64encode((root/'app-ui/assets/brand/clear-download-manager-celeste.png').read_bytes()).decode()
js=js.replace('./app-ui/assets/brand/clear-download-manager-celeste.png',brand)
bridge=r'''
window.__mockCalls=[];
window.__playlistProgress=8;
const snapshot={storage:{free_bytes:274877906944,total_bytes:549755813888},currency:{rate:59.68,source:'Última tasa guardada',updated_at:'2026-07-30 06:10:00',mode:'cached',online:false,error:null},jobs:[{id:11,title:'video-prueba.mp4',detail:'20 MB de 100 MB · 4 MB/s',progress:20,status:'running'}],recent_files:[{id:1,name:'video-prueba.mp4',path:'C:\\Demo\\video-prueba.mp4',category:'Vídeo',opened_at:'Hoy',kind:'video'}]};
const playlistItems=[
 {source_id:'one',source_url:'https://example.com/watch?v=one',title:'Canción uno',creator:'Artista',duration_label:'3:00',duration_seconds:180,thumbnail:''},
 {source_id:'two',source_url:'https://example.com/watch?v=two',title:'Canción dos',creator:'Artista',duration_label:'2:30',duration_seconds:150,thumbnail:''}
];
window.__TAURI__={core:{invoke:async(command,args={})=>{
 window.__mockCalls.push({command,args});
 switch(command){
  case 'desktop_snapshot': return structuredClone(snapshot);
  case 'desktop_settings': return {downloads_dir:'C:\\Users\\Demo\\Downloads\\CacaTools'};
  case 'get_appearance_settings': return null;
  case 'runtime_status': return {mode:'local',server_dependency:false,loopback_only:true,download_engine:'http-range-v1',version:'0.15.0'};
  case 'media_runtime_status': return {available:true,yt_dlp:'yt-dlp.exe',ffmpeg:'ffmpeg.exe',ffprobe:'ffprobe.exe'};
  case 'refresh_usd_dop_rate': snapshot.currency={rate:59.75,source:'Tasa en línea · ExchangeRate-API',updated_at:'2026-07-30 08:00:00',mode:'live',online:true,error:null}; return structuredClone(snapshot.currency);
  case 'inspect_download_url': return {kind:'media',normalized_url:args.url,suggested_filename:'',content_type:'text/html',content_length:null,requires_media_resolver:true};
  case 'analyze_media_url': return {kind:'playlist',title:'Playlist de prueba',creator:'2 vídeos',thumbnail:'',duration_label:'5:30',duration_seconds:330,formats:[{id:'best',label:'Audio · MP3 320 kbps',ext:'mp3',resolution:'Audio',audio_only:true,filesize:null}],items:playlistItems,resolver:'mock'};
  case 'queue_playlist_selection': return {batch_id:77,item_count:args.items.length,sequential:true};
  case 'playlist_runtime_snapshot': window.__playlistProgress=Math.min(94,window.__playlistProgress+17); return {batch_id:77,title:'Playlist de prueba',format:'Audio · MP3 320 kbps',status:'running',total:2,completed:0,failed:0,current:{job_id:501,title:'Canción uno',creator:'Artista',thumbnail:'',duration_label:'3:00',status:'running',progress:window.__playlistProgress},next:{job_id:502,title:'Canción dos',creator:'Artista',thumbnail:'',duration_label:'2:30',status:'queued',progress:0}};
  case 'set_job_status': return null;
  default: return null;
 }
}}};
'''
html=f'<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>{css}</style></head><body><div id="app"></div><script>{bridge}</script><script>{js}</script></body></html>'
report={'suite':'Phase 15 mocked native bridge','steps':[],'passed':True}
def add(name,passed,detail=None):
 report['steps'].append({'name':name,'passed':bool(passed),'detail':detail}); report['passed'] &= bool(passed)
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'])
 page=browser.new_page(viewport={'width':1536,'height':864}); errors=[]; page.on('pageerror',lambda e:errors.append(str(e)))
 page.set_content(html,wait_until='load'); page.wait_for_selector('.desktop-shell',timeout=15000)
 add('startup shell',page.locator('.desktop-shell').count()==1)
 page.wait_for_timeout(800)
 calls=page.evaluate('window.__mockCalls.map(x=>x.command)')
 add('startup IPC commands',all(x in calls for x in ['desktop_snapshot','desktop_settings','runtime_status','media_runtime_status','refresh_usd_dop_rate']),calls)
 page.locator('[data-section="Utilidades"]').click(); page.locator('[data-utility="currency"]').click(); page.wait_for_selector('.currency-page-grid')
 add('currency online refresh',page.locator('.currency-live-badge').inner_text().strip()=='En vivo',page.locator('.currency-source-line span').inner_text())
 page.locator('[data-section="Descargas"]').click(); page.wait_for_selector('.downloads-layout')
 page.locator('.new-download-top').click(); page.wait_for_selector('.download-dialog')
 page.locator('#download-url').fill('https://example.com/playlist?list=test'); page.locator('.analyze-button').click(); page.wait_for_selector('.playlist-select-item',timeout=10000)
 add('playlist analyzed',page.locator('.playlist-select-item').count()==2)
 # items default selected; queue
 page.locator('.confirm-download').click(); page.wait_for_selector('.playlist-current-card',timeout=10000)
 width1=page.locator('.current-progress i').evaluate('(e)=>parseFloat(e.style.width)')
 page.wait_for_timeout(2100)
 width2=page.locator('.current-progress i').evaluate('(e)=>parseFloat(e.style.width)')
 add('playlist progress changes',width2>width1,{'before':width1,'after':width2})
 current=page.locator('.playlist-current-copy h4').inner_text(); nxt=page.locator('.playlist-next-strip strong').inner_text(); add('current and next item',current=='Canción uno' and nxt=='Canción dos',{'current':current,'next':nxt})
 page.locator('.playlist-pause').click(); page.wait_for_timeout(100); setcalls=page.evaluate("window.__mockCalls.filter(x=>x.command==='set_playlist_batch_paused')")
 add('pause IPC',len(setcalls)>=1 and setcalls[-1]['args']['paused'] is True,setcalls[-1] if setcalls else None)
 add('no page errors',not errors,errors)
 browser.close()
(root/'docs/tests/phase15-mocked-native-smoke.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(report,ensure_ascii=False,indent=2))
raise SystemExit(0 if report['passed'] else 1)
