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
        for theme, width, height in (("dark", 1100, 760), ("light", 1100, 760), ("dark", 520, 640)):
            page = browser.new_page(viewport={"width": width, "height": height})
            errors: list[str] = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(
                f"http://127.0.0.1:{port}/?preview=1&view=settings",
                wait_until="networkidle",
                timeout=30_000,
            )
            page.locator("[data-dm-open-settings]").first.evaluate("element => element.click()")
            page.locator('[data-settings-category="appearance"]').click()
            page.locator(f'input[data-appearance-field="theme"][value="{theme}"]').click()
            page.locator('[data-settings-category="downloads"]').click()
            page.wait_for_selector(".settings-concurrency-section")

            http_input = page.locator("#http-concurrency-input")
            media_input = page.locator("#multimedia-concurrency-input")
            if http_input.input_value() != "2" or media_input.input_value() != "1":
                errors.append("Los defaults visibles no son HTTP=2 y Multimedia=1")

            http_input.fill("4")
            http_input.press("Tab")
            page.wait_for_timeout(80)
            media_input = page.locator("#multimedia-concurrency-input")
            media_input.fill("2")
            media_input.press("Tab")
            page.wait_for_timeout(80)
            if page.locator("#http-concurrency-input").input_value() != "4":
                errors.append("HTTP=4 no permaneció seleccionado")
            if page.locator("#multimedia-concurrency-input").input_value() != "2":
                errors.append("Multimedia=2 no permaneció seleccionado")

            page.locator("#http-concurrency-input").fill("9")
            page.locator("#http-concurrency-input").press("Tab")
            page.wait_for_timeout(40)
            if not page.locator(".app-toast.error").is_visible():
                errors.append("HTTP=9 no mostró rechazo")

            metrics = page.evaluate(
                """() => {
                  const section = document.querySelector('.settings-concurrency-section');
                  const rect = section.getBoundingClientRect();
                  return {
                    documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                    sectionLeft: rect.left,
                    sectionRight: rect.right,
                    viewportWidth: innerWidth
                  };
                }"""
            )
            if metrics["documentOverflow"] > 1:
                errors.append("La vista produjo overflow horizontal")
            if metrics["sectionLeft"] < 0 or metrics["sectionRight"] > metrics["viewportWidth"] + 1:
                errors.append("La sección quedó recortada")
            page.screenshot(
                path=str(OUTPUT / f"feature05-concurrency-{theme}-{width}x{height}.png"),
                full_page=True,
            )
            results.append(
                {
                    "theme": theme,
                    "viewport": f"{width}x{height}",
                    "pass": not errors,
                    "errors": errors,
                    "metrics": metrics,
                }
            )
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
print("OK: concurrency Settings UI passed defaults, valid/invalid values, dark/light/small viewport and clipping checks.")
