import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const previewPng = fs.readFileSync(path.resolve('app-ui/assets/brand/clear-download-manager-celeste.png'));
const previewData = `data:image/png;base64,${previewPng.toString('base64')}`;

const [,, layout = 'zen-sidebar', theme = 'dark', output = '', accent = '#2f9bff', density = 'normal', sidebarMode = 'collapsed', inspectorMode = 'collapsed'] = process.argv;
const preferences = {
  layout, theme, accent, success: '#45cf89', warning: '#e6ad48', danger: '#ef6975',
  sidebarCollapsed: sidebarMode !== 'expanded', inspectorCollapsed: inspectorMode !== 'expanded', lowerPanelCollapsed: true,
  compactRows: false, filter: 'all', category: 'all', query: '', selectedJobId: 1,
  inspectorTab: 'summary', commandPanel: 'overview', section: 'downloads', uiScale: 125, appearanceRevision: 6
};
globalThis.localStorage = {
  getItem: () => JSON.stringify(preferences),
  setItem: () => {}, removeItem: () => {}
};
globalThis.window = {
  matchMedia: () => ({ matches: theme === 'light', addEventListener: () => {}, removeEventListener: () => {} }),
  addEventListener: () => {}, removeEventListener: () => {}
};
const { renderDownloadManager } = await import(pathToFileURL(path.resolve('app-ui/download-manager/index.js')).href);
const snapshot = {
  jobs: [
    { id: 1, title: 'Jujutsu Kaisen - S02E17 (1080p).mp4', detail: 'MP4 · H.264 · 1080p', status: 'running', progress: 68, downloaded_bytes: 1210000000, total_bytes: 1780000000, speed_bps: 5420000, eta_seconds: 134, kind: 'video', engine: 'yt-dlp', thumbnail: previewData, source_url: 'https://www.youtube.com/watch?v=demo', destination: 'C:\\Users\\jerem\\Downloads\\CDM\\Jujutsu Kaisen.mp4', updated_at: '2026-07-31 16:20:00' },
    { id: 2, title: 'Manual de CacaTools.pdf', detail: 'PDF · documento descargado', status: 'completed', progress: 100, downloaded_bytes: 48700000, total_bytes: 48700000, speed_bps: 0, eta_seconds: null, kind: 'file', engine: 'http-range', source_url: 'https://example.com/manual.pdf', destination: 'C:\\Users\\jerem\\Downloads\\CDM\\Manual.pdf', updated_at: '2026-07-31 16:15:00' },
    { id: 4, title: 'CacaTools-Setup.exe', detail: 'EXE · instalador de Windows', status: 'completed', progress: 100, downloaded_bytes: 93200000, total_bytes: 93200000, speed_bps: 0, eta_seconds: null, kind: 'file', engine: 'http-range', source_url: 'https://example.com/CacaTools-Setup.exe', destination: 'C:\\Users\\jerem\\Downloads\\CDM\\CacaTools-Setup.exe', updated_at: '2026-07-31 16:13:00' },
    { id: 3, title: 'Vídeo restringido.mp4', detail: 'La fuente no está disponible en tu región', status: 'failed', progress: 14, downloaded_bytes: 3400000, total_bytes: 23000000, speed_bps: 0, eta_seconds: null, kind: 'video', engine: 'yt-dlp', source_url: 'https://example.com/restricted', destination: '', updated_at: '2026-07-31 16:10:00' }
  ],
  playlist_batches: [
    { batch_id: 7, title: 'Good Music · Cafuné y 7 más', format: 'Audio · MP3 320 kbps', status: 'queued', total_items: 8, completed_items: 0, failed_items: 0, active_items: 0, progress: 0, downloaded_bytes: 0, total_bytes: 1180000000, speed_bps: 0, eta_seconds: null, destination: 'C:\\Users\\jerem\\Downloads\\CDM', thumbnail_stack: [previewData, previewData, previewData].join('\u001f'), last_error: null, created_at: '2026-07-31 16:00:00', updated_at: '2026-07-31 16:00:00' }
  ]
};
const markup = renderDownloadManager({
  snapshot, pendingJobs: [], schedules: [],
  runtimeStatus: { mode: 'local', aria2_available: true, media_available: true },
  mediaRuntimeStatus: { yt_dlp: 'yt-dlp.exe', ffmpeg: 'ffmpeg.exe', ffprobe: 'ffprobe.exe' },
  downloadDirectory: 'C:\\Users\\jerem\\Downloads\\CDM', appearanceDensity: density, previewMode: true
});
const css = fs.readFileSync('app-ui/download-manager/styles.css', 'utf8');
const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{width:100%;height:100%;margin:0;overflow:hidden;background:${theme === 'light' ? '#e9edf2' : '#070b10'}}${css}</style></head><body>${markup}</body></html>`;
if (output) fs.writeFileSync(output, html); else process.stdout.write(html);
