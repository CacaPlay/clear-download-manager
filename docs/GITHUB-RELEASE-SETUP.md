# GitHub release controls

The `Release Windows` workflow publishes signed Windows packages and updater
metadata. Keep release signing and publication behind the repository's
environment and tag protections.

## Repository controls

- The `release` environment requires a reviewer and limits deployments through
  its configured branch and tag policy. Self-review prevention is currently
  disabled; use a separate reviewer if independent approval is required.
- The active `v*` tag rulesets authorize tag creation and prevent updating or
  deleting release tags. The creation ruleset has a maintainer bypass; the
  immutability ruleset has no bypass.
- The protected `main` branch requires the `quality` status check and blocks
  non-fast-forward updates and deletion.
- The release job receives the environment secrets
  `RELEASE_TAURI_SIGNING_PRIVATE_KEY` and
  `RELEASE_TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Never print their values or
  store them in the repository.
- Keep `GITHUB_TOKEN` permissions limited to the workflow steps that need to
  upload release assets. Build and validation jobs should remain read-only.

Check the current settings in GitHub before a release if the environment,
reviewer, deployment policy, rulesets, or workflow permissions have changed.
Do not weaken tag immutability, bypass restrictions, signature verification,
or source-readiness gates to make a run pass.

## Release contents and legacy updater route

The workflow verifies the signed updater metadata and Windows package before
publishing. Include the exact corresponding-source archives or written offers
required by the runtime registry, and verify the release checksums and
signatures after upload.

The current updater endpoint is the `latest.json` asset in the main
`clear-download-manager` repository. Some earlier installers use a legacy
endpoint; see [UPDATER-MIGRATION.md](UPDATER-MIGRATION.md) for the exact
compatibility boundary and bridge-release procedure.
