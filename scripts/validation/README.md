# Validation / Tooling

Esta página describe el sistema de validación existente en CacaTools Desktop
0.45.0. Documenta propósito y estado del tooling; no constituye una garantía
de que todos los gates hayan pasado en cada máquina o ejecución.

## Estados

* **SUPPORTED**: interfaz actual soportada para comprobar una propiedad
  concreta del producto o del build.
* **ENVIRONMENT-DEPENDENT**: depende de Windows, binarios, Python,
  Playwright, Chromium, WebView2, red u otra instalación externa.
* **MANUAL**: requiere una acción o decisión humana y no es un gate automático
  del build normal.
* **LEGACY**: se conserva por compatibilidad o valor histórico, pero no es el
  flujo canónico actual.
* **DEPRECATED**: explícitamente retirado del procedimiento soportado. No se
  asigna este estado a tooling mientras exista una duda histórica o dinámica.

La clasificación describe el estado del comando, no el resultado de una
ejecución concreta. Cuando se menciona un resultado reciente, se identifica
como evidencia de POST-3B2A y no como garantía permanente.

## 1. Qué certifica cada tipo de gate

Los gates estáticos inspeccionan código, configuración, contratos y archivos.
Los gates de build comprueban que el producto pueda compilar en el entorno
disponible. Los harnesses de navegador comprueban una superficie simulada o
una interacción concreta. Un PASS estático o de compilación no certifica por
sí solo una ejecución real de Tauri, proveedores externos, cookies, SQLite,
WebView2, ventanas nativas o reproducción online.

## 2. Gates principales soportados

| Comando | Estado | Cobertura / realidad actual |
|---|---|---|
| `npm run check` | **LEGACY AGGREGATOR** | Agregador histórico amplio. En POST-3B2A ya no exige los `.cmd` históricos ausentes y devuelve código distinto de cero cuando detecta fallos, pero conserva assertions 0.24.1/0.24.2/0.25.x y evidencias que pueden no existir. Puede fallar aunque los gates modernos pasen. |
| `npm run check:release` | **SUPPORTED / RELEASE** | Gate explícito de la línea 0.95.x. Ejecuta únicamente contratos actuales de versión, orden, menú flotante, motion, formatos, reproductor local, HTTP, catálogo de seguridad y extensión. No sustituye los gates Rust ni la firma del updater. |
| `npm run check:manifest` | **SUPPORTED** | Verifica `MANIFEST.sha256` contra el código fuente incluido. |
| `npm run check:encoding` | **SUPPORTED** | Busca problemas de codificación en los archivos inspeccionados. |
| `npm run check:ui-static` | **SUPPORTED** | Contratos estáticos de la UI actual. |
| `npm run check:functional-optimization` | **SUPPORTED** | Contratos actuales de optimización funcional, resultados incrementales y ciclo de thumbnails. |
| `npm run check:youtube-stability` | **SUPPORTED** | Protecciones de yt-dlp, saneamiento de traceback y contratos relacionados con media. |
| `npm run check:subwindows` | **SUPPORTED** | Responsividad y contratos de subventanas; la política de playlist se verifica en los owners actuales `resolver.rs`, `extraction.rs` y `playlist.rs`. |
| `npm run check:live` | **ENVIRONMENT-DEPENDENT** | Harness diagnóstico DOM/frontend simulado. No es certificación Tauri real; véase la sección 11. |
| `npm run check:performance` | **ENVIRONMENT-DEPENDENT** | Smoke de rendimiento local; depende de Python y de sus fixtures/artefactos. |
| `npm run check:media-e2e` | **ENVIRONMENT-DEPENDENT** | E2E multimedia; depende de binarios, proveedor, red, cookies/sesión y entorno. |
| `npm run check:progress-v2-runtime` | **ENVIRONMENT-DEPENDENT** | Validación runtime del progreso v2 y sus fixtures. |
| `npm run check:progress-acceptance` | **ENVIRONMENT-DEPENDENT** | Aceptación runtime del motor de progreso. |
| `npm run check:ui-v5` | **SUPPORTED** | Gate estructural reproducible del source actual; no requiere snapshots históricos ni evidencias externas. |
| `npm run check:ui-v5:parity` | **ENVIRONMENT-DEPENDENT** | Comparación del harness UI v5 en navegador Python. |
| `npm run check:ui-v5:performance` | **ENVIRONMENT-DEPENDENT** | Rendimiento del harness UI v5 en navegador Python. |
| `npm run check:extension` | **SUPPORTED** | Contratos estáticos de la extensión y su manifest. |
| `npm run build:web` | **SUPPORTED** | Construye frontend y módulos integrados mediante `scripts/build.mjs`. |

Los comandos de esta tabla no deben interpretarse como una orden de ejecutar
la matriz completa automáticamente.

## 3. Rust

Comandos relevantes:

```text
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo check --manifest-path src-tauri/Cargo.toml --locked
cargo test --manifest-path src-tauri/Cargo.toml --locked --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
```

