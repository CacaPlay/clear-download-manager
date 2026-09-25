# Clear Download Manager Extension 0.45.12

Chromium extension for sending video, audio, playlists, images and links to
Clear Download Manager 0.95.x. Public distribution is available from the
[Chrome Web Store](https://chromewebstore.google.com/detail/aonppfnabjnicjjeoofkfjofolfibggp).

## Install

1. Install Clear Download Manager for Windows from the [official releases repository](https://github.com/CacaPlay/clear-download-manager-releases/releases/latest) or Microsoft Store.
2. Install this extension from Chrome Web Store.
3. Open CDM once so browser integration can discover the application.

The generated test package preserves the official extension identity. The
[`official-public-key.json`](../evidence/official-public-key.json) file contains
public identity material only; no private key is distributed here.

## Features

- Detects compatible media in the active tab.
- Sends video, audio, playlists, pages, HTTP(S) images and links to CDM.
- Preserves automatic quality selection when a fixed source quality is unavailable.
- Supports manual playlists without duplicates.
- Keeps thumbnails, format labels and request state.
- Provides context-menu and side-panel workflows with CDM branding.
- Synchronizes theme and progress colors when CDM publishes them.
- Rejects `blob:`/`data:` images that cannot be transferred safely.

## Capture behavior

New installations start in **Automatic** mode. Capture ignores private windows,
checks available capabilities and cancels a browser action only after CDM accepts
it. If the result is uncertain, the extension asks for review instead of blindly
resuming a possible duplicate transfer.

## Development and validation

The extension source lives in this directory and the native host is registered by
the main repository scripts. Current gates cover extension modules, side panel,
detection, capture, synchronization and branding. Always distinguish fixtures,
real connections and actions observed in CDM when reporting results.

Browser profiles, credentials, test downloads and QA configuration are never part
of the production package.

## License

The intended license for project-authored extension source code is the
repository's [GPL-3.0-or-later](../LICENSE.md); the complete version 3 terms
are in [`COPYING`](../COPYING). The PR #5 evidence investigation is closed for
further investigation, but its formal owner review remains pending as recorded
in [`docs/OPEN-SOURCE-RIGHTS-REVIEW.md`](../docs/OPEN-SOURCE-RIGHTS-REVIEW.md).
Permission to distribute retained visual assets is tracked separately. Clear
names, logos and marks are outside GPL absent a separate grant. The exclusions
and separately licensed material in [`NOTICE.md`](../NOTICE.md) also apply to
the extension. Third-party marks and image assets retain their own rights.
