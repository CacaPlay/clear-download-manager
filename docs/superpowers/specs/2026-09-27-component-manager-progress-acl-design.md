# Component Manager Progress and Capability Prompt Design

**Date:** 2026-09-27
**Base:** `4b52bbe41e4a5fc0656cae0980e6c871e25e2dcf`
**Branch:** `codex/component-manager-progress-acl`

## Purpose

Fix the Tauri confirmation ACL failure and make optional component installation observable, bounded, safely cancellable during transfer, recoverable after errors, and discoverable from actions that require a missing capability. Preserve the existing Component Manager in Settings and the production trust boundary.

## Current Findings

- `src-tauri/capabilities/main-capability.json` does not grant a dialog confirmation permission. Frontend confirmation flows use `globalThis.confirm` / `window.confirm`, which invoke Tauri's dialog confirm command.
- The component manager records `Downloading` before fetching the signed catalog. The HTTP client currently has a 20-second connect timeout and a five-minute whole-request timeout. The catalog fetch has no progress event of its own.
- `app-ui/main.js` optimistically sets the component to `downloading` before invoking the install command. On an error it shows a toast and renders, but does not reload component status. The backend clears its internal activity when the install call returns, so the UI can retain a stale downloading state.
- Progress currently reports a component state, received bytes, total bytes, and a computed percent; it does not report speed or a distinct activation phase. The installer implementation combines staged installation and activation in one function.

## Design

### Tauri confirmation ACL

Add only `dialog:allow-confirm` to the existing main-window capability. Do not add dialog open/save, filesystem, shell, or broad plugin permissions. Add a focused static test that checks the exact permission and ensures no broader dialog permission was introduced.

### Backend operation lifecycle

Expose a typed progress event for the current operation with:

- `componentId`
- `phase`: `preparing`, `download`, `verify`, `install`, `activate`, `done`, `error`, or `cancelled`
- `bytesDownloaded`
- optional `totalBytes`
- optional `progressRatio`
- optional `bytesPerSecond`
- optional short user-safe error code/message

The backend is the source of every transition. `preparing` covers catalog fetch and signature/metadata validation; `download` starts only after the catalog signature and the selected package metadata validate; `verify` covers downloaded package/hash/signature validation; `install` covers extraction and staging; `activate` covers the active-pointer switch; `done` is emitted only after activation succeeds. Failed operations emit a terminal event and clear the backend activity. Frontend state is then refreshed from `list_components` after both success and failure.

Only the signed, validated catalog's `packageBytes` supplies an expected total or size shown to the user. If that value is absent, progress has no total or ratio; bytes received may still be reported. Never estimate a percentage or substitute a guessed size.

### Network timeouts and cancellation

- Preserve the existing 20-second connection timeout.
- Use a short bounded total timeout for the small signed-catalog request (30 seconds).
- For package transfers, use a bounded inactivity/read timeout (45 seconds without received data) and no arbitrary short whole-transfer deadline. This permits legitimately slow but progressing transfers while ensuring a stalled connection terminates.
- Treat the validated signed catalog's `packageBytes` as a hard transfer ceiling: after each read, if cumulative `bytesDownloaded` exceeds it, abort immediately with an invalid-asset/size-mismatch error, remove that operation's partial staging data, and emit a terminal error. Do not continue to EOF to discover the mismatch.
- Check a per-operation cancellation token between received chunks. Cancellation is accepted only while the operation phase is `download`; phase transition and cancellation decision must be serialized so a late cancel cannot interrupt verification, staging, or activation.
- On accepted cancellation, stop the transfer, remove only that operation's partial download through the existing staging cleanup guard, clear activity, and emit `cancelled`. After `verify` begins, cancellation is rejected and the UI offers no cancel action.
- Keep package URL, signature, exact-size, and SHA-256 validation unchanged. A timeout, HTTP, catalog, signature, or asset error preserves the active version and produces a terminal recoverable state.

### Frontend progress and recovery

