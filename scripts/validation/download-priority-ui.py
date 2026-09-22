#!/usr/bin/env python3
from __future__ import annotations

import contextlib
import http.server
import json
import os
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = Path(os.environ.get("CDM_UI_TEST_OUTPUT", ROOT / "output"))
OUTPUT.mkdir(exist_ok=True)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args: object) -> None:
        pass


handler = lambda *args, **kwargs: QuietHandler(*args, directory=str(ROOT), **kwargs)
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
port = server.server_address[1]
results: list[dict[str, object]] = []

fixture_script = """async ({ theme, small }) => {
  const { downloadRowMarkup } = await import('/app-ui/download-manager/view/unified.js');
  const { floatingRowMenu } = await import('/app-ui/download-manager/view/shared.js');
  const { settleFloatingRowMenu } = await import('/app-ui/download-manager/events.js');
  document.documentElement.dataset.theme = theme;
  document.body.dataset.theme = theme;
  const base = {
    title: 'Descarga de prueba', kind: 'http', category: 'Archivo', origin: 'fixture.local',
    status: 'queued', progress: 23, downloadedBytes: 2300, totalBytes: 10000,
    totalBytesEstimated: false, progressEstimated: false, indeterminate: false,
    speedBps: 0, etaSeconds: null, engine: 'HTTP', stage: 'queued', thumbnail: '',
    sourceUrl: 'https://fixture.local/file.bin', destination: 'D:/Downloads/file.bin', extension: 'bin'
  };
  const jobs = [
    {...base, id: 101, title: 'Prioridad alta', priority: 'high'},
    {...base, id: 102, title: 'Prioridad normal', priority: 'normal'},
    {...base, id: 103, title: 'Prioridad baja', priority: 'low'},
    {...base, id: 104, title: 'Terminada', status: 'completed', progress: 100, priority: 'high'},
    {...base, id: 105, title: 'Archivo comprimido', extension: 'rar', status: 'paused', priority: 'normal'}
  ];
  const menuPosition = small ? {left: innerWidth - 260, top: innerHeight - 310} : {left: innerWidth - 300, top: 115};
  document.body.innerHTML = `<main class="dm-host" data-dm-theme="${theme}"><section class="dm-download-area"><div class="dm-download-scroll">${jobs.map((job, index) => downloadRowMarkup(job, index, null, null, null, null, true, new Set([101, 103]))).join('')}</div>${floatingRowMenu(jobs[0], 101, menuPosition)}</section><div class="dm-selection-toolbar"><select data-dm-bulk-priority aria-label="Cambiar prioridad"><option value="">Prioridad</option><option value="high">Alta</option><option value="normal">Normal</option><option value="low">Baja</option></select></div></main>`;
  document.body.style.margin = '0';
  settleFloatingRowMenu(document, {
    x: innerWidth - 12,
    y: small ? innerHeight - 28 : 115,
    above: small ? innerHeight - 40 : 100,
    alignRight: true
  });
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return true;
}"""

