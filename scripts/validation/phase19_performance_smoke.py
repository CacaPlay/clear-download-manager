#!/usr/bin/env python3
"""Performance and compact-layout gate for the Phase 19 download manager."""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright

from phase16_hashing import source_fingerprint

ROOT = Path(__file__).resolve().parents[2]
REPORT = ROOT / "docs" / "tests" / "phase19-performance-smoke.json"
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


def browser_executable() -> str | None:
    configured = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE", "").strip()
    if configured:
        return configured
    if os.name == "nt":
        for candidate in (
            os.environ.get("PROGRAMFILES", "") + r"\BraveSoftware\Brave-Browser\Application\brave.exe",
            os.environ.get("LOCALAPPDATA", "") + r"\BraveSoftware\Brave-Browser\Application\brave.exe",
            os.environ.get("PROGRAMFILES", "") + r"\Google\Chrome\Application\chrome.exe",
            os.environ.get("LOCALAPPDATA", "") + r"\Google\Chrome\Application\chrome.exe",
            os.environ.get("PROGRAMFILES", "") + r"\Microsoft\Edge\Application\msedge.exe",
        ):
            if candidate and Path(candidate).exists():
                return candidate
    if Path("/usr/bin/chromium").exists():
        return "/usr/bin/chromium"
    return None


def browser_bundle() -> str:
    parts: list[str] = []
    for relative in MODULES:
        source = (ROOT / relative).read_text(encoding="utf-8")
        source = re.sub(r"^import\s+[^;]+;\s*$", "", source, flags=re.MULTILINE)
        source = re.sub(r"\bexport\s+(?=(?:const|let|var|function|class)\b)", "", source)
        source = re.sub(r"\bexport\s*\{[^}]*\};?", "", source, flags=re.DOTALL)
        parts.append(f"\n/* {relative} */\n{source}\n")
    return "".join(parts)


BOOTSTRAP = r"""
const statuses = ['running', 'queued', 'paused', 'failed', 'completed', 'cancelled'];
const categories = ['Vídeo', 'Software', 'Documentos', 'Música', 'S.O.', 'Archivos'];
const jobs = Array.from({ length: 1000 }, (_, index) => {
  const number = index + 1;
  const status = statuses[index % statuses.length];
  const running = status === 'running';
  const total = 25_000_000 + (index * 31_337);
  const progress = status === 'completed' ? 100 : status === 'cancelled' ? 0 : (index * 17) % 99;
  return {
    id: number,
    title: `archivo-${String(number).padStart(4, '0')}-${index % 5 === 0 ? 'video' : 'paquete'}.${index % 5 === 0 ? 'mp4' : 'zip'}`,
    detail: `Elemento de rendimiento ${number}`,
    status,
    progress,
    downloaded_bytes: Math.round(total * progress / 100),
    total_bytes: total,
    speed_bps: running ? 1_500_000 + (index % 20) * 120_000 : 0,
    eta_seconds: running ? 15 + (index % 420) : 0,
    kind: index % 5 === 0 ? 'media' : 'file',
    engine: index % 5 === 0 ? 'yt-dlp' : 'aria2c',
    category: categories[index % categories.length],
    origin: index % 5 === 0 ? 'yt-dlp' : 'HTTP',
    source_url: `https://downloads.example.test/files/${number}`,
    destination: `C:\\Downloads\\CacaTools\\archivo-${number}`,
    updated_at: new Date(Date.UTC(2026, 6, 31, 16, 0, index % 60)).toISOString(),
    active_connections: running ? 8 : 0,
    max_connections: running ? 16 : 0
  };
});
const phase17Context = {
  snapshot: { jobs, playlist_batches: [] },
  pendingJobs: [],
  invoke: async (command, args) => {
    if (command === 'search_media_by_title') {
      await new Promise((resolve) => setTimeout(resolve, 650));
      const query = String(args?.query || '');
      return [{ source_url: 'https://www.youtube.com/watch?v=remote', title: `${query} — resultado remoto`, creator: 'CacaTools', duration_label: '3:14', thumbnail: '', similarity: 96 }];
    }
    return null;
  },
  runtimeStatus: { mode: 'local', aria2_available: true, media_available: true },
  mediaRuntimeStatus: { yt_dlp: 'yt-dlp.exe', ffmpeg: 'ffmpeg.exe', ffprobe: 'ffprobe.exe' },
  downloadDirectory: 'C:\\Downloads\\CacaTools',
  schedules: [],
  onNewDownload: () => {},
  onAnalyzeSource: async () => {},
  onUnifiedSuggestions: async () => [],
  onRefresh: async () => {},
  onToast: () => {},
  onSection: () => {},
  onRerender: () => mountPhase17()
};
function mountPhase17() {
  const started = performance.now();
  const fixture = document.querySelector('#fixture');
  fixture.innerHTML = renderDownloadManager(phase17Context);
  bindDownloadManager(phase17Context);
  window.__phase17LastMountMs = performance.now() - started;
  window.__phase17MountCount = (window.__phase17MountCount || 0) + 1;
}
const initialStarted = performance.now();
mountPhase17();
window.__phase17InitialMs = performance.now() - initialStarted;
window.__phase17Ready = true;
"""


