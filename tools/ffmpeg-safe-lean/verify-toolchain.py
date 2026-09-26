#!/usr/bin/env python3
"""Fail closed unless installed MSYS2 packages match the captured lock."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lock", type=Path, required=True)
    args = parser.parse_args()

    try:
        lock = json.loads(args.lock.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Toolchain lock cannot be read: {exc}", file=sys.stderr)
        return 2

    packages = lock.get("packages")
    if not isinstance(packages, list) or len(packages) != lock.get("packageCount"):
        print("Toolchain lock package list/count is invalid.", file=sys.stderr)
        return 2

    result = subprocess.run(["pacman", "-Q"], capture_output=True, text=True, check=False)
    if result.returncode:
        print("pacman -Q failed; use the pinned MSYS2 UCRT64 environment.", file=sys.stderr)
        return 2

    installed: dict[str, str] = {}
    for line in result.stdout.splitlines():
        parts = line.rsplit(maxsplit=1)
        if len(parts) == 2:
            installed[parts[0]] = parts[1]

    failures = []
    seen = set()
    for record in packages:
        name = record.get("name")
        expected = record.get("version")
        if not isinstance(name, str) or name in seen or not isinstance(expected, str):
            failures.append(f"Invalid or duplicate package lock entry: {record!r}")
            continue
        seen.add(name)
        actual = installed.get(name)
        if actual != expected:
            failures.append(f"{name}: expected {expected}, installed {actual or 'missing'}")

    if failures:
        print("MSYS2 toolchain lock mismatch:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1

    print(f"MSYS2 toolchain package lock verified: {len(packages)} exact packages.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
