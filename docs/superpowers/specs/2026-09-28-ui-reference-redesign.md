# UI Reference Redesign — Design Spec

## Goal
Bring the updater dialog, torrent dialog, Settings workspace, and media preparation subwindow close to the six supplied Clear Download Manager references while preserving application behavior and personalization.

## Visual contract
- Use a calm light palette in light mode: near-white canvas/cards, thin blue-gray borders, navy text, compact rounded controls, clear spacing and restrained shadows. Keep dark mode legible and structurally equivalent.
- Every blue/cyan accent treatment in the references must use the existing dynamic accent tokens (`--accent`, `--dm-accent`, `--sp-accent`) so user-selected accent colors continue to work. Keep semantic status/progress colors distinct.
- Settings uses an icon-and-label vertical navigation rail and screenshot-like page headings, cards, rows, and preference switches.
- Updater and torrent dialogs use a solid elevated panel, visible restrained border, centered placement, dimmed/blurred background, clear title/body/footer hierarchy, and reference-like controls.
- Media preparation retains its existing separate-window workflow and uses the same accent-aware surface/control language.
- True binary preferences are rendered as accessible switches; multi-value choices, file selection, and destructive acknowledgements retain their current semantics.

## Behavior and boundaries
- Do not change updater trust/configuration, updater lifecycle, Component Manager trust, or navigation destinations. Downloads receives one narrowly scoped persisted preference contract and IPC handler for the four approved settings below.
- Preserve all existing user theme, accent, scale, density, and semantic progress-color settings.
- Preserve every action hook/data attribute used by event handlers and tests.
- Implement the four Downloads preferences as real behavior: safe category folders, source filenames unless the user enters a name, a per-job folder chooser that creates no job when cancelled, and configurable recovery of interrupted jobs on restart/exit.
- Torrent contents retain their names from torrent metadata and remain under the existing `Torrents` folder; media and direct HTTP outputs follow the category/name preferences.
- No tag, release, publish, commit, or production trust/secrets changes.

## Acceptance
- References are represented in the named high-impact surfaces above.
- Accent colors are token-driven; light/dark themes remain supported.
- Binary preference controls expose `role="switch"` and continue storing the same values.
- The four Downloads switches load from and save to local settings, and affect new jobs and interrupted-job recovery without modifying the default download folder when a one-off destination is chosen.
- Updater progress remains backend-fed and truthful; reduced-motion rules remain effective.
- Focused implementation checks and `npm run build:web` pass.
- Visual resemblance is not certified by static tests; user manual visual review remains required.
