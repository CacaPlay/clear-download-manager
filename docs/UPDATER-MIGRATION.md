# Updater and upgrade compatibility

## Current update channel

Current releases are published in `CacaPlay/clear-download-manager`. The
production updater endpoint is
`https://github.com/CacaPlay/clear-download-manager/releases/latest/download/latest.json`.
The release metadata and installer remain protected by the configured signing
key and release verification gates.

## LEGACY COMPATIBILITY — earlier updater clients

The available `v0.95.1` builds through `v0.95.1-build4` contain the endpoint
`https://github.com/CacaPlay/cacatools-download-manager-releases/releases/latest/download/latest.json`.
The `v0.95.4` and `v1.0.0` tags instead point to the current
`clear-download-manager` repository. Keep the public legacy endpoint available
while those older clients remain supported. A bridge release, when required,
must copy the verified `latest.json` and continue pointing to the signed asset
in the current repository; it must not bypass signature or hash verification.

## LEGACY COMPATIBILITY — installed v1.0.0 profile and local data

The production Tauri identifier remains
`lat.cacaplay.cacatools.downloadmanager`. Tauri uses this stable identifier for
the existing application data directory and default WebView2 profile; changing
it would create a separate profile and could make existing settings and local
data appear missing during an in-place update.

The v1.0.0 SQLite file `cacatools.sqlite3` is moved atomically to
`clear-download-manager.sqlite3` after the single-instance lock is held and its
SQLite journal is checkpointed. If both names already exist, startup fails
closed and preserves both files for recovery. The downloads folder
`Downloads\CacaTools` is renamed to `Downloads\Clear Download Manager` only
when the new folder does not exist; a conflict leaves both folders untouched
and continues using the existing folder.

The image editor migrates `cacatools-images-v3` to `cdm-images-v1` by copying
missing records in a transaction before removing the old database. App
`localStorage` keys are copied and verified before the old keys are removed;
conflicting values are retained for recovery. The current configuration uses
`CDM_*` environment variables first and accepts prior aliases only when the
current variable is absent.

The native messaging integration registers the canonical host
`lat.cacaplay.cleardownloadmanager` and the v1.0.0 host
`lat.cacaplay.cacatools.downloadmanager`. Both launch the current executable.
The v1 compatibility host keeps its registered protocol ID but ships as
`clear-download-manager-legacy-native-host.exe`. The shared bridge directory
`%LOCALAPPDATA%\CacaTools\DownloadManager\ExtensionBridge` remains an internal
compatibility path so installed browser extensions and queued bridge requests
continue to work.

Component catalog schema v1 serializes the origin authority as
`cacatools-controlled`. This signed wire value and its frozen verification
vector are preserved for compatibility; the internal Rust type uses the CDM
name. Changing the serialized value requires a new catalog schema version and
verification vector. Signature, key, source and component-policy checks remain
unchanged.

## EXTERNAL STORE IDENTITY

The assigned Microsoft Store AppUserModelId is
`CacaPlay.CacaToolsDownloadManager_b9fexpwkvxe1m!CacaTools`. Preserve this value
exactly in the package manifest and extension bridge because it belongs to the
existing Store identity; it is not the product's current display name.
