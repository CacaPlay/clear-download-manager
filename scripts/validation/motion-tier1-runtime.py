#!/usr/bin/env python3
"""Real DOM/computed-style gate for Motion Tier 1.

This exercises the same preview UI served by the application. It checks
computed properties, actual entry triggers, reduced/off behavior, floating
root invariants, and representative hover/state changes instead of only
searching the source stylesheet for tokens.
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


def milliseconds(value: str) -> float:
    first = str(value or "0s").split(",")[0].strip()
    if first.endswith("ms"):
        return float(first[:-2] or 0)
    if first.endswith("s"):
        return float(first[:-1] or 0) * 1000
    return float(first or 0)


def computed(page, selector: str) -> dict[str, str]:
    return page.locator(selector).first.evaluate(
        """(element) => {
          const style = getComputedStyle(element);
          return {
            transitionProperty: style.transitionProperty,
            transitionDuration: style.transitionDuration,
            transitionTimingFunction: style.transitionTimingFunction,
            animationName: style.animationName,
            animationDuration: style.animationDuration,
            animationTimingFunction: style.animationTimingFunction,
            transform: style.transform,
            opacity: style.opacity,
            backgroundColor: style.backgroundColor,
            borderTopColor: style.borderTopColor,
            boxShadow: style.boxShadow
          };
        }"""
    )


def has_property(style: dict[str, str], name: str) -> bool:
    return name in {part.strip() for part in style.get("transitionProperty", "").split(",")}


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
            page = browser.new_page(
                viewport={"width": 1180, "height": 780},
                reduced_motion="no-preference",
            )
            page.set_default_timeout(8_000)
            page.goto(
                f"http://127.0.0.1:{server.server_address[1]}/?preview=1&view=downloads",
                wait_until="domcontentloaded",
            )
            page.wait_for_function("typeof window.__cacatoolsRequestDownloadManagerRender === 'function'")
            page.wait_for_selector(".dm-download-item")
            page.evaluate(
                """() => {
                  const root = document.documentElement;
                  root.dataset.motionMode = 'on';
                  root.dataset.reducedMotion = 'false';
                  root.dataset.motion = 'on';
                }"""
            )

            button = computed(page, "#app button")
            sidebar = computed(page, ".dm-zen-nav nav button")
            card = computed(page, ".dm-download-item")
            evidence["on"] = {"button": button, "sidebar": sidebar, "card": card}
            if not has_property(button, "transform") or milliseconds(button["transitionDuration"]) <= 0:
                failures.append(f"button computed transition no está activo: {button}")
            if not has_property(sidebar, "background-color") or milliseconds(sidebar["transitionDuration"]) <= 0:
                failures.append(f"sidebar computed transition no está activo: {sidebar}")
            if not has_property(card, "background-color") or milliseconds(card["transitionDuration"]) <= 0:
                failures.append(f"card computed transition no está activo: {card}")

            page.evaluate(
                """() => {
                  const app = document.querySelector('#app');
                  app.dataset.motionNavigation = 'false';
                  requestAnimationFrame(() => { app.dataset.motionNavigation = 'true'; });
                }"""
            )
            page.wait_for_timeout(30)
            section = computed(page, ".dm-zen-content")
            evidence["section"] = section
            if section["animationName"] == "none" or milliseconds(section["animationDuration"]) <= 0:
                failures.append(f"section entry no tiene animación computed activa: {section}")

            before_card = {key: card[key] for key in ("backgroundColor", "borderTopColor", "boxShadow")}
            page.locator(".dm-download-item").first.hover()
            after_card = computed(page, ".dm-download-item")
            evidence["cardHover"] = {"before": before_card, "after": after_card}
            if before_card == {key: after_card[key] for key in before_card}:
                failures.append("card hover no cambia ninguna superficie visual")

            performance_matrix = page.evaluate(
                """() => {
                  const app = document.querySelector('#app');
                  const scroll = document.querySelector('.dm-download-scroll');
                  const original = scroll?.querySelector('.dm-download-item');
                  const target = scroll?.querySelector('[data-dm-virtual-window]') || scroll;
                  if (!app || !scroll || !original || !target) return { available: false, results: [] };
                  const results = [];
                  const baseRows = [...target.querySelectorAll('.dm-download-item')];
                  app.dataset.motionNavigation = 'false';
                  for (const count of [1, 20, 50, 100]) {
                    target.querySelectorAll('[data-motion-perf-probe]').forEach((node) => node.remove());
                    baseRows.forEach((row, index) => { row.hidden = index >= count; });
                    const clonesNeeded = Math.max(0, count - Math.min(count, baseRows.length));
                    for (let index = 0; index < clonesNeeded; index += 1) {
                      const clone = original.cloneNode(true);
                      clone.dataset.motionPerfProbe = '1';
                      clone.dataset.dmState = 'running';
                      clone.classList.remove('is-completed', 'is-paused', 'is-failed');
                      clone.classList.add('is-running');
                      target.append(clone);
                    }
                    const start = performance.now();
                    const rows = [...target.querySelectorAll('.dm-download-item:not([hidden])')];
                    let animatedRows = 0;
                    for (const row of rows) {
                      row.offsetHeight;
                      const style = getComputedStyle(row);
                      if (style.animationName !== 'none' && style.animationDuration !== '0s') animatedRows += 1;
                    }
                    const elapsedMs = performance.now() - start;
                    results.push({ count: rows.length, elapsedMs: Number(elapsedMs.toFixed(2)), animatedRows });
                  }
                  target.querySelectorAll('[data-motion-perf-probe]').forEach((node) => node.remove());
                  baseRows.forEach((row) => { row.hidden = false; });
                  return { available: true, results };
                }"""
            )
            evidence["performance"] = performance_matrix
            if not performance_matrix.get("available"):
                failures.append("performance matrix no encontró la lista real de descargas")
            else:
                for result in performance_matrix.get("results", []):
                    if result.get("animatedRows", 0):
                        failures.append(f"refresh con {result.get('count')} filas relanzó entry animations: {result}")
                    if result.get("elapsedMs", 0) > 250:
                        failures.append(f"refresh de {result.get('count')} filas excede el presupuesto proxy: {result}")

            # Deterministic, offline state harness. This calls the same keyed
            # live patch path used by native refreshes and reads the resulting
            # DOM, so CSS declarations alone cannot satisfy this gate.
            page.wait_for_function("typeof window.__cacatoolsMotionStateHarness?.setJobState === 'function'")
            page.evaluate("""() => {
              const app = document.querySelector('#app');
              app.dataset.motionNavigation = 'false';
              const root = document.documentElement;
              root.dataset.motionMode = 'on';
              root.dataset.reducedMotion = 'false';
              root.dataset.motion = 'on';
            }""")

            def harness_row(job_id: int) -> dict[str, object] | None:
                return page.evaluate("""(id) => window.__cacatoolsMotionStateHarness.rowState(id)""", job_id)

            def harness_set(patch: dict[str, object]) -> dict[str, object] | None:
                ok = page.evaluate("""(value) => window.__cacatoolsMotionStateHarness.setJobState(1, value)""", patch)
                if not ok:
                    failures.append(f"state harness no pudo aplicar patch: {patch}")
                row = harness_row(1)
                if row:
                    row["render"] = page.evaluate("""() => {
                      const row = document.querySelector('.dm-download-item[data-dm-select-job="1"]');
                      if (!row) return null;
                      const icon = row.querySelector('.dm-item-status > i');
                      const label = row.querySelector('.dm-item-status > span');
                      const transfer = row.querySelector('.dm-item-transfer');
                      return {
                        iconAnimation: icon ? getComputedStyle(icon).animationName : 'none',
                        labelAnimation: label ? getComputedStyle(label).animationName : 'none',
                        transferAnimation: transfer ? getComputedStyle(transfer).animationName : 'none',
                        rowAnimation: getComputedStyle(row).animationName
                      };
                    }""")
                return row

            initial = harness_row(1)
            prelude = [
                harness_set({"status": "queued", "stage": "En cola", "progress": 0, "downloaded_bytes": 0, "speed_bps": 0, "indeterminate": False}),
                harness_set({"status": "running", "stage": "Descargando", "speed_bps": 1000000}),
            ]
            page.wait_for_timeout(350)
            progress_only = harness_set({"status": "running", "stage": "Descargando", "progress": 64, "downloaded_bytes": 633902720, "speed_bps": 1200000})
            transition_sequence: list[dict[str, object] | None] = []
            if not initial or initial.get("visualState") != "downloading":
                failures.append(f"estado inicial del harness no es downloading: {initial}")
            transition_sequence.append(initial)
            for patch in (
                {"status": "paused", "stage": "En pausa", "speed_bps": 0},
                {"status": "running", "stage": "Descargando", "speed_bps": 1000000},
                {"status": "running", "stage": "Finalizando", "progress": 100, "downloaded_bytes": 986710016, "speed_bps": 0},
                {"status": "completed", "stage": "Completada", "progress": 100, "final_size": 986710016, "speed_bps": 0},
                {"status": "failed", "stage": "Error", "speed_bps": 0},
            ):
                transition_sequence.append(harness_set(patch))
            evidence["statusTransitions"] = {
                "prelude": prelude,
                "progressOnly": progress_only,
                "sequence": transition_sequence,
                "otherJob": harness_row(2),
            }
            expected = ["paused", "resumed", "finalizing", "completed", "error"]
            observed = [entry.get("transition") if entry else None for entry in transition_sequence[1:]]
            visual_states = [entry.get("visualState") if entry else None for entry in transition_sequence[1:]]
            prelude_states = [entry.get("visualState") if entry else None for entry in prelude]
            prelude_transitions = [entry.get("transition") if entry else None for entry in prelude]
            if prelude_states != ["queued", "downloading"] or prelude_transitions != ["queued", "downloading"]:
                failures.append(f"prelude queued->downloading no coincide: states={prelude_states}, transitions={prelude_transitions}")
            if progress_only and (progress_only.get("transition") or progress_only.get("active")):
                failures.append(f"un parche solo de progreso reactivó status motion: {progress_only}")
            if observed != expected:
                failures.append(f"secuencia de transiciones observada no coincide: {observed} != {expected}")
            if visual_states != ["paused", "downloading", "finalizing", "completed", "error"]:
                failures.append(f"estados visuales observados no coinciden: {visual_states}")
            for entry in transition_sequence[1:]:
                rendered = entry.get("render") if entry else None
                if not rendered or all(rendered.get(key) in (None, "none") for key in ("iconAnimation", "labelAnimation", "transferAnimation", "rowAnimation")):
                    failures.append(f"transición {entry.get('transition') if entry else None} no produjo animación DOM computada: {rendered}")
            other = evidence["statusTransitions"]["otherJob"]
            if other and (other.get("transition") or other.get("active")):
                failures.append(f"otro job recibió una transición que no le correspondía: {other}")
            # Restore the preview row without asserting another transition;
            # the harness is a finite sequence and the next checks use stable
            # DOM surfaces only.
            harness_set({"status": "running", "stage": "Descargando", "progress": 63, "downloaded_bytes": 623902720, "speed_bps": 8860467})

            page.locator("[data-dm-open-settings]").first.click()
            page.wait_for_selector(".settings-view, .dm-settings-popover:not([hidden])")
            settings_selector = ".settings-view" if page.locator(".settings-view").count() else ".dm-settings-panel"
            settings = computed(page, settings_selector)
            evidence["settings"] = settings
            if settings["animationName"] == "none" or milliseconds(settings["animationDuration"]) <= 0:
                failures.append(f"settings entry computed no está activo: {settings}")

            if page.locator(".settings-view").count():
                page.locator(".settings-back").click()
                page.wait_for_selector(".dm-download-item")
            else:
                page.keyboard.press("Escape")
            page.wait_for_timeout(30)
            page.locator("[data-dm-row-menu]").first.click()
            page.wait_for_selector(".dm-row-menu-floating")
            menu_root = computed(page, ".dm-row-menu-floating")
            menu_inner = computed(page, ".dm-row-menu-floating > .motion-inner")
            evidence["menu"] = {"root": menu_root, "inner": menu_inner}
            if menu_root["transform"] != "none":
                failures.append(f"floating positioning root transformado: {menu_root}")
            if menu_inner["animationName"] == "none" or milliseconds(menu_inner["animationDuration"]) <= 0:
                failures.append(f"menu motion-inner no tiene entrada computed activa: {menu_inner}")

            page.keyboard.press("Escape")
            page.locator("[data-dm-add-torrent]").first.click()
            page.wait_for_selector(".dm-modal-backdrop")
            dialog_root = computed(page, ".dm-modal-backdrop")
            dialog_inner = computed(page, ".dm-modal-backdrop > .motion-inner")
            evidence["dialog"] = {"root": dialog_root, "inner": dialog_inner}
            if dialog_root["transform"] != "none":
                failures.append(f"dialog positioning root transformado: {dialog_root}")
            if dialog_inner["animationName"] == "none" or milliseconds(dialog_inner["animationDuration"]) <= 0:
                failures.append(f"dialog motion-inner no tiene entrada computed activa: {dialog_inner}")

            page.locator("[data-dm-modal-close]").first.click()
            page.evaluate(
                """() => {
                  const region = document.querySelector('.toast-region');
                  const toast = document.createElement('div');
                  toast.className = 'app-toast success';
                  toast.textContent = 'Motion runtime gate';
                  region.append(toast);
                }"""
            )
            toast = computed(page, ".app-toast")
            evidence["toast"] = toast
            if toast["animationName"] == "none" or milliseconds(toast["animationDuration"]) <= 0:
                failures.append(f"toast computed entry no está activo: {toast}")

            page.evaluate("""() => window.__cacatoolsMotionStateHarness.setJobState(1, {
              status: 'completed', stage: 'Completada', progress: 100,
              final_size: 986710016, speed_bps: 0
            })""")
            completed_icon = computed(page, ".dm-download-item .dm-item-status > i")
            evidence["completed"] = completed_icon
            if not has_property(completed_icon, "transform") or milliseconds(completed_icon["transitionDuration"]) <= 0:
                failures.append(f"completion icon transition no está activo: {completed_icon}")

            for mode in ("reduced", "off"):
                page.evaluate(
                    """(mode) => {
                      const root = document.documentElement;
                      root.dataset.motionMode = mode;
                      root.dataset.reducedMotion = mode === 'reduced' ? 'true' : 'false';
                    }""",
                    mode,
                )
                reduced_button = computed(page, "#app button")
                reduced_inner = computed(page, ".app-toast")
                evidence[mode] = {"button": reduced_button, "inner": reduced_inner}
                if milliseconds(reduced_button["transitionDuration"]) > 2 or milliseconds(reduced_inner["animationDuration"]) > 2:
                    failures.append(f"modo {mode} conserva motion no esencial: {evidence[mode]}")
            browser.close()
    except Exception as error:  # pragma: no cover - surfaced as gate failure
        failures.append(f"browser: {type(error).__name__}: {error}")
    finally:
        with contextlib.suppress(Exception):
            server.shutdown()
            server.server_close()
    print(json.dumps({"pass": not failures, "failures": failures, "evidence": evidence}, ensure_ascii=False, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
