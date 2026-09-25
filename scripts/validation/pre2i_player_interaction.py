"""Browser-level regression coverage for the targeted Player stabilization."""
from __future__ import annotations

import http.server
import io
import math
import struct
import threading
import wave
from pathlib import Path
from socketserver import ThreadingTCPServer

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[2]


def tone_wav() -> bytes:
    sample_rate = 8_000
    frames = bytearray()
    for index in range(sample_rate * 8):
        sample = int(2_000 * math.sin(2 * math.pi * 440 * index / sample_rate))
        frames.extend(struct.pack("<h", sample))
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(sample_rate)
        audio.writeframes(frames)
    return output.getvalue()


TONE = tone_wav()


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path == "/__pre2i-player-tone.wav":
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(TONE)))
            self.end_headers()
            self.wfile.write(TONE)
            return
        super().do_GET()


def main() -> None:
    handler = lambda *args, **kwargs: QuietHandler(*args, directory=str(ROOT), **kwargs)
    server = ThreadingTCPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, args=["--autoplay-policy=no-user-gesture-required"])
            context = browser.new_context(viewport={"width": 1280, "height": 760})
            context.add_init_script(
                """
                const appearance = {
                  theme: 'dark', accent: '#249ee4', scale: 100, textScale: 100,
                  density: 'balanced', intensity: 100, revision: 7
                };
                localStorage.setItem('cacatools.desktop.appearance.v2', JSON.stringify(appearance));
                window.__playerCalls = [];
                window.__playerListeners = {};
                window.__TAURI__ = {
                  core: {
                    convertFileSrc: () => '/__pre2i-player-tone.wav',
                    invoke: async (command, args = {}) => {
                      window.__playerCalls.push({ command, args });
                      if (command === 'get_appearance_settings') return appearance;
                      if (command === 'player_media_snapshot') return {
                        job_id: 44, title: 'Audio QA pre-2I', status: 'completed',
                        detail: 'Archivo local final', progress: 100, thumbnail: '',
                        output_mode: 'audio_best', kind: 'audio', playable: true,
                        local_path: 'C:/QA/pre2i-tone.wav', state_title: 'Listo para reproducir',
                        message: 'Archivo local final', converted: false,
                        technical: { container: 'wav', bitrate_kbps: 128,
                          audio: { codec: 'pcm_s16le', bitrate_kbps: 128, sample_rate_hz: 8000, channels: 1 },
                          video: null }
                      };
                      if (command === 'player_window_action' && args.action === 'fullscreen') {
                        await new Promise((resolve) => setTimeout(resolve, 80));
                        window.__playerListeners['player-fullscreen-changed']?.({ payload: true });
                      }
                      return null;
                    }
                  },
                  event: {
                    listen: async (name, listener) => {
                      window.__playerListeners[name] = listener;
                      return () => { delete window.__playerListeners[name]; };
                    }
                  }
                };
                """
            )
            page = context.new_page()
            page.goto(
                f"http://127.0.0.1:{port}/app-ui/player/index.html?job=44",
                wait_until="networkidle",
            )
            page.wait_for_selector('.player-shell[data-player-state="ready"]')
            play = page.locator('[data-player-action="play"]')
            page.wait_for_function("!document.querySelector('.player-audio').paused")
            play.hover()
            page.wait_for_timeout(2_050)
            assert not page.locator('.player-shell').evaluate("node => node.classList.contains('is-ui-idle')")
            play.click()
            page.wait_for_function("document.querySelector('.player-audio').paused")

            accent = "getComputedStyle(document.documentElement).getPropertyValue('--player-accent').trim()"
            assert page.evaluate(accent) == "#249ee4"
            page.evaluate(
                "window.__playerListeners['appearance-changed']({ payload: { revision: 8, appearance: { theme: 'dark', accent: '#9b59ff', scale: 100, textScale: 100, density: 'balanced', intensity: 100, revision: 8 } } })"
            )
            assert page.evaluate(accent) == "#9b59ff"

            fullscreen = page.locator('[data-player-action="fullscreen"]')
            fullscreen.evaluate("button => { button.click(); button.click(); }")
            page.wait_for_timeout(120)
            fullscreen_calls = page.evaluate(
                "window.__playerCalls.filter(call => call.command === 'player_window_action' && call.args.action === 'fullscreen').length"
            )
            assert fullscreen_calls == 1, fullscreen_calls
            assert page.locator('.player-shell').get_attribute("data-player-fullscreen") == "on"

            print("OK: Player pause first-click, hover controls, accent sync, and fullscreen re-entry")
            page.close()

            preparation = context.new_page()
            preparation.goto(
                f"http://127.0.0.1:{port}/scripts/validation/ui-v5-harness.html?kind=multimedia&theme=dark&accent=249ee4",
                wait_until="networkidle",
            )
            preparation.evaluate(
                """(extendedPath) => {
                  const original = window.__TAURI__.core.invoke;
                  window.__TAURI__.core.invoke = async (command, args = {}) => {
                    if (command === 'analyze_media_url_with_session_for_window') return {
                      kind: 'media', title: 'Video QA pre-2I', creator: 'Fixture',
                      duration_label: '1:00', duration_seconds: 60, thumbnail: '',
                      formats: [
                        { id: '720', label: '720p', height: 720, audio_only: false, filesize: 48500000 },
                        { id: '1080', label: '1080p', height: 1080, audio_only: false, filesize: 89400000 }
                      ]
                    };
                    if (command === 'choose_download_directory') return extendedPath;
                    return original(command, args);
                  };
                }""",
                r"\\?\D:\QA\CacaTools",
            )
            preparation.locator('[data-role="url"]').fill("https://youtu.be/pre2i-fixture")
            preparation.locator('[data-role="source-form"]').press("Enter")
            quality = preparation.locator('[data-role="quality"]')
            quality.wait_for(state="visible")
            quality.select_option("1080")
            selected_text = quality.locator("option:checked").inner_text()
            assert selected_text.startswith("1080p · aprox. "), selected_text
            assert preparation.locator('[data-role="quality-note"]').count() == 0
            preparation.locator('[data-action="change-folder"]').click()
            destination = preparation.locator('[data-role="destination-path"]').first
            destination_text = destination.inner_text()
            assert destination_text == "D:\\QA\\CacaTools", destination_text
            assert destination.get_attribute("title") == "D:\\QA\\CacaTools"
            print("OK: format metadata and display-only Windows path normalization")

            extension_label = preparation.evaluate(
                """async () => {
                  const view = await import('/app-ui/download-manager/view/unified.js?pre2i-test');
                  const host = document.createElement('div');
                  host.innerHTML = view.downloadRowMarkup({
                    id: 99, title: 'Node.gitignore', detail: 'Completada', progress: 100,
                    status: 'completed', kind: 'file', category: 'Otros', origin: 'Directo',
                    extension: 'gitignore', destination: '', downloadedBytes: 2140,
                    totalBytes: 2140, speedBps: 0, etaSeconds: null
                  }, 0, null, null, null, null);
                  const label = host.querySelector('.dm-job-file small');
                  return { text: label?.textContent || '', title: label?.title || '' };
                }"""
            )
            assert extension_label == {"text": "GITI…", "title": "GITIGNORE"}, extension_label
            print("OK: long extension label is bounded while retaining its full accessible title")
            preparation.close()
            context.close()
            browser.close()
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
