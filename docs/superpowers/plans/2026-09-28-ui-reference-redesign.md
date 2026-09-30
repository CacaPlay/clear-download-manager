# UI Reference Redesign — Implementation Plan

1. Add focused regression tests for the Settings navigation, accessible binary switches, appearance persistence hook, modal structure, accent-aware styling, and media-subwindow tokens.
2. Establish screenshot-aligned Settings shell and component styling while preserving existing state, categories, localization, and event hooks.
3. Convert only the existing Auto scale binary selector into a real switch; preserve its current auto/manual behavior and stored schema.
4. Refine updater and torrent dialog markup/styles without touching updater progress data, handlers, or reduced-motion behavior.
5. Align the media preparation subwindow with the shared palette, accent tokens, typography hierarchy, and reference card/control treatment.
6. Apply consistent accessible switch styling to existing binary preference controls in Settings and download-manager dialogs; leave non-preference checkboxes/selects alone.
7. Run focused regressions, relevant localization/UI checks, quality gate, and web build. Review the diff for accidental changes to previously approved work. Report remaining visual/manual review.

No commit or remote action is in scope.

## Execution status — 2026-09-28

- Implemented the Settings icon-and-label rail, accent-aware card/control treatment, and accessible binary preference switches.
- Converted the existing Auto scale two-state setting to a switch while preserving the saved `autoScale` field and manual scale behavior.
- Refined updater/torrent modal presentation and the media preparation subwindow with theme-aware surfaces and the existing dynamic accent tokens.
- Preserved the updater progress slot and all torrent action selectors.
- Focused regression checks: 11/11 passed. Localization check passed (63 shared ES/EN keys and 670 runtime UI terms). Subwindow structural check passed. `build:web` and `git diff --check` passed.
- No Tauri runtime or installer was built in this phase, so visual matching still needs human review in the app.
- The user approved the four Downloads preferences in a follow-up. This implementation adds persisted settings, binds them to new HTTP/media/torrent queue operations, and makes the resume switch control recovery at shutdown and startup.
- A one-off destination selection does not replace the configured default folder. Cancelling it leaves the job unqueued. Torrent files retain their metadata names and existing `Torrents` directory.
- `cargo fmt --all -- --check`, `cargo check --locked --all-targets`, `cargo clippy --locked --all-targets -- -D warnings`, `npm run build:web`, and `git diff --check` pass after this follow-up.
- Tests were not run in this turn; the active workspace instruction says not to run tests unless the user asks for testing/verification. A Windows installer and manual visual review were not part of this follow-up.
