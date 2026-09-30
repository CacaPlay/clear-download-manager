#!/usr/bin/env python3
"""Viewport placement gate for current per-row actions in the compact layout."""
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
                page.wait_for_selector(".dm-download-item")
                actions = page.locator(".dm-item-actions button")
                if actions.count() == 0:
                    failures.append("Las filas actuales no muestran sus acciones contextuales")
                else:
                    viewport = page.evaluate("({ width: innerWidth, height: innerHeight })")
                    for index in range(actions.count()):
                        button = actions.nth(index)
                        rect = button.bounding_box()
                        row = button.locator("xpath=ancestor::article[contains(@class, 'dm-download-item')]").bounding_box()
                        if not rect or not row:
                            failures.append(f"Acción {index}: falta geometría de botón o fila")
                        elif not (
                            rect["x"] >= 0
                            and rect["y"] >= 0
                            and rect["x"] + rect["width"] <= viewport["width"]
                            and rect["y"] + rect["height"] <= viewport["height"]
                            and rect["x"] >= row["x"]
                            and rect["x"] + rect["width"] <= row["x"] + row["width"]
                        ):
                            failures.append(f"Acción {index}: control fuera de su fila o viewport: {rect} / {row} / {viewport}")
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
    print("PASS: compact download-row actions remain visible inside their rows at 620x520.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
