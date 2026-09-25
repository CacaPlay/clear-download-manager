#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
REPORT = ROOT / "docs/tests/phase22-internal-workspace-smoke.json"
SCREENSHOT = ROOT / "docs/screenshots/phase22/internal-workspace-1920x1080.png"


def free_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def rect(page):
    return page.locator("[data-floating-download-dialog]").bounding_box()


port = free_port()
server = subprocess.Popen(
    [sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"],
    cwd=ROOT,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
failures: list[str] = []
metrics: dict[str, object] = {}
try:
    time.sleep(0.5)
    with sync_playwright() as pw:
        launch_options = {"headless": True, "args": ["--disable-gpu", "--no-sandbox"]}
        executable = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE")
        if not executable and Path("/usr/bin/chromium").exists():
            executable = "/usr/bin/chromium"
        if executable:
            launch_options["executable_path"] = executable
        browser = pw.chromium.launch(**launch_options)
        page = browser.new_page(viewport={"width": 1920, "height": 1080}, reduced_motion="reduce")
        page.goto(f"http://127.0.0.1:{port}/?preview=1&dialog=video", wait_until="domcontentloaded")
        page.wait_for_selector("[data-floating-download-dialog]", timeout=10_000)

        initial = rect(page)
        header = page.locator(".dm-floating-workspace>.dialog-header").bounding_box()
        assert initial and header
        page.mouse.move(header["x"] + 250, header["y"] + header["height"] / 2)
        page.mouse.down()
        page.mouse.move(header["x"] + 360, header["y"] + header["height"] / 2 + 54, steps=10)
        page.mouse.up()
        moved = rect(page)

        handle = page.locator('[data-dialog-resize="se"]').bounding_box()
        assert moved and handle
        page.mouse.move(handle["x"] + handle["width"] / 2, handle["y"] + handle["height"] / 2)
        page.mouse.down()
        page.mouse.move(handle["x"] + 96, handle["y"] + 62, steps=10)
        page.mouse.up()
        resized = rect(page)

        page.get_by_role("button", name="Maximizar subventana").click()
        maximized = rect(page)
        page.get_by_role("button", name="Restaurar subventana").click()
        restored = rect(page)

        dialog = page.locator("[data-floating-download-dialog]")
        source = dialog.get_by_role("textbox")
        source.fill("https://example.com/demo.mp4")
        page.get_by_role("button", name="Cerrar centro de descarga").click()
        closed = page.locator("[data-floating-download-dialog]").count() == 0
        page.get_by_role("button", name="Archivo o enlace").click()
        page.wait_for_selector("[data-floating-download-dialog]")
        reopened_value = page.locator("[data-floating-download-dialog]").get_by_role("textbox").input_value()

        page.set_viewport_size({"width": 800, "height": 620})
        page.wait_for_timeout(120)
        compact = rect(page)
        document_overflow = page.evaluate(
            "()=>({x:document.documentElement.scrollWidth-innerWidth,y:document.documentElement.scrollHeight-innerHeight})"
        )
        page.set_viewport_size({"width": 1920, "height": 1080})
        page.wait_for_timeout(100)
        SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SCREENSHOT), animations="disabled")
        browser.close()

        metrics = {
            "initial": initial,
            "moved": moved,
            "resized": resized,
            "maximized": maximized,
            "restored": restored,
            "closed": closed,
            "reopened_value": reopened_value,
            "compact": compact,
            "document_overflow": document_overflow,
        }
        if moved["x"] < initial["x"] + 80 or moved["y"] < initial["y"] + 35:
            failures.append("drag did not update the window geometry")
        if resized["width"] < moved["width"] + 60 or resized["height"] < moved["height"] + 35:
            failures.append("south-east resize did not enlarge the window")
        if maximized["x"] > 13 or maximized["y"] > 13 or maximized["width"] < 1890:
            failures.append("maximize did not fill the useful area")
        if abs(restored["width"] - resized["width"]) > 2 or abs(restored["height"] - resized["height"]) > 2:
            failures.append("restore did not recover the resized geometry")
        if not closed or reopened_value != "https://example.com/demo.mp4":
            failures.append("close/reopen did not preserve the current state")
        if compact["x"] < 11 or compact["y"] < 11 or compact["x"] + compact["width"] > 789 or compact["y"] + compact["height"] > 609:
            failures.append("compact viewport did not clamp the window inside the app")
        if document_overflow["x"] > 0 or document_overflow["y"] > 0:
            failures.append("compact viewport produced document overflow")
finally:
    server.terminate()
    try:
        server.wait(timeout=5)
    except subprocess.TimeoutExpired:
        server.kill()

REPORT.parent.mkdir(parents=True, exist_ok=True)
REPORT.write_text(json.dumps({"passed": not failures, "failures": failures, "metrics": metrics}, indent=2), encoding="utf-8")
if failures:
    print(json.dumps({"failures": failures, "metrics": metrics}, indent=2))
    raise SystemExit(1)
print("OK: subventana interna movible, redimensionable, maximizable, restaurable y persistente")
