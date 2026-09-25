# Revisión de seguridad — Fase 8

**Fecha:** 2026-09-24  
**Estado:** PENDIENTE: la consulta remota de solo lectura confirmó que no hay
environment ni ruleset visible de protección; no se modificó el remoto.  
**Alcance:** revisión estática del árbol fuente y de `.github/workflows`; no se
ejecutó un build ni un release, no se inspeccionaron bases SQLite reales,
cookies, perfiles WebView ni valores de credenciales.

## Resumen por severidad

| Severidad | Cantidad | Resultado |
| --- | ---: | --- |
| CRITICAL | 0 | No se confirmó un hallazgo de esta severidad. |
| HIGH | 1 | Las protecciones de acceso a la clave de firma del release dependen de configuración remota pendiente. |
| MEDIUM | 1 | El cliente reqwest fija la resolución validada; proxy del sistema y motores externos quedan fuera de ese pinning. |
| LOW | 0 | No se confirmó un hallazgo de esta severidad. |
| INFO | 4 | Se registran límites y controles revisados sin tratarlos como vulnerabilidades confirmadas. |

## Hallazgos

### HIGH — La clave de firma del release requiere una barrera externa verificable

**Evidencia:** `.github/workflows/release-windows.yml:3-6` acepta tags `v*` y
`workflow_dispatch`; `:58-59` entrega la clave privada y su contraseña al paso
de compilación; `:8-9` concede `contents: write` al job. El workflow no declara
un environment protegido ni una política de refs en el propio archivo.

La ejecución desde un ref no confiable podría exponer la clave si una persona
con permiso para despachar workflows o crear el tag puede escoger código que
controle ese job. El workflow no declara un environment. El 2026-09-24, las
consultas de solo lectura a GitHub devolvieron `total_count: 0` para environments,
lista vacía para rulesets (incluyendo heredados) y 404 para la API legacy de
protección de tags. La configuración observada no ofrece una barrera remota
verificable para la firma. No se leyeron valores de secretos.

**Acción previa a cualquier release:** configurar un environment de release
con aprobación requerida, limitarlo a refs/tags de release protegidos y guardar
allí los secretos de firma. Confirmar además que las reglas de tags impiden
crear o reemplazar tags de release sin autorización. Verificar la configuración
con el titular del repositorio antes de volver a habilitar una publicación.

**Estado:** PENDIENTE CONFIRMADO; hace falta crear/configurar el environment,
trasladar allí secretos de firma y aplicar reglas de tags. El plan prohíbe
modificar el remoto, así que no se intentó.

### MEDIUM — Resolución fijada en reqwest, no en todos los motores

`src-tauri/src/app/network.rs` filtra respuestas A/AAAA contra rangos
privados/reservados, limita la cantidad de direcciones y entrega las mismas
direcciones validadas al resolver personalizado de reqwest. Los saltos HTTP se
revalidan y los clientes reqwest internos usan ese resolver, reduciendo el
desajuste validación/conexión y los cambios DNS entre ambas etapas. Las pruebas
unitarias cubren direcciones IPv4/IPv6 reservadas y respuestas inválidas.

Límite residual: con un proxy del sistema, reqwest resuelve el host del proxy y
el proxy puede resolver el destino fuera de este proceso. yt-dlp, aria2,
trackers/peers torrent y otros procesos externos usan su propia resolución y
política de red. No se cambió el uso de proxy ni se restringió egreso, porque
eso podría cambiar el comportamiento admitido. No se afirma que el rebinding
esté cerrado para esas rutas ni que se haya probado una explotación real.

**Estado local:** hardening implementado para conexiones reqwest directas; QA
de extremo a extremo y límites proxy/motores externos siguen pendientes. La
severidad residual es MEDIUM y requiere mantener esta frontera documentada.

## Controles y límites revisados

- **Secretos:** Gitleaks no está instalado. Se hizo un escaneo equivalente de
  patrones de alta confianza sobre archivos fuente y configuraciones, con
  salida limitada a ubicaciones/categorías; no mostró candidatos. La búsqueda
  equivalente en el historial Git también devolvió cero rutas candidatas. Esto
  no prueba ausencia absoluta de secretos. No se emitieron valores ni se
  consultaron almacenes de credenciales.
