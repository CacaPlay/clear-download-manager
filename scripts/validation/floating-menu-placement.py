#!/usr/bin/env python3
"""Viewport placement gate for the shared floating row menu."""
from __future__ import annotations

import contextlib
import http.server
import os
import subprocess
import threading
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[2]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args: object) -> None:
        pass


def main() -> int:
    failures: list[str] = []
    fixture_handle = tempfile.NamedTemporaryFile(
        prefix=".cdm-floating-", suffix=".html", dir=ROOT, delete=False
    )
    fixture = Path(fixture_handle.name)
    fixture_handle.close()
    try:
        subprocess.run(
            ["node", str(ROOT / "scripts/validation/phase20_live_fixture.mjs"), str(fixture)],
            cwd=ROOT,
            check=True,
        )
        server = http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0),
            lambda *args, **kwargs: QuietHandler(*args, directory=str(ROOT), **kwargs),
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            fixture_url = fixture.relative_to(ROOT).as_posix()
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                page = browser.new_page(viewport={"width": 620, "height": 520}, reduced_motion="reduce")
                page.goto(
                    f"http://127.0.0.1:{server.server_address[1]}/{fixture_url}",
                    wait_until="domcontentloaded",
                )
                page.wait_for_selector("[data-dm-row-menu]")
                for index, position in enumerate(((20, 20), (600, 20), (20, 500), (600, 500))):
                    page.locator("[data-dm-row-menu]").first.click()
                    page.wait_for_selector(".dm-row-menu-floating")
                    page.evaluate(
                        """async (position) => {
                      const mod = await import('/app-ui/download-manager/events.js');
                      mod.settleFloatingRowMenu(document.querySelector('.dm-host'), {
                        x: position[0], y: position[1], above: position[1], alignRight: true
                      });
                      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                    }""",
                        list(position),
                    )
                    page.wait_for_timeout(50)
                    rect = page.locator(".dm-row-menu-floating").bounding_box()
                    viewport = page.evaluate("({ width: innerWidth, height: innerHeight })")
                    if not rect:
                        failures.append(f"Caso {index}: menú sin geometría")
                    elif not (
                        rect["x"] >= 8
                        and rect["y"] >= 8
                        and rect["x"] + rect["width"] <= viewport["width"] - 8
                        and rect["y"] + rect["height"] <= viewport["height"] - 8
                    ):
                        failures.append(f"Caso {index}: menú fuera de viewport: {rect} / {viewport}")
                    appearance = page.locator(".dm-row-menu-floating").evaluate(
                        """(menu) => {
                      const style = getComputedStyle(menu);
                      return {
                        background: style.backgroundColor,
                        color: style.color,
                        border: style.borderTopColor,
                        shadow: style.boxShadow
                      };
                        }"""
                    )
                    if appearance["background"] in {"transparent", "rgba(0, 0, 0, 0)"}:
                        failures.append(f"Caso {index}: menú sin fondo resuelto: {appearance}")
                    if appearance["color"] in {"transparent", "rgba(0, 0, 0, 0)"}:
                        failures.append(f"Caso {index}: menú sin color resuelto: {appearance}")
                    page.keyboard.press("Escape")
                browser.close()
        finally:
            with contextlib.suppress(Exception):
                server.shutdown()
                server.server_close()
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(fixture)
    if failures:
        for failure in failures:
            print(f"FAIL: {failure}")
        return 1
    print("PASS: floating menus remain reachable inside the viewport at 620x520 corner cases.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
