# Clear Download Manager 0.95.0 source status

This source snapshot is based on the audited 0.95.0 functional and visual
checkpoint. The application authority is `0.95.0`; the Chrome extension
authority remains `0.45.12` and is released independently.

The release gate and Rust unit checks passed for this snapshot. A production
signed update is not claimed here: the private signing key stays outside the
repository and is injected only into the protected build workflow. Manual
clean-environment validation of installation, startup and basic functionality
was completed on Windows 11. This does not claim Authenticode, independent
security certification or universal compatibility.

Keep this file factual when the release state changes. The release-only
repository is the authority for downloadable assets and `news.json`.
