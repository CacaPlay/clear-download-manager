import fs from 'node:fs';
const readFrontendSource = (extension) => fs.readdirSync('app-ui', { recursive: true })
  .filter((file) => file.endsWith(extension) && !file.replaceAll('\\', '/').startsWith('download-manager/'))
  .sort((a, b) => {
    const primary = extension === '.js' ? 'main.js' : 'styles.css';
    return a === primary ? -1 : b === primary ? 1 : a.localeCompare(b);
  })
  .map((file) => fs.readFileSync(`app-ui/${file}`, 'utf8'))
  .join('\n');

const publishedId = 'aonppfnabjnicjjeoofkfjofolfibggp';
const files = {
  rust: fs.readdirSync('src-tauri/src', { recursive: true })
    .filter((file) => file.endsWith('.rs'))
    .sort((a, b) => (a === 'lib.rs' ? -1 : b === 'lib.rs' ? 1 : a.localeCompare(b)))
    .map((file) => fs.readFileSync(`src-tauri/src/${file}`, 'utf8'))
    .join('\n'),
  bridge: fs.readFileSync('src-tauri/src/extension_bridge.rs', 'utf8'),
  host: fs.readFileSync('extension/native-host/src/main.rs', 'utf8'),
  ui: readFrontendSource('.js'),
  dm: fs.readFileSync('app-ui/download-manager/index.js', 'utf8'),
  shared: fs.readFileSync('app-ui/download-manager/view/shared.js', 'utf8'),
  register: fs.readFileSync('scripts/register-extension-host-windows.ps1', 'utf8')
};
const config = JSON.parse(fs.readFileSync('src-tauri/resources/extension/extension-config.json', 'utf8'));
const failures = [];
const requireToken = (source, token, label) => {
  if (!source.includes(token)) failures.push(`${label}: falta ${token}`);
};

if (config.chromiumExtensionIds?.[0] !== publishedId) failures.push('El ID publicado no es el primer origen Chromium');
if (config.chromiumExtensionIds?.length !== 1) failures.push('La configuración de producción debe permitir solo el ID publicado');
requireToken(files.bridge, `PUBLISHED_CHROMIUM_EXTENSION_ID: &str = "${publishedId}"`, 'ID fijo backend');
requireToken(files.register, `[string]$ChromiumExtensionId = '${publishedId}'`, 'ID fijo registro Windows');
requireToken(files.register, `$PublishedId = '${publishedId}'`, 'ID publicado no reemplazable');
requireToken(files.register, '$AllowedIds = @($PublishedId)', 'registro siempre conserva ID publicado');
requireToken(files.bridge, 'claim_primary_app_instance', 'instancia única');
requireToken(files.bridge, 'write_request("activate_app"', 'activación de instancia existente');
requireToken(files.host, 'write_activation_request', 'host nativo restaura la app');
requireToken(files.host, 'REQUEST_SEQUENCE.fetch_add', 'solicitudes nativas sin colisiones');
requireToken(files.rust, 'WINDOW_BEHAVIOR_SETTINGS_KEY', 'persistencia de ventana');
requireToken(files.rust, 'minimize_action != "taskbar"', 'minimizar permanece en barra de tareas');
requireToken(files.rust, 'close_action == "exit"', 'cierre configurable');
requireToken(files.rust, 'Salir completamente', 'menú de bandeja explícito');
requireToken(files.rust, 'prepare_full_exit', 'salida completa centralizada');
requireToken(files.rust, 'kill_process_tree(pid)', 'salida mata procesos externos');
requireToken(files.rust, "detail='Interrumpida al salir · lista para continuar'", 'tareas recuperables al salir');
requireToken(files.rust, 'EXIT_REQUESTED.load(Ordering::SeqCst)', 'workers no convierten el cierre en fallo');
requireToken(files.ui, 'close-action-select', 'ajuste global de cierre');
requireToken(files.ui, "invoke('save_window_behavior_settings'", 'persistencia frontend');
requireToken(files.ui, "request.action === 'activate_app'", 'restauración frontend');
requireToken(files.shared, 'data-dm-close-action', 'ajuste en Centro de descargas');
requireToken(files.dm, 'onWindowBehaviorChange', 'evento Centro de descargas');

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('OK: Fase 2A valida instancia única, bandeja, salida recuperable, cierre persistente, minimizar en barra de tareas e ID publicado fijo.');
