#!/usr/bin/env python3
"""SQLite and progress-write evidence for CacaTools Fase 11.3."""
from __future__ import annotations

import json
import sqlite3
import statistics
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REPORT = ROOT / "docs" / "tests" / "phase24-2-phase4-sqlite.json"
INDEXES = {
    "idx_jobs_status_updated": "CREATE INDEX idx_jobs_status_updated ON jobs(status,updated_at DESC)",
    "idx_download_jobs_url": "CREATE INDEX idx_download_jobs_url ON download_jobs(url)",
    "idx_recent_files_opened": "CREATE INDEX idx_recent_files_opened ON recent_files(opened_at DESC)",
    "idx_playlist_batches_status_updated": "CREATE INDEX idx_playlist_batches_status_updated ON playlist_batches(status,updated_at DESC)",
    "idx_playlist_items_batch_status_position": "CREATE INDEX idx_playlist_items_batch_status_position ON playlist_items(batch_id,status,position)",
    "idx_playlist_items_job": "CREATE INDEX idx_playlist_items_job ON playlist_items(job_id)",
    "idx_media_jobs_playlist_batch": "CREATE INDEX idx_media_jobs_playlist_batch ON media_jobs(playlist_batch_id,job_id)",
}
SCHEMA = """
CREATE TABLE jobs(id INTEGER PRIMARY KEY,title TEXT,detail TEXT,progress REAL,status TEXT,updated_at TEXT);
CREATE TABLE download_jobs(job_id INTEGER PRIMARY KEY,url TEXT,destination TEXT);
CREATE TABLE recent_files(id INTEGER PRIMARY KEY,name TEXT,path TEXT,opened_at TEXT);
CREATE TABLE playlist_batches(id INTEGER PRIMARY KEY,title TEXT,format TEXT,status TEXT,updated_at TEXT);
CREATE TABLE playlist_items(id INTEGER PRIMARY KEY,batch_id INTEGER,status TEXT,position INTEGER,job_id INTEGER);
CREATE TABLE media_jobs(job_id INTEGER PRIMARY KEY,playlist_batch_id INTEGER);
"""
QUERIES = {
    "jobs_active": ("SELECT id,title,status FROM jobs WHERE status IN ('running','queued','paused','failed') ORDER BY updated_at DESC LIMIT 300", ()),
    "download_url": ("SELECT job_id FROM download_jobs WHERE url=?", ("https://example.test/file/17000",)),
    "recent": ("SELECT name,path FROM recent_files ORDER BY opened_at DESC LIMIT 20", ()),
    "playlist_batches": ("SELECT id,title,status FROM playlist_batches WHERE status IN ('running','queued','paused') ORDER BY updated_at DESC LIMIT 120", ()),
    "playlist_items": ("SELECT id,job_id FROM playlist_items WHERE batch_id=? AND status=? ORDER BY position", (37, "queued")),
    "playlist_job": ("SELECT batch_id FROM playlist_items WHERE job_id=?", (17000,)),
    "media_batch": ("SELECT job_id FROM media_jobs WHERE playlist_batch_id=?", (37,)),
}


def populate(db: sqlite3.Connection, count: int = 20_000) -> None:
    statuses = ("running", "queued", "paused", "failed", "completed")
    with db:
        db.executemany(
            "INSERT INTO jobs VALUES(?,?,?,?,?,?)",
            ((i, f"Trabajo {i}", "Detalle", float(i % 100), statuses[i % len(statuses)], f"2026-08-06T20:{i % 60:02d}:{i % 60:02d}Z") for i in range(1, count + 1)),
        )
        db.executemany(
            "INSERT INTO download_jobs VALUES(?,?,?)",
            ((i, f"https://example.test/file/{i}", f"C:/Downloads/{i}") for i in range(1, count + 1)),
        )
        db.executemany(
            "INSERT INTO recent_files VALUES(?,?,?,?)",
            ((i, f"Archivo {i}", f"C:/Downloads/{i}", f"2026-08-{(i % 28) + 1:02d}T20:00:00Z") for i in range(1, count + 1)),
        )
        db.executemany(
            "INSERT INTO playlist_batches VALUES(?,?,?,?,?)",
            ((i, f"Playlist {i}", "MP3", statuses[i % len(statuses)], f"2026-08-06T19:{i % 60:02d}:00Z") for i in range(1, 401)),
        )
        db.executemany(
            "INSERT INTO playlist_items VALUES(?,?,?,?,?)",
            ((i, (i % 400) + 1, statuses[i % len(statuses)], i % 500, i) for i in range(1, count + 1)),
        )
        db.executemany(
            "INSERT INTO media_jobs VALUES(?,?)",
            ((i, (i % 400) + 1) for i in range(1, count + 1)),
        )