selection_toolbar_script = """async () => {
  const { helperChipsMarkup } = await import('/app-ui/download-manager/view/unified.js');
  const { dmIcon } = await import('/app-ui/download-manager/view/icons.js');
  const { localizeDom } = await import('/app-ui/modules/i18n/runtime.js');
  document.body.style.margin = '0';
  document.body.innerHTML = `<main class="dm-host dm-root dm-zen-sidebar has-collapsed-inspector" data-dm-layout="zen-sidebar" data-dm-theme="dark">
    <nav class="dm-zen-nav"></nav>
    <section class="dm-zen-main"><header class="dm-zen-top"><div class="dm-zen-secondary-row">
      <div class="dm-zen-secondary-actions">${helperChipsMarkup({disabled:true})}</div>
      <div class="dm-zen-toolbar-actions"><div class="dm-selection-tools">
        <button type="button" data-dm-select-all-visible>${dmIcon('check',18)}<span>Todas</span></button>
        <select data-dm-bulk-priority aria-label="Cambiar prioridad"><option value="">Prioridad…</option><option value="high">Alta</option><option value="normal">Normal</option><option value="low">Baja</option></select>
        <button type="button" class="is-danger" data-dm-bulk-delete>${dmIcon('trash',18)}<span>Eliminar 3</span></button>
        <button type="button" data-dm-selection-toggle>${dmIcon('x',18)}</button>
      </div></div>
    </div></header></section>
  </main>`;
  localizeDom(document.querySelector('.dm-helper-chips'), 'es');
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const rect = (element) => {
    const value = element.getBoundingClientRect();
    return {left:value.left,right:value.right,top:value.top,bottom:value.bottom,width:value.width,height:value.height};
  };
  const row = document.querySelector('.dm-zen-secondary-row');
  const quick = document.querySelector('.dm-zen-secondary-actions');
  const bulk = document.querySelector('.dm-zen-toolbar-actions');
  const rowRect = rect(row);
  const quickRect = rect(quick);
  const bulkRect = rect(bulk);
  const controls = [...document.querySelectorAll('.dm-helper-chips button, .dm-selection-tools > *')];
  return {
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    row: rowRect,
    rowScrollWidth: row.scrollWidth,
    rowClientWidth: row.clientWidth,
    quick: quickRect,
    bulk: bulkRect,
    tops: controls.map((element) => rect(element).top),
    playlistLabel: document.querySelector('[data-dm-focus-unified]')?.textContent.trim(),
    quickButtonsDisabled: [...document.querySelectorAll('.dm-helper-chips button')].every((button) => button.disabled),
    categoryAndDetailsPresent: Boolean(document.querySelector('.dm-category-control, .dm-details-toggle')),
    priorityWidth: rect(document.querySelector('[data-dm-bulk-priority]')).width
  };
}"""

