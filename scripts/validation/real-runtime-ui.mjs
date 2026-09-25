#!/usr/bin/env node
/**
 * Real packaged WebView2 regression gate for the human-review UI fixes.
 * The gate drives the same Tauri DOM/runtime path used by the release build;
 * it never uses the preview renderer or synthetic fixture markup.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const caseName = process.argv.find((arg) => arg.startsWith('--case='))?.split('=')[1] || 'all';
const buildRoot = join(root, '..', '..', '.build');
const artifact = process.env.CACATOOLS_UI_ARTIFACT || join(buildRoot, 'human-review-stabilization-05-final', 'cacatools-desktop.exe');
const port = Number(process.env.CACATOOLS_CDP_PORT || 9235);
const dataDir = join(tmpdir(), `cacatools-ui-runtime-${process.pid}`, 'data');
const downloadsDir = join(tmpdir(), `cacatools-ui-runtime-${process.pid}`, 'downloads');
let child = null;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function cdpTarget() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  const pages = await response.json();
  const page = pages.find((entry) => entry.type === 'page');
  if (!page) throw new Error('No se encontró una página Tauri en CDP.');
  return page.webSocketDebuggerUrl;
}
async function waitForTarget(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await cdpTarget(); } catch { await sleep(250); }
  }
  throw new Error(`CDP no estuvo disponible en ${port}.`);
}
function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => { socket.close(); reject(new Error('Timeout conectando a CDP.')); }, 5_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(socket); }, { once: true });
    socket.addEventListener('error', (event) => { clearTimeout(timer); reject(new Error(`Error conectando a CDP (${event.message || event.type || 'socket'})`)); }, { once: true });
  });
}
function evaluate(socket, expression, awaitPromise = false) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      socket.removeEventListener('message', onMessage);
      if (message.error) reject(new Error(message.error.message || 'Runtime.evaluate failed'));
      else if (message.result?.exceptionDetails) {
        const detail = message.result.exceptionDetails;
        reject(new Error(detail.exception?.description || detail.exception?.value || detail.text || 'Runtime.evaluate exception'));
      }
      else resolve(message.result?.result?.value);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise, returnByValue: true } }));
  });
}
async function connect() {
  return openSocket(await waitForTarget());
}
async function waitForSelector(socket, selector, timeoutMs = 10_000) {
  const expression = `(async()=>{const deadline=Date.now()+${Number(timeoutMs)};while(Date.now()<deadline){if(document.querySelector(${JSON.stringify(selector)}))return true;await new Promise(r=>setTimeout(r,100));}return false;})()`;
  return Boolean(await evaluate(socket, expression, true));
}
function assert(condition, message) { if (!condition) throw new Error(message); }

async function runTransient(socket) {
  assert(await waitForSelector(socket, '[data-dm-open-settings]'), 'No apareció el gestor de descargas');
  const result = JSON.parse(await evaluate(socket, `(async()=>{
    document.querySelector('[data-dm-open-settings]')?.click();
    for(let i=0;i<100&&!document.querySelector('[data-settings-category="downloads"]');i++) await new Promise(r=>setTimeout(r,100));
    document.querySelector('[data-settings-category="downloads"]')?.click();
    for(let i=0;i<100&&!document.querySelector('#bandwidth-limit-select');i++) await new Promise(r=>setTimeout(r,100));
    const selector=document.querySelector('#bandwidth-limit-select');
    if(!selector) return JSON.stringify({error:'No apareció el selector de ancho de banda'});
    selector.value='custom'; selector.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(r=>setTimeout(r,120));
    const input=document.querySelector('#bandwidth-custom-value');
    if(!input) return JSON.stringify({error:'No apareció el editor personalizado'});
    input.focus(); input.value='7'; input.dispatchEvent(new Event('input',{bubbles:true}));
    const before=input;
    await new Promise(r=>setTimeout(r,9000));
    const after=document.querySelector('#bandwidth-custom-value');
    const settings={sameNode:before===after,focused:document.activeElement===after,value:after?.value||'',visible:Boolean(after&&after.offsetParent)};
    document.querySelector('.settings-back')?.click();
    await new Promise(r=>setTimeout(r,150));
    document.querySelector('[data-dm-category-toggle]')?.click();
    const categoryBefore=document.querySelector('[data-dm-category-menu]');
    await new Promise(r=>setTimeout(r,9000));
    const categoryAfter=document.querySelector('[data-dm-category-menu]');
    const category={sameNode:categoryBefore===categoryAfter,open:Boolean(categoryAfter&&!categoryAfter.hidden),selected:categoryAfter?.querySelector('[aria-selected="true"]')?.dataset.dmCategoryOption||''};
    return JSON.stringify({settings,category});
  })()`, true));
  assert(!result.error, result.error || 'Transient runtime test returned an error');
  assert(result.settings.sameNode && result.settings.focused && result.settings.value === '7' && result.settings.visible, `Settings transient state lost: ${JSON.stringify(result.settings)}`);
  assert(result.category.sameNode && result.category.open, `Category transient state lost: ${JSON.stringify(result.category)}`);
  console.log(`PASS: packaged transient controls preserve value/focus/open state (${JSON.stringify(result)})`);
}

async function runFloating(socket) {
  const queued = await evaluate(socket, `window.__TAURI_INTERNALS__.invoke('queue_http_download',{url:'https://example.invalid/hr-ui-runtime.bin',filename:'hr-ui-runtime.bin'})`, true);
  await waitForSelector(socket, '[data-dm-row-menu]', 12_000);
  const result = JSON.parse(await evaluate(socket, `(async()=>{
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    await new Promise(r=>setTimeout(r,100));
    const rowButtons=[...document.querySelectorAll('[data-dm-row-menu]')];
    const rowButton=rowButtons.at(-1);
    if(!rowButton) return JSON.stringify({error:'No apareció una fila real tras queue_http_download',queued:${JSON.stringify(queued)}});
    rowButton.click(); await new Promise(r=>setTimeout(r,300));
    const menu=document.querySelector('.dm-row-menu-floating');
    if(!menu) return JSON.stringify({error:'No apareció el menú flotante'});
    const before=menu.getBoundingClientRect(); const viewport={width:innerWidth,height:innerHeight};
    const appearance=getComputedStyle(menu);
    const layer=menu.parentElement?.id||'';
    await new Promise(r=>setTimeout(r,9000));
    const after=document.querySelector('.dm-row-menu-floating');
    const rect=after?.getBoundingClientRect();
    return JSON.stringify({layer,viewport,appearance:{background:appearance.backgroundColor,color:appearance.color,border:appearance.borderTopColor},before:{x:before.x,y:before.y,width:before.width,height:before.height},after:rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null,open:Boolean(after&& !after.hidden && after.getClientRects().length)});
  })()`, true));
  assert(!result.error, result.error || 'Floating runtime test returned an error');
  assert(result.layer === 'dm-floating-ui-layer', `Menu no está en la capa flotante común: ${JSON.stringify(result)}`);
  assert(result.appearance?.background && !['transparent', 'rgba(0, 0, 0, 0)'].includes(result.appearance.background), `Menú sin fondo resuelto: ${JSON.stringify(result)}`);
  assert(result.appearance?.color && !['transparent', 'rgba(0, 0, 0, 0)'].includes(result.appearance.color), `Menú sin color resuelto: ${JSON.stringify(result)}`);
  const rect = result.after;
  assert(rect && rect.x >= 8 && rect.y >= 8 && rect.x + rect.width <= result.viewport.width - 8 && rect.y + rect.height <= result.viewport.height - 8, `Menú fuera del viewport: ${JSON.stringify(result)}`);
  assert(result.open, `Menú se cerró durante refresh: ${JSON.stringify(result)}`);
  console.log(`PASS: packaged floating menu stays reachable and open (${JSON.stringify(result)})`);
}

async function main() {
  const useExisting = Boolean(process.env.CACATOOLS_CDP_PORT) || args.has('--existing');
  if (!useExisting) {
    mkdirSync(dataDir, { recursive: true }); mkdirSync(downloadsDir, { recursive: true });
    child = spawn(artifact, [], { cwd: join(buildRoot, 'human-review-stabilization-05-final'), windowsHide: true, env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, CACATOOLS_DATA_DIR: dataDir, CACATOOLS_DOWNLOADS_DIR: downloadsDir }, stdio: 'ignore' });
  }
  const socket = await connect();
  try {
    // Let the packaged startup snapshot finish its initial reconciliation
    // before driving controls; otherwise CDP would quite correctly report a
    // destroyed execution context during the first render.
    await sleep(12_000);
    if (caseName === 'transient' || caseName === 'all') await runTransient(socket);
    if (caseName === 'floating' || caseName === 'all') await runFloating(socket);
  } finally { socket.close(); }
}

main().catch((error) => { console.error(`FAIL: ${error.stack || error.message}`); process.exitCode = 1; }).finally(() => { if (child) child.kill(); });