def main() -> int:
    checks: list[dict[str, Any]] = []

    def check(name: str, condition: bool, detail: Any = None) -> None:
        checks.append({"name": name, "pass": bool(condition), "detail": detail})

    css = (ROOT / "app-ui/download-manager/styles.css").read_text(encoding="utf-8")
    html = (
        '<!doctype html><html lang="es"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f'<style>html,body,#fixture{{width:100%;height:100%;margin:0;overflow:hidden;background:#070b10}}{css}</style>'
        '</head><body><main id="fixture"></main></body></html>'
    )

    with sync_playwright() as playwright:
        launch_options: dict[str, Any] = {
            "headless": True,
            "args": ["--no-sandbox", "--disable-dev-shm-usage"],
        }
        executable = browser_executable()
        if executable:
            launch_options["executable_path"] = executable
        browser = playwright.chromium.launch(**launch_options)
        page = browser.new_page(viewport={"width": 1920, "height": 1080})
        page_errors: list[str] = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.set_content(html, wait_until="load")
        page.add_script_tag(content=browser_bundle() + BOOTSTRAP)
        page.wait_for_function("window.__phase17Ready === true")

        initial_ms = float(page.evaluate("window.__phase17InitialMs"))
        row_count = page.locator(".dm-download-item").count()
        content_visibility = page.locator(".dm-download-item").first.evaluate(
            "node => getComputedStyle(node).contentVisibility"
        )
        desktop_overflow = page.evaluate(
            "document.documentElement.scrollWidth - document.documentElement.clientWidth"
        )
        check("Zen Sidebar es el layout predeterminado", page.locator(".dm-host").get_attribute("data-dm-layout") == "zen-sidebar", page.locator(".dm-host").get_attribute("data-dm-layout"))
        check("Renderiza una cola de 1,000 trabajos", row_count == 1000, row_count)
        check("Render inicial dentro del presupuesto", initial_ms < 2800, round(initial_ms, 2))
        check("Filas fuera de pantalla usan content-visibility", content_visibility == "auto", content_visibility)
        check("Sin desbordamiento horizontal de documento en 1920x1080", desktop_overflow <= 2, desktop_overflow)

        filter_started = float(page.evaluate("performance.now()"))
        page.locator('[data-dm-section="running"]').click()
        page.wait_for_function("document.querySelector('[data-dm-section=\\\"running\\\"]').classList.contains('is-active')")
        page.wait_for_timeout(120)
        filter_ms = float(page.evaluate("performance.now()")) - filter_started
        filtered_rows = page.locator(".dm-download-item").count()
        check("La sección de estado filtra la cola real de 1,000 trabajos", 330 <= filtered_rows <= 340, filtered_rows)
        check("Filtrado completo dentro del presupuesto", filter_ms < 1200, round(filter_ms, 2))

        unified = page.locator("[data-dm-unified-input]")
        unified.focus()
        page.evaluate("window.__phase19UnifiedNode = document.querySelector('[data-dm-unified-input]')")
        suggestion_started = float(page.evaluate("performance.now()"))
        unified.fill("minim")
        page.wait_for_timeout(360)
        unified.type("alistas", delay=20)
        page.wait_for_function("document.querySelectorAll('.dm-unified-suggestions > button').length >= 4")
        page.wait_for_timeout(760)
        suggestion_ms = float(page.evaluate("performance.now()")) - suggestion_started
        search_state = page.evaluate("""() => {
          const input=document.querySelector('[data-dm-unified-input]');
          const wrap=input.closest('.dm-unified-input-wrap');
          return { same:input===window.__phase19UnifiedNode, focused:document.activeElement===input, value:input.value, inputBorder:getComputedStyle(input).borderTopWidth, wrapperBorder:getComputedStyle(wrap).borderTopWidth };
        }""")
        check("Sugerencias locales responden", page.locator(".dm-unified-suggestions > button").count() >= 4)
        check("Sugerencias locales y remotas dentro del presupuesto", suggestion_ms < 1900, round(suggestion_ms, 2))
        check("La búsqueda remota no reemplaza ni bloquea el input", search_state["same"] and search_state["focused"] and search_state["value"] == "minimalistas", search_state)
        check("El buscador dibuja un solo borde", search_state["inputBorder"] == "0px" and search_state["wrapperBorder"] != "0px", search_state)
        icon_width = float(page.locator('.dm-zen-nav nav button svg').first.evaluate('node=>node.getBoundingClientRect().width'))
        check("Iconos laterales ampliados", icon_width >= 23, icon_width)

        page.locator("[data-dm-open-settings]").first.click()
        check(
            "Ajustes conserva Zen Sidebar como único layout",
            page.locator('.dm-host').get_attribute('data-dm-layout') == 'zen-sidebar'
            and page.locator('[data-dm-setting="layout"]').count() == 0,
            {
                "layout": page.locator('.dm-host').get_attribute('data-dm-layout'),
                "layoutSelectors": page.locator('[data-dm-setting="layout"]').count(),
            },
        )

        close_settings = page.locator('[data-dm-settings-close]')
        if close_settings.count():
            close_settings.click()
        page.set_viewport_size({"width": 800, "height": 620})
        page.wait_for_timeout(120)
        compact_overflow = page.evaluate(
            "document.documentElement.scrollWidth - document.documentElement.clientWidth"
        )
        compact_offenders = page.evaluate(
            """() => [...document.querySelectorAll('button,input,select')]
              .filter((node) => {
                const rect = node.getBoundingClientRect();
                const style = getComputedStyle(node);
                const hiddenPanel = Boolean(node.closest('.dm-zen-nav,.dm-inspector'));
                const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
                const intersects = rect.right > 0 && rect.left < innerWidth && rect.bottom > 0 && rect.top < innerHeight;
                return !hiddenPanel && visible && intersects && (rect.left < -1 || rect.right > innerWidth + 1);
              }).map((node) => ({ text:(node.textContent || node.getAttribute('aria-label') || '').trim().slice(0,80), className:node.className || '' }))"""
        )
        check("Sin desbordamiento horizontal de documento en 800x620", compact_overflow <= 2, compact_overflow)
        check("Controles compactos permanecen alcanzables", not compact_offenders, compact_offenders)

        sidebar_rect = page.locator(".dm-zen-nav").evaluate(
            "node => { const r=node.getBoundingClientRect(); return {left:r.left,right:r.right,width:r.width}; }"
        )
        mobile_menu_visible = page.locator(".dm-mobile-menu").evaluate(
            "node => { const r=node.getBoundingClientRect(); const s=getComputedStyle(node); return s.display !== 'none' && r.width > 0 && r.height > 0; }"
        )
        check(
            "La barra lateral aprobada permanece fija en 800x620",
            sidebar_rect["left"] >= -1 and 70 <= sidebar_rect["width"] <= 90 and sidebar_rect["right"] <= 91,
            sidebar_rect,
        )
        check("No aparece un botón móvil que sustituya la barra lateral", not mobile_menu_visible, mobile_menu_visible)

        inspector = page.locator(".dm-inspector")
        if inspector.count():
            inspector_rect = inspector.evaluate(
                "node => { const r=node.getBoundingClientRect(); return {left:r.left,right:r.right,width:r.width}; }"
            )
            check(
                "El inspector no provoca desbordamiento en la ventana mínima",
                inspector_rect["left"] >= -1 and inspector_rect["right"] <= 801,
                inspector_rect,
            )
        check("Sin errores JavaScript", not page_errors, page_errors)
        browser.close()

    source_files, source_hash = source_fingerprint([
        Path(__file__),
        ROOT / "scripts/validation/phase16_hashing.py",
        *(ROOT / relative for relative in MODULES),
        ROOT / "app-ui/download-manager/styles.css",
    ])
    report = {
        "gate": "phase19-performance-smoke",
        "passed": all(item["pass"] for item in checks),
        "sourceFiles": source_files,
        "sourceHash": source_hash,
        "queueSize": 1000,
        "thresholdsMs": {"initialRender": 2800, "filter": 1200, "suggestions": 1900},
        "measurementsMs": {
            "initialRender": round(initial_ms, 2),
            "filter": round(filter_ms, 2),
            "suggestions": round(suggestion_ms, 2),
        },
        "checks": checks,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    failed = [item for item in checks if not item["pass"]]
    if failed:
        for item in failed:
            print(f"FAIL: {item['name']} -> {item.get('detail')}")
        return 1
    print(
        "OK: Phase 19 con 1,000 trabajos "
        f"(render {initial_ms:.1f} ms, filtro {filter_ms:.1f} ms, sugerencias {suggestion_ms:.1f} ms)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