try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for theme, viewport in (
            ("dark", {"width": 1100, "height": 760}),
            ("light", {"width": 1100, "height": 760}),
            ("dark-small", {"width": 520, "height": 640}),
        ):
            actual_theme = "dark" if theme == "dark-small" else theme
            page = browser.new_page(viewport=viewport)
            errors: list[str] = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(f"http://127.0.0.1:{port}/?preview=1&view=downloads", wait_until="networkidle", timeout=30_000)
            page.evaluate(fixture_script, {"theme": actual_theme, "small": theme == "dark-small"})
            page.wait_for_selector('.dm-row-menu[role="menu"]')

            if page.locator('.dm-priority-meta.is-high').count() != 1:
                errors.append("La metadata high no respeta estados relevantes")
            if page.locator('.dm-priority-meta.is-low').count() != 1:
                errors.append("La metadata low no respeta estados relevantes")
            if page.locator('.dm-priority-meta.is-normal').count() != 0:
                errors.append("La metadata Normal implícita no debe renderizarse")
            archive_type = page.locator('[data-dm-select-job="105"] .dm-item-type').inner_text()
            if 'Comprimido' not in archive_type or 'Archivo comprimido' in archive_type:
                errors.append(f"La etiqueta visual archive no es compacta: {archive_type!r}")
            if page.locator('.dm-priority-badge').count() != 0:
                errors.append("El badge legacy no debe renderizarse")
            if page.locator('[role="menuitemradio"]').count() != 3:
                errors.append("El menú no contiene tres radios de prioridad")
            if page.locator('[role="menuitemradio"][aria-checked="true"]').count() != 1:
                errors.append("El menú no tiene una selección accesible única")
            priority_rows = page.locator('.dm-priority-menu').first
            if priority_rows.locator('> button').count() != 3:
                errors.append("La sección de prioridad no tiene tres controles")
            first_priority_top = priority_rows.locator('> button').nth(0).evaluate("el => el.getBoundingClientRect().top")
            last_priority_top = priority_rows.locator('> button').nth(2).evaluate("el => el.getBoundingClientRect().top")
            # Chromium can return slightly different sub-pixel coordinates for
            # grid tracks; a one-CSS-pixel tolerance still rejects wrapping.
            if abs(first_priority_top - last_priority_top) > 1:
                errors.append("Los controles de prioridad no están en una sola fila")
            if page.locator('[data-dm-bulk-priority] option').count() != 4:
                errors.append("El control multiselección no expone High/Normal/Low")

            first_radio = page.locator('[role="menuitemradio"]').first
            first_radio.focus()
            if first_radio.evaluate("element => document.activeElement === element") is not True:
                errors.append("Los radios de prioridad no reciben foco de teclado")

            metrics = page.evaluate(
                """() => {
                  const menu = document.querySelector('.dm-row-menu');
                  const rect = menu.getBoundingClientRect();
                  return {
                    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                    iconFilter: getComputedStyle(document.querySelector('.dm-file-asset-neutral')).filter,
                    menuLeft: rect.left, menuTop: rect.top, menuRight: rect.right, menuBottom: rect.bottom,
                    viewportWidth: innerWidth, viewportHeight: innerHeight
                  };
                }"""
            )
            if metrics["overflow"] > 1:
                errors.append("La vista produjo overflow horizontal")
            expected_icon_filter = "brightness(0.64)" if actual_theme == "light" else "brightness(1.16)"
            if expected_icon_filter not in metrics["iconFilter"]:
                errors.append(f"El tema {actual_theme} aplicó un filtro de icono inesperado: {metrics['iconFilter']!r}")
            if metrics["menuLeft"] < 0 or metrics["menuTop"] < 0:
                errors.append("El menú quedó fuera del borde superior/izquierdo")
            if metrics["menuRight"] > metrics["viewportWidth"] + 1 or metrics["menuBottom"] > metrics["viewportHeight"] + 1:
                errors.append("El menú quedó recortado por el viewport")

            page.screenshot(path=str(OUTPUT / f"feature04-priority-{theme}.png"), full_page=True)
            results.append({"theme": theme, "pass": not errors, "errors": errors, "metrics": metrics})
            page.close()
        selection_page = browser.new_page(viewport={"width": 1123, "height": 714})
        selection_errors: list[str] = []
        selection_page.on("pageerror", lambda error: selection_errors.append(str(error)))
        selection_page.goto(f"http://127.0.0.1:{port}/?preview=1&view=downloads", wait_until="networkidle", timeout=30_000)
        metrics = selection_page.evaluate(selection_toolbar_script)
        if metrics["viewportWidth"] != 1123:
            selection_errors.append("La prueba no se ejecutó al ancho mínimo de 1123 px")
        if metrics["rowScrollWidth"] > metrics["rowClientWidth"] + 1:
            selection_errors.append("La barra de selección desborda horizontalmente al ancho mínimo")
        if metrics["quick"]["right"] > metrics["bulk"]["left"] + 1:
            selection_errors.append("Las acciones rápidas se solapan con los controles de selección")
        if metrics["bulk"]["right"] < metrics["row"]["right"] - 1:
            selection_errors.append("Los controles de selección no quedan alineados a la derecha")
        if max(metrics["tops"]) - min(metrics["tops"]) > 2:
            selection_errors.append("Los accesos y controles de selección no comparten una sola línea")
        if metrics["playlistLabel"] != "Playlist":
            selection_errors.append(f"La etiqueta española de Playlist cambió a {metrics['playlistLabel']!r}")
        if not metrics["quickButtonsDisabled"]:
            selection_errors.append("Los accesos rápidos deben quedar realmente desactivados en modo selección")
        if metrics["categoryAndDetailsPresent"]:
            selection_errors.append("Categorías y detalles deben salir de la barra en modo selección")
        if metrics["priorityWidth"] < 136:
            selection_errors.append("El selector de prioridad recorta su texto de marcador")
        selection_page.screenshot(path=str(OUTPUT / "selection-toolbar-minimum-1123.png"), full_page=True)
        results.append({"theme": "selection-minimum", "pass": not selection_errors, "errors": selection_errors, "metrics": metrics})
        selection_page.close()
        browser.close()
finally:
    with contextlib.suppress(Exception):
        server.shutdown()
        server.server_close()

if not all(result["pass"] for result in results):
    print(json.dumps(results, ensure_ascii=False, indent=2))
    raise SystemExit(1)
print(json.dumps(results, ensure_ascii=False))
print("OK: priority UI passed dark/light/small viewport, badges, radio semantics, keyboard focus, multiselect and clipping checks; selection toolbar stays on one line at the 1123px minimum.")
