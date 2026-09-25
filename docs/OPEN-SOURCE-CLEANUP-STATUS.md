# Estado de la limpieza open source

**Última actualización:** 2026-09-25  
**Rama/base:** `main`, HEAD de inicio `0aafcfe31bec58c41c52c542352d6af0df5cf423`  
**Límite de publicación:** no commit, push ni release.

El usuario aprobó el plan completo y autorizó avanzar automáticamente fase por
fase. La declaración directa para PR #5 y la declaración agrupada de assets ya
quedaron registradas; los controles de publicación binaria y las fuentes GPL de
terceros siguen siendo independientes.

## Cierre de PR #5 y source-only gate (2026-09-25)

- **PR #5 / derechos GPL:** PASS para el diff exacto
  `78ceb49a8ff2e870fbeb604e586f6e7212e5c5d2`. La declaración directa del titular
  identifica la cuenta personal self-service, la ausencia declarada de MSA,
  Order Form o acuerdo personalizado, el uso continuado tras el período de
  transición de los términos de 2026-06-30 y la autorización de distribución
  GPL para código que puede licenciar. La revisión está en
  `rights/pr5-owner-review-draft.md`; SHA-256
  `4731b18b79f9eea9012ff43220feab30a0b23ca3672b414a7cfcc6eb86ee813f`.
- **Límite de evidencia:** la aplicación de los términos a la cuenta se basa en
  la declaración directa del titular y los términos públicos. No hay registro
  independiente de click-through ni opinión legal externa; no se inventó un
  timestamp de aceptación.
- **Derechos globales de código:** PASS en el alcance del código del proyecto y
  del diff revisado de PR #5. La marca y artwork de Clear continúan fuera de GPL.
- **Assets:** `check:asset-provenance` y `check:asset-rights` PASS; la aprobación
  de distribución no relicencia marcas ni obliga a publicarlas bajo GPL.
- **Source-only:** el archivo fuente temporal pasó `check:source-release` con
  604 entradas, 0 binarios runtime, 0 instaladores y 0 PDFs. Esto valida un
  candidato local; no constituye release/publicación. El gate binario y la
  obligación de fuente correspondiente de aria2/FFmpeg/FFprobe siguen aparte.
- No se hizo commit, push, release, reemplazo de `main` ni cambio remoto.

## Cierre de evidencia Devin y revisión global al 2026-09-24 (registro histórico)

- **PR #5 / Devin:** la evidencia pública, la actividad de la sesión, el
  contexto del correo de bienvenida en la misma cuenta, la captura del plan
  Free de la organización CacaPlay y los términos públicos se consideran
  **SUFICIENTEMENTE RESPALDADOS / CERRADOS PARA INVESTIGACIÓN ADICIONAL**.
  No buscar más correos ni abrir una investigación nueva salvo contradicción.
  Esto no es una conclusión jurídica absoluta ni una declaración GPL formal.
  El registro formal mantiene PENDING mientras siga pendiente la revisión
  global de derechos. La implementación actual conserva el contrato técnico
  reconstruido y no se reescribió historia.
- **Assets:** las 28 rutas de la tanda anterior y las nuevas familias/paths
  marcados con X están inventariados. Conteo actual: **238 iniciales → 73
  imágenes retiradas → 165 retenidas**, más dos XML auxiliares eliminados.
  La aprobación expresa del titular cubre Clear brand (62), Tauri/plataforma
  (8) y producto/documentación (95); check:asset-provenance valida el SHA-256
  registrado y pasa. Clear brand permanece fuera de GPL.
  Clear brand permanece fuera de GPL. Los iconos Windows/MSIX no tachados se
  conservaron y el fallback de preview usa el PNG Clear existente. El vector
  musical ambiguo fue reemplazado por Lucide list-music oficial en los tres
  mapas de interfaz. `check:asset-rights`, `check:assets`, `check:licenses`,
  `check:manifest`, `check:manifest:scope`, los checks de extensión/Store y
  `test:release-artifacts` pasan; el bundle web QA temporal contiene el logo y
  fallback Clear y no contiene los assets tachados. `check:asset-provenance`
  pasa tras la aprobación formal de la declaración agrupada;
  `check:rights` sigue PENDING por la acción formal separada de PR #5. El
  source-release gate queda PENDING porque no se generó/proporcionó un archivo
  fuente para inspección.
- **aria2 y FFmpeg/FFprobe:** versiones, hashes, URL de binario y configuración
  conocida siguen en `docs/THIRD-PARTY-RUNTIMES.md`. Se añadieron inventario de
  intake y gate en `third-party-source/`; no se inventaron fuentes exactas ni
  oferta escrita. `check:gpl-source` bloquea mientras el distribuidor no
  seleccione y documente una vía válida con revisión humana.
