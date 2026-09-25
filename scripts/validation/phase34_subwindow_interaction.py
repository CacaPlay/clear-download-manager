"""Browser-level contracts for the preparation/player interaction fixes."""
from __future__ import annotations

import http.server
import threading
from pathlib import Path
from socketserver import ThreadingTCPServer

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[2]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def main() -> None:
    handler = lambda *args, **kwargs: QuietHandler(*args, directory=str(ROOT), **kwargs)
    server = ThreadingTCPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1320, "height": 900}, device_scale_factor=1)
            context.add_init_script(
                "localStorage.setItem('ct-ui-theme','dark');"
                "localStorage.setItem('ct-ui-accent','#59d37b');"
                "localStorage.setItem('cacatools.desktop.appearance.metrics.v1',"
                "JSON.stringify({interfaceRatio: 1}));"
            )
            page = context.new_page()
            page.goto(
                f"http://127.0.0.1:{port}/scripts/validation/ui-v5-harness.html?kind=multimedia&theme=dark&accent=59d37b",
                wait_until="networkidle",
            )
            page.locator('[data-role="url"]').fill("https://youtu.be/Lg2UXs9SDx4")
            page.locator('[data-role="source-form"]').press("Enter")
            page.wait_for_selector('.media-thumb [data-action="preview"]', state="attached")
            page.evaluate(
                """() => {
                  window.__subwindowCalls = [];
                  const original = window.__TAURI__.core.invoke;
                  window.__TAURI__.core.invoke = async (...args) => {
                    window.__subwindowCalls.push(args[0]);
                    return original(...args);
                  };
                }"""
            )

            play = page.locator('.media-thumb [data-action="preview"]')
            before = play.bounding_box()
            page.locator('.media-thumb').hover()
            page.wait_for_timeout(20)
            box = play.bounding_box()
            assert box is not None
            page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            page.wait_for_timeout(50)
            after_mouse = play.bounding_box()
            calls = page.evaluate("window.__subwindowCalls")
            assert calls.count("open_online_media_player") == 1, calls
            assert before == after_mouse, (before, after_mouse)

            play.focus()
            play.press("Enter")
            page.wait_for_timeout(50)
            calls = page.evaluate("window.__subwindowCalls")
            assert calls.count("open_online_media_player") == 2, calls

            page.locator('.titlebar-left').dispatch_event(
                "pointerdown", {"bubbles": True, "button": 0}
            )
            calls = page.evaluate("window.__subwindowCalls")
            assert calls.count("preparation_window_start_dragging") == 1, calls

            page.set_viewport_size({"width": 1050, "height": 700})
            page.wait_for_timeout(50)
            metrics = page.evaluate(
                """() => {
                  const content = document.querySelector('.content');
                  const titlebar = document.querySelector('.titlebar');
                  const footer = document.querySelector('.footer');
                  return {
                    scrollable: content.scrollHeight > content.clientHeight,
                    titlebarY: titlebar.getBoundingClientRect().y,
                    footerY: footer.getBoundingClientRect().y,
                    contentBottom: content.getBoundingClientRect().bottom,
                  };
                }"""
            )
            assert metrics["scrollable"], metrics
            assert metrics["titlebarY"] == 0, metrics
            assert metrics["footerY"] >= metrics["contentBottom"], metrics
            print("OK: single-click, keyboard, drag hook, stable rect, and reduced-window scroll")
            context.close()
            browser.close()
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
