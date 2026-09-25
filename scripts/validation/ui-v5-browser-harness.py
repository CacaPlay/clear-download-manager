"""Render V5 reference and production DOM with the same fixtures before Tauri build."""
from __future__ import annotations

import http.server
import json
import os
import socketserver
import tempfile
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[2]
REFERENCE = Path(os.environ.get(
    "CACATOOLS_UI_V5_REFERENCE",
    ROOT / "docs" / "ui-reference" / "CacaTools-UI-v5",
)).expanduser().resolve()
OUT: Path | None = None


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def serve(directory: Path):
    handler = lambda *args, **kwargs: QuietHandler(*args, directory=str(directory), **kwargs)
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


SELECTORS = {
    "titlebar": ".titlebar",
    "header": ".page-header",
    "url_row": ".url-row",
    "analyze": '[data-action="analyze"]',
    "footer": ".footer",
    "media_hero": ".media-hero",
    "thumbnail": ".media-thumb",
    "media_copy": ".media-copy",
    "media_title": ".media-title",
    "format_panel": ".media-options > .panel:nth-child(1)",
    "destination_panel": ".media-options > .panel:nth-child(2)",
    "playlist_layout": ".playlist-layout",
    "playlist_side": ".playlist-side",
    "playlist_summary": ".playlist-summary",
    "select_all": ".select-all",
    "track_grid": ".track-grid",
    "track_card": ".track-card",
    "track_thumb": ".track-thumb",
    "track_copy": ".track-copy",
    "http_info": ".http-info",
    "file_hero": ".file-hero",
    "file_poster": ".file-poster",
    "http_destination": ".http-destination",
}

KIND_SELECTORS = {
    "multimedia": ("titlebar", "header", "url_row", "analyze", "footer", "media_hero", "thumbnail", "media_copy", "media_title", "format_panel", "destination_panel"),
    "playlist": ("titlebar", "header", "url_row", "analyze", "footer", "playlist_layout", "playlist_side", "playlist_summary", "select_all", "track_grid", "track_card", "track_thumb", "track_copy"),
    "http": ("titlebar", "header", "url_row", "analyze", "footer", "http_info", "file_hero", "file_poster", "http_destination"),
}


def harness_url(port: int, kind: str, theme: str, accent: str) -> str:
    return f"http://127.0.0.1:{port}/scripts/validation/ui-v5-harness.html?kind={kind}&theme={theme}&accent={accent[1:]}"


def reference_url(port: int, kind: str) -> str:
    page = {"multimedia": "multimedia.html", "playlist": "playlist.html", "http": "http.html"}[kind]
    return f"http://127.0.0.1:{port}/{page}"


def fixture_source(kind: str) -> str:
    if kind == "playlist":
        return "https://www.youtube.com/playlist?list=V5-FIXTURE"
    if kind == "http":
        return "https://example.test/download/phase-v5-fixture.bin"
    return "https://youtu.be/Lg2UXs9SDx4"


def collect(page):
    return page.evaluate(
        """(selectors) => {
          const result = {};
          for (const [name, selector] of Object.entries(selectors)) {
            const node = document.querySelector(selector);
            if (!node) { result[name] = null; continue; }
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            result[name] = {x: rect.x, y: rect.y, width: rect.width, height: rect.height, fontSize: parseFloat(style.fontSize)};
          }
          const thumb = document.querySelector('.media-thumb, .track-thumb');
          if (thumb) { const r = thumb.getBoundingClientRect(); result.thumbnailRatio = r.width / r.height; }
          return result;
        }""",
        SELECTORS,
    )


def compare(reference, production, names):
    rows = []
    for name in names:
        a, b = reference.get(name), production.get(name)
        if not a or not b:
            rows.append({"element": name, "reference": a, "production": b, "pass": False, "reason": "missing"})
            continue
        deltas = {key: b[key] - a[key] for key in ("x", "y", "width", "height")}
        font_delta = b["fontSize"] - a["fontSize"]
        ok = all(abs(value) <= 3 for value in deltas.values()) and abs(font_delta) <= 1
        rows.append({"element": name, "reference": a, "production": b, "delta": deltas, "fontDelta": font_delta, "pass": ok})
    if "thumbnail" in names or "track_thumb" in names:
        ratio_ok = abs((production.get("thumbnailRatio") or 0) - 16 / 9) <= .015 and abs((reference.get("thumbnailRatio") or 0) - 16 / 9) <= .015
        rows.append({"element": "thumbnailRatio", "reference": reference.get("thumbnailRatio"), "production": production.get("thumbnailRatio"), "pass": ratio_ok})
    return rows


