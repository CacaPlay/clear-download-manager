#!/usr/bin/env python3
"""Fetch only the versioned, hash-pinned inputs for the yt-dlp source package."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "third-party-source/reviews/yt-dlp-2026.08.19-win64-download-inputs.json"
CHUNK_SIZE = 1024 * 1024
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class FetchError(Exception):
    """A pinned input is incomplete, unsafe, or fails integrity verification."""


def _is_relative_safe_path(value: Any) -> bool:
    if not isinstance(value, str) or not value or "\\" in value or ":" in value:
        return False
    candidate = PurePosixPath(value)
    return not candidate.is_absolute() and all(part not in ("", ".", "..") for part in candidate.parts)


def validate_entry(entry: Any) -> None:
    if not isinstance(entry, dict):
        raise FetchError("Each source entry must be an object.")
    if not _is_relative_safe_path(entry.get("path")):
        raise FetchError(f"Unsafe staging path: {entry.get('path')!r}")
    url = entry.get("url")
    parsed = urllib.parse.urlsplit(url if isinstance(url, str) else "")
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise FetchError(f"Source URL must be an HTTPS URL without credentials or fragment: {url!r}")
    size = entry.get("bytes")
    if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
        raise FetchError(f"Invalid pinned byte count for {entry['path']}.")
    digest = entry.get("sha256")
    if not isinstance(digest, str) or not SHA256_PATTERN.fullmatch(digest):
        raise FetchError(f"Invalid pinned SHA-256 for {entry['path']}.")
    redirect_hosts = entry.get("allowedRedirectHosts", [])
    if not isinstance(redirect_hosts, list) or any(not isinstance(host, str) or not host or host.lower() != host for host in redirect_hosts):
        raise FetchError(f"Invalid redirect host allowlist for {entry['path']}.")


def verify_file(path: Path, entry: dict[str, Any]) -> None:
    validate_entry(entry)
    if path.is_symlink() or not path.is_file():
        raise FetchError(f"Pinned input is missing or not a regular file: {entry['path']}")
    actual_size = path.stat().st_size
    if actual_size != entry["bytes"]:
        raise FetchError(f"Pinned input size mismatch for {entry['path']}: expected {entry['bytes']}, got {actual_size}.")
    actual_hash = sha256(path)
    if actual_hash != entry["sha256"]:
        raise FetchError(f"Pinned input SHA-256 mismatch for {entry['path']}: expected {entry['sha256']}, got {actual_hash}.")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(CHUNK_SIZE), b""):
            digest.update(block)
    return digest.hexdigest()


class RestrictedRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self, allowed_hosts: set[str]):
        super().__init__()
        self.allowed_hosts = {host.lower() for host in allowed_hosts}
        self.max_redirections = 4
        self.max_repeats = 2

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urlsplit(urllib.parse.urljoin(req.full_url, newurl))
        if target.scheme != "https" or not target.hostname or target.hostname.lower() not in self.allowed_hosts:
            raise FetchError(f"Rejected redirect outside the HTTPS allowlist: {target.geturl()}")
        return super().redirect_request(req, fp, code, msg, headers, target.geturl())


def _target_path(staging: Path, relative: str) -> Path:
    if not _is_relative_safe_path(relative):
        raise FetchError(f"Unsafe staging path: {relative!r}")
    target = staging.joinpath(*PurePosixPath(relative).parts)
    try:
        target.resolve(strict=False).relative_to(staging.resolve())
    except ValueError as error:
        raise FetchError(f"Staging path escapes the requested directory: {relative}") from error
    current = staging
    for part in PurePosixPath(relative).parts[:-1]:
        current = current / part
        if current.is_symlink():
            raise FetchError(f"Symlink directory in staging destination: {current}")
    return target


def _check_final_url(entry: dict[str, Any], final_url: str) -> None:
    original = urllib.parse.urlsplit(entry["url"])
    final = urllib.parse.urlsplit(final_url)
    allowed = {original.hostname.lower(), *(host.lower() for host in entry.get("allowedRedirectHosts", []))}
    if final.scheme != "https" or not final.hostname or final.hostname.lower() not in allowed:
        raise FetchError(f"Final download URL is outside the HTTPS allowlist for {entry['path']}.")


def download_entry(entry: dict[str, Any], staging: Path, opener=None) -> Path:
    validate_entry(entry)
    staging.mkdir(parents=True, exist_ok=True)
    target = _target_path(staging, entry["path"])
    partial = target.with_name(target.name + ".partial")
    if target.exists() or partial.exists():
        raise FetchError(f"Refusing to overwrite an existing staging input: {entry['path']}")
    target.parent.mkdir(parents=True, exist_ok=True)
    original_host = urllib.parse.urlsplit(entry["url"]).hostname.lower()
    allowed_hosts = {original_host, *(host.lower() for host in entry.get("allowedRedirectHosts", []))}
    request = urllib.request.Request(entry["url"], headers={"User-Agent": "Clear-Download-Manager-source-fetch/1"})
    client = opener or urllib.request.build_opener(RestrictedRedirectHandler(allowed_hosts))
    digest = hashlib.sha256()
    total = 0
    try:
        with client.open(request, timeout=90) as response:
            _check_final_url(entry, response.geturl())
            with partial.open("xb") as output:
                while True:
                    block = response.read(CHUNK_SIZE)
                    if not block:
                        break
                    total += len(block)
                    if total > entry["bytes"]:
                        raise FetchError(f"Pinned input exceeds its expected size: {entry['path']}")
                    digest.update(block)
                    output.write(block)
                output.flush()
                os.fsync(output.fileno())
        if total != entry["bytes"]:
            raise FetchError(f"Pinned input size mismatch for {entry['path']}: expected {entry['bytes']}, got {total}.")
        actual_hash = digest.hexdigest()
        if actual_hash != entry["sha256"]:
            raise FetchError(f"Pinned input SHA-256 mismatch for {entry['path']}: expected {entry['sha256']}, got {actual_hash}.")
        os.replace(partial, target)
        return target
    except (FetchError, urllib.error.URLError, TimeoutError, OSError) as error:
        try:
            partial.unlink(missing_ok=True)
        except OSError:
            pass
        if isinstance(error, FetchError):
            raise
        raise FetchError(f"Could not fetch pinned input {entry['path']}: {error}") from error


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        raise FetchError(f"Could not read source inventory JSON: {path}") from error
    if not isinstance(value, dict):
        raise FetchError(f"Expected JSON object in {path}.")
    return value


def load_manifest(manifest_path: Path, repository_root: Path) -> dict[str, Any]:
    manifest = _read_json(manifest_path)
    if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("inputs"), list):
        raise FetchError("Unsupported or malformed pinned-input manifest.")
    inventory = manifest.get("sourceDistributionInventory")
    if not isinstance(inventory, dict) or not _is_relative_safe_path(inventory.get("path")) or not _is_relative_safe_path(inventory.get("sourcePath")):
        raise FetchError("Malformed source-distribution inventory record.")
    if isinstance(inventory.get("bytes"), bool) or not isinstance(inventory.get("bytes"), int) or inventory["bytes"] <= 0 or not SHA256_PATTERN.fullmatch(str(inventory.get("sha256", ""))):
        raise FetchError("Source-distribution inventory must pin an exact size and SHA-256.")

    entries = list(manifest["inputs"])
    destinations = {inventory["path"]}
    for entry in entries:
        validate_entry(entry)
        if entry["path"] in destinations:
            raise FetchError(f"Duplicate pinned staging path: {entry['path']}")
        destinations.add(entry["path"])

    inventory_path = repository_root.joinpath(*PurePosixPath(inventory["sourcePath"]).parts)
    inventory_entry = {"path": inventory["path"], "bytes": inventory["bytes"], "sha256": inventory["sha256"]}
    if inventory_path.is_symlink() or not inventory_path.is_file():
        raise FetchError(f"Pinned source-distribution inventory is missing: {inventory['sourcePath']}")
    if inventory_path.stat().st_size != inventory["bytes"] or sha256(inventory_path) != inventory["sha256"]:
        raise FetchError("Pinned source-distribution inventory size or SHA-256 mismatch.")
    sdist_inventory = _read_json(inventory_path)
    packages = sdist_inventory.get("packages")
    if not isinstance(packages, list) or sdist_inventory.get("failures"):
        raise FetchError("The pinned source-distribution inventory is incomplete or records failures.")
    for package in packages:
        if not isinstance(package, dict) or not _is_relative_safe_path(package.get("filename")):
            raise FetchError("Malformed package entry in source-distribution inventory.")
        entry = {
            "path": f"sdists/{package['filename']}",
            "url": package.get("url"),
            "bytes": package.get("size"),
            "sha256": package.get("sha256"),
            "allowedRedirectHosts": ["files.pythonhosted.org"],
        }
        validate_entry(entry)
        if entry["path"] in destinations:
            raise FetchError(f"Duplicate pinned staging path: {entry['path']}")
        destinations.add(entry["path"])
        entries.append(entry)
    if len(packages) != 21:
        raise FetchError(f"Expected 21 pinned source distributions, found {len(packages)}.")
    manifest["inputs"] = entries
    manifest["sourceDistributionInventory"]["sourcePathResolved"] = str(inventory_path)
    return manifest


def _copy_inventory(inventory: dict[str, Any], staging: Path) -> Path:
    source = Path(inventory["sourcePathResolved"])
    target = _target_path(staging, inventory["path"])
    partial = target.with_name(target.name + ".partial")
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() or partial.exists():
        raise FetchError(f"Refusing to overwrite existing source inventory: {inventory['path']}")
    try:
        shutil.copyfile(source, partial)
        if partial.stat().st_size != inventory["bytes"] or sha256(partial) != inventory["sha256"]:
            raise FetchError("Copied source-distribution inventory failed its integrity check.")
        os.replace(partial, target)
    finally:
        partial.unlink(missing_ok=True)
    return target


def fetch_all(manifest_path: Path, repository_root: Path, staging: Path) -> list[Path]:
    manifest = load_manifest(manifest_path, repository_root.resolve())
    if staging.exists() and (not staging.is_dir() or staging.is_symlink() or any(staging.iterdir())):
        raise FetchError(f"Staging directory must be new or empty: {staging}")
    staging.mkdir(parents=True, exist_ok=True)
    _copy_inventory(manifest["sourceDistributionInventory"], staging)
    fetched = []
    for entry in manifest["inputs"]:
        fetched.append(download_entry(entry, staging))
    return fetched


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--repository-root", type=Path, default=ROOT)
    parser.add_argument("--staging-directory", type=Path, required=True)
    args = parser.parse_args()
    try:
        fetched = fetch_all(args.manifest.resolve(), args.repository_root.resolve(), args.staging_directory.resolve())
    except FetchError as error:
        print(f"yt-dlp source input fetch failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"status": "verified", "fileCount": len(fetched) + 1, "downloadCount": len(fetched), "stagingDirectory": str(args.staging_directory.resolve())}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
