<p align="center">
  <img src="app-ui/assets/brand/clear-download-manager-celeste.png" width="128" height="128" alt="Clear Download Manager">
</p>

<h1 align="center">Clear Download Manager</h1>
<p align="center">Download and multimedia manager for Windows</p>
<p align="center">Clear Download Manager (CDM) is a local Windows application for organizing HTTP/HTTPS downloads, video, audio, playlists, torrents and direct links. It is built with Tauri and Rust and includes optional Chromium browser integration.</p>

<p align="center">
  <img src="docs/assets/feature-pills/downloads-light.svg#gh-light-mode-only" height="36" alt="Downloads"><img src="docs/assets/feature-pills/downloads-dark.svg#gh-dark-mode-only" height="36" alt="Downloads">&nbsp;
  <img src="docs/assets/feature-pills/video-audio-light.svg#gh-light-mode-only" height="36" alt="Video and audio"><img src="docs/assets/feature-pills/video-audio-dark.svg#gh-dark-mode-only" height="36" alt="Video and audio">&nbsp;
  <img src="docs/assets/feature-pills/torrents-light.svg#gh-light-mode-only" height="36" alt="Torrents"><img src="docs/assets/feature-pills/torrents-dark.svg#gh-dark-mode-only" height="36" alt="Torrents">&nbsp;
  <img src="docs/assets/feature-pills/direct-links-light.svg#gh-light-mode-only" height="36" alt="Direct links"><img src="docs/assets/feature-pills/direct-links-dark.svg#gh-dark-mode-only" height="36" alt="Direct links">&nbsp;
  <img src="docs/assets/feature-pills/chromium-light.svg#gh-light-mode-only" height="36" alt="Chromium integration"><img src="docs/assets/feature-pills/chromium-dark.svg#gh-dark-mode-only" height="36" alt="Chromium integration">
</p>
<p align="center"><img src="docs/assets/section-divider.svg?v=visual-harmony-20260915" width="100%" height="2" alt=""></p>

## Download

Choose the option that works best for you.

<p align="center">
  <a href="https://github.com/CacaPlay/clear-download-manager/releases/latest/download/Clear.Download.Manager_0.95.4_x64-setup.exe#gh-light-mode-only"><img src="docs/assets/download-buttons/windows-light.png#gh-light-mode-only" width="354" alt="Get the app: Windows Installer"></a><a href="https://github.com/CacaPlay/clear-download-manager/releases/latest/download/Clear.Download.Manager_0.95.4_x64-setup.exe#gh-dark-mode-only"><img src="docs/assets/download-buttons/windows-dark.png#gh-dark-mode-only" width="354" alt="Get the app: Windows Installer"></a>&nbsp;&nbsp;
  <a href="https://apps.microsoft.com/detail/9NSTJ7JXM843#gh-light-mode-only"><img src="docs/assets/download-buttons/microsoft-store-light.png#gh-light-mode-only" width="354" alt="Official store: Microsoft Store"></a><a href="https://apps.microsoft.com/detail/9NSTJ7JXM843#gh-dark-mode-only"><img src="docs/assets/download-buttons/microsoft-store-dark.png#gh-dark-mode-only" width="354" alt="Official store: Microsoft Store"></a>
</p>
<p align="center">
  <a href="https://chromewebstore.google.com/detail/aonppfnabjnicjjeoofkfjofolfibggp#gh-light-mode-only"><img src="docs/assets/download-buttons/chrome-web-store-light.png#gh-light-mode-only" width="354" alt="Browser extension: Chrome Web Store"></a><a href="https://chromewebstore.google.com/detail/aonppfnabjnicjjeoofkfjofolfibggp#gh-dark-mode-only"><img src="docs/assets/download-buttons/chrome-web-store-dark.png#gh-dark-mode-only" width="354" alt="Browser extension: Chrome Web Store"></a>
</p>

You can also open the [complete Windows release](https://github.com/CacaPlay/clear-download-manager/releases/latest) for hashes, signature and updater metadata.

### What do I need?
- **Install the app:** use the Windows installer or Microsoft Store.
- **Browser integration:** install the extension from Chrome Web Store.
- **Already have CDM:** install only the extension if you want to send content from your browser.

## What it does
- HTTP/HTTPS downloads with resume, persistent queue and real progress.
- Video, audio and playlist downloads through yt-dlp.
- Torrents and magnet links through aria2c.
- Media processing with FFmpeg and FFprobe.
- SQLite history, categories, priorities, concurrency and bandwidth limits.
- Local player with safe full-screen playback for any aspect ratio.
- Light/dark/system themes with synchronized accent colors.
- Optional Chromium integration through Native Messaging.

## Basic usage
1. Open CDM and paste a link, file, torrent or playlist.
2. Select **Analyze** or the appropriate action.
3. Review quality, folder and priority before starting.

The app keeps the queue, history and insertion order locally on this device.

## Verify the installer
The current CDM installer is `Clear.Download.Manager_0.95.4_x64-setup.exe`.
```powershell
Get-FileHash .\Clear.Download.Manager_0.95.4_x64-setup.exe -Algorithm SHA256
```
Compare the result with the installer entry in `SHA256SUMS.txt` attached to the [latest release](https://github.com/CacaPlay/clear-download-manager/releases/latest).

## Requirements
Published builds require a compatible Windows x64 installation. WebView2, Node.js and Rust/MSVC are required only for development.

## Privacy and support
CDM is designed to work locally. Do not commit installers, databases, logs, credentials, cookies or private keys. See the [extension privacy policy](docs/extension/PRIVACY.md), [`SECURITY.md`](SECURITY.md) and [`SUPPORT.md`](SUPPORT.md).

## Development
```powershell
npm.cmd ci --no-audit --no-fund
npm.cmd run check:release
npm.cmd run build:windows:final
```
```text
app-ui/       interface, local player and download manager
src-tauri/    Tauri/Rust engine, SQLite and IPC
extension/    Chromium extension and native host
scripts/      build, validation and maintenance tools
docs/         technical contracts and development documentation
```

## Contributing and licensing
Read [`CONTRIBUTING.md`](CONTRIBUTING.md), [`SECURITY.md`](SECURITY.md) and [`LICENSE.md`](LICENSE.md) before sending changes. The license remains proprietary; review it before redistributing or modifying any component.
