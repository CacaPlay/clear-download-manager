#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
REPORT = ROOT / "docs/tests/phase25-1-beta-visual.json"
SCREENSHOT = ROOT / "docs/screenshots/phase25-1-beta/selection-and-centering.png"

with tempfile.NamedTemporaryFile(suffix=".html", delete=False, dir=ROOT) as tmp:
    html = Path(tmp.name)

failures: list[str] = []
metrics: dict[str, object] = {}
try:
    subprocess.run(
        ["node", "scripts/validation/phase25_0_evidence_fixture.mjs", str(html)],
        cwd=ROOT,
        check=True,
        timeout=25,
    )
    with sync_playwright() as pw:
        launch_options = {"headless": True, "args": ["--disable-gpu", "--no-sandbox"]}
        executable = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE")
        if not executable and Path("/usr/bin/chromium").exists():
            executable = "/usr/bin/chromium"
        if executable:
            launch_options["executable_path"] = executable
        browser = pw.chromium.launch(**launch_options)
        page = browser.new_page(viewport={"width": 1180, "height": 780}, reduced_motion="reduce")
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.set_content(html.read_text(encoding="utf-8"), wait_until="domcontentloaded", timeout=20_000)
        page.wait_for_selector(".dm-host", timeout=10_000)
        page.wait_for_timeout(350)

        geometry = page.evaluate(
            """() => {
              const rect = (selector) => {
                const node = document.querySelector(selector);
                if (!node) return null;
                const r = node.getBoundingClientRect();
                return {left:r.left,top:r.top,width:r.width,height:r.height,cx:r.left+r.width/2,cy:r.top+r.height/2};
              };
              const style = (selector) => {
                const node = document.querySelector(selector);
                return node ? getComputedStyle(node) : null;
              };
              const helper = style('.dm-helper-chips button');
              const filter = style('.dm-filter-row .dm-filter span, .dm-zen-filter-row .dm-filter span, .dm-category-toggle');
              return {
                thumb: (() => {
                  const overlay = document.querySelector('.dm-download-item.kind-video .dm-player-overlay');
                  if (!overlay?.parentElement) return null;
                  const r = overlay.parentElement.getBoundingClientRect();
                  return {left:r.left,top:r.top,width:r.width,height:r.height,cx:r.left+r.width/2,cy:r.top+r.height/2};
                })(),
                overlay: rect('.dm-download-item.kind-video .dm-player-overlay'),
                fileBox: rect('.dm-download-item.kind-file .dm-job-file'),
                fileIcon: rect('.dm-download-item.kind-file .dm-job-file > .dm-icon'),
                sidebarIcon: rect('.dm-zen-nav nav button[data-dm-section="downloads"] svg'),
                helperFontPx: helper ? parseFloat(helper.fontSize) : 0,
                filterFontPx: filter ? parseFloat(filter.fontSize) : 0
              };
            }"""
        )

        def centered(outer: dict | None, inner: dict | None, tolerance: float = 1.1) -> bool:
            return bool(outer and inner and abs(outer["cx"] - inner["cx"]) <= tolerance and abs(outer["cy"] - inner["cy"]) <= tolerance)

        play_centered = centered(geometry.get("thumb"), geometry.get("overlay"))
        file_icon_centered = centered(geometry.get("fileBox"), geometry.get("fileIcon"))
        sidebar_icon = geometry.get("sidebarIcon") or {}
        sidebar_symbol_large = float(sidebar_icon.get("width", 0)) >= 28 and float(sidebar_icon.get("height", 0)) >= 28
        text_large = float(geometry.get("helperFontPx", 0)) >= 17 and float(geometry.get("filterFontPx", 0)) >= 16

        selection_toggle = page.locator('[data-dm-selection-toggle]').first
        selection_toggle.click()
        page.wait_for_timeout(120)
        checkbox_count = page.locator('[data-dm-select-checkbox]').count()
        select_all = page.locator('[data-dm-select-all-visible]')
        select_all.click()
        page.wait_for_timeout(120)
        checked_count = page.locator('[data-dm-select-checkbox]:checked').count()
        delete_button = page.locator('[data-dm-bulk-delete]')
        delete_enabled = delete_button.count() == 1 and delete_button.is_enabled()

        if delete_enabled:
            delete_button.click()
            page.wait_for_timeout(100)
        app_only = page.locator('[data-dm-confirm-bulk-delete="record"]')
        storage = page.locator('[data-dm-confirm-bulk-delete="storage"]')
        delete_modes_present = app_only.count() == 1 and storage.count() == 1

        SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SCREENSHOT), full_page=False, animations="disabled")

        metrics = {
            "geometry": geometry,
            "play_centered": play_centered,
            "generic_file_icon_centered": file_icon_centered,
            "sidebar_symbol_large_without_outer_resize": sidebar_symbol_large,
            "helper_and_filter_text_large": text_large,
            "selection_checkbox_count": checkbox_count,
            "selected_after_select_all": checked_count,
            "bulk_delete_enabled": delete_enabled,
            "bulk_delete_modes_present": delete_modes_present,
            "page_errors": errors,
        }
        if errors:
            failures.append(f"JS: {errors}")
        if not play_centered:
            failures.append("el overlay de play no quedó centrado respecto a la miniatura")
        if not file_icon_centered:
            failures.append("el icono de archivo genérico no quedó centrado")
        if not sidebar_symbol_large:
            failures.append("el símbolo interno de Descargas no alcanzó 28 px")
        if not text_large:
            failures.append("chips o filtros siguen demasiado pequeños en escala predeterminada")
        if checkbox_count != 2 or checked_count != 2:
            failures.append("la selección individual/total no cubre las dos filas visibles")
        if not delete_enabled or not delete_modes_present:
            failures.append("el borrado por lote no expone ambos modos de eliminación")

        browser.close()
finally:
    html.unlink(missing_ok=True)

REPORT.parent.mkdir(parents=True, exist_ok=True)
REPORT.write_text(
    json.dumps({"passed": not failures, "failures": failures, "metrics": metrics}, indent=2, ensure_ascii=False),
    encoding="utf-8",
)
if failures:
    print(json.dumps({"failures": failures, "metrics": metrics}, indent=2, ensure_ascii=False))
    raise SystemExit(1)
print("OK: selección, centrado de play/archivo, iconos y texto de 0.25.1 validados visualmente.")
