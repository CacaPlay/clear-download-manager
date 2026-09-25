import fs from 'node:fs';
import path from 'node:path';

const output = process.argv[2] || '';
const cache = new Map();
function moduleUrl(filename) {
  const file = path.resolve(filename);
  if (cache.has(file)) return cache.get(file);
  let source = fs.readFileSync(file, 'utf8');
  const pattern = /(from\s*|import\s*)(['"])(\.\.?\/[^'"]+)\2/g;
  source = source.replace(pattern, (match, prefix, quote, specifier) => {
    const withoutQuery = specifier.split('?')[0].split('#')[0];
    return `${prefix}${quote}${moduleUrl(path.resolve(path.dirname(file), withoutQuery))}${quote}`;
  });
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  cache.set(file, url);
  return url;
}

const mod = moduleUrl('app-ui/download-manager/index.js');
const css = fs.readFileSync('app-ui/download-manager/styles.css', 'utf8');
const script = `import {renderDownloadManager,bindDownloadManager,patchDownloadManagerLive} from ${JSON.stringify(mod)};
const snapshot={jobs:[
{id:1,title:'Descarga activa.mp4',detail:'Descarga de prueba',status:'running',progress:12,downloaded_bytes:12000000,total_bytes:100000000,speed_bps:1250000,eta_seconds:70,kind:'video',engine:'yt-dlp',thumbnail:'',source_url:'https://example.com/a',destination:'C:/Temp/a.mp4',updated_at:'1'},
{id:2,title:'Archivo terminado.pdf',detail:'PDF',status:'completed',progress:100,downloaded_bytes:500000,total_bytes:500000,speed_bps:0,eta_seconds:null,kind:'file',engine:'http-range',source_url:'https://example.com/a.pdf',destination:'C:/Temp/a.pdf',updated_at:'1'}
],playlist_batches:[]};
const context={snapshot,pendingJobs:[],schedules:[],runtimeStatus:{mode:'local'},mediaRuntimeStatus:{},downloadDirectory:'C:/Temp',invoke:async()=>null,onRefresh:async()=>{},onToast:()=>{},onAnalyzeSource:async()=>{},onPreferencesChange:()=>{},onSection:()=>{},onOpenDownload:()=>{}};
function mount(){document.querySelector('#app').innerHTML=renderDownloadManager(context);bindDownloadManager(context);}
context.onRerender=mount;
mount();
window.phase25Patch=(next)=>{context.snapshot=next;return patchDownloadManagerLive({...context,snapshot:next});};`;
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#app{width:100%;height:100%;margin:0;overflow:hidden}${css}</style></head><body><div id="app"></div><script type="module">${script}</script></body></html>`;
if (output) fs.writeFileSync(output, html); else process.stdout.write(html);
