import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../../app-ui/download-manager/view/unified.js', import.meta.url), 'utf8');
const model = await import(new URL('../../app-ui/download-manager/core/model.js', import.meta.url));
const extensionSource = fs.readFileSync(new URL('../../extension/sidepanel.js', import.meta.url), 'utf8');
const workerSource = fs.readFileSync(new URL('../../extension/service-worker.js', import.meta.url), 'utf8');
const snapshotSource = fs.readFileSync(new URL('../../src-tauri/src/downloads/snapshot.rs', import.meta.url), 'utf8');

assert.match(source, /archive:\s*'Comprimido'/, 'archive debe usar la etiqueta visual compacta Comprimido');
assert.doesNotMatch(source, /archive:\s*'Archivo comprimido'/, 'no debe quedar la etiqueta larga Archivo comprimido');
for (const label of ['Playlist', 'Disco', 'Vídeo', 'Audio', 'PDF', 'Torrent']) {
  assert.match(source, new RegExp(`(?:${label}|["']${label}["'])`), `falta la etiqueta visual existente ${label}`);
}
assert.match(source, /priority === 'normal'\) return ''/, 'Normal debe permanecer implícita en metadata');
assert.equal(model.jobFileExtension({ kind: 'video', sourceUrl: 'https://www.youtube.com/watch?v=abc123' }), '', 'una URL de YouTube no debe convertirse en WATCH');
assert.equal(model.jobFileExtension({ kind: 'video', extension: 'mp4', sourceUrl: 'https://www.youtube.com/watch?v=abc123' }), 'mp4', 'la extensión explícita debe tener prioridad');
assert.match(source, /\['video', 'audio', 'image'\]\.includes\(type\.visualType\)/, 'vídeo, audio e imagen deben mostrar su formato real cuando esté disponible');
assert.doesNotMatch(extensionSource, /download-extension-badge/, 'la extensión no debe incrustar el formato dentro de la miniatura');
assert.match(extensionSource, /browserCaptureMode: 'automatic'/, 'las instalaciones nuevas deben iniciar en Automático');
assert.match(workerSource, /DEFAULT_CAPTURE_MODE = 'automatic'/, 'el worker debe usar Automático cuando no existe preferencia guardada');
assert.match(snapshotSource, /pub\(crate\) extension: String/, 'el snapshot nativo debe publicar la extensión real');
assert.match(snapshotSource, /snapshot_extension\(output_mode\.as_deref\(\), &destination_path\)/, 'el snapshot debe derivar el formato desde el modo de salida o el archivo final');

console.log('PASS: file-type labels use real formats, avoid URL tokens and keep thumbnails clean.');
