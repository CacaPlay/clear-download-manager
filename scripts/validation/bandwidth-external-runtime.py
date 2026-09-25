#!/usr/bin/env python3
from __future__ import annotations

import contextlib
import hashlib
import http.server
import json
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PAYLOAD = bytes(index % 251 for index in range(8_250_000))
EXPECTED_SHA256 = hashlib.sha256(PAYLOAD).hexdigest()
LIMIT = 1_000_000
CREATE_NO_WINDOW = 0x08000000 if hasattr(subprocess, "CREATE_NO_WINDOW") else 0


class RangeHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args: object) -> None:
        pass

    def _selection(self) -> tuple[int, int, bool]:
        value = self.headers.get("Range", "")
        if not value.startswith("bytes="):
            return 0, len(PAYLOAD) - 1, False
        raw_start, _, raw_end = value.removeprefix("bytes=").partition("-")
        start = int(raw_start or 0)
        end = min(int(raw_end) if raw_end else len(PAYLOAD) - 1, len(PAYLOAD) - 1)
        if start < 0 or start > end:
            self.send_error(416)
            raise ValueError("invalid range")
        return start, end, True

    def _respond(self, include_body: bool) -> None:
        try:
            start, end, partial = self._selection()
        except ValueError:
            return
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Disposition", 'attachment; filename="fixture.bin"')
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{len(PAYLOAD)}")
        self.send_header("Connection", "close")
        self.end_headers()
        if include_body:
            self.wfile.write(PAYLOAD[start : end + 1])

    def do_HEAD(self) -> None:
        self._respond(False)

    def do_GET(self) -> None:
        self._respond(True)


def run_engine(name: str, command: list[str], output: Path) -> dict[str, object]:
    started = time.perf_counter()
    process = subprocess.Popen(
        command,
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        creationflags=CREATE_NO_WINDOW,
    )
    transfer_started: float | None = None
    initial_bytes = 0
    observed_bytes = 0
    partial = Path(f"{output}.part")
    while process.poll() is None:
        current_bytes = max(
            output.stat().st_size if output.is_file() else 0,
            partial.stat().st_size if partial.is_file() else 0,
        )
        if current_bytes > 0 and transfer_started is None:
            transfer_started = time.perf_counter()
            initial_bytes = current_bytes
        observed_bytes = max(observed_bytes, current_bytes)
        if time.perf_counter() - started > 30:
            process.kill()
            raise RuntimeError(f"{name} excedió el timeout local")
        time.sleep(0.025)
    stdout, stderr = process.communicate(timeout=2)
    completed_at = time.perf_counter()
    total_elapsed = completed_at - started
    if process.returncode != 0:
        detail = (stderr or stdout).strip()[-800:]
        raise RuntimeError(f"{name} terminó con {process.returncode}: {detail}")
    if not output.is_file():
        raise RuntimeError(f"{name} no creó el archivo esperado")
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    if digest != EXPECTED_SHA256:
        raise RuntimeError(f"{name} alteró el contenido: {digest}")
    final_bytes = output.stat().st_size
    if transfer_started is None or observed_bytes <= initial_bytes:
        transfer_started = started
        initial_bytes = 0
    transfer_elapsed = completed_at - transfer_started
    measured = final_bytes / total_elapsed
    if not 600_000 <= measured <= 1_400_000:
        raise RuntimeError(f"{name} se desvió multiplicativamente: {measured:.0f} B/s")
    return {
        "engine": name,
        "bytes": final_bytes,
        "totalElapsedSeconds": round(total_elapsed, 3),
        "measuredTransferSeconds": round(transfer_elapsed, 3),
        "bytesPerSecond": round(measured),
        "sha256": digest,
    }


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), RangeHandler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
url = f"http://127.0.0.1:{server.server_address[1]}/fixture.bin"

try:
    curl = shutil.which("curl.exe")
    if not curl:
        raise RuntimeError("curl.exe no está disponible para el QA local")
    aria2 = ROOT / "src-tauri" / "resources" / "bin" / "aria2c.exe"
    yt_dlp = ROOT / "src-tauri" / "resources" / "bin" / "yt-dlp.exe"
    if not aria2.is_file() or not yt_dlp.is_file():
        raise RuntimeError("Los binarios empaquetados aria2c/yt-dlp no están disponibles")

    with tempfile.TemporaryDirectory(prefix="cacatools-bandwidth-") as temporary:
        temp = Path(temporary)
        results = [
            run_engine(
                "curl",
                [curl, "--fail", "--silent", "--show-error", "--limit-rate", str(LIMIT), "--output", str(temp / "curl.bin"), url],
                temp / "curl.bin",
            ),
            run_engine(
                "aria2c",
                [
                    str(aria2),
                    "--no-conf=true",
                    "--file-allocation=none",
                    "--allow-overwrite=true",
                    "--auto-file-renaming=false",
                    "--summary-interval=0",
                    f"--max-download-limit={LIMIT}",
                    f"--dir={temp}",
                    "--out=aria2.bin",
                    url,
                ],
                temp / "aria2.bin",
            ),
            run_engine(
                "yt-dlp",
                [
                    str(yt_dlp),
                    "--no-config",
                    "--no-playlist",
                    "--quiet",
                    "--no-warnings",
                    "--limit-rate",
                    str(LIMIT),
                    "--output",
                    str(temp / "yt-dlp.bin"),
                    url,
                ],
                temp / "yt-dlp.bin",
            ),
        ]
finally:
    with contextlib.suppress(Exception):
        server.shutdown()
        server.server_close()

print(json.dumps(results, ensure_ascii=False))
print("OK: curl, aria2c and yt-dlp honored 1 MB/s on loopback and preserved SHA-256.")
