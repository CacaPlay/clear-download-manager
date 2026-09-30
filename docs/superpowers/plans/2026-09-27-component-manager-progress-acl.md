# Component Manager Progress and Capability Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the dialog confirmation ACL and make optional components installable, independently removable, cancellable only during download, truthfully observable from backend through UI, and recoverable after failure.

**Architecture:** Keep the existing Rust ComponentManager and Settings surface. Add a typed backend operation lifecycle and transfer cancellation token; use signed catalog metadata as the only source of expected size; render phase/progress from emitted backend facts; identify missing components by the existing capability contract. Use the existing manager-owned removal path for optional components, with per-component activity safety and measured reclaimable bytes. Keep trust checks and production trust domains unchanged.

**Tech Stack:** Rust/Tauri 2, reqwest, JavaScript ES modules, Node `node:test`, PowerShell Windows NSIS build.

**Spec:** `docs/superpowers/specs/2026-09-27-component-manager-progress-acl-design.md`

## Execution Result

- Implementation and focused/full validation completed on `codex/component-manager-progress-acl` at `49087828203cd62bd5fdf091893139d5e60703c4`.
- Local unsigned NSIS test installer built with updater artifacts disabled and isolated package identifier; installed, launched, hidden to tray, reopened, and stopped after smoke.
- Core install contains no optional runtime executables or maintainer tooling.
- Production binary release remains correctly `PENDING` / fail-closed because corresponding-source release assets and signed component packages are not published.
- No commit, push, merge, tag, or release was performed.

## Global Constraints

- Base commit is `4b52bbe41e4a5fc0656cae0980e6c871e25e2dcf`; work only on `codex/component-manager-progress-acl`.
- Add only `dialog:allow-confirm` to the Tauri ACL.
- Retain the 20-second connection timeout; give catalog fetch a 30-second total bound and component transfer a 45-second read-inactivity bound without an arbitrary short whole-transfer deadline.
- Abort transfer on the first cumulative byte count above the validated signed catalog `packageBytes`; clean only that operation's partial staging data.
- The current catalog contract requires positive `packageBytes`; a missing/invalid value fails catalog validation before `download`. If HTTP `Content-Length` is absent, the verified catalog value remains the known total. Before catalog verification, omit size and ratio.
- Cancel only during `download`; serialize cancel and phase transition so `verify`, `install`, and `activate` cannot be interrupted.
- Every visible phase and number comes from backend state/events; never invent size, speed, percentage, or completion.
- Refresh Component Manager status after success, failure, and cancellation; preserve the prior active component on errors.
- Do not change catalog/tool trust, production keys/secrets, navigation, release gates, or runtime architecture.
- Build a local unsigned Windows NSIS installer; no tag, release, publication, push, or merge.

## Review Focus

- A slow but progressing package download has no arbitrary whole-transfer deadline; assert the transfer client policy has no total timeout and separately test inactivity using a deterministic stalled local server. (Task 2)
- A package that emits one byte beyond signed `packageBytes` must stop before EOF and leave no partial package. (Task 2)
- Cancel racing the download-to-verify boundary must either cancel before verification or be rejected after it, never interrupting installation. (Task 3)
- A missing catalog or failed install must clear optimistic UI state and leave retry available. (Tasks 3 and 5)
- An already-installed capability must not prompt, and unrelated backend errors must not map to a component prompt. (Task 4)
- Removing a component deletes only manager-owned versions, preserves Core, rejects only when that component is in active use, and causes a later required capability to prompt for reinstall. (Tasks 3 and 5)

---

### Task 1: Grant the exact dialog confirmation permission

**Files:**
- Modify: `src-tauri/capabilities/main-capability.json`
- Test: `scripts/validation/optional-component-install.test.mjs`

**Interfaces:**
- The main capability permission list gains only `dialog:allow-confirm`.
- The Node test parses the capability JSON and asserts that exact permission is present while no dialog open/save, filesystem, or shell permission is added.

- [ ] **Step 1: Write the failing ACL test**

Add a test named `main capability grants dialog confirm only for dialog operations` that reads the JSON file, asserts `dialog:allow-confirm`, and asserts the permission list has no broader `dialog:allow-*` permission.

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run: `node --test scripts/validation/optional-component-install.test.mjs`
Expected: the new test fails because `dialog:allow-confirm` is absent.

