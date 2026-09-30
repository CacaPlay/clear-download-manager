# Context Map — Window Reference Redesign

## Files to Modify

| File | Purpose | Changes Needed |
|------|---------|----------------|
| `app-ui/modules/settings/index.js` | Settings page and category navigation markup | Add visible navigation labels, preserve existing category ids/actions, expose true boolean preferences as switch semantics, convert only the existing two-state Auto scale control. |
| `app-ui/modules/settings/styles.css` | Settings shell, pages, controls, responsive layout | Match the supplied light reference surfaces while retaining dark mode, use the existing accent token, widen the settings rail to show labels, and style switches. |
| `app-ui/modules/appearance/styles.css` | Existing shared appearance settings controls | Align boolean preference toggle presentation with the new switch treatment without changing selection checkboxes. |
| `app-ui/modules/appearance/index.js` | Appearance state normalization and rendering coordination | Preserve existing theme/accent preferences; update boolean field handling only if needed for the Auto scale switch. |
| `app-ui/main.js` | Settings event binding and app updater state | Preserve the updater patch path and existing settings persistence; adapt the Auto scale event only if its input type requires it. |
| `app-ui/download-manager/view/dialogs.js` | Torrent and updater modal markup | Refine hierarchy and add non-functional presentation wrappers while preserving action selectors and real updater progress slots. |
| `app-ui/download-manager/view/shared.js` | Shared dialog shell, update progress, preferences | Keep real progress rendering, map binary preference checkboxes to accessible switches, and preserve settings data attributes. |
| `app-ui/download-manager/styles/01-base.css` | Base surfaces, modal and torrent styles | Style update/torrent dialogs to the supplied reference, with theme-aware surfaces and dynamic accent. |
| `app-ui/download-manager/styles/03-components.css` | Modal details and real update progress visuals | Refine progress card and modal spacing without changing progress values, animation truthfulness, or reduced-motion behavior. |
| `app-ui/subwindow.css` | Media preparation subwindow styling | Apply the same visual language and theme/accent tokens to the screenshot's preparation window. |
| `scripts/validation/ui-reference-redesign.test.mjs` | New focused regression coverage | Assert nav labels, accessible switch semantics, two-state conversion, modal action hooks, and dynamic theme/accent styling. |

## Dependencies

| File | Relationship |
|------|--------------|
| `app-ui/modules/appearance/tokens.js` | Canonical appearance preference names and defaults; do not replace its persisted schema. |
| `app-ui/modules/appearance/sync.js` | Theme synchronization across the app and subwindows. |
| `app-ui/download-manager/index.js` | Injects resolved theme/accent variables into the download manager root. |
| `app-ui/download-manager/events.js` | Consumes existing `data-dm-*` and checkbox settings hooks. |
| `app-ui/modules/composition/index.js` | Routes settings markup and must keep route/category behavior unchanged. |
| `app-ui/modules/i18n/runtime.js` | Labels used in Spanish/English; do not introduce a mixed-language screen. |
| `app-ui/styles.css` and `app-ui/download-manager/styles.css` | Import order for settings, shared app styles, and modal component sheets. |

## Test Files

| Test | Coverage |
|------|----------|
| `scripts/validation/app-update-progress.test.mjs` | Live updater progress markup and direct patch behavior; must remain green. |
| `scripts/validation/phase13_subwindows.mjs` | Tauri subwindow structure and behaviors. |
| `scripts/validation/phase20_ui_static.mjs` | Existing application layout and static UI invariants. |
| `scripts/validation/i18n-check.mjs` | Localization completeness and mixed-language regressions. |
| `scripts/validation/motion-tier1.mjs` and `motion-tier2.mjs` | Motion and reduced-motion behavior. |
| `scripts/validation/ui-reference-redesign.test.mjs` | New visual-contract regression coverage for this redesign. |

## Reference Patterns

| File | Pattern |
|------|---------|
| `app-ui/modules/appearance/index.js` | Existing dynamic theme/accent variables and persisted appearance values. |
| `app-ui/modules/settings/styles.css` | Existing settings page/card layout and responsive breakpoints. |
| `app-ui/download-manager/view/shared.js` (`dialogShell`) | Shared modal structure and keyboard/action hooks. |
| `app-ui/download-manager/styles/01-base.css` | Existing `--dm-*` semantic surface and theme variables. |
| `app-ui/download-manager/styles/03-components.css` | Existing progress styling and reduced-motion handling. |
| `app-ui/subwindow.css` | Existing scoped variables and compact subwindow layout. |

## Risk Assessment

- [ ] No public API, IPC, download lifecycle, updater trust, or component trust changes are required.
- [ ] No database migration is required; existing appearance/settings keys remain unchanged.
- [ ] Multi-value controls (theme, close action, locale, format, density) remain selects/radio groups.
- [ ] Selection and destructive-confirmation checkboxes remain checkboxes; only preference booleans become switches.
- [ ] The reference Downloads page shows four preferences that do not currently have matching settings keys/handlers. Do not render non-functional switches; record them as a separate approval item if exact content parity requires those new behaviors.
- [ ] The active branch worktree already contains 37 modified tracked files and approved untracked tests/docs. Preserve that work; limit edits to the listed UI files and new test/design docs.
- [ ] Do not edit the original `D:\CDM Desarrollo\clear-download-manager-source-clean` checkout.

## Map Review

Reviewed against the current isolated worktree at `codex/component-manager-progress-acl`, HEAD `49087828203cd62bd5fdf091893139d5e60703c4`. The map covers the six supplied screens, shared theme/accent handling, settings persistence, current modal hooks, and existing visual/localization tests. No production or native behavior changes are needed for the visual work.