- **Seguridad:** reqwest entrega las direcciones públicas validadas al resolver
  de conexión; pruebas nuevas cubren IPv4/IPv6 reservadas, respuestas mixtas y
  direcciones fijadas. Proxy del sistema y motores externos quedan fuera de
  ese control. Los pasos remotos de environment/reviewers/secrets/tag rules
  están en `docs/GITHUB-RELEASE-SETUP.md`; GitHub no se modificó.
- **SQLite/privacidad:** un archivo fixture sintético del schema pre-aditivo se
  migra dos veces, conserva el marcador Spotify heredado y pasa
  `foreign_key_check`; la suite de biblioteca pasó 366/366. La prueba estática
  de privacidad pasó 8/8 contratos. El checklist WebView requiere una cuenta/VM
  desechable y sigue PENDIENTE.
- **Build QA:** checkout temporal en
  `%TEMP%\cdm-closeout-qa-36964e1484e24a2ea968e89fe8c21b4e`;
  se excluyeron `.git`, caches, outputs preexistentes y todos los PDFs. NSIS y
  MSI unsigned, build Tauri Store, MSIX QA pack/unpack con identidad sintética,
  ZIP de extensión y native host fueron verificados. No se instalaron,
  firmaron, publicaron ni copiaron esos outputs al checkout principal. Evidencia
  y hashes: `docs/BUILD-QA-RESULTS.md`.
- **Gates:** fmt/check/Clippy/test pasan; `npm audit` reportó 0 vulnerabilidades;
  cargo audit halló siete warnings permitidos del desktop lockfile y ninguno
  para el host nativo. Knip informó 33 archivos y 127 exports aparentes sin uso;
  no se borró código basándose solo en ese diagnóstico. `check:release` debe
  fallar por `check:rights` y `check:gpl-source`; no hubo
  commit/push/release.

### Bloqueos pendientes antes de publicar

1. El distribuidor debe obtener/validar fuente correspondiente completa de
   aria2 y FFmpeg/FFprobe, o redactar/revisar la oferta aplicable; subir el
   material al canal que entrega cada binario. No publicar esos bundles hasta
   que el gate GPL pase.
2. Administrador del repositorio: crear/proteger environment `release`, mover
   secretos allí, requerir reviewer y proteger tags `v*`; verificar la regla
   remota sin exponer secretos.
3. Ejecutar `docs/PRIVACY-QA.md` solo en Windows desechable.

## Fases