- **GitHub Actions:** los cuatro workflows usan permisos explícitos. No hay
  `pull_request_target`, `workflow_run`, runner self-hosted ni descarga de
  artifacts. Checkout, setup-node y rust-toolchain se fijaron a commits SHA; se
  desactivó la persistencia de credenciales de checkout. El job de releases
  conserva `contents: write`, necesario para publicar, y el token de publicación
  está limitado a su paso. Los dos secretos de firma también quedan limitados
  al paso de compilación.
- **Inyección en CI:** se quitó la interpolación directa de
  `${{ github.ref_name }}` dentro de PowerShell. El paso usa la variable de
  entorno y escapa el segmento de ruta. Se quitó Playwright del workflow de
  release porque el script de arte promocional solo consume Pillow; las
  validaciones con Playwright permanecen en los workflows que las necesitan.
- **Procesos y shell:** la revisión encontró `Command::new` con argumentos
  separados para los procesos Rust revisados, sin una interpolación encontrada
  hacia `cmd.exe`/shell. La extensión acepta acciones enumeradas y limita el
  tamaño de mensaje nativo a 4 MiB (`extension/native-host/src/main.rs:14,
  :336-455`).
- **Extensión/native messaging:** el manifiesto Chromium generado contiene
  orígenes permitidos de la extensión (`src-tauri/src/extension_bridge.rs:381-390`);
  el template tiene lista de orígenes (`extension/native-host/chromium-host.template.json:6`).
  El ejecutable aplica límites de mensaje y acciones permitidas. No se evaluó
  una instalación real en Chrome/Firefox.
- **Rutas y temporales:** las rutas de administración de descargas pasan por
  validaciones de candidatos administrados; los nombres de respuesta del
  puente se derivan de IDs creados por el programa. La instalación/extracción
  de runtimes está precedida por comparación SHA-256 con los valores fijados en
  el flujo de preparación. No se abrió ninguna base real ni se borraron
  temporales o sidecars del usuario.
- **Hashes, firmas y raíces:** el catálogo de runtimes compara identidad,
  plataforma, versión, tamaño, SHA-256 y firma. `TrustedKeys::production()`
  está vacío y falla cerrado; no se presenta ninguna clave TEST ONLY como
  confianza de producción. La clave Tauri del updater configurada es una clave
  pública, no una credencial privada.
- **CSP/WebView:** `src-tauri/tauri.conf.json:32-48` limita `connect-src` a IPC,
  niega `object-src` y deja vacío el alcance del protocolo de assets. Mantiene
  scripts, frames, imágenes y medios remotos para las funciones actuales; se
  precisará su uso/persistencia en la Fase 9 antes de intentar recortes.
- **Torrent:** magnet/torrent se delega al motor aria2. El tráfico P2P y los
  endpoints declarados por metadatos de torrent forman una frontera de red
  distinta del cliente HTTP secuencial. No se identificó una prueba suficiente
  para llamar a ese comportamiento una vulnerabilidad; endurecerlo puede
  cambiar compatibilidad, por lo que se conserva y queda como límite explícito.
- **Dependencias (cierre 2026-09-24):** `npm audit --audit-level=high` informó
  cero vulnerabilidades. `cargo audit` no reportó advisories de vulnerabilidad,
  pero sí siete avisos permitidos en el desktop lockfile: seis crates sin
  mantenimiento y un aviso de soundness para `glib 0.18.5`. `cargo tree` para
  `x86_64-pc-windows-msvc` no resolvió `glib`; el lockfile del native host no
  reportó avisos. No se actualizaron dependencias transitivas por este informe.

## Verificación de esta fase

- Gitleaks y actionlint: no instalados.
- Escaneo equivalente actual e histórico: 0 candidatos de alta confianza.
- Referencias de Actions: 4 workflows revisados; todos los `uses:` encontrados
  están fijados a SHA completos.
- Las etiquetas upstream v4.4.0 de checkout y setup-node coinciden con los SHA
  fijados; el commit SHA de rust-toolchain fue resuelto en el upstream.
- `cargo fmt --all -- --check`, `cargo check --all-targets`,
  `cargo clippy --all-targets -- -D warnings` y 366 tests de biblioteca
  pasaron en un target temporal. `check:release` quedó bloqueado por derechos
  del código propio y fuente GPL correspondiente pendientes.
- No se hizo commit, push, release ni cambio en GitHub remoto.
- No se hizo commit, push, release ni cambio en GitHub remoto.

