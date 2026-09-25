# Contributing to Clear Download Manager

Thank you for helping improve CDM. Keep changes small, reviewable, and tied
to a reproducible issue or an agreed feature. By participating, follow the
project's [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Contribution rights and third-party material

- The project intends to distribute project-authored source under
  GPL-3.0-or-later, but rights clearance for historical PR #5 changes is still
  pending. See `LICENSE.md` and `docs/OPEN-SOURCE-RIGHTS-REVIEW.md`; do not
  interpret this checkout as a public release or as evidence that the pending
  rights question is resolved.
- The project proposes a lightweight DCO sign-off for future contributions.
  DCO enforcement is not enabled. Until the rights review is closed, contact
  the maintainer before preparing a contribution intended for public release.
- Contributors keep their copyright; no copyright assignment is requested.
- Submit only work you created or are authorized to contribute. Identify
  material authored by another person, generated from an external source, or
  copied from another project, and include its source, version and license.
- Do not add logos, product marks, fonts, images or other assets unless their
  redistribution rights are clear. See `NOTICE.md` for currently excluded
  brand and third-party assets.

## Before opening a pull request

- Read the contracts in `docs/` and preserve download, IPC, updater, player,
  extension, and visible UI behavior unless the change explicitly covers it.
- Run `npm.cmd ci --no-audit --no-fund` and `npm.cmd run check:release`.
- For Rust changes, run `cargo fmt --manifest-path src-tauri/Cargo.toml --all
  -- --check`, `cargo check --manifest-path src-tauri/Cargo.toml --locked`,
  and the relevant tests.
- Cargo checks and tests do not produce a runnable desktop app. To compile the
  local app with its frontend embedded and without creating an installer, run
  `npm.cmd run build:local` from the repository root. Do not use the executable
  from `cargo build --release` as a desktop build; that command does not run the
  Tauri frontend build step.
- Never include user databases, downloaded media, installers, logs, signing
  keys, or native runtime binaries in a source pull request.
- To build outside the default `src-tauri/target`, set `CARGO_TARGET_DIR`
  locally; do not commit a machine-specific `.cargo/config.toml`.

Describe the user-visible effect, the tests run, and any known limitation.
