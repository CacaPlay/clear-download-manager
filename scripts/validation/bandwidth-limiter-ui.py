#!/usr/bin/env python3
from __future__ import annotations

import contextlib
import http.server
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "output"
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

try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for theme in ("dark", "light"):
            page = browser.new_page(viewport={"width": 1100, "height": 760})
            errors: list[str] = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(
                f"http://127.0.0.1:{port}/?preview=1&view=settings",
                wait_until="networkidle",
                timeout=30_000,
            )
            page.locator("[data-dm-open-settings]").first.click()
            page.locator('[data-settings-category="appearance"]').click()
            page.locator(f'input[data-appearance-field="theme"][value="{theme}"]').click()
            page.locator('[data-settings-category="downloads"]').click()
            page.wait_for_selector(".settings-bandwidth-section")

            selector = page.locator("#bandwidth-limit-select")
            selector.select_option("1000000")
            page.wait_for_timeout(80)
            selector = page.locator("#bandwidth-limit-select")
            if selector.input_value() != "1000000":
                errors.append("El preset 1 MB/s no permaneció seleccionado")

            selector.select_option("custom")
            page.locator("#bandwidth-custom-value").fill("1")
            page.locator("#bandwidth-custom-unit").select_option("KB")
            page.locator(".save-bandwidth-custom").click()
            if not page.locator(".app-toast.error").is_visible():
                errors.append("El valor personalizado menor de 64 KB/s no mostró rechazo")
            page.locator("#bandwidth-custom-value").fill("2")
            page.locator("#bandwidth-custom-unit").select_option("MB")
            page.locator(".save-bandwidth-custom").click()
            page.wait_for_timeout(80)
            selector = page.locator("#bandwidth-limit-select")
            if selector.input_value() != "2000000":
                errors.append("El valor personalizado válido no se convirtió a SI exacto")

            metrics = page.evaluate(
                """() => {
                  const section = document.querySelector('.settings-bandwidth-section');
                  const rect = section.getBoundingClientRect();
                  return {
                    documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                    sectionLeft: rect.left,
                    sectionRight: rect.right,
                    viewportWidth: innerWidth,
                    theme: document.documentElement.dataset.theme || document.body.dataset.theme || getComputedStyle(document.documentElement).colorScheme
                  };
                }"""
            )
            if metrics["documentOverflow"] > 1:
                errors.append("La vista produjo overflow horizontal")
            if metrics["sectionLeft"] < 0 or metrics["sectionRight"] > metrics["viewportWidth"] + 1:
                errors.append("El control quedó recortado")
            page.screenshot(path=str(OUTPUT / f"feature03-bandwidth-{theme}.png"), full_page=True)
            results.append({"theme": theme, "pass": not errors, "errors": errors, "metrics": metrics})
            page.close()
        browser.close()
finally:
    with contextlib.suppress(Exception):
        server.shutdown()
        server.server_close()

if not all(result["pass"] for result in results):
    print(json.dumps(results, ensure_ascii=False, indent=2))
    raise SystemExit(1)
print(json.dumps(results, ensure_ascii=False))
print("OK: bandwidth Settings UI passed dark/light, preset, custom valid/invalid and clipping checks.")
