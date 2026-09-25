import fs from 'node:fs';
import path from 'node:path';
const output=process.argv[2]||''; const cache=new Map();
function moduleUrl(filename){
 const file=path.resolve(filename); if(cache.has(file)) return cache.get(file);
 let source=fs.readFileSync(file,'utf8');
 const pattern=/(from\s*|import\s*)(['"])(\.\.?\/[^'"]+)\2/g;
 source=source.replace(pattern,(m,p,q,s)=>`${p}${q}${moduleUrl(path.resolve(path.dirname(file),s.split(/[?#]/,1)[0]))}${q}`);
 const url=`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;cache.set(file,url);return url;
}
const mod=moduleUrl('app-ui/download-manager/index.js');
let css=fs.readFileSync('app-ui/download-manager/styles.css','utf8');
const script=`import {renderDownloadManager,bindDownloadManager,patchDownloadManagerLive} from ${JSON.stringify(mod)};
const preferences={layout:'zen-sidebar',theme:'dark',accent:'#2f9bff',success:'#45cf89',warning:'#e6ad48',danger:'#ef6975',sidebarCollapsed:true,inspectorCollapsed:true,lowerPanelCollapsed:true,compactRows:false,filter:'all',category:'all',query:'',selectedJobId:1,inspectorTab:'summary',commandPanel:'overview',section:'downloads',uiScale:120,appearanceRevision:4};
const snapshot={jobs:[{id:1,title:'Descarga activa.mp4',detail:'Descarga de prueba',status:'running',progress:12,downloaded_bytes:12000000,total_bytes:100000000,speed_bps:1250000,eta_seconds:70,kind:'video',engine:'yt-dlp',thumbnail:'',source_url:'https://example.com/a',destination:'C:/Temp/a.mp4',updated_at:'1'},{id:2,title:'Archivo terminado.pdf',detail:'PDF',status:'completed',progress:100,downloaded_bytes:500000,total_bytes:500000,speed_bps:0,eta_seconds:null,kind:'file',engine:'http-range',source_url:'https://example.com/a.pdf',destination:'C:/Temp/a.pdf',updated_at:'1'}],playlist_batches:[]};
window.phase20SuggestionQueries=[];window.phase20SuggestionActive=0;window.phase20SuggestionMaxActive=0;
const context={snapshot,pendingJobs:[],schedules:[],runtimeStatus:{mode:'local'},mediaRuntimeStatus:{},downloadDirectory:'C:/Temp',invoke:async(name,args)=>{
 if(name==='search_video_suggestions') return [];
 if(name!=='search_video_suggestions_page') return null;
 const query=String(args?.query||''); window.phase20SuggestionQueries.push(query);
 window.phase20SuggestionActive+=1;window.phase20SuggestionMaxActive=Math.max(window.phase20SuggestionMaxActive,window.phase20SuggestionActive);
 const wait=query==='mini'?620:80;
 return new Promise(resolve=>window.setTimeout(()=>{window.phase20SuggestionActive-=1;resolve([
   {title:query+' resultado remoto',source_url:'https://example.com/'+encodeURIComponent(query)+'/1'},
   {title:query+' video oficial',source_url:'https://example.com/'+encodeURIComponent(query)+'/2'},
   {title:query+' audio oficial',source_url:'https://example.com/'+encodeURIComponent(query)+'/3'}
 ]);},wait));
},onRefresh:async()=>{},onToast:()=>{},onAnalyzeSource:async()=>{},onPreferencesChange:()=>{},onSection:()=>{},onOpenDownload:()=>{}};
context.onRerender=()=>{const host=document.querySelector('.dm-host');if(host)host.outerHTML=renderDownloadManager(context);bindDownloadManager(context);};
document.querySelector('#app').innerHTML=renderDownloadManager(context);bindDownloadManager(context);window.phase20Patch=(next)=>patchDownloadManagerLive({...context,snapshot:next});`;
const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app-ui/download-manager/styles.css"><style>html,body,#app{width:100%;height:100%;margin:0;overflow:hidden}</style><style>${css}</style></head><body><div id="app"></div><script type="module">${script}</script></body></html>`;
if(output)fs.writeFileSync(output,html);else process.stdout.write(html);