def side_by_side(reference_path: Path, production_path: Path, output_path: Path):
    reference = Image.open(reference_path).convert("RGB")
    production = Image.open(production_path).convert("RGB")
    width = reference.width + production.width
    height = max(reference.height, production.height) + 28
    canvas = Image.new("RGB", (width, height), "#ffffff")
    canvas.paste(reference, (0, 28))
    canvas.paste(production, (reference.width, 28))
    draw = ImageDraw.Draw(canvas)
    draw.text((8, 8), "REFERENCE", fill="#111111")
    draw.text((reference.width + 8, 8), "PRODUCTION", fill="#111111")
    canvas.save(output_path)


def main():
    global OUT
    if not REFERENCE.is_dir():
        raise SystemExit(
            "UI V5 reference is unavailable. Set CACATOOLS_UI_V5_REFERENCE to an "
            "existing reference directory or restore docs/ui-reference/CacaTools-UI-v5."
        )
    output_override = os.environ.get("CACATOOLS_UI_V5_OUTPUT")
    if output_override:
        OUT = Path(output_override).expanduser().resolve()
        if OUT.exists():
            raise SystemExit(f"UI V5 output already exists and will not be overwritten: {OUT}")
        OUT.mkdir(parents=True)
    else:
        OUT = Path(tempfile.mkdtemp(prefix="cdm-ui-v5-harness-"))
    production_server, production_port = serve(ROOT)
    reference_server, reference_port = serve(REFERENCE)
    report = {"viewport": {"width": 1320, "height": 900}, "cases": [], "status": "PASS"}
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for theme, accent in (("dark", "#59d37b"), ("light", "#4d9dff")):
              for kind in ("multimedia", "playlist", "http"):
                context = browser.new_context(viewport={"width": 1320, "height": 900}, device_scale_factor=1)
                context.add_init_script(f"localStorage.setItem('ct-ui-theme', '{theme}'); localStorage.setItem('ct-ui-accent', '{accent}'); localStorage.setItem('cacatools.desktop.appearance.metrics.v1', JSON.stringify({{interfaceRatio: 1}}));")
                ref_page = context.new_page()
                prod_page = context.new_page()
                ref_page.goto(reference_url(reference_port, kind), wait_until="networkidle")
                prod_page.goto(harness_url(production_port, kind, theme, accent), wait_until="networkidle")
                main_selector = {"multimedia": ".media-hero", "playlist": ".playlist-layout", "http": ".http-layout"}[kind]
                ref_page.wait_for_selector(main_selector)
                prod_page.locator('[data-role="url"]').fill(fixture_source(kind))
                prod_page.locator('[data-role="source-form"]').press("Enter")
                prod_page.wait_for_selector(main_selector)
                ref = collect(ref_page)
                prod = collect(prod_page)
                case = {"kind": kind, "theme": theme, "accent": accent, "rows": compare(ref, prod, KIND_SELECTORS[kind])}
                reference_path = OUT / f"reference-{kind}-{theme}.png"
                production_path = OUT / f"production-{kind}-{theme}.png"
                ref_page.screenshot(path=str(reference_path), full_page=True)
                prod_page.screenshot(path=str(production_path), full_page=True)
                side_by_side(reference_path, production_path, OUT / f"side-by-side-{kind}-{theme}.png")
                case["status"] = "PASS" if all(row["pass"] for row in case["rows"]) else "FAIL"
                report["cases"].append(case)
                context.close()
            browser.close()
    finally:
        production_server.shutdown()
        reference_server.shutdown()
    if any(case["status"] != "PASS" for case in report["cases"]):
        report["status"] = "FAIL"
    (OUT / "geometry-report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "cases": [case["kind"] + ':' + case["status"] for case in report["cases"]]}, ensure_ascii=False))
    if report["status"] != "PASS":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
