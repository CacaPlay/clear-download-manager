# Build and packaging

CDM has separate build paths for local development, the Windows release, the
Microsoft Store package, and the Chromium extension. Each path uses its own
configuration and output directory.

| Purpose | Command or workflow | Output |
| --- | --- | --- |
| Run from source | `npm.cmd run tauri -- dev` | Local desktop app connected to the development server |
| Build a local executable | `npm.cmd run build:local` | `src-tauri/target/release/cacatools-desktop.exe` |
| Build the Store package | `scripts/build-store-msix.ps1` | MSIX package and Store-specific frontend |
| Build the browser extension | `scripts/build-extension.ps1` | Extension directory and ZIP under `extension-dist/` |
| Publish the signed Windows release | GitHub Actions `Release Windows` workflow | Versioned installer, stable download alias, updater metadata, checksums and source materials |

Build scripts clear their configured output directories before writing. Check
the script's destination before running it and move any files you need to keep
to a separate location. The local executable is not an installer and is not
signed as a release.

Use [`RELEASE-GUIDE.md`](RELEASE-GUIDE.md) for release prerequisites and
publication gates. The application license and bundled third-party notices
are documented in [`THIRD-PARTY-RUNTIMES.md`](THIRD-PARTY-RUNTIMES.md),
[`../NOTICE.md`](../NOTICE.md), and `src-tauri/resources/licenses/`.
