#!/usr/bin/env python3
"""Measured UI performance gate for CacaTools 0.24.2 Phase 4."""
from __future__ import annotations

import json
import re
import shutil
import sys
import time
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
REPORT = ROOT / "docs" / "tests" / "phase24-2-phase4-performance.json"
MODULES = (
    "app-ui/download-manager/core/constants.js",
    "app-ui/download-manager/core/model.js",
    "app-ui/download-manager/view/icons.js",
    "app-ui/download-manager/view/shared.js",
    "app-ui/download-manager/view/sections.js",
    "app-ui/download-manager/view/unified.js",
    "app-ui/download-manager/view/zen-sidebar.js",
    "app-ui/download-manager/view/dialogs.js",
    "app-ui/download-manager/index.js",
)
BASELINE = {
    "live_updates": 40,
    "live_total_ms": 9161.1,
    "live_average_ms": 229.0275,
    "live_max_ms": 350.5,
    "heap_delta_bytes": 59_181_186,
    "row_node_preserved": False,
    "thumbnail_node_preserved": False,
}


def browser_bundle() -> str:
    parts: list[str] = []
    for relative in MODULES:
        source = (ROOT / relative).read_text(encoding="utf-8")
        if relative == "app-ui/download-manager/core/constants.js":
            source = source.replace("section: 'downloads'", "section: 'history'", 1)
        source = re.sub(r"^import\s+[^;]+;\s*$", "", source, flags=re.MULTILINE)
        source = re.sub(r"\bexport\s+(?=(?:const|let|var|function|class)\b)", "", source)
        source = re.sub(r"\bexport\s*\{[^}]*\};?", "", source, flags=re.DOTALL)
        parts.append(f"\n/* {relative} */\n{source}\n")
    return "".join(parts)


