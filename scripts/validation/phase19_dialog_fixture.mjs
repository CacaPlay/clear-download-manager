import fs from 'node:fs';
import path from 'node:path';

const [,, layout = 'command-center', theme = 'dark', dialog = 'video', stage = 'selection', output = ''] = process.argv;
const root = process.cwd();
const query = `?preview=1&view=downloads&dialog=${encodeURIComponent(dialog)}&playlist=${encodeURIComponent(stage)}`;
const previewPng = fs.readFileSync(path.join(root, 'app-ui/assets/brand/clear-download-manager-celeste.png'));
const previewData = `data:image/png;base64,${previewPng.toString('base64')}`;
const cache = new Map();

function moduleUrl(filename) {
  const file = path.resolve(filename);
  if (cache.has(file)) return cache.get(file);
  let source = fs.readFileSync(file, 'utf8');
  if (file.endsWith(`${path.sep}app-ui${path.sep}download-manager${path.sep}core${path.sep}constants.js`)) {
    source = source
      .replace("layout: 'zen-sidebar'", `layout: ${JSON.stringify(layout)}`)
      .replace("theme: 'dark'", `theme: ${JSON.stringify(theme)}`);
  }
  if (file.endsWith(`${path.sep}app-ui${path.sep}download-manager${path.sep}core${path.sep}model.js`)) {
    source = source.replace("stored.layout = 'zen-sidebar';", `stored.layout = ${JSON.stringify(layout)};`);
  }
  if (file.endsWith(`${path.sep}app-ui${path.sep}main.js`)) {
    source = source
      .replace('const qs = new URLSearchParams(window.location.search);', `const qs = new URLSearchParams(${JSON.stringify(query)});`)
      .replaceAll('./app-ui/assets/brand/clear-download-manager-celeste.png', previewData)
      .replace('const visual = downloadManagerVisualPreferences();', `const visual = { theme: ${JSON.stringify(theme)}, layout: ${JSON.stringify(layout)} };`);
    const fixtureState = `
if (previewMode) {
  appState.unifiedSearchAlternatives = [
    { source_url: 'https://www.youtube.com/watch?v=alt1', title: 'Mitski — My Love Mine All Mine (Official Audio)', creator: 'Mitski', duration_label: '2:19', duration_seconds: 139, thumbnail: ${JSON.stringify(previewData)}, similarity: 98 },
    { source_url: 'https://www.youtube.com/watch?v=alt2', title: 'Mitski — My Love Mine All Mine (Lyrics)', creator: '7clouds', duration_label: '2:19', duration_seconds: 139, thumbnail: ${JSON.stringify(previewData)}, similarity: 94 },
    { source_url: 'https://www.youtube.com/watch?v=alt3', title: 'Mitski — My Love Mine All Mine (Live)', creator: 'Mitski', duration_label: '2:21', duration_seconds: 141, thumbnail: ${JSON.stringify(previewData)}, similarity: 90 }
  ];
  if (${JSON.stringify(dialog)} === 'playlist' && ${JSON.stringify(stage)} === 'queue') {
    appState.playlistBatchId = 7;
    appState.playlistRuntime = {
      batch_id: 7, title: 'Good Music', format: 'Audio · MP3 320 kbps', status: 'running',
      total: 7, completed: 1, failed: 1, last_error: 'El vídeo no está disponible en tu región.',
      failed_item: { job_id: 403, title: 'Mitski — My Love Mine All Mine', creator: 'Mitski', thumbnail: ${JSON.stringify(previewData)}, duration_label: '2:19', status: 'failed', progress: 0, detail: 'No disponible', error: 'El vídeo no está disponible en tu región.' },
      current: { job_id: 402, title: 'Cafuné — Tek It (I Watch The Moon)', creator: 'Cafuné', thumbnail: ${JSON.stringify(previewData)}, duration_label: '3:14', status: 'running', progress: 68, detail: '4.8 MB/s · 2m 14s restantes', error: '' },
      next: { job_id: 404, position: 3, title: 'Jace June — Come Home', creator: 'Jace June', thumbnail: ${JSON.stringify(previewData)}, duration_label: '2:49', status: 'queued', progress: 0, detail: 'En espera', error: '' },
      upcoming: [
        { job_id: 404, position: 3, title: 'Jace June — Come Home', creator: 'Jace June', thumbnail: ${JSON.stringify(previewData)}, duration_label: '2:49', status: 'queued', progress: 0, detail: 'En espera', error: '' },
        { job_id: 405, position: 4, title: 'Hero', creator: 'Skylper', thumbnail: ${JSON.stringify(previewData)}, duration_label: '2:21', status: 'queued', progress: 0, detail: 'En espera', error: '' },
        { job_id: 406, position: 5, title: 'Die With A Smile', creator: 'Lady Gaga', thumbnail: ${JSON.stringify(previewData)}, duration_label: '4:12', status: 'queued', progress: 0, detail: 'En espera', error: '' },
        { job_id: 407, position: 6, title: 'Headlock', creator: 'Imogen Heap', thumbnail: ${JSON.stringify(previewData)}, duration_label: '3:35', status: 'queued', progress: 0, detail: 'En espera', error: '' }
      ]
    };
  }
}
`;
    source = source.replace('function formatBytes(bytes) {', `${fixtureState}\nfunction formatBytes(bytes) {`);
  }
  const importPattern = /(from\s*|import\s*)(['"])(\.\.?\/[^'"]+)\2/g;
  source = source.replace(importPattern, (match, prefix, quote, specifier) => {
    const target = path.resolve(path.dirname(file), specifier.split('?')[0]);
    return `${prefix}${quote}${moduleUrl(target)}${quote}`;
  });
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  cache.set(file, url);
  return url;
}

let css = fs.readFileSync(path.join(root, 'app-ui/styles.css'), 'utf8');
css = css.replace(/@import\s+url\(['"]\.\/download-manager\/styles\.css(?:\?[^'"]*)?['"]\)\s*;/, fs.readFileSync(path.join(root, 'app-ui/download-manager/styles.css'), 'utf8'));
const main = moduleUrl(path.join(root, 'app-ui/main.js'));
const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="app"></div><script type="module" src="${main}"></script></body></html>`;
if (output) fs.writeFileSync(output, html); else process.stdout.write(html);
