#!/usr/bin/env python3
"""Deterministic gates for the post-Feature-06 human-review fixes."""
from __future__ import annotations

import argparse
import contextlib
import http.server
import json
import os
import subprocess
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[2]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args: object) -> None:
        pass


def source_gate() -> list[str]:
    failures: list[str] = []
    shared = (ROOT / "app-ui/download-manager/view/shared.js").read_text(encoding="utf-8")
    unified = (ROOT / "app-ui/download-manager/view/unified.js").read_text(encoding="utf-8")
    css = (ROOT / "app-ui/download-manager/styles/05-overrides.css").read_text(encoding="utf-8")
    main = (ROOT / "app-ui/main.js").read_text(encoding="utf-8")
    lib = (ROOT / "src-tauri/src/lib.rs").read_text(encoding="utf-8")
    if "role=\"menuitemradio\"" not in shared or "aria-checked" not in shared:
        failures.append("Los controles de prioridad perdieron semántica radio accesible")
    if "grid-template-columns:repeat(3,minmax(0,1fr))" not in css:
        failures.append("La sección de prioridad no tiene layout de tres controles en una fila")
    if "dm-priority-meta" not in unified or "priorityMetaMarkup" not in unified:
        failures.append("La prioridad no se renderiza como metadata inline")
    if "priorityBadgeMarkup" in unified or "dm-priority-badge" in unified:
        failures.append("El indicador legacy de prioridad sigue en el markup")
    if "settingsEditingIsActive" not in main or ".settings-workspace input" not in main:
        failures.append("El boundary de edición de Settings no protege inputs activos")
    if "__cacatoolsRequestDownloadManagerRender" not in main:
        failures.append("Falta el boundary de refresh determinista para el gate de Settings")
    if "la beta final incluirá yt-dlp" in lib.lower():
        failures.append("Quedó copy obsoleto de beta en el fallback del resolver")
    return failures


def resource_gate(artifact: Path | None) -> list[dict[str, object]]:
    if artifact is None:
        return [{"name": "bundled-resource-resolution", "pass": True, "deferred": True, "detail": "Se ejecutará con --artifact-root sobre la carpeta final."}]
    bin_dir = artifact / "resources" / "bin"
    checks = {
        "yt-dlp": "yt-dlp.exe",
        "ffmpeg": "ffmpeg.exe",
        "ffprobe": "ffprobe.exe",
        "deno": "deno.exe",
        "aria2c": "aria2c.exe",
    }
    results: list[dict[str, object]] = []
    safe_env = os.environ.copy()
    safe_env["PATH"] = ""
    for key in ("CACATOOLS_YTDLP", "CACATOOLS_FFMPEG", "CACATOOLS_FFPROBE", "CACATOOLS_DENO", "CACATOOLS_ARIA2C"):
        safe_env.pop(key, None)
    for name, filename in checks.items():
        path = bin_dir / filename
        detail = "missing"
        passed = path.is_file()
        if passed:
            probe_args = ["--version", "-version"] if name in {"ffmpeg", "ffprobe"} else ["--version"]
            try:
                completed = None
                for argument in probe_args:
                    attempt = subprocess.run([str(path), argument], capture_output=True, text=True, timeout=15, env=safe_env)
                    if attempt.returncode == 0:
                        completed = attempt
                        break
                    completed = attempt
                passed = bool(completed and completed.returncode == 0)
                detail = (completed.stdout or completed.stderr).splitlines()[0][:160] if passed else f"exit={completed.returncode if completed else 'unknown'}"
            except (OSError, subprocess.SubprocessError) as error:
                passed = False
                detail = type(error).__name__
        results.append({"name": name, "pass": passed, "path": str(path), "detail": detail})
    return results


def browser_gate() -> dict[str, object]:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), lambda *args, **kwargs: QuietHandler(*args, directory=str(ROOT), **kwargs))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    errors: list[str] = []
    result: dict[str, object] = {"pass": False, "errors": errors}
    browser = None
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1180, "height": 780}, reduced_motion="reduce")
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(f"http://127.0.0.1:{server.server_address[1]}/?preview=1&view=downloads", wait_until="domcontentloaded", timeout=15_000)
            page.wait_for_function("typeof window.__cacatoolsRequestDownloadManagerRender === 'function'")
            page.locator('[data-dm-open-settings]').first.click()
            page.locator('[data-settings-category="downloads"]').click()
            page.locator('#bandwidth-limit-select').select_option('custom')
            page.wait_for_selector('#bandwidth-custom-value')
            stability = page.evaluate(
                """() => {
                  const input = document.getElementById('bandwidth-custom-value');
                  const select = document.getElementById('bandwidth-limit-select');
                  input.focus();
                  input.value = '7';
                  input.dispatchEvent(new Event('input', { bubbles: true }));
                  const before = input;
                  for (let i = 0; i < 6; i += 1) window.__cacatoolsRequestDownloadManagerRender({ force: true });
                  const after = document.getElementById('bandwidth-custom-value');
                  const protectedState = {
                    sameNode: before === after,
                    focused: document.activeElement === after,
                    value: after?.value || '',
                    customSelected: document.getElementById('bandwidth-limit-select')?.value === 'custom',
                    visible: Boolean(after && after.offsetParent)
                  };
                  document.body.focus();
                  window.__cacatoolsRequestDownloadManagerRender({ force: true });
                  return {
                    ...protectedState,
                    restoredValue: document.getElementById('bandwidth-custom-value')?.value || '',
                    restoredSelected: document.getElementById('bandwidth-limit-select')?.value === 'custom',
                    editorVisibleAfterBlur: Boolean(document.getElementById('bandwidth-custom-value')?.offsetParent),
                    selectPresent: Boolean(select)
                  };
                }"""
            )
            if not stability["sameNode"] or not stability["focused"] or stability["value"] != "7" or not stability["customSelected"] or not stability["visible"]:
                errors.append(f"El editor custom perdió estado durante refresh: {stability}")
            if stability["restoredValue"] != "7" or not stability["restoredSelected"] or not stability["editorVisibleAfterBlur"]:
                errors.append(f"El editor custom no se conservó tras el refresh diferido: {stability}")
            result["settings"] = stability
            result["pass"] = not errors
    except Exception as error:  # pragma: no cover - surfaced as gate failure
        errors.append(f"browser: {type(error).__name__}: {error}")
    finally:
        if browser is not None:
            with contextlib.suppress(Exception):
                browser.close()
        with contextlib.suppress(Exception):
            server.shutdown()
            server.server_close()
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-root", type=Path, default=None)
    args = parser.parse_args()
    source_failures = source_gate()
    browser = browser_gate()
    resources = resource_gate(args.artifact_root)
    failures = list(source_failures)
    if not browser.get("pass"):
        failures.extend(str(error) for error in browser.get("errors", []))
    if args.artifact_root is not None:
        failures.extend(f"Recurso {item['name']} no resolvió desde BUNDLED: {item.get('detail', '')}" for item in resources if not item.get("pass"))
    payload = {"source": {"pass": not source_failures, "failures": source_failures}, "settings": browser, "resources": resources}
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
