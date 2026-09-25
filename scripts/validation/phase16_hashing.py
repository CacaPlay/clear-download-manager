#!/usr/bin/env python3
"""Source fingerprint helpers for Phase 16 validation reports.

Every Phase 16 report records the exact source files it validated. ``npm run check``
recomputes the same SHA-256 digest, so a report becomes invalid immediately after a
covered source file changes. This prevents stale screenshots/static reports from being
mistaken for validation of the final Windows source bundle.
"""
from __future__ import annotations

from hashlib import sha256
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parents[2]


def manager_source_files() -> list[Path]:
    base = ROOT / "app-ui" / "download-manager"
    return sorted(
        path
        for path in base.rglob("*")
        if path.is_file() and path.suffix.lower() in {".js", ".css"}
    )


def source_fingerprint(paths: Iterable[str | Path]) -> tuple[list[str], str]:
    resolved: set[Path] = set()
    for value in paths:
        path = value if isinstance(value, Path) else ROOT / value
        path = path.resolve()
        if path != ROOT and ROOT not in path.parents:
            raise ValueError(f"Archivo fuera del proyecto: {path}")
        if not path.is_file():
            raise FileNotFoundError(path)
        resolved.add(path)

    relative_files = sorted(path.relative_to(ROOT).as_posix() for path in resolved)
    digest = sha256()
    for relative in relative_files:
        path = ROOT / relative
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return relative_files, digest.hexdigest()