def browser_executable() -> str | None:
    candidates = [
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
        "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return candidate
    return shutil.which("chromium") or shutil.which("google-chrome")


def main() -> int:
    css = (ROOT / "app-ui/download-manager/styles.css").read_text(encoding="utf-8")
    html = (
        '<!doctype html><html><head><meta charset="utf-8">'
        f'<style>html,body,#fixture{{width:100%;height:100%;margin:0;overflow:hidden}}{css}</style>'
        '</head><body><main id="fixture"></main></body></html>'
    )
    checks: list[dict[str, Any]] = []

    def check(name: str, passed: bool, detail: Any = None) -> None:
        checks.append({"name": name, "pass": bool(passed), "detail": detail})

    with sync_playwright() as playwright:
        executable = browser_executable()
        if not executable:
            print("SKIP: no se encontró Chrome, Edge o Chromium para el harness", file=sys.stderr)
            return 2
        browser = playwright.chromium.launch(
            executable_path=executable,
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage", "--enable-precise-memory-info"],
        )
        page = browser.new_page(viewport={"width": 1920, "height": 1080})
        page.add_init_script(
            "(() => { const values = new Map([['cacatools.download-manager.v2', "
            "JSON.stringify({section:'history',filter:'all',category:'all',query:''})]]); "
            "Object.defineProperty(window, 'localStorage', {configurable:true, value: "
            "{getItem:(key)=>values.get(key)||null,setItem:(key,value)=>values.set(key,String(value)), "
            "removeItem:(key)=>values.delete(key),clear:()=>values.clear(),key:(index)=>Array.from(values.keys())[index]||null, get length(){return values.size;}}}); })();"
        )
        thumbnail_requests: list[str] = []
        thumbnail_png = bytes.fromhex(
            "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
            "0000000d49444154789c6360f8cfc000000301010018dd8db40000000049454e44ae426082"
        )

        def fulfill_thumbnail(route: Any) -> None:
            url = route.request.url
            thumbnail_requests.append(url)
            if "/vi/broken-primary/mqdefault.jpg" in url:
                route.fulfill(status=404, body=b"", headers={"Content-Type": "text/plain"})
                return
            route.fulfill(status=200, body=thumbnail_png, headers={"Content-Type": "image/png", "Cache-Control": "no-store"})

        page.route("https://i.ytimg.com/**", fulfill_thumbnail)
        page.set_content(html, wait_until="load")
        page.evaluate(
            "window.__CACATOOLS_THUMBNAIL_TEST__={cacheHits:0,cacheMisses:0,loads:0,failures:0,fallbacks:0};"
            "window.__CACATOOLS_THUMBNAIL_LOADS=0;"
            "document.addEventListener('load',(event)=>{if(event.target instanceof HTMLImageElement && event.target.matches('[data-dm-thumbnail]')) window.__CACATOOLS_THUMBNAIL_LOADS += 1;},true);"
        )
        page.add_script_tag(content=browser_bundle())
        render_samples: dict[str, float] = {}
        for size in (50, 100, 500, 1000):
            result = page.evaluate(
                """(size) => {
                  const jobs=Array.from({length:size},(_,i)=>({
                    id:i+1,title:`video-${i+1}.mp4`,detail:'Descargando',status:i<4?'running':'queued',
                    progress:i<4?25:0,downloaded_bytes:i<4?25_000_000:0,total_bytes:100_000_000,
                    speed_bps:i<4?2_000_000:0,eta_seconds:i<4?38:null,kind:'video',engine:'yt-dlp',
                    category:'Vídeo',origin:'yt-dlp',thumbnail:`https://i.ytimg.com/vi/${i}/hqdefault.jpg`,
                    updated_at:'2026-08-06T20:00:00Z'}));
                  jobs.forEach((job) => { job.status='completed'; job.detail='Completed'; job.category='Video'; job.progress=100; job.downloaded_bytes=100_000_000; job.speed_bps=0; job.eta_seconds=null; });
                  const context={snapshot:{jobs,playlist_batches:[]},pendingJobs:[],invoke:async()=>null,
                    runtimeStatus:{mode:'local'},mediaRuntimeStatus:{},downloadDirectory:'C:\\Downloads',schedules:[],
                    onNewDownload:()=>{},onAnalyzeSource:async()=>{},onRefresh:async()=>{},onToast:()=>{},onSection:()=>{},onRerender:()=>{}};
                  const started=performance.now();
                  document.querySelector('#fixture').innerHTML=renderDownloadManager(context);
                  bindDownloadManager(context);
                  const scroll=document.querySelector('.dm-download-scroll');
                  return {ms:performance.now()-started,rows:document.querySelectorAll('.dm-download-item').length,
                    virtual:Boolean(scroll?.dataset.dmVirtualList),total:Number(scroll?.dataset.dmVirtualTotal||size),
                    start:Number(scroll?.dataset.dmVirtualStart||0),end:Number(scroll?.dataset.dmVirtualEnd||size),section:loadDownloadManagerPreferences().section};
                }""",
                size,
            )
            render_samples[str(size)] = round(float(result["ms"]), 3)
            expected_virtual = size > 160
            check(f"Renderiza {size} filas", int(result["total"]) == size, result)
            check(f"VirtualizaciÃ³n selectiva para {size}", bool(result["virtual"]) == expected_virtual, result)
            if expected_virtual:
                check(f"Mantiene una ventana acotada para {size}", int(result["rows"]) < size and int(result["end"]) - int(result["start"]) == int(result["rows"]), result)
            else:
                check(f"Conserva el DOM completo para {size}", int(result["rows"]) == size, result)

        def wait_for_thumbnails() -> None:
            page.wait_for_timeout(700)

        def thumbnail_fixture(source: str, count: int = 3) -> list[dict[str, Any]]:
            return page.evaluate(
                """([source,count])=>Array.from({length:count},(_,i)=>({
                  id:900000+i,title:`thumb-${i}.mp4`,detail:'Completed',status:'completed',progress:100,
                  downloaded_bytes:1000000,total_bytes:1000000,speed_bps:0,eta_seconds:null,kind:'video',
                  engine:'yt-dlp',category:'Video',origin:'yt-dlp',thumbnail:source,updated_at:'2026-08-06T20:00:00Z'}))""",
                [source, count],
            )

        def render_thumbnail_fixture(jobs: list[dict[str, Any]]) -> None:
            page.evaluate(
                """(jobs)=>{const context={snapshot:{jobs,playlist_batches:[]},pendingJobs:[],invoke:async()=>null,
                  runtimeStatus:{mode:'local'},mediaRuntimeStatus:{},downloadDirectory:'C:\\Downloads',schedules:[],
                  onNewDownload:()=>{},onAnalyzeSource:async()=>{},onRefresh:async()=>{},onToast:()=>{},onSection:()=>{},onRerender:()=>{}};
                  document.querySelector('#fixture').innerHTML=renderDownloadManager(context);bindDownloadManager(context);}""",
                jobs,
            )

        # Drain visible thumbnails from the preceding list fixture before
        # measuring the duplicate-URL case; otherwise late network completions
        # are attributed to the next fixture.
        wait_for_thumbnails()
        before_requests = len(thumbnail_requests)
        before_loads = int(page.evaluate("window.__CACATOOLS_THUMBNAIL_LOADS || 0"))
        render_thumbnail_fixture(thumbnail_fixture("https://i.ytimg.com/vi/duplicate-115/mqdefault.jpg"))
        wait_for_thumbnails()
        duplicate = {
            "requests": len(thumbnail_requests) - before_requests,
            "loads": int(page.evaluate("window.__CACATOOLS_THUMBNAIL_LOADS || 0")) - before_loads,
            "urls": thumbnail_requests[before_requests:],
            "stats": page.evaluate("window.__CACATOOLS_THUMBNAIL_TEST__.stats"),
        }
        check("Deduplica tres filas con la misma URL", duplicate["requests"] == 1, duplicate)

        before_requests = len(thumbnail_requests)
        render_thumbnail_fixture(thumbnail_fixture("https://i.ytimg.com/vi/duplicate-115/mqdefault.jpg"))
        wait_for_thumbnails()
        cache_hit = {
            "requests": len(thumbnail_requests) - before_requests,
            "stats": page.evaluate("window.__CACATOOLS_THUMBNAIL_TEST__.stats"),
        }
        check("Reinsertar una fila usa el resultado cacheado", cache_hit["requests"] == 0, cache_hit)

        before_requests = len(thumbnail_requests)
        render_thumbnail_fixture(thumbnail_fixture("https://i.ytimg.com/vi/broken-primary/hqdefault.jpg", 1))
        wait_for_thumbnails()
        fallback = {
            "requests": thumbnail_requests[before_requests:],
            "image": page.evaluate("document.querySelector('[data-dm-thumbnail]')?.currentSrc || document.querySelector('[data-dm-thumbnail]')?.src || ''"),
            "stats": page.evaluate("window.__CACATOOLS_THUMBNAIL_TEST__.stats"),
        }
        check("Fallback de miniatura no entra en bucle", len(fallback["requests"]) == 2 and "hqdefault.jpg" in fallback["image"], fallback)

        render_thumbnail_fixture(thumbnail_fixture("https://i.ytimg.com/vi/url-a-115/hqdefault.jpg", 1))
        wait_for_thumbnails()
        render_thumbnail_fixture(thumbnail_fixture("https://i.ytimg.com/vi/url-b-115/hqdefault.jpg", 1))
        wait_for_thumbnails()
        url_change = page.evaluate("document.querySelector('[data-dm-thumbnail]')?.currentSrc || document.querySelector('[data-dm-thumbnail]')?.src || ''")
        check("Cambio real de URL muestra la miniatura nueva", "url-b-115" in url_change, url_change)

        race = page.evaluate(
            """()=>{const image=document.createElement('img');image.dataset.dmThumbnail='';image.dataset.dmThumbnailSrc='https://i.ytimg.com/vi/race-a-115/mqdefault.jpg';
              document.querySelector('#fixture').append(image);window.__CACATOOLS_THUMBNAIL_TEST__.requestThumbnail(image,image.dataset.dmThumbnailSrc);
              image.dataset.dmThumbnailSrc='https://i.ytimg.com/vi/race-b-115/mqdefault.jpg';image.dataset.dmThumbnailKey=image.dataset.dmThumbnailSrc;return image;}"""
        )
        wait_for_thumbnails()
        race_result = page.evaluate("document.querySelector('#fixture > img')?.currentSrc || document.querySelector('#fixture > img')?.src || ''")
        check("Carrera de fila reciclada no aplica A sobre B", "race-a-115" not in race_result, {"created": race, "current": race_result})

        eviction = page.evaluate(
            """()=>{for(let i=0;i<160;i++){const image=document.createElement('img');image.dataset.dmThumbnail='';image.dataset.dmThumbnailSrc=`https://i.ytimg.com/vi/evict-${i}-115/mqdefault.jpg`;document.querySelector('#fixture').append(image);window.__CACATOOLS_THUMBNAIL_TEST__.requestThumbnail(image,image.dataset.dmThumbnailSrc);}return true;}"""
        )
        wait_for_thumbnails()
        eviction_stats = page.evaluate("window.__CACATOOLS_THUMBNAIL_TEST__.stats")
        check("La caché LRU permanece limitada", int(eviction_stats.get("cacheEntries", 999)) <= 128, eviction_stats)
        thumbnail_metrics = {
            "duplicate": duplicate,
            "cache_hit": cache_hit,
            "fallback": fallback,
            "url_change": url_change,
            "race": race_result,
            "eviction": eviction_stats,
            "requests_total": len(thumbnail_requests),
            "loads_total": int(page.evaluate("window.__CACATOOLS_THUMBNAIL_LOADS || 0")),
            "memory_api": page.evaluate("performance.memory ? {used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize} : null"),
        }

        live = page.evaluate(
            """async () => {
              const jobs=Array.from({length:1000},(_,i)=>({id:i+1,title:`video-${i+1}.mp4`,detail:'Descargando',status:i<4?'running':'queued',progress:i<4?25:0,downloaded_bytes:i<4?25_000_000:0,total_bytes:100_000_000,speed_bps:i<4?2_000_000:0,eta_seconds:i<4?38:null,kind:'video',engine:'yt-dlp',category:'Vídeo',origin:'yt-dlp',thumbnail:`https://i.ytimg.com/vi/${i}/hqdefault.jpg`,updated_at:'2026-08-06T20:00:00Z'}));
              jobs.forEach((job) => { job.status='completed'; job.detail='Completed'; job.category='Video'; job.progress=100; job.downloaded_bytes=100_000_000; job.speed_bps=0; job.eta_seconds=null; });
              const context={snapshot:{jobs,playlist_batches:[]},pendingJobs:[],invoke:async()=>null,runtimeStatus:{mode:'local'},mediaRuntimeStatus:{},downloadDirectory:'C:\\Downloads',schedules:[],onNewDownload:()=>{},onAnalyzeSource:async()=>{},onRefresh:async()=>{},onToast:()=>{},onSection:()=>{},onRerender:()=>{}};
              context.onRerender=()=>{ document.querySelector('#fixture').innerHTML=renderDownloadManager(context); bindDownloadManager(context); };
              document.querySelector('#fixture').innerHTML=renderDownloadManager(context);bindDownloadManager(context);
              const scroll=document.querySelector('.dm-download-scroll');
              const first=document.querySelector('[data-dm-select-job="1000"]');
              if(!scroll || !first) return {updates:0,totalMs:0,avgMs:999,maxMs:999,rowNodePreserved:false,thumbnailNodePreserved:false,scrollTop:0,heapBefore:0,heapAfter:0,heapDelta:0,mountedRows:document.querySelectorAll('.dm-download-item').length,virtual:Boolean(scroll?.dataset.dmVirtualList),debug:{section:loadDownloadManagerPreferences().section,scroll:Boolean(scroll),rows:document.querySelectorAll('.dm-download-item').length,ids:Array.from(document.querySelectorAll('[data-dm-select-job]')).slice(0,20).map((row)=>row.dataset.dmSelectJob)}};
              const image=first.querySelector('img');
              const heapBefore=performance.memory?.usedJSHeapSize||0;
              const samples=[];
              for(let n=0;n<40;n++){
                const job=jobs[999];job.progress=25+n*1.5;job.downloaded_bytes=Math.round(job.total_bytes*job.progress/100);job.speed_bps=2_000_000+n*1000;job.eta_seconds=40-n;
                const started=performance.now();patchDownloadManagerLive(context);samples.push(performance.now()-started);
              }
              const next=document.querySelector('[data-dm-select-job="1000"]');
              const heapAfter=performance.memory?.usedJSHeapSize||0;
              scroll.scrollTop=640;
              const scrollPreserved=scroll.scrollTop;
              const frame=()=>new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
              const virtualChecks={};
              scroll.scrollTop=Math.round(scroll.scrollHeight*0.5); scroll.dispatchEvent(new Event('scroll')); await frame();
              virtualChecks.prePatchScroll=scroll.scrollTop;
              jobs[999].detail='Offscreen changed';
              patchDownloadManagerLive({...context,changedJobIds:new Set(['1000'])});
              virtualChecks.offscreenOmitted=!document.querySelector('[data-dm-select-job="1000"]');
              scroll.scrollTop=0; scroll.dispatchEvent(new Event('scroll')); await frame();
              virtualChecks.offscreenDeltaApplied=document.querySelector('[data-dm-select-job="1000"]')?.textContent.includes('Offscreen changed') || false;
              scroll.scrollTop=Math.round(scroll.scrollHeight*0.5); scroll.dispatchEvent(new Event('scroll')); await frame();
              const middleRow=document.querySelector('[data-dm-select-job="500"]');
              virtualChecks.middleRowMounted=Boolean(middleRow);
              virtualChecks.middleRange={scrollTop:scroll.scrollTop,start:scroll.dataset.dmVirtualStart,end:scroll.dataset.dmVirtualEnd,scrollHeight:scroll.scrollHeight,clientHeight:scroll.clientHeight,ids:Array.from(document.querySelectorAll('[data-dm-select-job]')).slice(0,3).map((row)=>row.dataset.dmSelectJob)};
              middleRow?.focus();
              scroll.scrollTop=Math.round(scroll.scrollHeight*0.82); scroll.dispatchEvent(new Event('scroll')); await frame();
              virtualChecks.focusReturnsToScroll=document.activeElement===scroll;
              scroll.scrollTop=Math.round(scroll.scrollHeight*0.5); scroll.dispatchEvent(new Event('scroll')); await frame();
              virtualChecks.middleRowRestored=Boolean(document.querySelector('[data-dm-select-job="500"]'));
              const selectionToggle=document.querySelector('[data-dm-selection-toggle]');
              selectionToggle?.click();
              await frame();
              const selectionInput=document.querySelector('[data-dm-select-checkbox="500"]');
              virtualChecks.selectionControls={toggle:Boolean(selectionToggle),inputBefore:Boolean(selectionInput),rows:Array.from(document.querySelectorAll('[data-dm-select-job]')).slice(0,3).map((row)=>row.dataset.dmSelectJob)};
              if (selectionInput) { selectionInput.checked=true; selectionInput.dispatchEvent(new Event('change',{bubbles:true})); }
              const postSelectionScroll=document.querySelector('.dm-download-scroll');
              virtualChecks.selectionControlsAfter={modeTools:Boolean(document.querySelector('[data-dm-select-all-visible]')),input:Boolean(document.querySelector('[data-dm-select-checkbox="500"]')),checked:Boolean(document.querySelector('[data-dm-select-checkbox="500"]')?.checked),row:Boolean(document.querySelector('[data-dm-select-job="500"]')),selectedRow:Boolean(document.querySelector('[data-dm-select-job="500"].is-batch-selected')),scrollTop:postSelectionScroll?.scrollTop,start:postSelectionScroll?.dataset.dmVirtualStart,end:postSelectionScroll?.dataset.dmVirtualEnd};
              virtualChecks.selectionById=Boolean(document.querySelector('[data-dm-select-job="500"].is-batch-selected'));
              jobs.push({id:1001,title:'new-video.mp4',detail:'Completed',status:'completed',progress:100,downloaded_bytes:100_000_000,total_bytes:100_000_000,speed_bps:0,eta_seconds:null,kind:'video',engine:'yt-dlp',category:'Video',origin:'yt-dlp',thumbnail:'',updated_at:'2026-08-06T20:00:00Z'});
              patchDownloadManagerLive(context);
              virtualChecks.newItemTotal=document.querySelector('.dm-download-scroll')?.dataset.dmVirtualTotal==='1001';
              jobs.pop(); patchDownloadManagerLive(context);
              virtualChecks.deletedItemTotal=document.querySelector('.dm-download-scroll')?.dataset.dmVirtualTotal==='1000';
              return {updates:samples.length,totalMs:samples.reduce((a,b)=>a+b,0),avgMs:samples.reduce((a,b)=>a+b,0)/samples.length,maxMs:Math.max(...samples),rowNodePreserved:first===next,thumbnailNodePreserved:image===next.querySelector('img'),scrollTop:scrollPreserved,heapBefore,heapAfter,heapDelta:heapAfter-heapBefore,mountedRows:document.querySelectorAll('.dm-download-item').length,virtual:document.querySelector('.dm-download-scroll')?.dataset.dmVirtualList==='1',virtualChecks};
            }"""
        )
        browser.close()

    live = {key: round(value, 4) if isinstance(value, float) else value for key, value in live.items()}
    heap_reduction = (1 - max(0, live["heapDelta"]) / BASELINE["heap_delta_bytes"]) * 100
    comparison = {
        "average_ms_reduction_percent": round((1 - live["avgMs"] / BASELINE["live_average_ms"]) * 100, 2),
        "heap_growth_reduction_percent": round(max(0, min(100, heap_reduction)), 2),
        "heap_delta_bytes_after": live["heapDelta"],
    }
    check("Actualización de una fila mantiene su nodo", live["rowNodePreserved"], live)
    check("Actualización de una fila mantiene la miniatura", live["thumbnailNodePreserved"], live)
    check("Actualización de una fila mantiene el scroll", live["scrollTop"] == 640, live)
    check("Promedio de actualización de 1,000 filas menor de 40 ms", live["avgMs"] < 40, live)
    check("Mejora medida frente a la línea base", comparison["average_ms_reduction_percent"] >= 70, comparison)
    check("Long list uses virtualization", live["virtual"] and live["mountedRows"] < 1000, live)
    for metric in ("offscreenOmitted", "offscreenDeltaApplied", "middleRowMounted", "focusReturnsToScroll", "middleRowRestored", "selectionById", "newItemTotal", "deletedItemTotal"):
        check(f"Virtual list {metric}", bool(live.get("virtualChecks", {}).get(metric)), live.get("virtualChecks", {}))
    check("Render de 1,000 filas dentro del presupuesto", render_samples["1000"] < 1000, render_samples)

    report = {
        "phase": "0.24.2-phase4-performance",
        "baseline": BASELINE,
        "after": {"render_ms": render_samples, "live_patch": live},
        "thumbnails": thumbnail_metrics,
        "comparison": comparison,
        "checks": checks,
        "passed": all(item["pass"] for item in checks),
        "limitations": [
            "Mide Chromium headless en Linux; inicio nativo, CPU/RAM de procesos externos y Tauri requieren Windows.",
            "Las cifras absolutas dependen del equipo; la comparación usa la misma fixture y el mismo navegador.",
        ],
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if not report["passed"]:
        for item in checks:
            if not item["pass"]:
                print(f"FAIL: {item['name']} · {item['detail']}")
        return 1
    print(
        "OK: rendimiento Fase 4 · "
        f"actualización media {live['avgMs']:.2f} ms · "
        f"reducción {comparison['average_ms_reduction_percent']:.2f}% · "
        f"render 1,000 filas {render_samples['1000']:.2f} ms"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