| Fase | Estado | Resultado / bloqueo concreto |
| --- | --- | --- |
| 0 — Mapa y plan | COMPLETADA | Se inspeccionó el árbol y se preservaron los cambios locales existentes, incluidos los de Microsoft Store y el PDF personal. |
| 1 — Licencia | DERECHOS DE CÓDIGO Y ASSETS PASS | PR #5 quedó aprobada para el diff revisado con declaración directa hash-registrada; distribución de assets aprobada por separado; marcas Clear siguen fuera de GPL. |
| 2 — Historial y contribuciones | AUDITADA; PR #5 EVIDENCIA CERRADA | Se encontró una sola cuenta humana propietaria en las contribuciones sustantivas y tres cambios mecánicos de Dependabot. No se reescribió historia; cierre de investigación no equivale a dictamen legal. |
| 3 — Retirada Spotify/spotDL | COMPLETADA | Sin rutas activas, OAuth, comandos, detección, logos en UI ni reanudación automática de trabajos heredados. `playlist_items.spotify_url` e historial permanecen intactos. |
| 4 — Assets, logos y marcas | 73 GRÁFICOS RETIRADOS; DISTRIBUCIÓN DE 165 RETENIDOS APROBADA | check:asset-rights verifica las 42 disposiciones; check:asset-provenance pasa para 62 brand, 8 Tauri/plataforma y 95 producto/docs. Clear brand sigue fuera de GPL; el vector musical ambiguo fue reemplazado por list-music oficial |
| 5 — AI slop, dead code y legacy | COMPLETADA CON RESIDUOS JUSTIFICADOS | Retirados los workers HTTP curl/aria2/segmentado inalcanzables, el inspector HTTP sin consumidor, wrappers de motores ignorados y la bandera fija muerta. Conservadas compatibilidad SQLite/sidecars, aria2 de torrents y gates de host/contenido usados. |
| 6 — Dependencias | COMPLETADA CON AVISOS TRANSITIVOS | Sin dependencias directas Rust/npm sin uso ni advisories de vulnerabilidad en los lockfiles revisados. El cargo audit actual mantiene siete warnings en desktop (seis sin mantenimiento y uno de soundness en `glib`, no resuelto para Windows MSVC); native host y npm reportan cero avisos/vulnerabilidades. |
| 7 — Refactorización | COMPLETADA EN EL ALCANCE PLANIFICADO | Nueve extracciones incrementales movieron responsabilidades de matching, inspección, formatos, búsqueda, recuperación, player/preview, scheduler, snapshots de descargas y metadatos/miniaturas a módulos de dominio. `lib.rs` pasó de 6.336 a 3.373 líneas frente a la instantánea previa a F7 (reducción de 2.963 líneas; 46,8%). El registro raíz conserva la composición de arranque Tauri y `run_app`; no hubo reescritura funcional. |
| 8 — Seguridad | HARDENING DNS DIRECTO IMPLEMENTADO; HIGH REMOTO PENDIENTE | reqwest fija respuestas públicas validadas y pruebas IPv4/IPv6 pasan. El proxy del sistema y motores externos quedan fuera del pinning; reglas/environment GitHub requieren configuración y verificación humana. No se modificó el remoto. |
| 9 — Privacidad/WebView2 | QA ESTÁTICO PASS; RUNTIME PENDIENTE | `check:privacy-storage` pasa 8 contratos de fuente/configuración. El checklist reproducible en `docs/PRIVACY-QA.md` requiere perfil Windows desechable; ningún perfil real fue inspeccionado. |
| 10 — SQLite | FIXTURE HISTÓRICO PASS; DATOS DE INSTALACIONES PENDIENTES | El fixture sintético de archivo prueba schema pre-aditivo, Spotify heredado, dos migraciones y foreign_key_check; provocó mover el índice `job_id` después de agregar la columna. No se abrió ninguna base instalada. |
| 11 — Frontend | COMPLETADA EN REVISIÓN ESTÁTICA | Traducción faltante corregida, contratos de validadores actualizados y carrusel probado como huérfano retirado. Sin QA visual/manual de navegador; límites en `docs/FRONTEND-REVIEW.md`. |
| 12 — Third party/licencias | GATE GPL IMPLEMENTADO; FUENTE CORRESPONDIENTE PENDIENTE | SBOM/notices/inventario regenerados y conservados. `check:gpl-source` coteja versiones/hashes y exige archivos, hashes y revisión del distribuidor; bloquea aria2 y FFmpeg/FFprobe mientras falten. |
| 13 — Build/CI/release | QA UNSIGNED PASS; PUBLICACIÓN BLOQUEADA | En clon temporal se construyeron NSIS/MSI, MSIX QA y extensión ZIP; se extrajo el MSI y se hizo pack/unpack del MSIX. No se firmó ni publicó. Tras retirar los assets y regenerar `MANIFEST.sha256`, siguen pendientes derechos, fuentes GPL y reglas remotas. |
| 14 — Documentación open source | COMPLETADA CON GATES EXPLÍCITOS | README con clon limpio, toolchain, comprobaciones y ejecución local; arquitectura, marcas y contribuciones documentadas. RELEASE-GUIDE prohíbe tags/publicación hasta cerrar derechos, fuentes GPL y barreras remotas. |
| 15 — Modularidad futura | COMPLETADA COMO LÍMITES DOCUMENTALES | `docs/ARCHITECTURE.md` separa HTTP, torrents y multimedia y registra seams futuros; no se implementó un sistema de plugins/providers. |
| 16 — Verificación final / cierre de bloqueos | SOURCE-ONLY PASS; BINARY/REMOTE GATES SEPARADOS | El archivo source-only inspeccionado pasa el gate sin runtime binaries ni instaladores. Binary readiness conserva el gate GPL estricto y fuentes correspondientes; protección remota y QA de privacidad siguen pendientes. No se reemplazó `main`. |

## Evidencia ejecutada

- Fase 3: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` pasó.
- Fase 3: `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` pasó, 361/361.
- Fase 3: regresión SQLite en memoria `legacy_playlist_spotify_data_is_preserved_and_never_resumed` pasó.
- Fase 3: `scripts/validation/source-boundaries.mjs`, `phase24_1_download_inputs.mjs`, `extension-check.mjs`, `extension-sync-smoke.mjs`, `store-edition.mjs` pasaron; 130 archivos JavaScript pasaron `node --check`.
- Fase 4: `scripts/validation/assets-brand-minimization.mjs` y `license-readiness.mjs` pasaron.
- Fase 4: `scripts/build.mjs` generó una salida de prueba temporal en
  `%TEMP%\cdm-phase4-webdist-f67f5851fead49699adc3c1f3e811f0e`;
  los 16 assets excluidos no aparecieron y los iconos genéricos, Lucide y Clear
  requeridos sí estuvieron presentes. No se tocó `dist/` del proyecto.
- Fase 5: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` pasó.
- Fase 5: `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`
  pasó, 358/358. Se retiraron las pruebas del código HTTP heredado y se agregó
  cobertura para el clasificador MIME y la reserva que preserva sidecars.
