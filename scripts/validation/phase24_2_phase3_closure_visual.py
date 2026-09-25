#!/usr/bin/env python3
"""Visual interaction gate for the final Phase 3 closure."""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
REPORT = ROOT / "docs" / "tests" / "phase24-2-phase3-closure-visual.json"
SCREENSHOTS = ROOT / "docs" / "screenshots" / "phase24-2-phase3-closure"
MODULES = (
    "app-ui/download-manager/core/constants.js",
    "app-ui/download-manager/core/model.js",
    "app-ui/download-manager/view/icons.js",
    "app-ui/download-manager/view/shared.js",
    "app-ui/download-manager/view/sections.js",
    "app-ui/download-manager/view/unified.js",
    "app-ui/download-manager/view/zen-sidebar.js",
    "app-ui/download-manager/view/dialogs.js",
    "app-ui/download-manager/index.js",
)


def bundle() -> str:
    output: list[str] = []
    for relative in MODULES:
        source = (ROOT / relative).read_text(encoding="utf-8")
        source = re.sub(r"^import\s+[^;]+;\s*$", "", source, flags=re.MULTILINE)
        source = re.sub(r"\bexport\s+(?=(?:const|let|var|function|class)\b)", "", source)
        source = re.sub(r"\bexport\s*\{[^}]*\};?", "", source, flags=re.DOTALL)
        output.append(source)
    return "\n".join(output)


def main() -> int:
    css = (ROOT / "app-ui" / "download-manager" / "styles.css").read_text(encoding="utf-8")
    html = f"<!doctype html><html><head><style>html,body,#fixture{{width:100%;height:100%;margin:0;overflow:hidden}}{css}</style></head><body><main id='fixture'></main></body></html>"
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    checks: list[dict[str, Any]] = []

    def check(name: str, passed: bool, detail: Any = None) -> None:
        checks.append({"name": name, "pass": bool(passed), "detail": detail})

    with sync_playwright() as playwright:
        executable = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE")
        launch = {"headless": True, "args": ["--no-sandbox", "--disable-dev-shm-usage"]}
        if executable:
            launch["executable_path"] = executable
        browser = playwright.chromium.launch(**launch)
        page = browser.new_page(viewport={"width": 1180, "height": 780})
        page.set_content(html, wait_until="load")
        page.add_script_tag(content=bundle())
        page.evaluate(
            """() => {
              const job={id:1,title:'Video de prueba descargado.mp4',detail:'Completado',status:'completed',progress:100,downloaded_bytes:34100000,total_bytes:34100000,speed_bps:0,eta_seconds:null,kind:'video',engine:'yt-dlp',category:'Vídeo',origin:'yt-dlp',thumbnail:'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="320" height="180"%3E%3Crect width="100%25" height="100%25" fill="%2318273a"/%3E%3Ctext x="50%25" y="50%25" fill="white" text-anchor="middle" dominant-baseline="middle" font-size="24"%3EVideo%3C/text%3E%3C/svg%3E',updated_at:'2026-08-06T20:00:00Z'};
              const context={snapshot:{jobs:[job],playlist_batches:[]},pendingJobs:[],invoke:async()=>null,runtimeStatus:{mode:'local'},mediaRuntimeStatus:{},downloadDirectory:'C:\\Downloads',schedules:[],onNewDownload:()=>{},onAnalyzeSource:async()=>{},onRefresh:async()=>{},onToast:()=>{},onSection:()=>{},onRerender:()=>{},onOpenPlayer:()=>{}};
              document.querySelector('#fixture').innerHTML=renderDownloadManager(context);
              bindDownloadManager(context);
            }"""
        )
        trigger = page.locator(".dm-player-trigger").first
        overlay = page.locator(".dm-player-overlay").first
        before_box = trigger.bounding_box()
        before = overlay.evaluate("el => ({opacity:getComputedStyle(el).opacity,visibility:getComputedStyle(el).visibility,border:getComputedStyle(el).borderColor})")
        page.screenshot(path=str(SCREENSHOTS / "thumbnail-normal.png"), full_page=True)
        trigger.hover()
        page.wait_for_timeout(180)
        after_box = trigger.bounding_box()
        after = overlay.evaluate("el => ({opacity:getComputedStyle(el).opacity,visibility:getComputedStyle(el).visibility,border:getComputedStyle(el).borderColor})")
        page.screenshot(path=str(SCREENSHOTS / "thumbnail-hover.png"), full_page=True)
        focus_outline = trigger.evaluate("el => { el.focus(); return getComputedStyle(el).outlineStyle; }")
        check("Play oculto en estado normal", float(before["opacity"]) == 0 and before["visibility"] == "hidden", before)
        check("Play visible en hover", float(after["opacity"]) >= 0.99 and after["visibility"] == "visible", after)
        check("Hover no mueve ni redimensiona la miniatura", before_box == after_box, {"before": before_box, "after": after_box})
        check("Foco de teclado permanece accesible", focus_outline != "none", focus_outline)
        browser.close()

    report = {"phase": "0.24.2-phase3-final-closure-visual", "checks": checks, "passed": all(item["pass"] for item in checks)}
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if not report["passed"]:
        for item in checks:
            if not item["pass"]:
                print(f"FAIL: {item['name']} · {item['detail']}")
        return 1
    print("OK: play de miniatura validado en estado normal, hover y foco sin desplazamiento.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
