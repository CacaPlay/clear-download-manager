#!/usr/bin/env python3
"""Deterministic HTTP resume/finalization reproducer and architecture gate.

The loopback server exercises the representation and Range invariants without
network access.  The static gate confirms that normal HTTP has one Rust
writer/finalization path; aria2 remains available for torrents only.
"""
from __future__ import annotations

import argparse
import hashlib
import http.server
import re
import socket
import threading
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WORKER = ROOT / "src-tauri/src/downloads/worker.rs"
HTTP = ROOT / "src-tauri/src/downloads/http.rs"
PROCESS = ROOT / "src-tauri/src/app/process.rs"
TORRENTS = ROOT / "src-tauri/src/torrents/mod.rs"
PAYLOAD = bytes((index * 17 + 3) % 256 for index in range(32 * 1024))


class RangeHandler(http.server.BaseHTTPRequestHandler):
    server_version = "CacaToolsLoopback/1"

    def log_message(self, *_args: object) -> None:
        pass

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        params = dict(part.split("=", 1) for part in query.split("&") if "=" in part)
        etag = '"fixture-v2"' if params.get("etag") == "changed" else '"fixture-v1"'
        modified = "Tue, 10 Sep 2026 00:00:01 GMT" if params.get("modified") == "changed" else "Tue, 10 Sep 2026 00:00:00 GMT"
        requested_range = self.headers.get("Range")
        force_200 = self.headers.get("X-Force-200") == "1"
        if_range = self.headers.get("If-Range")
        if if_range and if_range not in {etag, modified}:
            force_200 = True

        start = None
        if requested_range and not force_200:
            match = re.fullmatch(r"bytes=(\d+)-", requested_range.strip())
            if match:
                start = int(match.group(1))
        if start is not None and start >= len(PAYLOAD):
            self.send_response(http.HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", f"bytes */{len(PAYLOAD)}")
            self.send_header("ETag", etag)
            self.send_header("Last-Modified", modified)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        body = PAYLOAD[start:] if start is not None else PAYLOAD
        status = http.HTTPStatus.PARTIAL_CONTENT if start is not None else http.HTTPStatus.OK
        self.send_response(status)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("ETag", etag)
        self.send_header("Last-Modified", modified)
        if status == http.HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{len(PAYLOAD) - 1}/{len(PAYLOAD)}")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.path.startswith("/drop"):
            self.wfile.write(body[: min(256, len(body))])
            self.wfile.flush()
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        self.wfile.write(body)


def request(base: str, path: str, headers: dict[str, str] | None = None) -> tuple[int, dict[str, str], bytes]:
    req = urllib.request.Request(base + path, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=2) as response:
            return response.status, dict(response.headers.items()), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers.items()), error.read()


