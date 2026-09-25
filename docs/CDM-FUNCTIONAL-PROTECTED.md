# Clear Download Manager functional protected contract

Motion work must not own, rewrite, or infer business state.

## Progress

- Determinate fill width equals the actual progress value: 1% ≈ 1%, 28% ≈ 28%, 50% ≈ 50%, 93% ≈ 93%, and 100% is full.
- State colors may change color only; they must never force determinate width to 100%.
- Indeterminate/processing uses a separate visual layer and never replaces the determinate value.

## Protected behavior

Preserve quality selection (144/360/480/720/1080), playlist and extension quality,
yt-dlp selector correctness, size estimation, processing semantics, HTTP,
bandwidth, priority, concurrency, speed-limit persistence/application, SQLite,
updater, extension protocol, player playback, CMP/local-player behavior, row
selection, floating-menu positioning/semantics, and all existing Tauri IPC/event
contracts.

Motion may not change download state transitions, progress ownership, file
opening, playback lifecycle, native icon authority, or menu child geometry.