Estado: **SUPPORTED**, sujeto a toolchain y dependencias locales. El resultado
observado en una fase concreta debe registrarse aparte. El gate Clippy
conserva dos diagnósticos históricos `too_many_arguments`; no se presentan
como regresión de 3B-2, no se silencian con `allow` y no se corrigen desde
esta documentación.

## 4. Frontend / UI estático

* `check:ui-static` ejecuta `scripts/validation/phase20_ui_static.mjs` y
  comprueba contratos estáticos de la UI.
* `check:encoding` ejecuta `scripts/validation/scan-mojibake.mjs`.
* `check:manifest` ejecuta
  `scripts/generate-source-manifest.mjs --check`.
* `check:ui-v5` ejecuta `scripts/validation/ui-v5-structural-gate.mjs` y valida contratos estructurales actuales del source, sin depender del snapshot histórico Fase 0 ni de reports/PNG externos.
* `check:ui-v5:parity` y `check:ui-v5:performance` permanecen environment-dependent: pueden requerir navegador, referencias externas, fixtures y outputs generados por sus harnesses.

Los smoke visuales y los harnesses de navegador no sustituyen una prueba
runtime de Tauri ni una comprobación visual humana cuando esta sea necesaria.

## 5. Media / YouTube

* `check:youtube-stability` ejecuta
  `scripts/validation/phase30_ytdlp_stabilization.mjs`.
* `check:media-e2e` ejecuta
  `scripts/validation/phase30_media_e2e.mjs`.
* Los checks de media dependen de yt-dlp, FFmpeg/ffprobe, red, proveedor,
  disponibilidad de URLs y contexto de sesión. No deben tratarse como una
  garantía universal para todos los vídeos.
* Las cookies, tokens y almacenamiento privado no forman parte de los
  informes de tooling.

## 6. Download Manager / progreso

* `check:progress-v2-runtime` ejecuta
  `scripts/validation/progress-v2-runtime-corrective.mjs`.
* `check:progress-acceptance` ejecuta
  `scripts/validation/progress-acceptance-runtime.mjs`.
* `check:functional-optimization` ejecuta
  `scripts/validation/phase33_functional_optimization.mjs`.
* `check:performance` ejecuta
  `scripts/validation/phase19_performance_smoke.py`.

Estos comandos comprueban contratos o fixtures según su propia cobertura; no
certifican por sí solos pausa, cancelación, reanudación, SQLite, FFmpeg o
transferencia real en todas las combinaciones.

## 7. Subventanas

`check:subwindows` ejecuta
`scripts/validation/phase34_subwindow_responsiveness.mjs` y está **SUPPORTED**.
La assertion de análisis multimedia sigue la arquitectura actual: resolución
en `src-tauri/src/media/resolver.rs`, construcción de extracción en
`src-tauri/src/media/extraction.rs` y post-procesamiento de playlist en
`src-tauri/src/media/playlist.rs`. No presupone que todo viva en `lib.rs`.

La interacción separada `check:subwindows:interaction` es
**ENVIRONMENT-DEPENDENT** y usa
`scripts/validation/phase34_subwindow_interaction.py`.

## 8. Windows / build / release

La cadena Windows se documenta por responsabilidad:

| Comando | Estado | Responsabilidad |
|---|---|---|
| `npm run check:windows-toolchain` | **ENVIRONMENT-DEPENDENT** | Comprueba toolchain Windows mediante `scripts/check-windows-toolchain.ps1`. |
| `npm run check:native-windows` | **ENVIRONMENT-DEPENDENT** | Ejecuta `scripts/native-check-windows.ps1`. |
| `npm run check:windows` | **ENVIRONMENT-DEPENDENT** | Actualmente es un alias del mismo `scripts/native-check-windows.ps1`; no es un agregador completo. |
| `npm run build:windows` | **ENVIRONMENT-DEPENDENT** | Build beta mediante `scripts/build-windows-beta.ps1`. |
| `npm run build:windows:final` | **ENVIRONMENT-DEPENDENT** | Build final y bundle NSIS mediante `scripts/final-windows-build.ps1`. |
| `npm run prepare:windows-binaries` | **ENVIRONMENT-DEPENDENT** | Preparación de binarios empaquetados. |
| `npm run smoke:windows` | **MANUAL / ENVIRONMENT-DEPENDENT** | Smoke de la aplicación instalada. |
| `npm run ci:windows` | **ENVIRONMENT-DEPENDENT** | Secuencia CI Windows. |
| `npm run report:size:windows` | **MANUAL / ENVIRONMENT-DEPENDENT** | Informe de tamaño de binarios. |
| `scripts/prepare-update-release.ps1` | **MANUAL / ENVIRONMENT-DEPENDENT** | Preparación de release/update; no tiene alias npm y no se ejecuta como validación documental. |

Build y release pueden usar `scripts/powershell-hash-compat.ps1` y
`scripts/collect-windows-diagnostics.ps1` de forma transitiva. Esas
dependencias permanecen activas y no son candidatas de limpieza por esta
documentación.

## 9. Extensión

* `npm run check:extension` ejecuta `scripts/validation/extension-check.mjs`.
* `npm run extension:build` ejecuta `scripts/build-extension.ps1` y depende de
  Windows/PowerShell.
