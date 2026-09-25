#!/usr/bin/env python3
"""Regression gate for transient controls during live data refreshes."""
from __future__ import annotations

import contextlib
import http.server
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
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1180, "height": 780}, reduced_motion="reduce")
            page.set_default_timeout(5_000)
            page.goto(
                f"http://127.0.0.1:{server.server_address[1]}/?preview=1&view=downloads",
                wait_until="domcontentloaded",
            )
            page.wait_for_function("typeof window.__cacatoolsRequestDownloadManagerRender === 'function'")

            # Settings editor: focus/value/DOM identity survive repeated forced refreshes.
            page.locator("[data-dm-open-settings]").first.click()
            page.wait_for_selector(".settings-workspace")
            page.locator("[data-settings-category='downloads']").click()
            page.locator("#bandwidth-limit-select").select_option("custom")
            page.wait_for_selector("#bandwidth-custom-value")
            settings = page.evaluate(
                """() => {
                  const input = document.getElementById('bandwidth-custom-value');
                  input.focus(); input.value = '7';
                  input.dispatchEvent(new Event('input', { bubbles: true }));
                  for (let i = 0; i < 8; i += 1) window.__cacatoolsRequestDownloadManagerRender({ force: true });
                  const after = document.getElementById('bandwidth-custom-value');
                  return { sameNode: input === after, focused: document.activeElement === after,
                    value: after?.value || '', visible: Boolean(after && after.offsetParent) };
                }"""
            )
            if settings != {"sameNode": True, "focused": True, "value": "7", "visible": True}:
                failures.append(f"Settings perdió estado: {settings}")

            # Category selector: an open option panel must not be replaced by polling.
            page.locator(".settings-back").click()
            page.wait_for_selector("[data-dm-category-toggle]")
            page.locator("[data-dm-category-toggle]").click()
            category = page.evaluate(
                """() => {
                  const menu = document.querySelector('[data-dm-category-menu]');
                  const before = menu;
                  for (let i = 0; i < 8; i += 1) window.__cacatoolsRequestDownloadManagerRender({ force: true });
                  const after = document.querySelector('[data-dm-category-menu]');
                  return { sameNode: before === after, open: Boolean(after && !after.hidden), selected: after?.querySelector('[aria-selected="true"]')?.dataset.dmCategoryOption || '' };
                }"""
            )
            if not category["sameNode"] or not category["open"]:
                failures.append(f"Categorías perdió estado: {category}")

            # Row menu: use a fixture row and verify the floating menu remains open.
            page.locator("[data-dm-category-toggle]").click()
            page.wait_for_selector("[data-dm-select-job]")
            row_menu = page.locator("[data-dm-row-menu]").first
            row_menu.click()
            menu = page.locator(".dm-row-menu-floating")
            before = menu.element_handle()
            for _ in range(8):
                page.evaluate("window.__cacatoolsRequestDownloadManagerRender({ force: true })")
            after = page.locator(".dm-row-menu-floating")
            if after.count() != 1 or not after.is_visible():
                failures.append("Menú contextual perdió apertura durante refresh")
            browser.close()
    finally:
        with contextlib.suppress(Exception):
            server.shutdown()
            server.server_close()
    if failures:
        for failure in failures:
            print(f"FAIL: {failure}")
        return 1
    print("PASS: transient controls preserve open state, value, focus and node identity across refresh cycles.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
