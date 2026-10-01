#!/usr/bin/env python3
"""Assemble a deterministic, source-only candidate for the pinned yt-dlp runtime."""

from __future__ import annotations

import hashlib
import argparse
import json
import lzma
import os
import shutil
import tarfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STAGING = ROOT / "output/source-assembly/yt-dlp-package"
ARCHIVE_NAME = "yt-dlp-2026.08.19-win64-corresponding-source.tar.xz"
EXPECTED_ARCHIVE_BYTES = 89855212
EXPECTED_ARCHIVE_SHA256 = "78f552ec5c4bd5c05012cc1c9c1c8eb526d301bdd3f2cbbe1bab79d507c27184"
EXPECTED_RUNTIME_SHA256 = "66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a"
SOURCE_COMMIT = "3a08beaf031ab68f966401ead017ac81fe8486cf"
PYINSTALLER_COMMIT = "70fc17210920bce17f4ab09bbf8104b0dbd45338"
BUILDER_COMMIT = "5eb86b862d61adc3df0f44e6e0b815b7d74fa3f5"
PINNED_INPUT_HASHES = {
    "upstream/yt-dlp-3a08beaf031ab68f966401ead017ac81fe8486cf.tar.gz": "7206981142eb461cfa603c360a55e0d08f3ed58cc754000ed821ad3ebac31ea0",
    "upstream/pyinstaller-70fc17210920bce17f4ab09bbf8104b0dbd45338.tar.gz": "587eb41e1087aeaf2a879b04db35b68bbe44b85f9227e263c873396806103540",
    "upstream/yt-dlp-pyinstaller-builds-5eb86b862d61adc3df0f44e6e0b815b7d74fa3f5.tar.gz": "65fa1589e00923522b289ad4fbde68feca06850acd699e1a4764882b2734c582",
    "upstream/Python-3.10.11.tgz": "f3db31b668efa983508bd67b5712898aa4247899a346f2eb745734699ccd3859",
    "upstream/openssl-1.1.1t.tar.gz": "8dee9b24bdb1dcbf0c3d1e9b02fb8f6bf22165e807f45adeb7c9677536859d3b",
    "build-wheels/pyinstaller-6.22.0-py3-none-win_amd64.whl": "294099ecb5fdd2a13ae4c29006d4e335b697a63b6a16cf052b90ec2b40bef05a",
    "native/curl-impersonate-v2.0.0-source.tar.gz": "9f64512f18dc8b9ce0d95f0ea9588065e69048456e53817506a0241a13798cd7",
    "native/curl-8_21_0-source.tar.gz": "ec753aa6f408a3ca9f0d6d5f7a77417aecd1544db13c03ae5d443612bf367364",
    "native/libcurl-impersonate-v2.0.0.x86_64-win32.tar.gz": "88e5b641a13b9a991857996947837c6f058cc3b0c9142ded0fc17b82008e98b2",
    "native/dependencies/boringssl-156c7b75ae9b8c3b3f847acf264f17594c3859fb.zip": "450e169b284697c6eafe523cb7679f4221fbe1a0993f773a566c33b188762844",
    "native/dependencies/brotli-1.2.0.tar.gz": "816c96e8e8f193b40151dad7e8ff37b1221d019dbcb9c35cd3fadbfe6477dfec",
    "native/dependencies/nghttp2-1.63.0.tar.bz2": "607b174554d22a828bc532d1d734fe0f729b5d5ed207f2f12e96a62e83f29c55",
    "native/dependencies/nghttp3-1.15.0.tar.bz2": "c6c491a52804814098e446630e6efc459afc0d3da7952ffe6cbdc0b3f99b2b62",
    "native/dependencies/ngtcp2-1.20.0.tar.bz2": "871ec97ad86803cf312901b0c393b0ee70163e25a87c9b2894d1234341ce4e97",
    "native/dependencies/zlib-1.3.1.tar.gz": "9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23",
    "native/dependencies/zstd-1.5.7.tar.gz": "eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def safe_copy_tree(source: Path, destination: Path, excluded: set[str] | None = None) -> None:
    if not source.is_dir() or source.is_symlink():
        raise SystemExit(f"Expected a real source directory: {source}")
    excluded = excluded or set()
    for item in sorted(source.rglob("*")):
        if item.relative_to(source).as_posix() in excluded:
            continue
        if item.is_symlink():
            raise SystemExit(f"Refusing symlink in source inputs: {item}")
        if not item.is_file():
            continue
        relative = item.relative_to(source)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(item, target)



def is_boringssl_test_data(name: str) -> bool:
    """Return only test-only data excluded by BoringSSL BUILD_TESTING=OFF."""
    parts = name.replace("\\", "/").split("/")[1:]
    path = "/" + "/".join(parts)
    if "/third_party/wycheproof_testvectors/" in path:
        return True
    if "/crypto/cipher/test/nist_cavp/" in path:
        return True
    if "/ssl/test/runner/hpke/testdata/" in path:
        return True
    if "/crypto/hpke/" in path and ("test-vectors" in path or path.endswith("hpke_test_vectors.txt")):
        return True
    if "/crypto/mlkem/" in path and path.endswith("_tests.txt"):
        return True
    if "/crypto/kyber/" in path and path.endswith("_tests.txt"):
        return True
    if "/crypto/slhdsa/" in path and path.endswith(("_siggen.txt", "_sigver.txt")):
        return True
    return path.endswith("/crypto/fipsmodule/keccak/keccak_tests.txt")


def extract_pinned_zip(archive: Path, destination: Path) -> list[dict[str, object]]:
    """Expand a verified upstream source ZIP without trusting its path names."""
    excluded = []
    with zipfile.ZipFile(archive) as source:
        for item in source.infolist():
            name = item.filename.replace("\\", "/")
            if name.startswith("/") or any(part in ("", ".", "..") for part in name.split("/")[:-1]):
                raise SystemExit(f"Unsafe path in pinned source archive: {item.filename}")
            mode = (item.external_attr >> 16) & 0o170000
            if mode == 0o120000:
                raise SystemExit(f"Refusing symlink in pinned source archive: {item.filename}")
            if item.is_dir():
                continue
            if is_boringssl_test_data(name):
                digest = hashlib.sha256()
                with source.open(item) as incoming:
                    for block in iter(lambda: incoming.read(1024 * 1024), b""):
                        digest.update(block)
                excluded.append({"path": name, "bytes": item.file_size, "sha256": digest.hexdigest()})
                continue
            target = destination.joinpath(*name.split("/"))
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.open(item) as incoming, target.open("xb") as outgoing:
                shutil.copyfileobj(incoming, outgoing)
    return excluded

def safe_copy_file(source: Path, destination: Path) -> None:
    if not source.is_file() or source.is_symlink():
        raise SystemExit(f"Expected a regular source file: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content.rstrip() + "\n", encoding="utf-8", newline="\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staging-directory", type=Path, default=STAGING)
    parser.add_argument("--output-directory", type=Path, default=ROOT / "output/release-assets")
    args = parser.parse_args()
    staging = args.staging_directory.resolve()
    output_directory = args.output_directory.resolve()
    package_root = output_directory / "yt-dlp-corresponding-source-package"
    archive = output_directory / ARCHIVE_NAME

    runtime = staging / "runtime-reference/yt-dlp.exe"
    if not runtime.is_file() or sha256(runtime) != EXPECTED_RUNTIME_SHA256:
        raise SystemExit("The staged official yt-dlp executable does not match the pinned SHA-256.")
    if package_root.exists():
        raise SystemExit(f"Refusing to replace existing package staging directory: {package_root}")
    if archive.exists():
        raise SystemExit(f"Refusing to replace existing corresponding-source archive: {archive}")
    if not (staging / f"upstream/yt-dlp-{SOURCE_COMMIT}.tar.gz").is_file():
        raise SystemExit("Pinned yt-dlp source archive is missing.")
    if not (staging / f"upstream/pyinstaller-{PYINSTALLER_COMMIT}.tar.gz").is_file():
        raise SystemExit("Pinned PyInstaller source archive is missing.")
    if not (staging / f"upstream/yt-dlp-pyinstaller-builds-{BUILDER_COMMIT}.tar.gz").is_file():
        raise SystemExit("Pinned yt-dlp PyInstaller builder source is missing.")
    for relative, expected in PINNED_INPUT_HASHES.items():
        path = staging / relative
        if not path.is_file() or sha256(path) != expected:
            raise SystemExit(f"Pinned build input hash mismatch: {relative}")

    output_directory.mkdir(parents=True, exist_ok=True)
    package_root.mkdir(parents=True)
    boringssl_zip = "dependencies/boringssl-156c7b75ae9b8c3b3f847acf264f17594c3859fb.zip"
    for dirname in ("upstream", "sdists", "native", "build-wheels"):
        exclusions = {boringssl_zip} if dirname == "native" else set()
        safe_copy_tree(staging / dirname, package_root / dirname, exclusions)
    excluded_boringssl_test_data = extract_pinned_zip(
        staging / "native" / boringssl_zip,
        package_root / "native/dependencies/boringssl-156c7b75ae9b8c3b3f847acf264f17594c3859fb",
    )
    write_text(
        package_root / "native/dependencies/BORINGSSL-SOURCE-IDENTITY.md",
        "The source tree in this directory was extracted from the verified upstream archive "
        "boringssl-156c7b75ae9b8c3b3f847acf264f17594c3859fb.zip.\n\n"
        "Pinned commit: 156c7b75ae9b8c3b3f847acf264f17594c3859fb\n"
        "SHA-256 of original upstream ZIP: 450e169b284697c6eafe523cb7679f4221fbe1a0993f773a566c33b188762844\n\n"
        "The compressed upstream ZIP is omitted; its extracted source tree is included. The file "
        "BORINGSSL-EXCLUDED-TEST-DATA.json lists the exact upstream test-only data omitted by the "
        "pinned curl-impersonate build recipe's `-DBUILD_TESTING=OFF`. Those datasets are not "
        "compilation inputs. All included source files have per-file SHA-256 records in "
        "SOURCE-PACKAGE-MANIFEST.sha256.",
    )
    write_text(
        package_root / "native/dependencies/BORINGSSL-EXCLUDED-TEST-DATA.json",
        json.dumps({"reason": "The pinned BoringSSL build sets BUILD_TESTING=OFF; these test fixtures are not compiler inputs.", "files": excluded_boringssl_test_data}, sort_keys=True, separators=(",", ":")),
    )
    # Keep only the upstream checksum file; the executable itself is not source.
    safe_copy_file(
        staging / "runtime-reference/yt-dlp-SHA2-256SUMS",
        package_root / "runtime-reference/yt-dlp-SHA2-256SUMS",
    )
    for name in (
        "YT-DLP-LICENSE.txt",
        "YT-DLP-NOTICE.txt",
        "YT-DLP-THIRD-PARTY-LICENSES.txt",
    ):
        safe_copy_file(
            ROOT / "src-tauri/resources/licenses" / name,
            package_root / "notices" / name,
        )

    sdist_inventory = json.loads((package_root / "sdists/source-inventory.json").read_text(encoding="utf-8"))
    for package in sdist_inventory.get("packages", []):
        file = package_root / "sdists" / package["filename"]
        if not file.is_file() or file.stat().st_size != package["size"] or sha256(file) != package["sha256"]:
            raise SystemExit(f"Source distribution hash/size mismatch: {package.get('filename')}")
    if sdist_inventory.get("failures"):
        raise SystemExit("The source distribution inventory records failed inputs.")

    readme = f"""# yt-dlp 2026.08.19 Windows corresponding-source candidate

This archive is a distributor-prepared source and build-input candidate for the official Windows executable whose SHA-256 is `{EXPECTED_RUNTIME_SHA256}`. It does not contain that executable.

Pinned yt-dlp source commit: `{SOURCE_COMMIT}`. The bundle also includes the pinned PyInstaller source (`{PYINSTALLER_COMMIT}`), yt-dlp's PyInstaller build repository (`{BUILDER_COMMIT}`), CPython/OpenSSL inputs, source distributions for the Python modules recorded by the runtime audit, and curl-impersonate/curl plus its pinned native dependencies and notices.

The executable's own `--verbose --version` output identified Python 3.10.11 and the optional library versions recorded in the external build-input review. The upstream Windows build workflow uses the yt-dlp PyInstaller bundler. This archive preserves the source trees and build inputs needed for review and rebuilding.

## Rebuild status

No clean Windows rebuild was performed for this candidate. The available machine did not have the matching Python 3.10/MSVC/CMake toolchain, and the published workflow selects a moving Windows runner and Python 3.10 patch release. Therefore this package does not claim bit-for-bit or independent functional reproduction. See the external `third-party-source/reviews/yt-dlp-2026.08.19-win64-build-inputs.json` for exact hashes and limitations.

## Integrity

`SOURCE-PACKAGE-MANIFEST.sha256` lists every other file in this archive. It deliberately excludes itself. The release candidate archive name and SHA-256 are recorded in the repository's corresponding-source registry and the external build-input review record.

## Review status

This is a technical candidate only. Distributor/legal review remains PENDING. The included notices are supplied as received/recorded; their inclusion is not a legal conclusion about the combined executable.
"""
    write_text(package_root / "README-CORRESPONDING-SOURCE.md", readme)

    license_inventory = """# License inventory for the yt-dlp runtime candidate

This is an evidence index for human review, not a legal determination. The redistributed executable is treated as a combined GPL-3.0-or-later artifact for the project's gate; review remains PENDING.

| Runtime/build component | Pinned version or identity | License evidence included |
| --- | --- | --- |
| yt-dlp | 2026.08.19, source commit recorded in README | `notices/YT-DLP-LICENSE.txt`, upstream source archive |
| PyInstaller | source commit recorded in README | PyInstaller source archive, including upstream license and bootloader exception text |
| Mutagen | 1.48.1 | sdist and `notices/YT-DLP-THIRD-PARTY-LICENSES.txt` |
| Python bundled modules and build dependencies | exact versions in `sdists/source-inventory.json` | corresponding source distributions and upstream license files within them |
| CPython and OpenSSL | exact source archives in `upstream/` | upstream license files in those source archives |
| curl-cffi / curl-impersonate / native dependencies | pinned source and release inputs in `native/` | upstream license/notice files carried in source archives or release inputs |
| yt-dlp third-party notices | commit-pinned project notice | `notices/YT-DLP-THIRD-PARTY-LICENSES.txt` |

The build input set contains multiple licenses, including copyleft components. This file does not decide whether any exception or combined-work condition applies. A distributor must review the included notice/source material and confirm the effective obligations before public binary distribution.
"""
    write_text(package_root / "LICENSE-INVENTORY.md", license_inventory)

    content_files = sorted(
        path for path in package_root.rglob("*")
        if path.is_file() and path.name != "SOURCE-PACKAGE-MANIFEST.sha256"
    )
    input_records = [
        {
            "path": path.relative_to(package_root).as_posix(),
            "bytes": path.stat().st_size,
            "sha256": sha256(path),
        }
        for path in content_files
    ]
    input_record = {
        "schemaVersion": 1,
        "runtime": {
            "id": "yt-dlp",
            "version": "2026.08.19",
            "sourceRepository": "https://github.com/yt-dlp/yt-dlp",
            "sourceVersion": "2026.08.19",
            "sourceCommit": SOURCE_COMMIT,
            "binarySha256": EXPECTED_RUNTIME_SHA256,
            "effectiveLicense": "GPL-3.0-or-later",
        },
        "upstreamBuildRecipe": {
            "repository": "https://github.com/yt-dlp/yt-dlp-pyinstaller-builds",
            "commit": BUILDER_COMMIT,
            "builder": "python -m bundle.pyinstaller",
            "runner": "windows-2025 (moving hosted runner label)",
            "pythonReportedByRuntime": "3.10.11",
            "pythonSourceArchive": "upstream/Python-3.10.11.tgz",
            "opensslSourceArchive": "upstream/openssl-1.1.1t.tar.gz",
            "pyinstallerSourceCommit": PYINSTALLER_COMMIT,
            "customPyInstallerWheelIncludedAsBuildInput": "build-wheels/pyinstaller-6.22.0-py3-none-win_amd64.whl",
        },
        "componentsObservedByRuntime": [
            {"name": "Cryptodome", "version": "3.23.0"},
            {"name": "brotli", "version": "1.2.0"},
            {"name": "certifi", "version": "2026.07.22"},
            {"name": "curl_cffi", "version": "0.16.0"},
            {"name": "mutagen", "version": "1.48.1"},
            {"name": "requests", "version": "2.34.2"},
            {"name": "sqlite3", "version": "3.40.1", "source": "CPython/Windows runtime"},
            {"name": "urllib3", "version": "2.7.0"},
            {"name": "websockets", "version": "16.1.1"},
            {"name": "yt_dlp_ejs", "version": "0.8.0"},
        ],
        "sourceDistributions": sdist_inventory["packages"],
        "nativeBuildInputs": [
            {"name": "curl-impersonate", "version": "2.0.0", "commit": "ec41b71ce888806bfec56ada7a7258d333eb3d19"},
            {"name": "curl", "version": "8.21.0"},
            {"name": "Brotli", "version": "1.2.0"},
            {"name": "BoringSSL", "commit": "156c7b75ae9b8c3b3f847acf264f17594c3859fb"},
            {"name": "nghttp2", "version": "1.63.0"},
            {"name": "nghttp3", "version": "1.15.0"},
            {"name": "ngtcp2", "version": "1.20.0"},
            {"name": "zlib", "version": "1.3.1"},
            {"name": "zstd", "version": "1.5.7"},
        ],
        "buildInputFileCount": len(input_records),
        "fileIntegrityIndex": "SOURCE-PACKAGE-MANIFEST.sha256",
        "reproducibility": {
            "cleanWindowsRebuildPerformed": False,
            "bitIdenticalRebuildEstablished": False,
            "functionalComparisonPerformed": False,
            "confidence": "SOURCE_AND_BUILD_INPUTS_COLLECTED; REBUILD NOT VERIFIED",
            "blockers": [
                "No clean Windows rebuild was performed in this environment.",
                "The upstream windows-2025 runner and Python 3.10 patch selection are moving inputs.",
                "The runtime binary does not expose a complete cryptographic inventory of every compiled module and native library.",
            ],
        },
        "distributionApproval": {"required": True, "status": "PENDING"},
    }
    write_text(package_root / "BUILD-INPUTS.json", json.dumps(input_record, sort_keys=True, separators=(",", ":")))

    # Rebuild the source manifest after adding the package inventory documents.
    content_files = sorted(
        path for path in package_root.rglob("*")
        if path.is_file() and path.name != "SOURCE-PACKAGE-MANIFEST.sha256"
    )
    internal_manifest = "".join(
        f"{sha256(path)}  {path.relative_to(package_root).as_posix()}\n"
        for path in content_files
    )
    write_text(package_root / "SOURCE-PACKAGE-MANIFEST.sha256", internal_manifest)

    temporary = archive.with_suffix(archive.suffix + ".partial")
    if temporary.exists():
        raise SystemExit(f"Refusing to replace existing partial archive: {temporary}")
    try:
        with tarfile.open(temporary, "w:xz", format=tarfile.PAX_FORMAT, preset=9 | lzma.PRESET_EXTREME) as tar:
            for path in sorted(package_root.rglob("*")):
                if not path.is_file():
                    continue
                relative = path.relative_to(package_root).as_posix()
                info = tar.gettarinfo(str(path), arcname=f"yt-dlp-corresponding-source/{relative}")
                info.uid = 0
                info.gid = 0
                info.uname = ""
                info.gname = ""
                info.mtime = 0
                info.mode = 0o644
                with path.open("rb") as stream:
                    tar.addfile(info, stream)
        actual_bytes = temporary.stat().st_size
        actual_hash = sha256(temporary)
        if actual_bytes != EXPECTED_ARCHIVE_BYTES or actual_hash != EXPECTED_ARCHIVE_SHA256:
            raise SystemExit(
                f"Corresponding-source archive mismatch: expected {ARCHIVE_NAME} "
                f"{EXPECTED_ARCHIVE_BYTES} bytes SHA-256 {EXPECTED_ARCHIVE_SHA256}; "
                f"got {actual_bytes} bytes SHA-256 {actual_hash}."
            )
        if archive.exists():
            raise SystemExit(f"Refusing to replace existing corresponding-source archive: {archive}")
        os.replace(temporary, archive)
    finally:
        if temporary.exists():
            temporary.unlink()

    print(json.dumps({"archive": str(archive), "name": ARCHIVE_NAME, "bytes": archive.stat().st_size, "sha256": sha256(archive), "internalManifestSha256": sha256(package_root / "SOURCE-PACKAGE-MANIFEST.sha256")}, indent=2))


if __name__ == "__main__":
    main()
