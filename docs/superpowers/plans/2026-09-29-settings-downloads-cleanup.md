# Settings and Downloads Refinement Plan

> **For agentic workers:** Execute locally in this D: worktree. Preserve all inherited dirty files and do not commit, push, merge, tag, release, publish, or touch production trust/secrets.

**Goal:** Apply the user's supplied Settings and Downloads references, preserve customization and existing behavior, and produce a local QA executable with installable QA components.

**Architecture:** Keep the existing settings, appearance, download-manager, and component-manager owners. Move visual controls to Appearance, keep diagnostic copy in Updates and diagnostics, use existing accent-aware logo assets, and keep optional packages fetched only from the existing loopback QA catalog. Avoid production architecture or trust changes.

**Tech Stack:** Existing JavaScript ES modules, CSS, Rust settings defaults/migrations, Node validation scripts, Tauri Windows bundle.

**Spec:** `docs/superpowers/specs/2026-09-28-ui-reference-redesign.md` plus the current user request and attached screenshots.

## Global Constraints

- Preserve the main checkout at `D:\CDM Desarrollo\clear-download-manager-source-clean` and the original C: worktree.
- Build and edit only in the isolated worktree for this task.
- Keep QA component traffic on `127.0.0.1:49301`; never change production updater/catalog endpoints, identifiers, keys, or secrets.
- Preserve custom accent, icon, theme, scale, density, progress-color, locale, download, and component-manager behavior.
- Keep PDF/Word file artwork, download thumbnails, and main/sidebar navigation icons.
- Do not remove active download controls or context-menu behavior.
- Do not commit, push, merge, tag, release, publish, install over the user's existing app, or delete the active QA server folder.

## Review Focus

- Only the selected appearance category receives active styling; neutral controls remain neutral in both themes.
- Old uncustomized neon-green progress defaults migrate to the new semantic palette, while customized colors remain untouched.
- Completed rows retain accessible folder/actions through context menu and keyboard; active rows retain pause/resume/retry controls.
- Download byte/date display derives from persisted backend job fields and never invents completion dates or totals.
- Header geometry is fixed independently of live speed/count string widths.

---

### Task 1: Transfer the latest approved work to D:

**Files:** Existing project files in this worktree; no source changes.

- [x] Create a new isolated worktree at the D: root from the approved C: branch HEAD.
- [x] Copy all pending tracked and approved untracked source changes while excluding generated `target`, `node_modules`, and `dist` directories.
- [x] Compare branch, HEAD, and pending-file set; keep the original checkouts untouched.

### Task 2: Settings and appearance

**Files:** `app-ui/modules/settings/index.js`, `app-ui/modules/settings/styles.css`, `app-ui/modules/appearance/index.js`, `app-ui/modules/appearance/tokens.js`, `app-ui/main.js`, `src-tauri/src/settings.rs`, `src-tauri/src/extension_bridge.rs`, relevant Rust tests and `scripts/validation/ui-reference-redesign.test.mjs`.

- [ ] Add failing tests proving scale controls live under Appearance, diagnostics stay in Updates, repeated language labels are clarified, decorative settings icons are removed, and preference/button states stay visually distinct.
- [ ] Move duplicated visual scale controls out of Updates and diagnostics into Appearance; leave a compact icon-free diagnostic-copy action in Updates.
- [ ] Refresh the settings logo from the existing accent variant immediately on committed accent selection.
- [ ] Use default progress colors Active `#22A9D6`, Completed `#04D25A`, Paused `#E2A93F`, Error `#EF6674`; migrate only known old uncustomized defaults.
- [ ] Refine selection/button and dark off-switch contrast without changing saved setting values or accessible switch semantics.

### Task 3: Downloads toolbar and rows

**Files:** `app-ui/download-manager/view/unified.js`, `app-ui/download-manager/view/zen-sidebar.js`, `app-ui/download-manager/events.js`, `app-ui/download-manager/core/model.js`, `app-ui/download-manager/styles/03-components.css`, `app-ui/download-manager/styles/05-overrides.css`, `app-ui/download-manager/styles/06-legacy-order.css`, and focused validation tests.

- [ ] Add failing tests for active size/total, completed size/date, completed action reduction, keyboard/context-menu availability, compact toolbar geometry, and stable speed-summary columns.
- [ ] Keep progress placement and thumbnail dimensions; show active transfer amounts stacked and completed total/date in a separated two-column area.
- [ ] Remove redundant completed-row folder/overflow buttons while preserving their actions through right-click and keyboard context menus; keep only necessary live-job controls.
- [ ] Align toolbar spacing with the supplied reference and reserve stable width for live speed/counts.
- [ ] Consolidate only conflicting CSS overrides proven obsolete by the focused regressions.

### Task 4: Verify, QA build, and safe storage cleanup

**Files:** D: worktree build outputs and D: test-delivery folder; no production configuration changes.

- [ ] Run relevant UI, localization, settings, download, component, quality, manifest, and formatting checks.
- [ ] Build the local QA executable in D: with explicit QA identity and QA public catalog key; use the currently prepared loopback QA server/packages.
- [ ] Verify the executable, QA endpoint guards, app identity, artifact size/hash, and source worktree preservation.
- [ ] Only after the D: build is verified, remove identified generated C: build caches and superseded temporary preview copies; preserve C: source worktree, all checkouts, personal/user files, release-source archives, and the running QA server/harness.
- [ ] Report UI/manual acceptance as pending for the user's visual test.
