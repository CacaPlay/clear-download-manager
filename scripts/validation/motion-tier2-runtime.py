#!/usr/bin/env python3
"""Runtime gate for Motion Tier 2 using the real preview DOM.

The gate deliberately exercises the keyed Download Manager patch path and the
theme fallback rather than treating CSS text as proof of behavior.
"""
from __future__ import annotations

import contextlib
import http.server
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[2]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args: object) -> None:
        pass


def main() -> int:
    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0),
        lambda *args, **kwargs: QuietHandler(*args, directory=str(ROOT), **kwargs),
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    failures: list[str] = []
    evidence: dict[str, object] = {}
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1180, "height": 780}, reduced_motion="no-preference")
            page.set_default_timeout(8_000)
            page.goto(f"http://127.0.0.1:{server.server_address[1]}/?preview=1&view=downloads", wait_until="domcontentloaded")
            page.wait_for_selector(".dm-download-item")

            active_nav = page.locator(".dm-zen-nav nav button.is-active").first
            active_before_box = active_nav.bounding_box()
            active_before = active_nav.evaluate("el => { const s = getComputedStyle(el, '::before'); return {opacity:s.opacity, transform:s.transform, width:el.getBoundingClientRect().width, height:el.getBoundingClientRect().height}; }")
            page.locator(".dm-zen-nav nav button").nth(1).click()
            page.wait_for_timeout(80)
            active_after = page.locator(".dm-zen-nav nav button.is-active").first
            active_after_box = active_after.bounding_box()
            active_after_style = active_after.evaluate("el => { const s = getComputedStyle(el, '::before'); return {opacity:s.opacity, transform:s.transform, width:el.getBoundingClientRect().width, height:el.getBoundingClientRect().height}; }")
            evidence["nav"] = {"before": {"box": active_before_box, **active_before}, "after": {"box": active_after_box, **active_after_style}}
            if active_after_style["opacity"] != "1":
                failures.append(f"superficie local nav no quedó visible: {evidence['nav']}")
            if active_after_style["width"] != 72 or active_after_style["height"] != 72:
                failures.append(f"hitbox nav dejó de ser 72x72: {evidence['nav']}")
            if page.locator(".dm-nav-selection-indicator").count():
                failures.append("se encontró un indicador compartido legacy en el DOM")

            # Return to downloads with the same functional click path.
            page.locator(".dm-zen-nav nav button").first.click()
            page.wait_for_selector(".dm-download-item")
            page.wait_for_function("typeof window.__cacatoolsMotionStateHarness?.setJobState === 'function'")

            # Button press/release gate: the pointer state must be visible on
            # the button itself, then settle without leaving a transform behind.
            top_button = page.locator("[data-dm-selection-toggle]").first
            top_box = top_button.bounding_box()
            if not top_box:
                failures.append("no se encontró un control superior para el gate de press")
            else:
                page.mouse.move(top_box["x"] + top_box["width"] / 2, top_box["y"] + top_box["height"] / 2)
                page.mouse.down()
                page.wait_for_timeout(20)
                button_down = top_button.evaluate("el => ({transform: getComputedStyle(el).transform, transition: getComputedStyle(el).transitionDuration})")
                page.mouse.up()
                page.wait_for_timeout(180)
                button_up = top_button.evaluate("el => ({transform: getComputedStyle(el).transform, transition: getComputedStyle(el).transitionDuration})")
                evidence["buttonPress"] = {"down": button_down, "up": button_up}
                page.wait_for_timeout(30)
                if button_down["transform"] in ("none", "matrix(1, 0, 0, 1, 0, 0)"):
                    failures.append(f"press de botón no produjo compresión: {button_down}")
                if button_up["transform"] not in ("none", "matrix(1, 0, 0, 1, 0, 0)"):
                    failures.append(f"botón no asentó después de soltar: {button_up}")

            # Regression path: the same delegated root/document flow used by
            # the real manager. A row body click must toggle exactly once;
            # checkbox and explicit action controls must remain independent.
            selection_toggle = page.locator("[data-dm-selection-toggle]").first
            if selection_toggle.get_attribute("title") == "Seleccionar descargas":
                selection_toggle.click()
            page.wait_for_timeout(40)
            visual_row = page.locator(".dm-download-item").nth(1)
            visual_before = visual_row.evaluate("el => { const s = getComputedStyle(el); return {background:s.backgroundColor, border:s.borderColor, duration:s.transitionDuration}; }")
            visual_id = visual_row.get_attribute("data-dm-select-job")
            visual_row.click(position={"x": 420, "y": 20})
            page.wait_for_timeout(24)
            visual_after = page.locator(f'.dm-download-item[data-dm-select-job="{visual_id}"]').evaluate("el => { const s = getComputedStyle(el); return {background:s.backgroundColor, border:s.borderColor, duration:s.transitionDuration, selected:el.classList.contains('is-visually-selected')}; }")
            evidence["selectionVisual"] = {"before": visual_before, "after": visual_after}
            if not visual_after["selected"] or (visual_before["background"] == visual_after["background"] and visual_before["border"] == visual_after["border"]):
                failures.append(f"selección no produjo feedback de superficie: {evidence['selectionVisual']}")
            duration_seconds = float(visual_after["duration"].replace("s", ""))
            if not (0.140 <= duration_seconds <= 0.190):
                failures.append(f"duración de selección fuera de 140-190ms: {evidence['selectionVisual']}")
            page.locator(f'.dm-download-item[data-dm-select-job="{visual_id}"]').click(position={"x": 420, "y": 20})
            page.wait_for_timeout(24)
            selection_row = page.locator(".dm-download-item").first
            selection_id = selection_row.get_attribute("data-dm-select-job")
            selection_row.click(position={"x": 420, "y": 20})
            page.wait_for_timeout(40)
            selected_once = page.locator(f'.dm-download-item[data-dm-select-job="{selection_id}"]').get_attribute("aria-selected") == "true"
            page.locator(f'.dm-download-item[data-dm-select-job="{selection_id}"]').click(position={"x": 420, "y": 20})
            page.wait_for_timeout(40)
            selected_twice = page.locator(f'.dm-download-item[data-dm-select-job="{selection_id}"]').get_attribute("aria-selected") == "false"
            checkbox = page.locator(f'.dm-download-item[data-dm-select-job="{selection_id}"] [data-dm-select-checkbox]').first
            checkbox.check(force=True)
            page.wait_for_timeout(40)
            selected_checkbox = page.locator(f'.dm-download-item[data-dm-select-job="{selection_id}"]').get_attribute("aria-selected") == "true"
            page.locator(f'.dm-download-item[data-dm-select-job="{selection_id}"] [data-dm-row-menu]').first.click()
            page.wait_for_selector(".dm-row-menu-floating")
            selected_action = page.locator(f'.dm-download-item[data-dm-select-job="{selection_id}"]').get_attribute("aria-selected") == "true"
            page.keyboard.press("Escape")
            evidence["selection"] = {
                "rowBodySelected": selected_once,
                "rowBodySecondClickDeselected": selected_twice,
                "checkboxSelected": selected_checkbox,
                "actionDidNotToggle": selected_action,
            }
            if not all((selected_once, selected_twice, selected_checkbox, selected_action)):
                failures.append(f"regresión de selección: {evidence['selection']}")
            selection_toggle.click()
            page.wait_for_timeout(30)

            def set_state(patch: dict[str, object]) -> dict[str, object]:
                return page.evaluate("patch => { window.__cacatoolsMotionStateHarness.setJobState(1, patch); const row = document.querySelector('.dm-download-item[data-dm-select-job=\"1\"]'); const bar = row?.querySelector('.dm-progress'); const fill = row?.querySelector('.dm-progress > i'); const sameFill = Boolean(fill && window.__cdmMotionFillNode === fill); window.__cdmMotionFillNode = fill || null; const processing = row?.querySelector('.dm-item-progress')?.classList.contains('is-processing') || false; const processingBar = Boolean(row?.querySelector('.dm-item-progress.is-processing .dm-progress-processing')); const processingSpinner = Boolean(row?.querySelector('.dm-processing-indicator')); return { rowAnimation: row ? getComputedStyle(row).animationName : 'none', rowOpacity: row ? getComputedStyle(row).opacity : '1', ratio: fill?.style.getPropertyValue('--dm-progress-ratio') || '', transform: fill ? getComputedStyle(fill).transform : 'none', visualDuration: fill?.style.getPropertyValue('--dm-progress-duration') || '', processing, processingBar, processingSpinner, barAnimation: bar ? getComputedStyle(bar).animationName : 'none', sameFill }; }", patch)

            progress = set_state({"status": "running", "stage": "Descargando", "progress": 47, "downloaded_bytes": 470000, "total_bytes": 1000000, "speed_bps": 1000000, "indeterminate": False})
            completed = set_state({"status": "completed", "stage": "Completada", "progress": 100, "downloaded_bytes": 1000000, "total_bytes": 1000000, "final_size": 1000000, "speed_bps": 0})
            processing = set_state({"status": "running", "stage": "Preparando", "progress": 0, "speed_bps": 0, "indeterminate": False})
            evidence["continuity"] = {"progress": progress, "completed": completed, "processing": processing}
            if progress["ratio"] != "0.4700":
                failures.append(f"ratio de progreso no conserva el valor real: {progress}")
            if completed["rowAnimation"] != "none" or completed["rowOpacity"] != "1":
                failures.append(f"completado todavía anima/desaparece la fila: {completed}")
            if not processing["processing"] or not processing["processingBar"] or processing["processingSpinner"]:
                failures.append("estado Preparando no activa una barra indeterminada localizada sin spinner")
            if completed.get("sameFill") is not True:
                failures.append(f"el parche de progreso recreó el nodo fill: {completed}")

            # The processing segment is sampled for more than two complete
            # cycles. A linear compositor transform must keep changing at the
            # cycle boundary instead of holding on a terminal eased frame.
            processing_samples = []
            for _ in range(22):
                page.wait_for_timeout(100)
                processing_samples.append(page.evaluate("() => { const el = document.querySelector('.dm-download-item[data-dm-select-job=\"1\"] .dm-progress-processing > i'); if (!el) return null; const s = getComputedStyle(el); return {transform:s.transform, animation:s.animationName, duration:s.animationDuration, timing:s.animationTimingFunction}; }"))
            processing_samples = [sample for sample in processing_samples if sample]
            evidence["processingCadence"] = processing_samples
            distinct_transforms = len({sample["transform"] for sample in processing_samples})
            duplicate_boundaries = sum(1 for left, right in zip(processing_samples, processing_samples[1:]) if left["transform"] == right["transform"])
            if not processing_samples or processing_samples[0]["animation"] != "cdm-processing-travel" or processing_samples[0]["duration"] != "0.9s" or processing_samples[0]["timing"] != "linear":
                failures.append(f"barra de procesamiento no usa ciclo lineal calibrado: {evidence['processingCadence']}")
            if distinct_transforms < 12 or duplicate_boundaries > 2:
                failures.append(f"barra de procesamiento presenta pausa o poca cadencia: distinct={distinct_transforms}, duplicates={duplicate_boundaries}")

            # Measure the same live keyed patch path at representative
            # activity intervals. The diagnostic buffer is opt-in and has a
            # bounded sample count; it never drives rendering.
            page.evaluate("() => { window.__CACATOOLS_MOTION_DIAGNOSTICS__ = true; window.__cdmProgressCadenceSamples = []; }")
            cadence = []
            for wait_ms, progress_value in ((220, 51), (250, 57), (280, 64), (260, 71), (240, 78)):
                page.wait_for_timeout(wait_ms)
                set_state({"status": "running", "stage": "Descargando", "progress": progress_value, "downloaded_bytes": progress_value * 10000, "total_bytes": 1000000, "speed_bps": 1000000, "indeterminate": False})
                sample = page.evaluate("() => (window.__cdmProgressCadenceSamples || []).at(-1) || null")
                cadence.append({"requestedWaitMs": wait_ms, "measuredDeltaMs": sample, "visualDuration": page.evaluate("() => document.querySelector('.dm-download-item[data-dm-select-job=\"1\"] .dm-progress > i')?.style.getPropertyValue('--dm-progress-duration') || ''")})
            evidence["progressCadence"] = cadence
            measured = [entry["measuredDeltaMs"] for entry in cadence if isinstance(entry.get("measuredDeltaMs"), (int, float))]
            in_range = [value for value in measured if 180 <= value <= 1000]
            if len(in_range) < 3:
                failures.append(f"no se obtuvieron suficientes deltas reales del parche live: {cadence}")
            elif min(in_range) < 180 or max(in_range) > 1000:
                failures.append(f"cadencia fuera de los límites adaptativos: {cadence}")

            # Exercise the real root transition path with a controlled API
            # shim. The implementation must set the suppression attribute
            # before capture and keep it active through the synchronous update.
            theme_runtime = page.evaluate(
                """async () => {
                  const root = document.documentElement;
                  const original = document.startViewTransition;
                  const samples = [];
                  document.startViewTransition = (callback) => {
                    samples.push({ phase: 'before-capture', transitioning: root.dataset.themeTransitioning === 'true', theme: root.dataset.theme || '' });
                    const updateCallbackDone = Promise.resolve().then(() => {
                      samples.push({ phase: 'before-update', transitioning: root.dataset.themeTransitioning === 'true', theme: root.dataset.theme || '' });
                      callback();
                      samples.push({ phase: 'after-update', transitioning: root.dataset.themeTransitioning === 'true', theme: root.dataset.theme || '' });
                    });
                    const finished = updateCallbackDone.then(() => new Promise(resolve => setTimeout(resolve, 220)));
                    return { updateCallbackDone, ready: updateCallbackDone, finished };
                  };
                  const control = document.querySelector('[data-dm-theme-toggle]');
                  const main = document.querySelector('.dm-zen-main');
                  const rectSnapshot = (node) => { const r = node?.getBoundingClientRect(); return r ? {x:r.x, y:r.y, width:r.width, height:r.height} : null; };
                  control?.focus();
                  const focusBefore = control === document.activeElement;
                  const before = root.dataset.theme || '';
                  const mainBefore = rectSnapshot(main);
                  control?.click();
                  await new Promise(resolve => setTimeout(resolve, 80));
                  const during = {
                    transitioning: root.dataset.themeTransitioning === 'true',
                    theme: root.dataset.theme || '',
                    appTransitionProperty: getComputedStyle(document.querySelector('#app')).transitionProperty,
                    cardTransitionProperty: getComputedStyle(document.querySelector('.dm-download-item')).transitionProperty,
                    appTransition: getComputedStyle(document.querySelector('#app')).transitionDuration,
                    cardTransition: getComputedStyle(document.querySelector('.dm-download-item')).transitionDuration,
                    mainRect: rectSnapshot(document.querySelector('.dm-zen-main')),
                    motionNavigation: document.querySelector('#app')?.dataset.motionNavigation || '',
                    overlayCount: document.querySelectorAll('.motion-theme-fallback-overlay').length
                  };
                  await new Promise(resolve => setTimeout(resolve, 260));
                  const after = { theme: root.dataset.theme || '', overlayCount: document.querySelectorAll('.motion-theme-fallback-overlay').length, focusPreserved: focusBefore && control === document.activeElement };
                  const firstSamples = samples.slice();
                  control?.click();
                  await new Promise(resolve => setTimeout(resolve, 80));
                  const duringReverse = { transitioning: root.dataset.themeTransitioning === 'true', theme: root.dataset.theme || '', appTransitionProperty: getComputedStyle(document.querySelector('#app')).transitionProperty, cardTransitionProperty: getComputedStyle(document.querySelector('.dm-download-item')).transitionProperty, appTransition: getComputedStyle(document.querySelector('#app')).transitionDuration, cardTransition: getComputedStyle(document.querySelector('.dm-download-item')).transitionDuration, mainRect: rectSnapshot(document.querySelector('.dm-zen-main')), motionNavigation: document.querySelector('#app')?.dataset.motionNavigation || '' };
                  await new Promise(resolve => setTimeout(resolve, 260));
                  const reverse = { theme: root.dataset.theme || '', overlayCount: document.querySelectorAll('.motion-theme-fallback-overlay').length };
                  document.startViewTransition = original;
                  return { before, mainBefore, during, after, duringReverse, reverse, samples: firstSamples.concat(samples.slice(firstSamples.length)) };
                }"""
            )
            evidence["themeRootTransition"] = theme_runtime
            for key in ("during", "duringReverse"):
                state = theme_runtime.get(key, {})
                if state.get("transitioning") or state.get("motionNavigation") == "true":
                    failures.append(f"tema activó una transición o navegación durante {key}: {state}")
                before_rect = theme_runtime.get("mainBefore") or {}
                during_rect = state.get("mainRect") or {}
                if any(abs(float(before_rect.get(field, 0)) - float(during_rect.get(field, 0))) > 0.5 for field in ("x", "y", "width", "height")):
                    failures.append(f"Main se movió durante {key}: before={before_rect}, during={during_rect}")
            if theme_runtime.get("after", {}).get("overlayCount") or theme_runtime.get("reverse", {}).get("overlayCount"):
                failures.append(f"cambio de tema dejó overlay: {theme_runtime}")
            if theme_runtime.get("samples"):
                failures.append(f"cambio de tema invocó una captura de documento: {theme_runtime['samples']}")

            # The static theme path must remain atomic even when the browser
            # exposes no View Transition API; no fallback overlay is needed.
            page.evaluate("() => { window.__cdmOriginalStartViewTransition = document.startViewTransition; document.startViewTransition = undefined; }")
            page.locator("[data-dm-theme-toggle]").click()
            page.wait_for_timeout(80)
            evidence["themeAtomicWithoutViewTransition"] = True
            if page.locator(".motion-theme-fallback-overlay").count():
                failures.append("cambio de tema sin View Transition dejó overlay")
            page.evaluate("() => { if (window.__cdmOriginalStartViewTransition) document.startViewTransition = window.__cdmOriginalStartViewTransition; }")

            for mode in ("reduced", "off"):
                page.evaluate("mode => { document.documentElement.dataset.motionMode = mode; document.documentElement.dataset.reducedMotion = mode === 'reduced' ? 'true' : 'false'; }", mode)
                style = page.locator(".dm-download-item .dm-progress > i").first.evaluate("el => { const s = getComputedStyle(el); return {duration:s.transitionDuration, animation:s.animationName}; }")
                evidence[mode] = style
                if style["animation"] != "none" and page.locator(".dm-item-progress.is-processing").count():
                    failures.append(f"modo {mode} conserva animation en superficie de procesamiento: {style}")

            # Browser-level lifecycle traces for the visible player shell and
            # all three preparation variants. Native show is represented by
            # the preview hook here; the Tauri command is exercised by the
            # same bootstrap path in the packaged window.
            player_page = browser.new_page(viewport={"width": 960, "height": 640}, reduced_motion="no-preference")
            player_page.goto(f"http://127.0.0.1:{server.server_address[1]}/app-ui/player/index.html?preview=1", wait_until="domcontentloaded")
            player_page.wait_for_selector(".player-shell")
            player_page.wait_for_function("window.__cdmPlayerLifecycle?.some(entry => entry.label === 'entry-class-added')")
            player_page.wait_for_timeout(420)
            player_trace = player_page.evaluate("() => ({ lifecycle: window.__cdmPlayerLifecycle || [], body: document.body.className, opacity: getComputedStyle(document.querySelector('.player-shell')).opacity, transform: getComputedStyle(document.querySelector('.player-shell')).transform })")
            evidence["playerLifecycle"] = player_trace
            player_labels = [entry.get("label") for entry in player_trace.get("lifecycle", [])]
            if not all(label in player_labels for label in ("webview-bootstrap", "css-ready", "dom-ready", "first-visible-frame", "entry-class-added", "entry-class-removed")):
                failures.append(f"traza de player incompleta: {player_trace}")
            if "player-entry-complete" not in player_trace.get("body", "") or player_trace.get("opacity") != "1":
                failures.append(f"entrada de player no terminó visible: {player_trace}")

            prep_traces = {}
            for kind in ("media", "playlist", "direct"):
                prep_page = browser.new_page(viewport={"width": 960, "height": 640}, reduced_motion="no-preference")
                prep_page.goto(f"http://127.0.0.1:{server.server_address[1]}/app-ui/subwindow.html?preview=1&kind={kind}", wait_until="domcontentloaded")
                prep_page.wait_for_selector("#subwindow-root > .app-window")
                prep_page.wait_for_function("window.__cdmSubwindowLifecycle?.some(entry => entry.label === 'entry-class-added')")
                prep_page.wait_for_timeout(420)
                trace = prep_page.evaluate("() => ({ lifecycle: window.__cdmSubwindowLifecycle || [], body: document.body.className, opacity: getComputedStyle(document.querySelector('#subwindow-root > .app-window')).opacity })")
                prep_traces["http-prep" if kind == "direct" else f"{kind}-prep"] = trace
                labels = [entry.get("label") for entry in trace.get("lifecycle", [])]
                if not all(label in labels for label in ("webview-bootstrap", "css-ready", "dom-ready", "first-visible-frame", "entry-class-added", "entry-class-removed")):
                    failures.append(f"traza de {kind}-prep incompleta: {trace}")
                if "subwindow-entry-complete" not in trace.get("body", "") or trace.get("opacity") != "1":
                    failures.append(f"entrada de {kind}-prep no terminó visible: {trace}")
                prep_page.close()
            evidence["subwindowLifecycle"] = prep_traces
            player_page.close()
            browser.close()
    except Exception as error:  # pragma: no cover
        failures.append(f"browser: {type(error).__name__}: {error}")
    finally:
        with contextlib.suppress(Exception):
            server.shutdown()
            server.server_close()
    print(json.dumps({"pass": not failures, "failures": failures, "evidence": evidence}, ensure_ascii=False, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