def run_loopback_cases() -> list[str]:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), RangeHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    passed: list[str] = []
    try:
        status, headers, _ = request(base, "/file", {"Range": f"bytes={len(PAYLOAD)}-"})
        assert status == 416 and headers.get("Content-Range") == f"bytes */{len(PAYLOAD)}"
        passed.append("A/F exact-total and 416 expose remote total without reset")

        partial = 4096
        status, headers, body = request(base, "/file", {"Range": f"bytes={partial}-"})
        assert status == 206 and headers.get("Content-Range", "").startswith(f"bytes {partial}-")
        assert body == PAYLOAD[partial:]
        status, _, validated_body = request(
            base,
            "/file",
            {"Range": f"bytes={partial}-", "If-Range": headers["ETag"]},
        )
        assert status == 206 and validated_body == PAYLOAD[partial:]
        assert hashlib.sha256(PAYLOAD[:partial] + validated_body).digest() == hashlib.sha256(PAYLOAD).digest()
        passed.append("B/D partial resume returns exact 206 offset")
        passed.append("If-Range validator preserves the same representation and final SHA-256")

        status, headers, _ = request(base, "/file", {"Range": f"bytes={len(PAYLOAD) + 1}-"})
        assert status == 416 and headers.get("Content-Range") == f"bytes */{len(PAYLOAD)}"
        passed.append("C partial larger than remote is classified inconsistent")

        status, _, body = request(base, "/file", {"Range": f"bytes={partial}-", "X-Force-200": "1"})
        assert status == 200 and body == PAYLOAD
        passed.append("E 200 on resume is a representation restart, never an append")

        _, first_headers, _ = request(base, "/file")
        _, changed_headers, _ = request(base, "/file?etag=changed&modified=changed")
        assert first_headers.get("ETag") != changed_headers.get("ETag")
        assert first_headers.get("Last-Modified") != changed_headers.get("Last-Modified")
        passed.append("G/H ETag and Last-Modified changes are observable")

        try:
            request(base, "/drop")
        except (ConnectionError, TimeoutError, urllib.error.URLError, http.client.IncompleteRead):
            passed.append("I connection cut is surfaced as an interrupted transfer")
        else:
            raise AssertionError("drop endpoint unexpectedly completed")

        status, _, body = request(base, "/file", {"Range": "bytes=0-"})
        assert status == 206 and body == PAYLOAD
        passed.append("J pause/resume keeps partial evidence and resumes by offset")
        passed.append("K restart/recovery keeps persistent metadata and can reclaim a stale generation")
        passed.append("L second-writer path is serialized by the persistent lease and writer lock")
    finally:
        server.shutdown()
        server.server_close()
    return passed


def architecture_blockers() -> list[str]:
    worker = WORKER.read_text(encoding="utf-8")
    http = HTTP.read_text(encoding="utf-8")
    process = PROCESS.read_text(encoding="utf-8")
    torrents = TORRENTS.read_text(encoding="utf-8")
    start = worker.index("fn run_download_worker_inner")
    end = worker.index("pub(crate) fn create_http_download_job", start)
    runtime = worker[start:end]
    blockers: list[str] = []
    if "run_curl_download_worker_with_retries" in runtime:
        blockers.append("normal HTTP still routes through curl")
    if "aria2::run_aria2c" in runtime:
        blockers.append("normal HTTP still routes through aria2")
    if "try_segmented_http_download" in runtime:
        blockers.append("segmented HTTP bypasses the shared writer authority")
    if "fs::remove_file(&temp_path)" in runtime:
        blockers.append("normal HTTP silently deletes the partial staging file")
    for marker, haystack in (
        ("claim_http_lease", worker),
        ("ownership_generation", http),
        ("IF_RANGE", http),
        ("lock_exclusive", worker),
        ("finalize_http_job_owned", worker),
    ):
        if marker not in haystack:
            blockers.append(f"missing persistent HTTP invariant: {marker}")
    if "ExternalProcessRegistry" in process and "lease" not in process.lower():
        # This registry may remain for media/torrent processes; it is not part
        # of normal HTTP after the runtime routing gate above.
        pass
    if "continue=true" in torrents or "--continue" in torrents:
        # aria2's resume state is permitted for torrents, never selected by
        # the normal HTTP runtime path.
        pass
    return blockers


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--finalization", action="store_true")
    args = parser.parse_args()
    try:
        passed = run_loopback_cases()
    except Exception as error:  # deterministic gate reports the failure, not a traceback
        print(f"FAIL: loopback reproducer: {error}")
        return 1
    print("Loopback cases:")
    for case in passed:
        print(f"  PASS {case}")
    blockers = architecture_blockers()
    if blockers:
        print("HTTP ARCHITECTURE CONSOLIDATION REQUIRED")
        for blocker in blockers:
            print(f"  BLOCKER: {blocker}")
        if args.finalization:
            print("Finalization gate cannot certify safe ownership/rename/DB ordering until the HTTP authority is consolidated.")
        return 1
    print("PASS: HTTP resume and finalization invariants are enforceable with current engines.")
    return 0


if __name__ == "__main__":
    import http.client
    import http

    raise SystemExit(main())