- [ ] **Step 3: Add the minimal ACL entry**

Add exactly `dialog:allow-confirm` to the existing `permissions` array in `src-tauri/capabilities/main-capability.json`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `node --test scripts/validation/optional-component-install.test.mjs`
Expected: all optional-flow tests and the ACL assertion pass.

### Task 2: Bound component network operations and reject oversized streams immediately

**Files:**
- Modify: `src-tauri/src/components/distribution.rs`
- Test: `src-tauri/src/components/tests.rs`

**Interfaces:**
- Keep catalog fetch and package transfer separate: catalog client has a 30-second total timeout; package client retains 20-second connect timeout and uses a 45-second read-inactivity timeout without an arbitrary short whole-transfer deadline.
- In the existing `download_asset_to_path` streaming loop, compare cumulative bytes with `AssetDownloadRequest.expected_size` after every read and before writing the excess chunk; return a size-mismatch error immediately. Add cancellation checking to this loop in Task 3.
- The expected size is still the signed, validated catalog's `package_bytes`; do not weaken its existing required/positive/max-size validation.

- [ ] **Step 1: Write local-server tests for exact-size and over-size streams**

Add tests named `signed_remote_component_download_rejects_overrun_before_eof` and `signed_remote_component_download_uses_catalog_total_without_content_length`. Stream an exact-size package successfully; for the overrun case, send `expected_size + 1` bytes while keeping the response open, then assert the request returns before EOF and removes its partial destination.

- [ ] **Step 2: Run the focused Rust tests and verify the over-size test fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib components::tests::signed_remote_component_download`
Expected: the over-size test fails because the current reader only discovers a mismatch after transfer completion.

- [ ] **Step 3: Add distinct timeout policies and per-read size enforcement**

Refactor `build_client` to accept an explicit request policy. Preserve `connect_timeout(20s)`, configure catalog total timeout `30s`, and configure package read inactivity timeout `45s` with no short total-transfer deadline. In `download_asset_to_path`, check cumulative bytes after each read and abort immediately above `expected_size`.

- [ ] **Step 4: Verify cleanup, no-Content-Length, and timeout behavior**

Add `signed_remote_component_download_applies_idle_timeout_without_total_timeout`, covering short catalog timeout, transfer inactivity using test-only short durations, and absence of a whole-transfer deadline. Assert every received chunk resets the inactivity window while a stalled transfer times out.

- [ ] **Step 5: Run focused Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib components::tests::signed_remote_component_download`
Expected: exact-size, missing HTTP `Content-Length`, immediate over-size abort, cleanup, and timeout-policy tests pass.

### Task 3: Model real install phases and safe download cancellation in the backend

**Files:**
- Modify: `src-tauri/src/components.rs`
- Modify: `src-tauri/src/commands/components.rs`
- Test: `src-tauri/src/components/tests.rs`

**Interfaces:**
- Add `ComponentInstallPhase` with `Preparing`, `Download`, `Verify`, `Install`, `Activate`, `Done`, `Error`, and `Cancelled` serialized as stable kebab-case values.
- Add `ComponentInstallProgress` with `component_id`, `phase`, `bytes_downloaded`, optional `total_bytes`, optional `progress_ratio`, optional `bytes_per_second`, and optional safe error code.
- `install_component_from_catalog` emits this payload as `component-download-progress`; add a cancel command keyed by component ID that succeeds only while its operation phase is `Download`.
- Make cancel and the transition to `Verify` atomic with respect to each other. Keep the existing staging cleanup guard responsible for partial file cleanup.
- Emit `progress_ratio = 1.0` only after exactly the validated catalog byte count has been received; later phases still follow afterward.

- [ ] **Step 1: Write failing lifecycle, error-reset, and cancellation tests**

Add tests named `component_install_emits_real_lifecycle_phases`, `component_install_failure_clears_activity_and_can_retry`, `component_install_cancel_is_download_only_and_cleans_staging`, and `component_install_cancel_race_with_verify_boundary_is_serialized`. Cover catalog fetch failure emits terminal error and clears activity; preparing before catalog verification exposes no size or ratio, and a catalog without required `packageBytes` fails before download; successful order is `preparing -> download -> verify -> install -> activate -> done`; cancellation removes only its download staging data; cancellation after `Verify` is rejected; retry after download/verify/install/activate failure succeeds without replacing the prior active component. Add removal tests for component-specific busy rejection, independent removal with Core preserved, deletion limited to manager-owned version files, and reliable reclaimed-byte measurement.