Use one event listener/model for Settings and contextual installation flows. Render the component name, true current phase, bytes and total when known, percent only when the backend supplies a ratio, and measured speed only when available. Smooth only the visual interpolation toward the latest real ratio; never synthesize progress. The progress display is non-interactive and has no button hover/cursor/hit target. Show Cancel only in `download`; show Retry for a terminal error; stop animations at terminal states. Refresh backend status after success, error, or cancellation and update component actions immediately.

### Independent optional component removal

Keep Media Tools and Torrent Engine independently removable from Settings without removing CDM Core. Remove is rejected while an active operation uses the selected component. The manager may report reclaimable bytes only when it can reliably total the files it owns; otherwise the UI omits the amount. Removal deletes only manager-owned component versions and metadata, never Core files or unrelated user files. After removal, refresh component status and capabilities immediately. A later action requiring the removed capability must again produce the contextual install prompt.

### Capability-driven prompt

When a command reports a missing optional capability, return/propagate a structured capability identifier that can be mapped using the Component Manager's existing capability contract. Do not match user-facing error text or executable filenames. Resolve component details and optional package size from a verified signed catalog; when no validated catalog is available, omit the size. Show a compact accessible dialog with the component, purpose, known size if verified, Cancel, and Download and install. After a successful install, retry the original action once. Declining, install failure, or retry failure returns a short understandable message and leaves the user able to retry from Settings.

### Trust and scope boundaries

- Keep manual management under Settings > Components.
- Keep the optional component catalog trust domain and production key/trust configuration unchanged.
- Do not bypass signature/catalog/package validation when production release artifacts are absent.
- No global UI redesign, primary navigation change, release, tag, or production-secret/trust modification.

## Verification Plan

### Rust/backend

- Catalog fetch fails and times out: operation emits terminal error and returns to retryable state.
- Download with known content length reports exact byte totals and only reaches 100% after complete receipt.
- Download without HTTP `Content-Length` still reports the validated signed catalog `packageBytes` as its total; before catalog verification, size and ratio remain absent. (The current catalog contract rejects a missing or invalid `packageBytes` before download.)
- A streamed asset that exceeds the signed catalog's `packageBytes` is aborted on the first excess read, cleans its partial file, and returns an invalid-asset error before EOF.
- A stalled transfer times out; progressing slow transfer remains eligible to continue.
- Cancellation during download stops the transfer and removes its partial staging file; cancellation after transition to verify is rejected.
- Successful installation emits `download -> verify -> install -> activate -> done` from real backend boundaries.
- Verification, install, activation, HTTP, and signature failures each emit terminal error, preserve the previous active component, and permit retry.

### Frontend

- Tauri capability includes `dialog:allow-confirm` and no broader permission.
- Media-extraction/merge/probe capability missing prompts for Media Tools; BitTorrent capability missing prompts for Torrent Engine.
- Installed capability bypasses the prompt.
- After independent removal, the corresponding capability is absent, Core remains installed, and a later action shows the contextual reinstall prompt.
- Removal is blocked while the selected component is in use, deletes only manager-owned files, and reports reclaimable space only when measured reliably.
- Prompt displays a size only when sourced from validated catalog data.
- Progress has no interactive cursor/hover behavior; error/cancel stops motion and enables retry.
- Success, failure, and cancellation each refresh component status from the backend.

### Build/release boundary

- Run the focused Rust and JS tests, the relevant quality/component-manager gates, Tauri ACL validation, and `git diff --check`.
- Build a local unsigned Windows NSIS installer from the branch for manual testing. Do not tag, publish, release, or access production secrets/trust.

## Acceptance Criteria

The pasted-link flow no longer fails with `Command plugin:dialog|confirm not allowed by ACL`; component operations cannot remain indefinitely shown as downloading; every visible phase and numeric progress value reflects backend facts; download cancellation cleans only its partial staging data and cannot interrupt verify/install/activate; retry and capability prompts work from real capability state; either optional component can be removed independently without removing Core or unrelated files; and the clean local installer contains no optional runtimes outside the existing component architecture.
