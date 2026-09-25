# Auditoría de build, CI y distribución

**Fecha:** 2026-09-24. Revisión estática y consultas remotas de solo lectura;
no se ejecutó un instalador, MSIX ni release.

## Resumen de GitHub Actions

| Severidad | Cantidad | Resultado |
| --- | ---: | --- |
| CRITICAL | 0 | No se encontró una ejecución de código de PR en un trigger privilegiado. |
| HIGH | 1 | La firma puede ejecutarse sin una barrera verificable: el workflow no declara environment y la API consultada no devolvió environments ni rulesets del repo. |
| MEDIUM | 0 | Permisos de workflows de CI limitados; el permiso de escritura queda en el flujo de release. |
| LOW | 0 | La falta de protección de tags forma parte del hallazgo HIGH de acceso a la firma; no se cuenta por segunda vez. |
| INFO | 3 | Acciones fijadas por SHA; checkout sin persistir credenciales; comentarios de versión legibles en las referencias. |

Se revisaron `.github/workflows/quality.yml`, `security.yml`,
`check-ytdlp-update.yml` y `release-windows.yml`. Quality y Security usan
`contents: read`; el actualizador tiene `issues: write` porque abre issues y
`contents: read`; Release necesita `contents: write`. Las acciones observadas
están fijadas a SHA completos. No se encontraron `pull_request_target`,
`workflow_run`, runners self-hosted ni datos de eventos externos interpolados
directamente dentro de comandos. Checkout desactiva `persist-credentials`.

**Evidencia remota de solo lectura:** GitHub API informó cero environments para
`CacaPlay/clear-download-manager`, la consulta de rulesets con reglas heredadas
devolvió una lista vacía y la consulta legacy de tag-protection devolvió 404.
El workflow entrega `TAURI_SIGNING_PRIVATE_KEY` y su password al paso de build,
pero no declara `environment:`. La falta de controles de tags forma parte del
mismo límite de firma y no se cuenta como otro hallazgo. Por tanto, el HIGH de
`docs/SECURITY-REVIEW.md` queda confirmado para la configuración consultada.
No se modificó el remoto ni se consultaron valores de secretos.

## Qué entra en cada distribución

| Canal | Entrada y configuración | Contenido observado |
| --- | --- | --- |
| GitHub Windows NSIS/MSI | `.github/workflows/release-windows.yml`, `src-tauri/tauri.conf.json` | Frontend `dist/`, ejecutable Tauri, `resources/bin/*`, `resources/licenses/*`, updater y bridge/extensión nativa. La firma y publicación requieren secretos de release. |
| Microsoft Store MSIX | `scripts/build-store-msix.ps1`, `src-tauri/tauri.store.conf.json` | Frontend `dist-store/`, runtime Windows, avisos/licencias y bridge. No incluye endpoints ni artefactos del updater; el MSIX se produce sin firmar para Partner Center. |
| Extensión Chrome ZIP | `scripts/build-extension.ps1` | Solo los archivos runtime de `extension/`, assets/iconos y `LICENSE.md`, `COPYING`, `NOTICE.md`. La identidad pública versionada se inyecta en el manifest generado; el ZIP no incorpora los binarios Windows. |

El inventario de versiones runtime está en
`docs/THIRD-PARTY-RUNTIMES.md`. Los builds Windows regeneran los avisos antes
del empaquetado. `package.json` es la versión de referencia convencional; la
versión de Tauri, Cargo, UI y extensión sigue duplicada en sus metadatos y
`scripts/version-check.mjs` exige que coincidan. La extensión tiene además su
propia matriz de compatibilidad de app.

## Salidas locales y manifiesto fuente

Se preservaron `dist/`, `dist-store/`, `extension-dist/`, `output/`, los ZIP de
extensión existentes y los caches/builds de Rust. No se ejecutó un script que
los regenere. Varios scripts de build eliminan su destino predeterminado antes
de escribir; en especial `scripts/build.mjs` hace `rmSync` sobre el directorio
indicado por `CDM_WEB_DIST_DIR` (por defecto `dist`). El Store build fija esa
variable a `dist-store`, que ya existía; el build Windows beta/final también
limpia carpetas bajo `output/` y el bundle Tauri. Por ese motivo sus wrappers
no se usaron en este checkout.

Se acotó `scripts/generate-source-manifest.mjs` para excluir el output local
`dist-store/`, el scratch `.superpowers/`, planes internos `docs/superpowers/`
y PDFs de nivel raíz que pueden ser adjuntos personales. Se agregó un gate que
verifica esas exclusiones y que conserva como entradas el metadata `.cdm` ya
versionado y la clave **pública** requerida por el build de extensión. El
manifiesto se regeneró con 640 archivos y `check:manifest` pasó. La carpeta
`extension/native-host/target/` también quedó ignorada; no se borró.

El harness V5 ya no apunta a `%USERPROFILE%\...`: usa una referencia
configurable mediante `CACATOOLS_UI_V5_REFERENCE`, da un error explícito si no
existe y escribe sus imágenes/reportes en un directorio temporal único (o una
salida configurada que debe no existir). No se ejecutó porque tanto la
referencia configurada anteriormente como el default portable faltan en este
checkout.

## Gates ejecutados y pendiente

Pasaron `version:check`, `check:store-edition`, `check:extension`,
`check:manifest:scope`, `check:manifest`, la verificación de sintaxis Python del
harness y `git diff --check`. F16 regeneró el manifiesto con 643 entradas y
construyó solo la UI web QA en un directorio temporal nuevo; no se hizo un
bundle Tauri, instalador ni MSIX.

**No publicar** mientras no se creen y verifiquen el environment de release con
aprobación y secretos de entorno, reglas de creación/reemplazo para tags de
release, y los materiales de fuente/oferta GPL de aria2 y FFmpeg. La
configuración remota queda fuera del alcance autorizado para modificar.
