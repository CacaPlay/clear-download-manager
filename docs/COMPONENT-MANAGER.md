# Component Manager

## Core and optional components

The Windows Core installer is standalone and works offline. It contains the
CDM application, UI, SQLite support, native HTTP/HTTPS downloads, extension
bridge, and license notices. It does not contain `yt-dlp.exe`, `ffmpeg.exe`,
`ffprobe.exe`, `deno.exe`, or `aria2c.exe`. Media and torrent features remain
optional; ordinary HTTP downloads do not depend on them.

After installation, a user can request an optional component from Settings.
The Core fetches the configured catalog itself; the UI cannot supply a URL.
The planned immutable package names are:

- `media-tools-<version>.cdmcomponent`: yt-dlp, the approved SAFE LEAN
  FFmpeg/FFprobe pair, and Deno.
- `torrent-engine-<version>.cdmcomponent`: aria2c.

Packages are hosted as versioned assets in the CDM GitHub release. This is an
explicit post-install download initiated by the user, not a web installer or a
Store-policy workaround. The normal GitHub/web Windows Core bundle uses
Tauri's `downloadBootstrapper` WebView2 mode to keep its installer compact.
The Microsoft Store overlay uses `offlineInstaller` so its package remains
standalone and installable offline; that mode adds approximately 127 MB to
the Store installer. Neither mode includes optional media or torrent runtimes
in Core.

Microsoft Store Policies 7.20 was published on 2026-09-15 and takes effect
2026-10-22. Until then, 7.19 remains effective. Microsoft's change history
shows that 7.20 changes concern XBOX, child safety, and user-generated content;
the relevant 10.1.5, 10.2.2, 10.2.3, and 10.2.9 language is unchanged.
Policy 10.1.5 allows, with user consent after the primary product is first
downloaded, add-ons or extensions that enhance the product. Clauses 10.2.2
and 10.2.3 still require downloads to stay within the described app
functionality and not introduce policy-violating behavior. CDM's Media Tools
and Torrent Engine are intended to enhance its stated download features. The
EXE/MSI installer rule (10.2.9) requires a standalone installer, so Core does
not download components during setup. The review found no explicit policy
blocker to versioned, user-consented post-install packages; Store certification
still needs human confirmation and honest feature disclosure in the listing.
See [Microsoft Store Policies 7.20](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies),
[policy change history](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies-change-history),
and [MSI/EXE package requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements).

## Catalog and package trust

The catalog has a strict schema, exact component identities, package names,
version, size, SHA-256, capabilities, minimum CDM version, corresponding-source
assets, and notice hashes. The catalog payload is verified with Ed25519 using
the existing trust implementation. The catalog URL and release asset route are
fixed in Core; redirects are restricted to GitHub release hosts. Package bytes
are bounded, written to a temporary file, checked for exact size and SHA-256,
then passed through the existing archive, manifest, and per-file validation
before staging and atomic activation. A persisted sequence and signed catalog
proof reject catalog rollback and allow installed packages to be checked again
after the catalog freshness window expires.

The signed catalog is verified before component installation. The production
trust root is empty in this change, so production catalog refresh and remote
installation fail closed until the distributor provisions and approves a
production public verification key in a reviewed Core change. Public
verification keys and key IDs are not secrets and may be embedded in the
application and versioned in the repository. The corresponding private
signing key must remain only in a protected signing environment and must never
be committed or printed in logs. Test-only keys and loopback HTTP are compiled
into tests only. Do not reuse a test signing key for a release.

If an update fails, the currently active component remains selected. The
manager stages the replacement in a version-specific directory and changes
the active pointer only after package validation succeeds. Users can verify,
repair through the approved catalog, or remove an inactive component. There is
no background service and no silent mandatory update.

## Local development and tests

The legacy local `.cdmcomponent` builder remains available for isolated V1
installation tests. It is not the production distribution path. A local HTTP
fixture exercises catalog fetch, signature verification, bounded download,
hash validation, installation, activation, restart verification, and failed
update rollback. Production mode rejects HTTP and accepts only the configured
GitHub release route.

## Release assets and rights gates

A future component-enabled release needs all of the following, with immutable
names and recorded SHA-256 values:

1. The offline Core installer and source archive.
2. `component-catalog-v1.json` and its detached signature, signed by the
   distributor's offline key.
3. One versioned `.cdmcomponent` package and its corresponding-source assets
   for each component the catalog advertises.
4. Runtime notices, license inventory, and checksum inventory.

The media package links yt-dlp, FFmpeg/FFprobe, and Deno to their exact
runtime/source/notice records. The torrent package links aria2 to its exact
records. A release must not advertise a component unless the corresponding
source and license gates pass. SAFE LEAN is approved. aria2 and yt-dlp source
packages and human distributor reviews remain pending, so the GPL source and
binary release gate remains fail-closed.

`runtime-manifest.json`, SBOM, notices, and license inventories remain in the
source tree. The manifest identifies runtimes and hashes; it does not mean
those executables are embedded in the Core installer.
