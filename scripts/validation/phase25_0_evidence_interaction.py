#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
REPORT = ROOT / "docs/tests/phase25-0-evidence-interaction.json"
SCREENSHOT = ROOT / "docs/screenshots/phase25-0-evidence/context-menu-stable.png"

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

        # Usa la fila completada histórica que forma parte del snapshot estable del fixture.
        page.wait_for_timeout(400)
        old_row = page.locator('.dm-download-item').filter(has_text='Archivo terminado.pdf')
        old_row.wait_for(timeout=5000)
        old_row.click(button='right')
        page.wait_for_timeout(80)
        opened = page.locator('.dm-row-menu-floating').count() == 1

        # Simula el click sintético que WebView2 puede disparar justo después del contextmenu.
        page.evaluate("document.body.dispatchEvent(new MouseEvent('click',{bubbles:true,button:0}))")
        page.wait_for_timeout(90)
        after_synthetic_click = page.locator('.dm-row-menu-floating').count() == 1

        # Un snapshot ligero posterior tampoco debe destruir la fila/menú abiertos.
        page.evaluate(
            """() => window.phase25Patch({
              jobs: [
                {id: 1,title:'Descarga activa.mp4',detail:'Descargando sin recargar',status:'running',progress:44,downloaded_bytes:44000000,total_bytes:100000000,speed_bps:2600000,eta_seconds:22,kind:'video',engine:'yt-dlp',thumbnail:'',source_url:'https://example.com/a',destination:'C:/Temp/a.mp4',updated_at:'3'},
                {id: 2,title:'Archivo terminado.pdf',detail:'PDF',status:'completed',progress:100,downloaded_bytes:500000,total_bytes:500000,speed_bps:0,eta_seconds:null,kind:'file',engine:'http-range',source_url:'https://example.com/a.pdf',destination:'C:/Temp/a.pdf',updated_at:'1'}
              ],
              playlist_batches: []
            })"""
        )
        page.wait_for_timeout(300)
        after_live_patch = page.locator('.dm-row-menu-floating').count() == 1

        # Fuera de la ventana de protección, un click normal sí debe cerrar el menú.
        page.wait_for_timeout(250)
        page.locator('body').click(position={"x": 10, "y": 10})
        page.wait_for_timeout(80)
        closes_normally = page.locator('.dm-row-menu-floating').count() == 0

        metrics = {
            "opened": opened,
            "after_synthetic_click": after_synthetic_click,
            "after_live_patch": after_live_patch,
            "closes_normally": closes_normally,
            "page_errors": errors,
        }
        if errors:
            failures.append(f"JS: {errors}")
        if not opened:
            failures.append("el clic derecho no abrió el menú en una descarga antigua")
        if not after_synthetic_click:
            failures.append("el click sintético inmediato cerró el menú contextual")
        if not after_live_patch:
            failures.append("el snapshot de progreso destruyó el menú contextual abierto")
        if not closes_normally:
            failures.append("el menú dejó de cerrar con un click normal fuera")

        SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
        # Reabre para dejar evidencia visual del estado estable.
        old_row = page.locator('.dm-download-item').filter(has_text='Archivo terminado.pdf')
        old_row.click(button='right')
        page.wait_for_timeout(100)
        page.screenshot(path=str(SCREENSHOT), full_page=False, animations='disabled')
        browser.close()
finally:
    html.unlink(missing_ok=True)

REPORT.parent.mkdir(parents=True, exist_ok=True)
REPORT.write_text(json.dumps({"passed": not failures, "failures": failures, "metrics": metrics}, indent=2, ensure_ascii=False), encoding="utf-8")
if failures:
    print(json.dumps({"failures": failures, "metrics": metrics}, indent=2, ensure_ascii=False))
    raise SystemExit(1)
print("OK: menú contextual estable ante click sintético y snapshot en vivo.")
