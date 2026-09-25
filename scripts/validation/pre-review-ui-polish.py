#!/usr/bin/env python3
from __future__ import annotations

import contextlib
import http.server
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "output" / "feature06-pre-review-ui"
OUTPUT.mkdir(parents=True, exist_ok=True)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args: object) -> None:
        pass


def static_lifecycle_failures() -> list[str]:
    rust = (ROOT / "src-tauri/src/subwindows.rs").read_text(encoding="utf-8")
    commands = (ROOT / "src-tauri/src/commands/subwindows.rs").read_text(encoding="utf-8")
    main = (ROOT / "app-ui/main.js").read_text(encoding="utf-8")
    failures: list[str] = []
    for label in ("media-prep", "playlist-prep", "http-prep"):
        if label not in rust or label not in main:
            failures.append(f"Falta la autoridad visual/lifecycle de {label}")
    for token in (
        "HashSet<String>",
        "cacatools-preparation-modal-state",
        "WindowEvent::CloseRequested",
        "WindowEvent::Destroyed",
        "restore_main_if_no_preparation",
    ):
        if token not in rust:
            failures.append(f"Falta lifecycle token: {token}")
    if "preparation_modal_state" not in commands or "preparation_modal_state" not in main:
        failures.append("Main reload no puede recuperar el snapshot modal")
    if "setInterval" in rust or "Focused(" in rust[rust.find("ACTIVE_PREPARATION_LABELS") :]:
        failures.append("El dimming no debe depender de polling ni focus/blur")
    return failures


handler = lambda *args, **kwargs: QuietHandler(*args, directory=str(ROOT), **kwargs)
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
port = server.server_address[1]
results: list[dict[str, object]] = []


def svg_data(color: str, label: str) -> str:
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">'
        f'<rect width="320" height="180" fill="{color}"/>'
        f'<text x="160" y="100" text-anchor="middle" fill="white" font-size="42">{label}</text>'
        "</svg>"
    )
    from urllib.parse import quote

    return "data:image/svg+xml," + quote(svg)