- Fase 5: `http-single-writer-recovery.py` y
  `http-resume-integrity.py` pasaron, incluidos los escenarios loopback y el
  SHA-256 de integridad.
- Fase 5: `bandwidth-limiter.mjs` y `download-priority.mjs` pasaron luego de
  actualizar sus referencias al worker activo y quitar una guarda contra un
  commit histórico que no existe en este checkout.
- Fase 5: las búsquedas del código no encuentran referencias a los módulos
  fuente retirados `downloads/aria2.rs` y `downloads/segmented.rs`; quedan solo
  menciones documentales y aserciones negativas de los validadores.
- Fase 6: `npm audit` pasó con 0 vulnerabilidades; `npx knip --dependencies`
  y `cargo machete src-tauri extension/native-host` no reportaron dependencias
  directas sin uso después de la poda.
- Fase 6: `cargo audit --json` informó 0 vulnerabilidades y 0 crates yanked en
  `src-tauri/Cargo.lock`; el lockfile de `extension/native-host` también quedó
  con 0 vulnerabilidades y sin avisos. `rustls` pasó a 0.23.45 (con
  `rustls-webpki` 0.103.15) y `chacha20` a 0.10.2. Se retiraron las
  dependencias directas no usadas `unicode-normalization` y `serde` del native
  host, y `motion` junto con sus transitivas del lock npm.
