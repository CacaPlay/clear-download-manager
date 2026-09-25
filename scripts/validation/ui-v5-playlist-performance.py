"""Exercise the production V5 playlist virtualizer with 45 and 100+ items."""
from __future__ import annotations

import http.server
import json
import socketserver
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[2]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def serve():
    handler = lambda *args, **kwargs: QuietHandler(*args, directory=str(ROOT), **kwargs)
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def run_case(page, port: int, count: int):
    page.goto(
        f"http://127.0.0.1:{port}/scripts/validation/ui-v5-harness.html?kind=playlist&theme=dark&accent=59d37b&items={count}",
        wait_until="networkidle",
    )
    page.locator('[data-role="url"]').fill("https://www.youtube.com/playlist?list=V5-PERF-FIXTURE")
    page.locator('[data-role="source-form"]').press("Enter")
    page.wait_for_selector(".playlist-layout")
    page.wait_for_timeout(80)
    page.evaluate(
        """() => {
          window.__v5Perf = {mutations: 0};
          const root = document.querySelector('.playlist-layout');
          const content = document.querySelector('[data-role="track-content"]');
          window.__v5Perf.root = root;
          window.__v5Perf.content = content;
          new MutationObserver(() => { window.__v5Perf.mutations += 1; }).observe(root, {childList: true, subtree: true});
        }"""
    )
    before = page.evaluate(
        """() => {
          const list = document.querySelector('[data-role="track-scroll"]');
          const grid = document.querySelector('[data-role="track-content"]');
          const cards = [...grid.querySelectorAll('.track-card')];
          return {
            columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
            totalScrollHeight: list.scrollHeight,
            clientHeight: list.clientHeight,
            renderedCards: cards.length,
            heap: performance.memory?.usedJSHeapSize ?? null,
            rootStable: window.__v5Perf.root === document.querySelector('.playlist-layout'),
            contentStable: window.__v5Perf.content === grid,
          };
        }"""
    )
    page.locator('[data-role="track-scroll"]').hover()
    page.mouse.wheel(0, 900)
    page.wait_for_timeout(60)
    after_scroll = page.evaluate(
        """() => {
          const list = document.querySelector('[data-role="track-scroll"]');
          return {scrollTop: list.scrollTop, heap: performance.memory?.usedJSHeapSize ?? null};
        }"""
    )
    first = page.locator('[data-role="item-check"]').first
    first.evaluate("node => node.click()")
    page.wait_for_timeout(20)
    selected_after_item = page.locator('[data-role="selected-count"]').inner_text()
    page.locator('[data-action="select-all"]').click()
    page.wait_for_timeout(50)
    after_select_all = page.evaluate(
        """() => {
          const grid = document.querySelector('[data-role="track-content"]');
          return {
            selected: document.querySelector('[data-role="selected-count"]').textContent,
            renderedCards: grid.querySelectorAll('.track-card').length,
            rootStable: window.__v5Perf.root === document.querySelector('.playlist-layout'),
            contentStable: window.__v5Perf.content === grid,
            mutations: window.__v5Perf.mutations,
            heap: performance.memory?.usedJSHeapSize ?? null,
          };
        }"""
    )
    heap_values = [value for value in (before["heap"], after_scroll["heap"], after_select_all["heap"]) if value is not None]
    heap_delta = max(heap_values) - min(heap_values) if heap_values else None
    checks = {
        "twoColumns": before["columns"] == 2,
        "scrollable": before["totalScrollHeight"] > before["clientHeight"],
        "wheelScroll": after_scroll["scrollTop"] > 0,
        "virtualized": before["renderedCards"] < min(count, 40),
        "individualSelection": selected_after_item.startswith(f"{count - 1} / ") or selected_after_item.startswith(f"{count} / "),
        "selectAll": after_select_all["selected"] == f"{count} / {count}",
        "noGlobalRootRerender": after_select_all["rootStable"] and after_select_all["contentStable"],
        "boundedMutation": after_select_all["mutations"] < 10,
        "heapDeltaUnder64MiB": heap_delta is None or heap_delta < 64 * 1024 * 1024,
    }
    return {
        "count": count,
        "before": before,
        "afterScroll": after_scroll,
        "afterSelectAll": after_select_all,
        "heapDelta": heap_delta,
        "checks": checks,
        "status": "PASS" if all(checks.values()) else "FAIL",
    }


def main():
    server = serve()
    report = {"status": "PASS", "cases": []}
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, args=["--enable-precise-memory-info"])
            context = browser.new_context(viewport={"width": 1320, "height": 900}, device_scale_factor=1)
            context.add_init_script(
                "localStorage.setItem('ct-ui-theme','dark'); localStorage.setItem('ct-ui-accent','#59d37b'); "
                "localStorage.setItem('cacatools.desktop.appearance.metrics.v1', JSON.stringify({interfaceRatio: 1}));"
            )
            page = context.new_page()
            for count in (45, 120):
                report["cases"].append(run_case(page, server.server_address[1], count))
            browser.close()
    finally:
        server.shutdown()
    if any(case["status"] != "PASS" for case in report["cases"]):
        report["status"] = "FAIL"
    output = ROOT / "docs" / "qa" / "ui-v5" / "playlist-performance-report.json"
    output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "cases": [f"{c['count']}:{c['status']}" for c in report["cases"]]}))
    if report["status"] != "PASS":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
