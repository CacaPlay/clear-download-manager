# Catalog schema v1 golden vector

This directory is a frozen, public **TEST ONLY** Ed25519 vector. The private
seed is intentionally public and exists only so independent processes can
prove deterministic generation. It is not a production secret, must never be
added to `TrustedKeys::production()`, and must never be bundled as an app,
installer, extension, native-host, or runtime resource.

The manifest repository marker is deliberately
`TEST_ONLY/NOT_A_PRODUCTION_AUTHORITY`; this vector does not freeze or select a
GitHub owner, endpoint, or production manifest policy.

Schema v1 signs exactly `payload.canonical.json`: UTF-8 compact JSON, no BOM,
no final newline, deterministic Rust struct field order, and no `signature`
field. `payload.canonical.sha256` is the lowercase SHA-256 of those exact bytes.

Do not edit or silently regenerate this directory after acceptance. A signed
format change requires a new versioned vector directory.

Offline verification from `src-tauri/`:

```text
cargo run --locked --features maintainer-tooling --example catalog-verifier -- verify --input tools/catalog-test-vectors/v1/envelope.json --public-key-file tools/catalog-test-vectors/v1/test-public-key.base64 --key-id test-only-catalog-v1
```

The signer accepts private material only through `--key-file`; it deliberately
has no raw-seed command-line option. `npm.cmd run check:catalog-tooling`
regenerates the vector twice in a temporary directory and verifies both results
in separate processes.
