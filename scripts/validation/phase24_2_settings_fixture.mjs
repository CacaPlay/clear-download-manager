import fs from 'node:fs';
import path from 'node:path';

const output = process.argv[2] || '';
const cache = new Map();
function moduleUrl(filename) {
  const file = path.resolve(filename);
  if (cache.has(file)) return cache.get(file);
  let source = fs.readFileSync(file, 'utf8');
  const pattern = /(from\s*|import\s*)(['"])(\.\.?\/[^'"]+)\2/g;
  source = source.replace(pattern, (match, prefix, quote, relative) => {
    const sourcePath = relative.split(/[?#]/, 1)[0];
    return `${prefix}${quote}${moduleUrl(path.resolve(path.dirname(file), sourcePath))}${quote}`;
  });
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  cache.set(file, url);
  return url;
}

const module = moduleUrl('app-ui/download-manager/index.js');
const css = fs.readFileSync('app-ui/download-manager/styles.css', 'utf8');
const script = `import {renderDownloadManager,bindDownloadManager} from ${JSON.stringify(module)};
const snapshot={jobs:[{id:1,title:'Video de prueba con un título suficientemente largo para validar la distribución responsive.mp4',detail:'Descargando',status:'running',progress:42,downloaded_bytes:42000000,total_bytes:100000000,speed_bps:3200000,eta_seconds:18,kind:'video',engine:'yt-dlp',thumbnail:'',source_url:'https://example.com/video',destination:'C:/Users/Demo/Downloads/video.mp4',updated_at:'1'}],playlist_batches:[]};
const context={snapshot,pendingJobs:[],schedules:[],runtimeStatus:{mode:'local',version:'0.25.1',aria2_available:true,aria2_version:'aria2 version 1.37.0'},mediaRuntimeStatus:{yt_dlp:true,yt_dlp_version:'2026.07.04',ffmpeg:true,ffmpeg_version:'ffmpeg version 8.1.2',ffprobe:true,ffprobe_version:'ffprobe version 8.1.2',detail:'Motores locales disponibles'},downloadDirectory:'C:/Users/Demo/Downloads/CacaTools',windowBehavior:{closeAction:'tray'},startupStatus:{supported:true,enabled:true},updaterStatus:{configured:true,currentVersion:'0.25.1',channel:'stable',repository:'cacatools/releases'},extensionBridgeStatus:{prepared:true,registered:true,hostName:'lat.cacaplay.cacatools.downloadmanager',protocolVersion:1},mediaPreferences:{outputMode:'video_mp4',formatSelector:'bestvideo[height<=1080]+bestaudio/best',playlistFormat:'Mejor calidad disponible'},appearance:{accent:'#2f9bff',intensity:88,scale:120,textScale:120},appearanceDensity:'normal',invoke:async()=>null,onRefresh:async()=>{},onToast:()=>{},onAnalyzeSource:async()=>{},onPreferencesChange:()=>{},onSection:()=>{},onOpenDownload:()=>{},onChooseDownloadDirectory:async()=>{},onOpenDownloadDirectory:async()=>{},onMediaPreferencesChange:()=>{},onRepairIntegration:async()=>{},onRefreshRuntime:async()=>{},onCopyDiagnostics:async()=>{},onStartupChange:async()=>{},onWindowBehaviorChange:async()=>{},onAutoUpdateChange:()=>{},onCheckUpdate:async()=>{},onInstallUpdate:async()=>{},onDismissUpdate:()=>{}};
function mount(){document.querySelector('#app').innerHTML=renderDownloadManager(context);bindDownloadManager(context);}context.onRerender=mount;mount();`;
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#app{width:100%;height:100%;margin:0;overflow:hidden}${css}</style></head><body><div id="app"></div><script type="module">${script}</script></body></html>`;
if (output) fs.writeFileSync(output, html);
else process.stdout.write(html);