* `npm run check:extension-sync` ejecuta
  `scripts/validation/extension-sync-smoke.mjs`.
* `check:extension-detection` y `check:video-detector` apuntan actualmente al
  mismo `scripts/validation/video-detector-smoke.mjs`.

La apertura real de Chrome, el native host y la publicación no quedan
certificados por un gate estático aislado.

## 10. Diagnóstico y benchmarks

Son herramientas de observación, no gates obligatorios del build:

* `check:visual` ejecuta `scripts/validation/phase20_workspace_visual_smoke.py`.
* `check:workspace` ejecuta
  `scripts/validation/phase22_internal_workspace_smoke.py`.
* `check:icons` ejecuta `scripts/validation/phase20_icon_audit.mjs`.
* `check:browser-capture` ejecuta
  `scripts/validation/browser-capture-smoke.mjs`.
* `check:live` usa el harness descrito en la sección 11.

Los benchmarks pueden escribir informes o screenshots en las carpetas de
salida previstas por cada script. Esos artefactos no deben confundirse con
fuente, ni copiarse a un freeze de código.

## 11. Harnesses Playwright / DOM simulados

Los scripts Python que usan Playwright dependen del entorno Python externo y
Playwright no está declarado actualmente como `devDependency` npm. Pueden
requerir además un navegador Chromium instalado o una ruta configurada por el
entorno. Por eso se clasifican como **ENVIRONMENT-DEPENDENT** o
**MANUAL / DIAGNOSTIC** según el comando.

En particular, `check:live` es un **DOM / frontend simulated diagnostic
harness**. Puede comprobar:

* render del DOM;
* búsqueda y debounce;
* latest-request-wins;
* patch de progreso;
* selección;
* ausencia de errores JavaScript en ese fixture.

`check:live` no certifica WebView Tauri real, IPC nativo real, lifecycle,
SQLite real, procesos externos, player online real, permisos ni ventanas
nativas. Un PASS de este harness debe informarse como PASS del harness DOM,
nunca como PASS runtime Tauri.

## 12. Legacy / históricos

### Fase 15

Estos scripts permanecen documentados como **LEGACY / MANUAL** y no son gates
obligatorios del build normal:

* `phase15_media_smoke.py`: fixtures multimedia locales; requiere Python,
  FFmpeg y FFprobe; no usa Internet.
* `phase15_visual_smoke.py`: smoke visual con páginas simuladas; requiere
  Python, Playwright y Chromium; no certifica Tauri real.
* `phase15_responsive_smoke.py`: combinaciones históricas de viewport; no
  sustituye los checks actuales de CSS o subventanas.
* `phase15_mock_native_smoke.py`: mock de bridge Tauri, playlist, progreso y
  pausa; no prueba el proceso nativo real.

### Fases 16–18

Los elementos históricos de Fases 16–18 no se enumeran automáticamente como
muertos. El grafo actual mantiene 34 elementos **E — NO DETERMINABLE**. La
ausencia de una raíz npm o de una importación no basta para clasificarlos como
DEPRECATED o seguros de eliminar. Cualquier decisión futura debe auditar
loader, acceso dinámico, documentación soportada y consumidores transitivos.

### Aliases equivalentes

Se conservan sin cambios los siguientes aliases equivalentes:

* `check:native-windows` y `check:windows` →
  `scripts/native-check-windows.ps1`.
* `check:extension-detection` y `check:video-detector` →
  `scripts/validation/video-detector-smoke.mjs`.
* `check:0.24.2:precompile`, `check:0.25.0:precompile` y
  `check:0.25.1:precompile` →
  `scripts/validation/phase24_2_precompile_audit.mjs`.

La decisión sobre aliases duplicados pertenece a una fase posterior; esta
ronda no modifica `package.json`.

## 13. Requisitos de entorno

Según el comando, pueden ser necesarios:

* Node.js y npm para los scripts JavaScript y `build:web`;
* Rust y Cargo con el toolchain MSVC para el backend;
* Python para los smoke/harnesses Python;
* Playwright Python y Chromium para los harnesses de navegador;
* Windows, PowerShell y WebView2 para Tauri y los scripts Windows;
* FFmpeg/ffprobe para media local y multimedia;
* yt-dlp fijado por el proyecto para extracción;
* aria2 cuando el flujo de descarga lo requiera;
* red, proveedor y sesión válida para E2E multimedia.

Esta documentación no instala tooling ni dependencias.

## 14. Qué NO constituye certificación Tauri real

No son equivalentes a una certificación runtime completa:

* una compilación correcta;
* `cargo test` aislado;
* una assertion estática;
* un fixture DOM o un mock de IPC;
* un PASS de Playwright con `page.set_content`;
* un resultado histórico guardado en `docs/tests`;
* una prueba de proveedor sin repetir las condiciones de sesión y red;
* un gate que no ejercite WebView2, ventanas nativas, SQLite o procesos reales.

La certificación runtime debe indicar qué parte se observó realmente, qué
parte quedó sin certificar y qué entorno se utilizó.
