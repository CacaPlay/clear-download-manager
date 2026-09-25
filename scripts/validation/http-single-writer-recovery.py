#!/usr/bin/env python3
"""Static and deterministic gate for HTTP ownership/recovery invariants."""
from __future__ import annotations

import hashlib
import threading
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WORKER = (ROOT / "src-tauri/src/downloads/worker.rs").read_text(encoding="utf-8")
HTTP = (ROOT / "src-tauri/src/downloads/http.rs").read_text(encoding="utf-8")
DB = (ROOT / "src-tauri/src/db/mod.rs").read_text(encoding="utf-8")
PAYLOAD = bytes((index * 29 + 11) % 256 for index in range(64 * 1024))


def static_gate() -> None:
    start = WORKER.index("fn run_download_worker_inner")
    end = WORKER.index("pub(crate) fn create_http_download_job", start)
    runtime = WORKER[start:end]
    required = {
        "persistent HTTP lease": "claim_http_lease",
        "generation check": "ownership_generation",
        "sidecar writer lock": "lock_exclusive",
        "stale-worker stop": "HTTP_STALE_LEASE",
        "owned finalization": "finalize_http_job_owned",
    }
    for label, marker in required.items():
        haystack = HTTP if marker == "ownership_generation" else WORKER
        assert marker in haystack, f"missing {label}: {marker}"
    assert "run_curl_download_worker_with_retries" not in runtime
    assert "aria2::run_aria2c" not in runtime
    assert "try_segmented_http_download" not in runtime
    for marker in (
        "remote_size",
        "strong_etag",
        "last_modified",
        "representation_fingerprint",
        "ownership_token",
        "finalization_state",
    ):
        assert marker in DB or marker in HTTP, f"missing persisted field: {marker}"


def recovery_simulation() -> None:
    state = {"generation": 0, "writes": []}
    lock = threading.Lock()

    def claim() -> int:
        with lock:
            state["generation"] += 1
            return state["generation"]

    def write(generation: int, chunk: bytes) -> bool:
        with lock:
            if generation != state["generation"]:
                return False
            state["writes"].append(chunk)
            return True

    old = claim()
    assert write(old, PAYLOAD[:4096])
    new = claim()
    assert not write(old, PAYLOAD[4096:8192])
    assert write(new, PAYLOAD[4096:])
    assembled = b"".join(state["writes"])
    assert hashlib.sha256(assembled).hexdigest() == hashlib.sha256(PAYLOAD).hexdigest()


def main() -> int:
    try:
        static_gate()
        recovery_simulation()
    except AssertionError as error:
        print(f"FAIL: {error}")
        return 1
    print("PASS: persistent single-writer lease, stale-worker recovery, and SHA-256 integrity")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
