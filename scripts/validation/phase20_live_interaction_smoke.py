#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
REPORT = ROOT / "docs/tests/phase20-live-interaction-smoke.json"
SCREENSHOT = ROOT / "docs/screenshots/phase20-workspaces/search-live-nonblocking-1180x780.png"

with tempfile.NamedTemporaryFile(suffix=".html", delete=False, dir=ROOT) as tmp:
    html = Path(tmp.name)

failures: list[str] = []
metrics: dict[str, object] = {}
try:
    subprocess.run(
        ["node", "scripts/validation/phase20_live_fixture.mjs", str(html)],
        cwd=ROOT,
        check=True,
        timeout=25,
    )
    with sync_playwright() as pw:
        launch_options = {
            "headless": True,
            "args": ["--disable-gpu", "--no-sandbox"],
        }
        executable = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE")
        if not executable and Path("/usr/bin/chromium").exists():
            executable = "/usr/bin/chromium"
        if executable:
            launch_options["executable_path"] = executable
        browser = pw.chromium.launch(**launch_options)
        page = browser.new_page(
            viewport={"width": 1180, "height": 780},
            reduced_motion="reduce",
        )
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.set_content(
            html.read_text(encoding="utf-8"),
            wait_until="domcontentloaded",
            timeout=20_000,
        )
        page.wait_for_selector(".dm-host", timeout=10_000)

        input_box = page.locator("[data-dm-unified-input]")
        input_box.click()
        input_box.type("mini", delay=5)
        page.wait_for_timeout(270)  # Debounce elapsed; the first remote request is pending.
        pending = {
            "focus": page.evaluate(
                "document.activeElement?.matches('[data-dm-unified-input]')"
            ),
            "value": input_box.input_value(),
            "suggestions": page.locator(".dm-unified-suggestions>button").count(),
        }

        # Keep typing while the first request remains unresolved.
        input_box.type("malistas", delay=5)
        page.wait_for_timeout(270)
        while_remote = {
            "focus": page.evaluate(
                "document.activeElement?.matches('[data-dm-unified-input]')"
            ),
            "value": input_box.input_value(),
            "suggestions": page.locator(".dm-unified-suggestions>button").count(),
        }

        patch = page.evaluate(
            """() => window.phase20Patch({
              jobs: [
                {
                  id: 1,
                  title: 'Descarga activa.mp4',
                  detail: 'Descargando sin recargar',
                  status: 'running',
                  progress: 47,
                  downloaded_bytes: 47000000,
                  total_bytes: 100000000,
                  speed_bps: 3250000,
                  eta_seconds: 16,
                  kind: 'video',
                  engine: 'yt-dlp',
                  thumbnail: '',
                  source_url: 'https://example.com/a',
                  destination: 'C:/Temp/a.mp4',
                  updated_at: '2'
                },
                {
                  id: 2,
                  title: 'Archivo terminado.pdf',
                  detail: 'PDF',
                  status: 'completed',
                  progress: 100,
                  downloaded_bytes: 500000,
                  total_bytes: 500000,
                  speed_bps: 0,
                  eta_seconds: null,
                  kind: 'file',
                  engine: 'http-range',
                  source_url: 'https://example.com/a.pdf',
                  destination: 'C:/Temp/a.pdf',
                  updated_at: '1'
                }
              ],
              playlist_batches: []
            })"""
        )
        page.wait_for_timeout(520)

        suggestion_texts = page.locator(
            ".dm-unified-suggestions>button strong"
        ).all_text_contents()
        after = {
            "focus": page.evaluate(
                "document.activeElement?.matches('[data-dm-unified-input]')"
            ),
            "value": input_box.input_value(),
            # The current product order intentionally keeps newest insertion
            # first, so select the running fixture by its stable job id
            # instead of assuming it is the first visible row.
            "progress": page.locator(
                '.dm-download-item[data-dm-select-job="1"] .dm-progress-wrap strong'
            ).text_content(),
            "selected": page.locator(".dm-download-item.is-selected").count(),
            "suggestions": suggestion_texts,
            "queries": page.evaluate("window.phase20SuggestionQueries"),
            "max_active_queries": page.evaluate("window.phase20SuggestionMaxActive"),
        }
        before = {
            "focus": pending["focus"],
            "value": while_remote["value"],
            "suggestions": while_remote["suggestions"],
            "selected": page.locator(".dm-download-item.is-selected").count(),
        }
        metrics = {
            "pending": pending,
            "while_remote": while_remote,
            "before": before,
            "after": after,
            "patch": patch,
            "page_errors": errors,
        }
        SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(
            path=str(SCREENSHOT),
            full_page=False,
            animations="disabled",
            timeout=15_000,
        )

        if errors:
            failures.append(f"JS: {errors}")
        if not pending["focus"] or not while_remote["focus"] or not after["focus"]:
            failures.append("live update or pending suggestions removed search focus")
        if (
            pending["value"] != "mini"
            or while_remote["value"] != "minimalistas"
            or after["value"] != "minimalistas"
        ):
            failures.append("typing was blocked or live update changed query")
        if pending["suggestions"] and while_remote["suggestions"] and pending["suggestions"] != while_remote["suggestions"]:
            failures.append("pending search changed the visible suggestion count unexpectedly")
        if any(text.startswith("mini resultado") for text in after["suggestions"]):
            failures.append("stale suggestion response replaced latest query")
        if after["max_active_queries"] > 2:
            failures.append("predictive search created an unbounded request storm")
        # One current query may legitimately fetch two pages; the obsolete
        # first query contributes one request before latest-request-wins drops
        # its result.  More than three indicates a debounce/request storm.
        if len(after["queries"]) > 3:
            failures.append("typing generated more remote requests than the debounce permits")
        if not any(text.startswith("minimalistas") for text in after["suggestions"]):
            failures.append("latest remote suggestions were not rendered")
        if not patch or "47" not in str(after["progress"]):
            failures.append("download progress did not patch in place")
        if before["selected"] != after["selected"]:
            failures.append("live update reset row selection")
        browser.close()
finally:
    html.unlink(missing_ok=True)

REPORT.parent.mkdir(parents=True, exist_ok=True)
REPORT.write_text(
    json.dumps(
        {"passed": not failures, "failures": failures, "metrics": metrics},
        indent=2,
        ensure_ascii=False,
    ),
    encoding="utf-8",
)
if failures:
    print(json.dumps({"failures": failures, "metrics": metrics}, indent=2, ensure_ascii=False))
    raise SystemExit(1)
print("OK: búsqueda no bloqueante, respuesta obsoleta descartada y progreso en vivo")
