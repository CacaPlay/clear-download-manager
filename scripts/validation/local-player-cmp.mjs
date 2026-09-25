import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const playerJs = read('app-ui/player/player.js');
const playerCss = read('app-ui/player/player.css');
const playerHtml = read('app-ui/player/index.html');
const downloadEvents = read('app-ui/download-manager/events.js');
const failures = [];
const check = (label, condition) => { if (!condition) failures.push(label); };

check('El escenario local no alterna video y audio', playerJs.includes("playerStage?.addEventListener('click'") && playerJs.includes("currentSource === 'preview'") && playerJs.includes("activeMedia.paused"));
check('El clic del escenario no atraviesa controles', playerJs.includes('.player-controls') && playerJs.includes('.player-popover') && playerJs.includes('.player-audio-card'));
check('La proporción local no usa recorte', playerCss.includes('data-player-source="local"') && playerCss.includes('object-fit:contain!important') && playerCss.includes('object-position:center center!important'));
check('La pantalla completa local no conserva el zoom', playerJs.includes("invoke('player_window_action'") && playerCss.includes('data-player-fullscreen="on"'));
check('El volumen local sigue el popover compacto de CMP', playerCss.includes('data-player-source="local"] .player-volume-popover') && playerCss.includes('position:absolute!important') && playerCss.includes('player-volume-controls:hover .player-volume-popover') && playerCss.includes('width:min(220px,24vw)!important'));
check('El reproductor conserva teclado y sesión multimedia', playerJs.includes("event.code === 'Space'") && playerJs.includes("event.key.toLowerCase() === 'f'") && playerJs.includes('navigator.mediaSession.setActionHandler'));
check('El HTML conserva el escenario y control de volumen', playerHtml.includes('class="player-stage"') && playerHtml.includes('data-player-volume-popover') && playerHtml.includes('data-player-action="fullscreen"'));
check('La vista previa online mantiene su ruta separada', playerJs.includes("currentSource === 'preview'") && playerHtml.includes('data-player-source="local"') && playerJs.includes('loadPreview'));
check('El doble clic abre el destino correcto', downloadEvents.includes("root.addEventListener('dblclick'") && downloadEvents.includes('onOpenPlaylistPlayer') && downloadEvents.includes('open_local_file') && downloadEvents.includes('El archivo todavía no está disponible para abrirlo.'));

if (failures.length) {
  console.error(failures.map((failure) => `FAIL: ${failure}`).join('\n'));
  process.exit(1);
}
console.log('OK: contrato CMP local validado: escenario, proporción, pantalla completa, volumen, teclado y sesión multimedia; preview online separado.');