try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1180, "height": 780}, reduced_motion="reduce")
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(f"http://127.0.0.1:{port}/?preview=1&view=downloads", wait_until="networkidle")
        page.wait_for_function("typeof window.__cacatoolsSetPreparationModalState === 'function'")

        dimming = page.evaluate(
            """() => {
              const setState = window.__cacatoolsSetPreparationModalState;
              const host = document.querySelector('.dm-host');
              const rect = () => { const value = host.getBoundingClientRect(); return [value.x, value.y, value.width, value.height]; };
              const before = rect();
              setState(['media-prep']);
              const one = { count: document.body.dataset.preparationModalCount, className: document.body.className, style: getComputedStyle(document.body, '::after') };
              const oneStyle = { opacity: one.style.opacity, pointerEvents: one.style.pointerEvents, visibility: one.style.visibility };
              setState(['media-prep', 'playlist-prep', 'media-prep']);
              const twoCount = document.body.dataset.preparationModalCount;
              setState(['playlist-prep']);
              const afterOneClose = { count: document.body.dataset.preparationModalCount, active: document.body.classList.contains('has-preparation-modal') };
              setState([]);
              const clear = { count: document.body.dataset.preparationModalCount, active: document.body.classList.contains('has-preparation-modal') };
              return { before, after: rect(), oneStyle, twoCount, afterOneClose, clear, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
            }"""
        )
        if dimming["oneStyle"] != {"opacity": "0.2", "pointerEvents": "none", "visibility": "visible"}:
            errors.append(f"Overlay inesperado: {dimming['oneStyle']}")
        if dimming["twoCount"] != "2" or dimming["afterOneClose"] != {"count": "1", "active": True}:
            errors.append("El estado multi-window no conserva el dim al cerrar una de dos")
        if dimming["clear"] != {"count": "0", "active": False}:
            errors.append("El último cierre dejó overlay stale")
        if dimming["before"] != dimming["after"] or dimming["overflow"] > 1:
            errors.append("El overlay produjo layout shift u overflow")
        page.evaluate("window.postMessage({type:'cacatools:theme-request', theme:'light'}, '*')")
        page.wait_for_timeout(80)
        page.evaluate("window.__cacatoolsSetPreparationModalState(['http-prep'])")
        page.screenshot(path=str(OUTPUT / "main-light-http-dim.png"), animations="disabled")
        page.evaluate("window.postMessage({type:'cacatools:theme-request', theme:'dark'}, '*')")
        page.evaluate("window.__cacatoolsSetPreparationModalState(['playlist-prep'])")
        page.screenshot(path=str(OUTPUT / "main-dark-playlist-dim.png"), animations="disabled")
        page.evaluate("window.__cacatoolsSetPreparationModalState([])")
        results.append({"case": "main-dimming", "pass": not errors, "errors": errors, "metrics": dimming})

        colors = [svg_data("#2358a5", "A"), svg_data("#7b3fa1", "B"), svg_data("#247b55", "C")]
        for theme, accent, width, height in (
            ("dark", "#2f9bff", 1180, 780),
            ("light", "#8b5cf6", 1180, 780),
            ("dark", "#e69b32", 620, 700),
        ):
            page.set_viewport_size({"width": width, "height": height})
            case_errors: list[str] = []
            page_errors: list[str] = []
            page.on("pageerror", lambda error: page_errors.append(str(error)))
            metrics = page.evaluate(
                """async ({ theme, accent, colors }) => {
                  const module = await import('/app-ui/download-manager/index.js');
                  const mount = (batch) => {
                    const context = {
                      snapshot: { jobs: [], playlist_batches: [batch] }, pendingJobs: [], schedules: [],
                      runtimeStatus: { mode: 'local', aria2_available: true, media_available: true },
                      mediaRuntimeStatus: { yt_dlp: true, ffmpeg: true, ffprobe: true },
                      downloadDirectory: 'C:/Downloads', appearanceDensity: 'normal', previewMode: true,
                      appearance: { theme, accent, intensity: 88 }
                    };
                    document.querySelector('#app').innerHTML = module.renderDownloadManager(context);
                    module.bindDownloadManager(context);
                  };
                  const batch = (id, thumbnails, status = 'running') => ({
                    batch_id: id, title: `Playlist ${id}`, format: 'Audio', status,
                    total_items: 7, completed_items: status === 'completed' ? 7 : 1,
                    failed_items: status === 'failed' ? 1 : 0, active_items: status === 'running' ? 1 : 0,
                    progress: status === 'completed' ? 100 : 28, downloaded_bytes: 1000, total_bytes: 4000,
                    speed_bps: 100, destination: 'C:/Downloads', thumbnail_stack: thumbnails.join('\\u001f')
                  });
                  const inspect = () => {
                    const stack = document.querySelector('.dm-playlist-stack');
                    const parent = stack.getBoundingClientRect();
                    const layers = [...stack.querySelectorAll(':scope > i')].map((layer) => {
                      const rect = layer.getBoundingClientRect();
                      return {
                        src: layer.querySelector('img')?.dataset.originalThumbnail || '',
                        z: getComputedStyle(layer).zIndex,
                        inside: rect.left >= parent.left - .5 && rect.top >= parent.top - .5 && rect.right <= parent.right + .5 && rect.bottom <= parent.bottom + .5,
                        width: rect.width,
                        height: rect.height,
                        fallback: Boolean(layer.querySelector('.dm-thumbnail-fallback'))
                      };
                    });
                    return {
                      order: layers.map((layer) => layer.src),
                      layers,
                      hasTextLabel: Boolean(stack.querySelector('.dm-playlist-label')),
                      parent: { width: parent.width, height: parent.height },
                      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
                    };
                  };
                  mount(batch(61, [colors[0]]));
                  const first = inspect();
                  mount(batch(61, [colors[2], colors[1], colors[0]]));
                  const late = inspect();
                  mount(batch(61, [colors[1], colors[0], colors[2]], 'completed'));
                  const refreshed = inspect();
                  mount(batch(62, [], 'failed'));
                  const missing = inspect();
                  mount(batch(61, [colors[2], colors[0], colors[1]], 'completed'));
                  return { first, late, refreshed, missing };
                }""",
                {"theme": theme, "accent": accent, "colors": colors},
            )
            if metrics["first"]["order"][0] != colors[0] or metrics["late"]["order"][0] != colors[0] or metrics["refreshed"]["order"][0] != colors[0]:
                case_errors.append("La thumbnail frontal cambió durante carga tardía/refresh")
            if metrics["late"]["layers"][0]["z"] != "3" or not all(layer["inside"] for layer in metrics["late"]["layers"]):
                case_errors.append("Las capas no conservan orden o límites estables")
            if metrics["late"]["hasTextLabel"] or any(metrics[key]["hasTextLabel"] for key in ("first", "refreshed", "missing")):
                case_errors.append("La pila no debe superponer la etiqueta textual Playlist")
            if len(metrics["late"]["layers"]) == 3 and not (
                metrics["late"]["layers"][1]["width"] <= metrics["late"]["layers"][0]["width"] + .5
                and metrics["late"]["layers"][2]["width"] < metrics["late"]["layers"][1]["width"]
            ):
                case_errors.append("Las capas posteriores no exponen profundidad visual")
            if not all(layer["fallback"] for layer in metrics["late"]["layers"] if layer["src"]):
                case_errors.append("Una thumbnail cargable carece de fallback estable")
            if any(metrics[key]["overflow"] > 1 for key in ("first", "late", "refreshed", "missing")):
                case_errors.append("La pila produjo overflow horizontal")
            if len(metrics["missing"]["layers"]) != 3 or any(metrics["missing"]["order"]):
                case_errors.append("El placeholder sin thumbnails no es estable")
            if page_errors:
                case_errors.extend(f"JS: {error}" for error in page_errors)
            page.wait_for_timeout(80)
            page.screenshot(path=str(OUTPUT / f"playlist-stack-{theme}-{width}x{height}.png"), animations="disabled")
            results.append({"case": f"playlist-{theme}-{width}x{height}", "pass": not case_errors, "errors": case_errors, "metrics": metrics})
        page.close()
        browser.close()
finally:
    with contextlib.suppress(Exception):
        server.shutdown()
        server.server_close()

static_failures = static_lifecycle_failures()
if static_failures:
    results.append({"case": "lifecycle-static", "pass": False, "errors": static_failures})
else:
    results.append({"case": "lifecycle-static", "pass": True, "errors": []})

print(json.dumps(results, ensure_ascii=False, indent=2))
if not all(result["pass"] for result in results):
    raise SystemExit(1)
print("OK: Feature 06 dimming lifecycle and playlist thumbnail stack passed 5/5 deterministic visual/static cases.")
