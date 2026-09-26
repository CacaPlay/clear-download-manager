# Component Manager V1

## Core and optional components

The default Windows installer contains the CDM application, UI, SQLite support,
native HTTP/HTTPS downloads, extension bridge, and license notices. It does not
embed yt-dlp, FFmpeg, FFprobe, Deno, or aria2. Torrent and media jobs require
their optional components; ordinary HTTP downloads do not.

Component data is per-user under Tauri's Windows `app_local_data_dir()`:

```text
%LOCALAPPDATA%\lat.cacaplay.cacatools.downloadmanager\components\
  media-tools\
    active.json
    versions\<version-and-package-hash>\
  torrent-engine\
    active.json
    versions\<version-and-package-hash>\
```

The component directory is separate from the SQLite database and does not use
the process working directory. Components are installed without administrator
rights. New packages are expanded into a staging directory, checked against
the app's pinned `runtime-manifest.json`, and activated by atomically replacing
the active pointer. A failed install leaves the current active version intact;
stale staging entries are cleaned on the next launch. Removal is disabled while
media or torrent processes are active.

## Local package validation

V1 accepts only local `.cdmcomponent` ZIP packages. The package contains one
`component.json` and the exact pinned executables for one component. The app
checks the component id, schema, capability set, filenames, versions, file
sizes, SHA-256 hashes, archive paths, and extracted files. It does not execute
an executable during installation.

For local development, run the existing pinned binary preparation script, then
`npm run package:components:local`. It writes:

- `output/component-packages/media-tools-1.0.0.cdmcomponent`
- `output/component-packages/torrent-engine-1.0.0.cdmcomponent`

The package builder verifies every runtime SHA-256 against
`src-tauri/resources/bin/runtime-manifest.json` before writing either archive.
These local packages validate installation only; they do not establish a public
hosting or redistribution policy.

## Runtime inventory and distribution review

`runtime-manifest.json`, third-party notices, SBOM, license inventories, and
corresponding-source gates remain in the source tree and are still required.
The manifest is a version/hash inventory; its presence does not mean the
executables are embedded in the default installer.

The previous bundled model put the runtimes inside CDM's Windows installer.
The V1 architecture keeps them outside the installer and supports installation
from verified local packages. A future release may provide packages through a
CDM-hosted release asset or download official upstream assets directly. This
prototype does neither automatically and does not settle distributor or Store
review questions. In particular, aria2 and yt-dlp remain PENDING for binary
release, and the binary release gate remains fail-closed.