def benchmark(db: sqlite3.Connection, repetitions: int = 25) -> dict[str, float]:
    values: dict[str, float] = {}
    for name, (sql, args) in QUERIES.items():
        samples = []
        for _ in range(repetitions):
            started = time.perf_counter()
            list(db.execute(sql, args))
            samples.append((time.perf_counter() - started) * 1000)
        values[name] = round(statistics.median(samples), 4)
    return values


def main() -> int:
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA busy_timeout=750")
    db.executescript(SCHEMA)
    populate(db)
    before = benchmark(db)
    for statement in INDEXES.values():
        db.execute(statement)
    db.execute("ANALYZE")
    after = benchmark(db)
    plans = {
        name: [row[3] for row in db.execute(f"EXPLAIN QUERY PLAN {sql}", args)]
        for name, (sql, args) in QUERIES.items()
    }
    source = "\n".join((ROOT / "src-tauri" / "src" / path).read_text(encoding="utf-8") for path in (Path("lib.rs"), Path("db") / "mod.rs"))
    checks = []
    for name in INDEXES:
        checks.append({"name": f"Índice {name} está en la migración", "pass": name in source, "detail": plans})
    indexed_queries = {
        "download_url": "idx_download_jobs_url",
        "recent": "idx_recent_files_opened",
        "playlist_items": "idx_playlist_items_batch_status_position",
        "playlist_job": "idx_playlist_items_job",
        "media_batch": "idx_media_jobs_playlist_batch",
    }
    for query, index in indexed_queries.items():
        used = any(index in item for item in plans[query])
        checks.append({"name": f"SQLite usa {index}", "pass": used, "detail": plans[query]})
    checks.append({"name": "Las consultas indexadas no empeoran globalmente", "pass": sum(after.values()) <= sum(before.values()) * 1.1, "detail": {"before": before, "after": after}})
    timeout = db.execute("PRAGMA busy_timeout").fetchone()[0]
    checks.append({"name": "La escritura de progreso conserva una ventana base de 250 ms y batching", "pass": "MEDIA_PROGRESS_DB_INTERVAL_MS: u64 = 250" in source and "PROGRESS_MIN_BYTES_DELTA" in source and "PROGRESS_MIN_PERCENT_DELTA" in source, "detail": {"base_interval_ms": 250, "minimum_bytes_delta": 256 * 1024, "minimum_percent_delta": 0.5}})
    checks.append({"name": "SQLite usa un busy_timeout corto", "pass": timeout == 750 and "SQLITE_BUSY_TIMEOUT_MS: u64 = 750" in source and "busy_timeout" in source, "detail": {"busy_timeout_ms": timeout}})
    report = {
        "phase": "0.25.1-phase11.3-sqlite",
        "fixture_rows": 20_000,
        "median_query_ms_before_indexes": before,
        "median_query_ms_after_indexes": after,
        "query_plans": plans,
        "progress_persistence": {"interval_ms": 250, "minimum_bytes_delta": 256 * 1024, "minimum_percent_delta": 0.5, "busy_timeout_ms": timeout},
        "checks": checks,
        "passed": all(item["pass"] for item in checks),
        "limitations": "Fixture sintética con sqlite3 de Python; el gate Rust/Windows valida las conexiones reales mediante pruebas unitarias. No instrumenta una sesión de descarga externa.",
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    db.close()
    if not report["passed"]:
        for item in checks:
            if not item["pass"]:
                print(f"FAIL: {item['name']} · {item['detail']}")
        return 1
    before_total = sum(before.values())
    after_total = sum(after.values())
    reduction = (1 - after_total / before_total) * 100 if before_total else 0
    print(f"OK: SQLite Fase 4 · mediana agregada {before_total:.4f} -> {after_total:.4f} ms · reducción {reduction:.2f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
