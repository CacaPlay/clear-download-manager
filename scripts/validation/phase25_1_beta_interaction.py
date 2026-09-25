#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
REPORT = ROOT / "docs/tests/phase25-1-beta-interaction.json"
SCREENSHOT = ROOT / "docs/screenshots/phase25-1-beta/context-menu-running-stable.png"

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

        # Reproduce el caso problemático real: menú contextual sobre una descarga
        # que sigue recibiendo snapshots de progreso durante más de un segundo.
        running_row = page.locator('.dm-download-item').filter(has_text='Descarga activa.mp4')
        running_row.wait_for(timeout=5000)
        running_row.click(button="right")
        page.wait_for_timeout(100)
        opened = page.locator('.dm-row-menu-floating').count() == 1

        # Root regression from the user's recording: rerenders restore scrollTop.
        # A programmatic scroll event must not dismiss the menu.
        page.evaluate("""() => {
          const scroll = document.querySelector('.dm-download-scroll');
          if (!scroll) return;
          scroll.scrollTop = scroll.scrollTop;
          scroll.dispatchEvent(new Event('scroll', { bubbles: false }));
        }""")
        page.wait_for_timeout(80)
        survived_programmatic_scroll = page.locator('.dm-row-menu-floating').count() == 1

        # WebView2 may echo a primary pointer at the context-menu origin.
        box = running_row.bounding_box()
        if box:
            echo_x = box['x'] + box['width'] / 2
            echo_y = box['y'] + box['height'] / 2
            page.evaluate(
                """({x,y}) => document.body.dispatchEvent(new PointerEvent('pointerdown', {
                  bubbles:true, button:0, clientX:x, clientY:y, pointerType:'mouse'
                }))""",
                {'x': echo_x, 'y': echo_y},
            )
            page.wait_for_timeout(60)
        survived_pointer_echo = page.locator('.dm-row-menu-floating').count() == 1

        still_open_samples: list[bool] = []
        for step in range(5):
            progress = 18 + step * 7
            page.evaluate(
                """({progress, step}) => window.phase25Patch({
                  jobs: [
                    {id:1,title:'Descarga activa.mp4',detail:'Descargando sin recargar',status:'running',progress,downloaded_bytes:progress*1000000,total_bytes:100000000,speed_bps:2600000 + step*12000,eta_seconds:Math.max(1,40-step*4),kind:'video',engine:'yt-dlp',thumbnail:'',source_url:'https://example.com/a',destination:'C:/Temp/a.mp4',updated_at:String(10+step)},
                    {id:2,title:'Archivo terminado.pdf',detail:'PDF',status:'completed',progress:100,downloaded_bytes:500000,total_bytes:500000,speed_bps:0,eta_seconds:null,kind:'file',engine:'http-range',source_url:'https://example.com/a.pdf',destination:'C:/Temp/a.pdf',updated_at:'1'}
                  ],
                  playlist_batches: []
                })""",
                {"progress": progress, "step": step},
            )
            page.wait_for_timeout(300)
            still_open_samples.append(page.locator('.dm-row-menu-floating').count() == 1)

        survived_over_one_second = all(still_open_samples)

        # Un simple click sintético sin gesto pointerdown no debe hacer parpadear
        # el menú; es una secuencia que WebView2 puede emitir al repintar.
        page.evaluate("document.body.dispatchEvent(new MouseEvent('click',{bubbles:true,button:0}))")
        page.wait_for_timeout(120)
        survived_synthetic_click = page.locator('.dm-row-menu-floating').count() == 1

        SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SCREENSHOT), full_page=False, animations="disabled")

        # Un gesto primario real fuera sí debe cerrarlo inmediatamente.
        page.locator("body").click(position={"x": 10, "y": 10})
        page.wait_for_timeout(100)
        closes_on_real_primary = page.locator('.dm-row-menu-floating').count() == 0

        metrics = {
            "opened_on_running_job": opened,
            "live_patch_samples": still_open_samples,
            "survived_programmatic_scroll_restore": survived_programmatic_scroll,
            "survived_immediate_pointer_echo": survived_pointer_echo,
            "survived_1_5_seconds_of_progress_updates": survived_over_one_second,
            "survived_synthetic_click": survived_synthetic_click,
            "closes_on_real_primary_pointer": closes_on_real_primary,
            "page_errors": errors,
        }
        if errors:
            failures.append(f"JS: {errors}")
        if not opened:
            failures.append("el clic derecho no abrió el menú en la descarga activa")
        if not survived_programmatic_scroll:
            failures.append("el menú contextual se cerró al restaurar scrollTop programáticamente")
        if not survived_pointer_echo:
            failures.append("el eco de pointerdown inmediato de WebView2 cerró el menú")
        if not survived_over_one_second:
            failures.append("el menú contextual de la descarga activa desapareció durante snapshots de progreso")
        if not survived_synthetic_click:
            failures.append("un click sintético posterior al contextmenu cerró el menú")
        if not closes_on_real_primary:
            failures.append("el menú no cerró con un gesto primario real fuera")

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
print("OK: menú contextual estable ante progreso, scroll programático y eco de WebView2.")
