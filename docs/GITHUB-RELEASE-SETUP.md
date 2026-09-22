# GitHub release setup

Configure these repository secrets in
`CacaPlay/clear-download-manager`:

- `TAURI_SIGNING_PRIVATE_KEY`: the production Tauri updater private key.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: its password, when configured.

Keep the signing key out of commits, logs, artifacts, and pull requests. The
workflow uses the repository-scoped `GITHUB_TOKEN`, reads the publication target
from `src-tauri/resources/updater/updater-config.json`, publishes `latest.json`,
and verifies the downloaded catalog and Windows asset before finishing.

Older installers still reference the legacy releases endpoint. Keep
`CacaPlay/cacatools-download-manager-releases` public and publish a same-version
bridge release containing the main repository's `latest.json`; verify that it
points to the signed main-repository asset. The private historical archive is
`CacaPlay/cacatools-download-manager-releases-private-archive` and must remain
private.
