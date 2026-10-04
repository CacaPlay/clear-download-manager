# Prepare a Clear Download Manager release

Use a clean, dedicated checkout for a release build. Build scripts clear their
configured output directories; see [`BUILD-AND-PACKAGING.md`](BUILD-AND-PACKAGING.md)
before running them in a directory that contains files to keep.

## Preflight

Install the locked dependencies and run the source, rights, licensing, and
runtime checks before packaging:

```powershell
npm.cmd ci --no-audit --no-fund
npm.cmd run prepare:windows-binaries
npm.cmd run prepare:third-party-notices
npm.cmd run check:manifest
npm.cmd run version:check
npm.cmd run check:release
npm.cmd run check:licenses
npm.cmd run verify:binaries
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
```

Review `MANIFEST.sha256`, generated third-party notices, the SBOM, Cargo
inventory, package contents, and the corresponding-source archives or written
offers. A passing source registry does not prove that the exact materials were
uploaded with a particular release; verify the published asset names, sizes,
hashes, and signatures.

## Publish and verify

Only an authorized maintainer should start a release. The `Release Windows`
workflow accepts version tags and a manual dispatch for the existing release
tag. Tag creation and immutability are protected by the active `v*` rulesets;
the signing job waits on the `release` environment's reviewer gate. Current
environment settings allow self-review, so request a separate reviewer when
independent approval is required. See [`GITHUB-RELEASE-SETUP.md`](GITHUB-RELEASE-SETUP.md)
for the controls and signing-secret names.

After a successful workflow, verify the GitHub Release, its single versioned
NSIS setup installer, signed updater package, `latest.json`, checksums, and
exact corresponding-source materials. The release must not contain duplicate
installer copies or operator-only upload notes. The README download button
opens the latest release page, where users can choose the versioned installer:

`https://github.com/CacaPlay/clear-download-manager/releases/latest`

Some earlier installations use a legacy updater endpoint. See
[`UPDATER-MIGRATION.md`](UPDATER-MIGRATION.md) for the exact compatibility
boundary and bridge-release procedure. Current release assets remain in the
main `clear-download-manager` repository.