- [ ] **Step 2: Run focused Rust tests and confirm lifecycle/cancel assertions fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib components::tests::component_install`
Expected: new phase/cancel tests fail because no operation-phase event or cancellation API exists.

- [ ] **Step 3: Implement per-operation phase and cancellation state**

Implement a single-operation state record keyed by `ComponentId`, with a cancellation flag checked by the transfer reader. Atomically reject cancellation once phase changes from `Download`. Keep `ComponentManager::clear_activity` and cleanup guards on every terminal path.

- [ ] **Step 4: Emit transitions at actual backend operation boundaries**

Emit `Preparing` before catalog fetch; `Download` only after signed catalog/component validation; `Verify` before package validation; `Install` while extracting, staging, and re-hashing; `Activate` immediately before the atomic active-pointer switch; `Done` only after activation. Calculate bytes/ratio from received bytes and validated catalog size; calculate speed from measured byte/time deltas only.

- [ ] **Step 5: Add terminal events and cancel command**

Have command paths emit `Error`/`Cancelled`, retain technical details in backend logs, return short safe user errors, and refresh runtime slots only after success. Add `cancel_component_install` without interrupting verify/install/activate.

- [ ] **Step 6: Run focused Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib components::tests::component_install`
Expected: all lifecycle, cleanup, size, cancel-boundary, retry, and prior-active-version assertions pass.

### Task 4: Report missing optional capabilities structurally and resolve prompt metadata

**Files:**
- Modify: `src-tauri/src/components.rs`
- Modify: `src-tauri/src/commands/components.rs`
- Modify: `scripts/validation/optional-component-install.test.mjs`

**Interfaces:**
- Replace frontend matching of localized/user-facing error strings with a stable missing-capability error carrying the existing `Capability` identifier. Include an uninstall -> capability absent -> contextual reinstall prompt test.
- Map `MediaExtraction`, `MediaMerge`, `MediaProbe`, `MediaTranscode`, and `JsRuntime` to the Component Manager's Media Tools contract; map `BitTorrent` to Torrent Engine.
- Add a prompt-info command returning the component ID, user-facing purpose, installed state, and optional package byte count only from already verified signed catalog data. Catalog absence/error returns no size, not a guessed value.

- [ ] **Step 1: Write failing JS tests for typed capability routing**

Assert that a missing media capability resolves Media Tools, a missing BitTorrent capability resolves Torrent Engine, installed capability bypasses prompt, unrelated errors do not prompt, and package size is omitted when catalog metadata is unavailable.

- [ ] **Step 2: Run the focused JS suite and verify the new assertions fail**

Run: `node --test scripts/validation/optional-component-install.test.mjs`
Expected: new capability-ID tests fail because current code recognizes message substrings.

- [ ] **Step 3: Implement structured capability mapping and prompt info**

Use the existing Rust `Capability`/`ComponentId` model as the only mapping authority. Return signed-catalog `package_bytes` only after catalog verification; do not inspect executable names or parse display copy.

- [ ] **Step 4: Verify tests pass**

Run: `node --test scripts/validation/optional-component-install.test.mjs`
Expected: media, torrent, installed-capability, unrelated-error, and unknown-size cases pass.

### Task 5: Render truthful component progress, retry, cancel, and contextual prompt

**Files:**
- Modify: `app-ui/main.js`
- Modify: `app-ui/modules/components/optional-install.js`
- Modify: `app-ui/modules/settings/index.js`
- Modify: `app-ui/modules/settings/styles.css`
- Test: `scripts/validation/optional-component-install.test.mjs`
- Test: `scripts/validation/component-manager.mjs`

