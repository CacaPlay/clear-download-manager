# Offline manifest fixtures

`valid-manifest-payload.json` is the data-only payload used by the Rust tests.
The tests sign it in memory with a deterministic `TEST-ONLY` Ed25519 seed;
no private production key is stored in the repository.

The same payload is mutated in memory to exercise these rejection cases:

- invalid signature
- unknown keyId
- unknown component
- wrong platform
- wrong architecture
- malformed SHA-256
- oversized component
- incompatible app version
- downgrade candidate
- revoked version
- forbidden field
- duplicate JSON key
- partial FFmpeg/FFprobe set
- untrusted origin/repository

All fixture inputs are offline JSON data. They contain no URLs, commands,
paths, binaries, or network instructions.

Future publication is intentionally only a documented boundary: an
operator-controlled release process outside this repository will serialize
the typed payload, sign those exact bytes with a private key kept outside the
client and repository, and publish the envelope through the allowlisted
CacaTools authority. Phase 2B contains no production signer or key workflow.