- Fase 6: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`,
  `cargo check --locked --manifest-path src-tauri/Cargo.toml`,
  `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --
  -D warnings` y `cargo test --locked --manifest-path src-tauri/Cargo.toml
  --lib --quiet` pasaron; 358/358 pruebas. `cargo check --manifest-path
  extension/native-host/Cargo.toml` también pasó.
- Fase 6: quedan 6 avisos `unmaintained` (`proc-macro-error 1.0.4` y cinco
  crates `unic-*` vía `urlpattern`/Tauri) y 1 `unsound` (`glib 0.18.5`, vía
  GTK/Tauri). El árbol Linux los incluye; el árbol Windows MSVC no incluye
  `glib`. No se sustituyó la cadena Tauri/GTK a ciegas. El informe amplio de
  Knip señaló posibles archivos/exports sin uso, pero sus rutas dinámicas no
  quedaron demostradas como muertas; se conservaron para las revisiones F7/F11.
- `phase32_ui_reference_v3.mjs` no pudo ejecutarse porque su referencia local
  `docs/ui-reference/CacaTools-UI-Reference-v3/README.md` no existe en este
  checkout. No se alteró esa referencia ausente.
- Fase 10: `cargo fmt --manifest-path src-tauri/Cargo.toml --check` pasó.
  `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib db::tests`
  pasó (2/2); `legacy_playlist_spotify_data_is_preserved_and_never_resumed`
  pasó (1/1). Las pruebas usan exclusivamente SQLite en memoria e incluyen
  error de migración propagado, rollback de ALTER parciales, repetición de la
  migración y `PRAGMA foreign_key_check`.
- Fase 10: no se abrieron perfiles ni bases SQLite instaladas y no se cambió
  ni eliminó dato real. La comprobación de filas huérfanas en instalaciones
  queda pendiente por ese límite de privacidad/datos.
- Fase 11: `check:i18n`, `check:0.24.1:responsive`, `check:ui-v5`,
  `check:phase13:subwindows`, `check:ui-static`, `check:extension-ui`,
  `check:extension-modules` y `check:extension-sync` pasaron. `node --check`
  pasó en todos los JavaScript de `app-ui/` y `extension/`; una búsqueda de
  runtime no encontró controlador/estado/DOM del carrusel retirado y
  `git diff --check` no encontró errores de whitespace. El alcance y límites
  están en `docs/FRONTEND-REVIEW.md`; no se hizo QA visual/manual en navegador.
- Fase 12: `npm run prepare:third-party-notices` regeneró
  `THIRD_PARTY_NOTICES.txt`, `NPM-SBOM.spdx.json` (SPDX 2.3; 45 paquetes) y
  `CARGO-DEPENDENCY-LICENSES.txt` (366 paquetes de registro para el grafo
  Windows x64 de desktop/native-host). `npm run verify:binaries` pasó y las
  versiones/hashes de yt-dlp 2026.08.19, Deno 2.9.7, aria2 1.37.0, FFmpeg y
  FFprobe 9.0.2 coinciden con `runtime-manifest.json`. Se retiró el texto de
  licencia AGPL residual de spotDL, ya que el componente no forma parte de los
  paquetes ni del generador actual. Las fuentes/ofertas de distribución GPL
  de aria2 y FFmpeg no están preparadas; F12 no se declara lista para publicar.
- Fase 13: GitHub Actions y el contenido de los bundles se revisaron sin
  ejecutar builds. La protección ausente de environment y tags cuenta como un
  único hallazgo HIGH del límite de firma; no se modificó configuración remota.
  El manifiesto fuente excluye el PDF personal, `dist-store/` y notas internas.
- Fase 14: el README documenta un clon limpio, requisitos Windows con enlace a
  Tauri, checks focalizados, fmt, cargo check/test y `tauri dev`. La guía release
  mantiene bloqueados tags/bundles mientras sigan pendientes las fuentes/ofertas
  GPL de runtime y la protección remota. Los derechos de PR #5 y de distribución
  de assets ya están registrados como aprobados en su alcance. `TRADEMARKS.md` y
  `ARCHITECTURE.md` documentan la separación de las marcas Clear y los límites
  actuales de distribución.
- Fase 15: los límites de HTTP, aria2/torrent y multimedia se describen en
  `docs/ARCHITECTURE.md`; el desacoplamiento de herramientas multimedia queda
  como objetivo futuro no verificado. No se añadieron plugins/providers ni
  nuevas funciones.
- Fase 16: la segunda ejecución de `npm run check:release` pasó los 27
  contratos vigentes. La primera ejecución reveló cuatro aserciones estáticas
  atadas a ubicaciones/activos anteriores; se actualizaron para seguir los
  módulos de búsqueda, formatos y snapshot actuales y el badge genérico, y los
  cuatro contratos aislados pasaron antes de repetir el gate. En la verificación
  del 2026-09-24 posterior a la retirada, el gate pasó los demás contratos y
  bloqueó únicamente `check:rights` y `check:gpl-source`.
- Fase 16: `cargo fmt --all -- --check`, `cargo check --locked`,
  `cargo clippy --all-targets -- -D warnings` y `cargo test --lib --quiet`
  pasaron en un `CARGO_TARGET_DIR` temporal nuevo; Rust reportó 360/360 tests.
  `cargo check` del native host pasó. `cargo audit --file` pasó para ambos
  lockfiles: 7 avisos transitivos de mantenimiento/sonoridad en desktop y 0
  avisos en native host; no se reportaron advisories de vulnerabilidad.
- Fase 16: `npm audit --audit-level=moderate` informó 0 vulnerabilidades.
  Knip terminó con código 1 y señaló 33 archivos/127 exports por uso no
  detectado en los entrypoints dinámicos; no se aceptaron borrados basados solo
  en ese resultado. `npm run prepare:third-party-notices`,
  `check:licenses`, `verify:binaries`, `version:check`, Store, extensión,
  i18n, responsive, UI V5 y UI estática pasaron.
- Fase 16: `scripts/build.mjs` generó una UI web QA de 118 archivos en
  `%TEMP%\cdm-f16-web-8169e744be4e47f1b451a9dcec2d0f1b`;
  SHA-256 de `index.html`:
  `EC2F9BAFEAB3A9666D50D8D195C7C5D90B0B760E6CF4B882D2EC09C5CED36F08`.
  No se construyó Tauri, NSIS/MSI ni MSIX, y no se modificaron outputs del
  checkout.
- Fase 16: el manifiesto fuente se regeneró después de las ediciones y contiene
  653 entradas. `check:manifest`, `check:manifest:scope`, `source-boundaries`,
  `git diff --check` y las búsquedas de semántica Apache en metadata de código
  propio confirmaron el estado actual. Apache-2.0 sigue presente solo en
  metadatos de licencias de dependencias y referencias históricas/de validación.
- Cierre de bloqueos posterior a la eliminación manual: 28/28 rutas ausentes;
  `check:asset-rights`, `check:assets`, `check:licenses`, `check:extension`,
  `check:extension-modules`, `check:store-edition` y el release gate ejecutados.
  Build web temporal comparó 50 assets esperados con 50 incluidos (diff 0) y
  ningún nombre retirado; 26 Markdown revisados sin imagen local rota y cuatro
  iconos de extensión presentes. QA runtime de privacidad sigue pendiente en
  perfil desechable.
- Fase 7 (parcial): matching de resultados pasó a `media/matching.rs`; los
  DTOs y helpers puros de parsing/clasificación de páginas pasaron a
  `downloads/inspection.rs`. Se conservaron las reglas de similitud y los
  niveles de confianza existentes; el flujo HTTP permanece en
  `downloads/commands.rs`.
- Fase 7 (Task 2): los tests previos y posteriores
  `extracts_downloadable_links_from_html_attributes`,
  `scores_files_and_rejects_html_pages` y
  `lowers_confidence_for_embedded_page_assets` pasaron (1/1 cada uno).
  `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`, la suite de
  librería (358/358) y Clippy `--all-targets -- -D warnings` también pasaron.
  El bloque de inspección se movió sin alterar sus cuerpos; se elevaron a
  visibilidad crate-local solo los DTOs/campos y helpers con consumidores
  existentes fuera del módulo.
- Fase 7 (Task 3): proyección, clasificación de streams, estimación de tamaño y
  generación de selectores multimedia pasaron a `media/formats.rs`. Los tests
  `video_selection_` (4/4) y
  `media_formats_expose_audio_technical_metadata_without_false_lossless`
  pasaron antes y después; fmt, suite completa (358/358) y Clippy con warnings
  denegados también pasaron. Se mantuvieron las selecciones y contratos
  observables; el helper de texto compartido no se movió en esta tarea.
- Fase 7 (Task 4): la conversión de resultados y la ejecución acotada de
  búsquedas del proveedor, junto con su generación de cancelación, pasaron a
  `media/search.rs`; la recuperación consume su exportación desde
  `media::mod`. Las 7 pruebas existentes del módulo, la prueba de generación de
  cancelación y la prueba de similitud pasaron antes; después pasaron las 8
  pruebas del módulo (incluida la prueba reubicada), cancelación y similitud.
  Fmt, suite completa (358/358) y Clippy con warnings denegados pasaron. No se
  ejecutó una búsqueda live del proveedor.
- Fase 7 (Task 5): DTOs, clasificación de fallos y comprobaciones de
  disponibilidad pasaron a `media/recovery.rs`; el módulo padre usa una
  exportación crate-local del clasificador para la misma política de reintento.
  Las pruebas de clasificación y del contrato camelCase pasaron antes y después
  (1/1 cada una); fmt, suite completa (358/358) y Clippy con warnings denegados
  también pasaron. Se movieron las pruebas junto a la implementación, sin
  cambiar cadenas, categorías, sugerencias ni número/demora de intentos.
- Fase 7 (Task 6): DTOs de reproductor/preview/cola pasaron a
  `media/models.rs`; la detección de tipo y `ffprobe` opcional a
  `media/player.rs`; y selección/proyección de preview a `media/preview.rs`.
  Las pruebas `preview_` (13/13) y de modo de salida (1/1) pasaron antes y
  después; fmt, suite completa (358/358) y Clippy con warnings denegados también
  pasaron. Los campos serializados, el orden de calidades y la validación de
  archivos locales permanecen iguales.
- Fase 7 (Task 7): validación/carga de programaciones, runtime, dispatch y loop
  pasaron a `downloads/scheduler.rs`; los wrappers de comandos y `run_app`
  conservan sus interfaces vía reexports crate-local. La suite completa
  (358/358), fmt y Clippy con warnings denegados pasaron. La revisión estática
  confirmó que el loop solo se inicia desde `run_app` y los helpers de
  programación son consumidos por el comando existente; no había test unitario
  dedicado al loop en este checkout.
- Fase 7 (Task 8): DTOs de snapshots/recibos y lectura/proyección de actividad
  pasaron a `downloads/snapshot.rs`; `runtime_status` y la orquestación de
  comandos se conservaron en `lib.rs`. Antes y después pasaron `snapshot_`
  (11), `download_activity_` (1), `playlist_snapshot_` (2) y
  `multimedia_processing_stage_preserves_last_real_percentage` (1). La suite
  completa pasó 358/358, además de fmt y Clippy con warnings denegados.
- Fase 7 (Task 9): duración, lectura de strings JSON, aceptación de streams y
  selección/validación de miniaturas pasaron a `media/metadata.rs`; los
  consumidores existentes usan reexports crate-local. Las cinco pruebas
  focalizadas de aceptación de streams, URLs seguras, preferencia de variante
  y fallback de YouTube pasaron antes y después; suite completa 358/358, fmt y
  Clippy con warnings denegados también pasaron.
- Fase 7: `lib.rs` conserva el wiring del punto de entrada Tauri y el arranque
  de aplicación como composition root. La reducción de líneas es una medida
  mecánica de tamaño, no una afirmación de cobertura ni de completitud legal.
- Fase 8: Gitleaks y actionlint no estaban disponibles. El escaneo equivalente
  de patrones de secretos en fuente e historial Git produjo cero candidatos de
  alta confianza y nunca imprimió valores. Se revisaron manualmente procesos,
  argumentos, rutas, redirecciones, validación de descargas, firma, updater,
  puente nativo, extensión, CSP, torrent y workflows. No se inspeccionaron
  cookies, bases reales ni credenciales.
- Fase 8: checkout, setup-node y rust-toolchain quedaron fijados a SHA; el
  checkout no persiste credenciales. Se eliminó la interpolación directa del
  ref en PowerShell y Playwright innecesario del job de release. Sin embargo,
  la clave privada del updater sigue disponible en el job de publicación
  mientras no se confirme un environment protegido y tags protegidos en
  GitHub; por esa dependencia la fase sigue PENDIENTE y no se publicó nada.
- Fase 8: la política de URL rechaza redes privadas y revalida cada redirect,
  pero la resolución usada para verificar y la conexión efectiva son separadas;
  se documenta un riesgo MEDIUM de rebinding sin explotación demostrada. Los
  destinos de trackers/web seeds del motor torrent permanecen como una frontera
  de red separada y no se modificaron para evitar cambiar compatibilidad.
- Fase 9: `docs/PRIVACY.md` inventaría datos locales y solicitudes de red por
  función. Se confirma en fuente que `media_session_v1` guarda preferencia y
  ruta, no valores de cookies; yt-dlp 2026.08.19 lee Brave con copia temporal y
  la caché persistente del motor no está desactivada. Tauri 2.11.6 configura
  automáticamente el perfil WebView bajo LocalData si no hay ruta propia; no se
  limpian esos datos al salir.
- Fase 9: `app-ui/download-manager/view/shared.js` ya informa que las cookies
  correspondientes se envían al sitio de contenido y que la extracción usa
  copia temporal local. Se actualizó la traducción inglesa. El editor conserva
  hasta 12 blobs recientes y proyectos en IndexedDB; estos datos no se tocaron.
  La extensión también conserva enlaces manuales y una copia local de hasta 80
  trabajos con URL/destino, además de preferencias y journal de idempotencia.
- Fase 9: la CSP conserva `connect-src` IPC, `object-src 'none'` y alcance vacío
  de assets. No se estrecharon `img-src`/`media-src` porque los CDNs de streams y
  miniaturas varían por proveedor y no se demostró compatibilidad de un allowlist
  fijo. No se abrió WebView2 ni se hizo captura de tráfico.

## Límites de preservación

- No se abrió ninguna base de datos real ni se leyeron tokens o credenciales.
- No se modificó `playlist_items.spotify_url` ni se reescribieron estados
  históricos al inicio.
- `Pago en Línea - UASD.pdf` permanece intacto.
- Los recursos generados `dist/`, `dist-store/`, `extension-dist/`, `output/` y
  `MANIFEST.sha256` no se regeneraron durante estas fases.
- Los cambios previos de edición Microsoft Store se conservaron junto con el
  trabajo realizado aquí.

## Fase 5 — plan de limpieza acotado

### Estado actual y evidencia

- `src-tauri/src/downloads/segmented.rs` contenía un worker HTTP segmentado
  completo, pero `rg` no encontró ninguna llamada a
  `try_segmented_http_download` fuera de su propia definición. Los gates
  `scripts/validation/http-single-writer-recovery.py` y
  `scripts/validation/http-resume-integrity.py` bloquean explícitamente que ese
  worker vuelva a entrar en la ruta HTTP: escribiría fuera de la autoridad de
  escritor único/lease persistente.
- La inspección posterior del grafo corrigió el alcance del helper: el borrado
  `remove_http_segment_artifacts` se llamaba únicamente desde el propio worker
  curl que ya está desconectado. `downloads/storage.rs` sí reconoce ocho
  nombres históricos `.segment-NNN.part` al reservar destinos. Se retiró el
  módulo de descarga/limpieza huérfano y se conservó únicamente esa protección
  contra colisiones; no se borró ningún sidecar del usuario.
- `progress/aria2.rs`, el motor torrent, `chaos.rs` y los clasificadores de
  host/contenido sí muestran usos activos. El anterior `downloads/aria2.rs` no
  tenía consumidores para `inspect_http`, `run_aria2c` ni sus auxiliares; se
  reemplazó por `downloads/response_classification.rs`, llamado desde
  `downloads/commands.rs`. El aria2 de torrents y progreso queda intacto.
- `run_curl_download_worker_inner`, su wrapper de reintentos,
  `schedule_aria2_resume` y el adaptador `run_aria2c` no tienen llamadas desde
  los workers actuales. Los gates de recuperación prohíben esas rutas; el worker
  HTTP actual usa reqwest, lease y escritor único. El timeout `HTTP_IDLE_TIMEOUT_SECS`
  también se usa en esa ruta nueva y se mantuvo.
- `inspect_http` y su clasificación completa tampoco tienen consumidor; la
  cola ya usa `remote_download_probe`. Se mantendrán solo los dos helpers
  efectivamente llamados por `downloads/commands.rs`. El dispatcher también
  pasa `aria2_path` y un registro de procesos a wrappers HTTP que los ignoran;
  se simplificará esa cadena para que el worker declare solo sus entradas reales.
- El campo de estado de ejecución `http_aria2_enabled` no tiene consumidor en la
  UI ni extensión. Se quitará ese indicador fijo del estado en memoria, pero no
  se inspeccionará ni modificará la base real; el esquema `http_engine_attempts`
  y toda configuración histórica permanecerán.
- `docs/UPDATER-MIGRATION.md` conserva instrucciones y límites de soporte para
  instaladores 0.95.1/build4 en adelante; es información de actualización aún
  necesaria, no un artefacto binario viejo.
- Las configuraciones de Store son parte del canal local vigente y se
  conservarán. Los ejemplos de firma/verificación están detrás de
  `maintainer-tooling` y sus claves vectoriales están identificadas como TEST
  ONLY; se conservarán para reproducibilidad, sin usar claves de producción.
- `extension/native-host/firefox-host.template.json` no tiene consumidor de
  build encontrado, pero `scripts/check.mjs` lo declara como parte del esquema
  fuente y el host manifiesta un placeholder de Firefox. No se borrará mientras
  la compatibilidad y el formato de distribución de Firefox no estén
  aclarados en las fases de extensión/build.
- No se limpiarán automáticamente `TODO/FIXME`, validadores históricos o
  nombres `CacaTools`: varias referencias pertenecen a contratos de extensión,
  persistencia, releases previas, gates de regresión y rutas de actualización.

### Secuencia autorizada

1. Retirar el módulo `downloads/segmented.rs` y sus helpers huérfanos; mantener
   en `downloads/storage.rs` el reconocimiento de ocho nombres de sidecar para
   evitar reutilizar destinos heredados.
2. Retirar los adaptadores curl/aria2 HTTP sin consumidores, el reintento
   aria2 huérfano y el inspector sin consumidor. Renombrar el módulo residual a
   `response_classification.rs`, conservar los dos clasificadores usados por la
   cola y simplificar los wrappers HTTP que todavía aceptan motores/registries
   que ya no utilizan.
3. Retirar la bandera de estado muerta sin tocar datos/configuración de SQLite.
4. Ejecutar los gates HTTP de integridad/escritor único, chequeo Rust relevante
   y `cargo fmt --check`; corregir únicamente regresiones atribuibles a este
   cambio.
5. Registrar hallazgos examinados y su decisión (retirado/conservado/pendiente)
   antes de marcar Fase 5. Los candidatos restantes sin prueba de inutilidad se
   conservan para las fases de dependencias, seguridad y build.

### Recuperación

El código retirado está disponible en el diff local; ante regresión se
restituirá solo el módulo funcional desde la base local registrada y se dejará
el gate activo. No se usará reset, stash, checkout global ni commit.

### Resultado y decisiones conservadoras

- Eliminados: runner curl y sus reintentos, runner aria2 HTTP y auxiliares,
  inspector HTTP sin consumidor, wrapper de reanudación aria2 sin llamada,
  wrapper HTTP que aceptaba `aria2_path`/registro de procesos ignorados, módulo
  HTTP segmentado y adaptador de límite curl.
- Renombrado: la capa que la cola sí usa ahora es
  `downloads/response_classification.rs`; conserva el allowlist de hosts y la
  clasificación MIME de HTML.
- Conservado: aria2/progreso de torrents, `chaos.rs` activo, los ocho sufijos
  de segmento al reservar nombres, SQLite `http_engine_attempts` y la
  configuración/historial local. No se borraron sidecars existentes.
- Conservado como evidencia/compatibilidad: `docs/UPDATER-MIGRATION.md` (las
  instalaciones 0.95.1/build4 aún necesitan la transición), fixtures firmados
  TEST ONLY, ejemplos bajo `maintainer-tooling`, Firefox host template
  (declarado por `scripts/check.mjs`; el formato de distribución Firefox sigue
  sin aclararse), scripts Store locales, y nombres/IDs históricos que forman
  parte de contratos, releases previas o estado persistido.
- Limpieza de validadores: sustituidas las referencias a módulos retirados y se
  eliminó una guarda `git diff` fijada a SHA inexistente; las aserciones
  funcionales de prioridad y bandwidth siguen activas.