**Interfaces:**
- Subscribe to `component-download-progress` once per UI context and store the typed backend payload as the component's current operation.
- Settings rows render phase, exact bytes/known total, percentage only when `progressRatio` exists, and speed only when `bytesPerSecond` exists. The progress bar is non-interactive and has no button hover/cursor.
- Render a Cancel control only for `download`, Retry only after a terminal error, and `Instalado` after backend `done` plus refreshed component status.
- Capability prompt shows component name, purpose, validated size if available, and explicit `Cancelar` / `Descargar e instalar` buttons. The same real progress events remain visible during contextual installation, then the original action retries once.
- After success/error/cancel, reload `list_components`, runtime status, and media runtime status before final render. Stop event listeners/animations on terminal states.
- Keep/remove controls for Media Tools and Torrent Engine independent of CDM Core. Show reclaimable space only from measured manager-owned files; disable or explain removal while the selected component is used. On remove completion, refresh status and capabilities immediately so subsequent required actions take the contextual install path again.

- [ ] **Step 1: Write failing UI model/render tests**

Test every real phase label; validated catalog size rendering even without HTTP `Content-Length`; no size or ratio before catalog verification; no percent fabricated; measured speed optional; no pointer/hover behavior on progress; cancel only during download; retry after error; terminal event stops progress animation and triggers status refresh. Test removal -> absent capability -> contextual reinstall prompt.

- [ ] **Step 2: Write failing contextual prompt tests**

Test separate Media Tools and Torrent Engine prompts with purpose, optional validated size, explicit button labels, cancel-without-install, install-and-retry-once, and installed-capability no-prompt behavior.

- [ ] **Step 3: Run focused frontend tests and verify failures**

Run: `node --test scripts/validation/optional-component-install.test.mjs`
Expected: new progress and prompt assertions fail because current UI uses global confirm and state/percent-only events.

- [ ] **Step 4: Implement shared real-event UI model and Settings progress**

Update `main.js` to consume all backend phases including terminal events, render the phase and measured metrics through Settings, refresh backend state after every terminal path, and expose cancel/retry actions under their allowed phases. Update CSS for compact smooth interpolation and a non-interactive progress bar.

- [ ] **Step 5: Implement the contextual dialog and single retry**

Replace message substring matching with capability identifiers, show a compact accessible dialog with explicit buttons and only verified optional size, forward real progress to that flow, and retry the original command no more than once after installation succeeds.

- [ ] **Step 6: Run focused frontend and component manager gates**

Run: `node --test scripts/validation/optional-component-install.test.mjs`; then `npm.cmd run check:component-manager`.
Expected: all JS tests and the static component-manager contract pass.

### Task 6: Integrate, validate release boundaries, and build local installer

**Files:**
- Modify: `MANIFEST.sha256` via `npm.cmd run manifest:source`
- Validate: modified ACL/backend/UI files and generated installer package.

**Interfaces:**
- Preserve component catalog and Tool Catalog trust separation. The production binary-release gate remains fail-closed until real signed release artifacts exist.
- Installer is unsigned/local and contains no optional runtime binaries or maintainer tooling.

- [ ] **Step 1: Run formatting and Rust tests**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`; `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib components::tests`; `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings`.
Expected: formatting, component tests, and clippy pass.

- [ ] **Step 2: Run JS/component/quality and ACL validation**

Run: `node --test scripts/validation/optional-component-install.test.mjs`; `npm.cmd run check:component-manager`; `npm.cmd run check:quality`; validate the Tauri capability with the project's installed Tauri CLI.
Expected: focused tests, project quality, and ACL validation pass; binary release remains fail-closed.

- [ ] **Step 3: Regenerate and verify the source manifest**

Run: `npm.cmd run manifest:source`; then `npm.cmd run check:manifest` and `git diff --check`.
Expected: manifest check and whitespace validation pass.

- [ ] **Step 4: Build the web frontend and local unsigned NSIS installer**

Run: `npm.cmd run build:web`; then the repository's canonical Tauri CLI command for a local unsigned Windows NSIS bundle with updater artifacts disabled and an isolated local-test application identifier. Do not use the production release workflow, production keys, or release secrets.
Expected: NSIS installer is generated from this branch and its installed Core excludes optional runtimes and maintainer tooling.

- [ ] **Step 5: Verify installed build and record the final branch state**

Install to a test-only location; verify launch, window close/tray behavior, relaunch, and Core contents. Confirm no tag, release, push, or production trust/secret change. Record test results and installer path in the final report.
Expected: the user can install and manually test the new build; source-only/production trust remains unchanged and binary release remains fail-closed.
