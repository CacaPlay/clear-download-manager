# Preparar una publicación de Clear Download Manager

## Bloqueo actual

**No crear tags de release, ejecutar `workflow_dispatch`, distribuir bundles ni
publicar una versión desde este checkout.** A 2026-09-24 permanecen abiertos
estos requisitos:

1. Resolver con evidencia la titularidad o autorización de los cambios de PR
   #5 indicados en `OPEN-SOURCE-RIGHTS-REVIEW.md`. El texto de licencia y los
   metadatos locales no resuelven esa cadena de derechos.
2. Preparar y verificar el código fuente correspondiente o una oferta escrita
   que acompañe cualquier redistribución de los runtimes GPL de aria2 y
   FFmpeg/FFprobe. El inventario y las versiones exactas están en
   `THIRD-PARTY-RUNTIMES.md`.
3. Configurar y verificar en GitHub un environment de release con aprobación,
   guardar allí los secretos de firma y proteger la creación/reemplazo de tags
   `v*`. La consulta remota de solo lectura no encontró environments ni
   rulesets aplicables; véase `GITHUB-RELEASE-SETUP.md`.
4. Repetir las comprobaciones de fuente, avisos, manifiesto y bundle desde una
   copia limpia, verificando que los archivos de código, marcas y terceros que
   entran al paquete están autorizados y documentados.

Los puntos 1 y 2 requieren cerrar derechos/materiales de distribución; el
punto 3 requiere una acción del administrador del repositorio. No se debe
interpretar la preparación local como permiso para liberar.

## Preparación de un checkout dedicado

Antes de considerar una versión futura, un mantenedor debe usar un clon de
compilación dedicado con los outputs de destino vacíos. Los scripts de Windows
limpian directorios predeterminados en `output/`, `dist/` y `src-tauri/target/`;
consulta `BUILD-RELEASE-AUDIT.md`. No los ejecutes donde existan artefactos que
se deban conservar.

Comprobaciones previas que no publican:

```powershell
npm.cmd ci --no-audit --no-fund
npm.cmd run prepare:windows-binaries
npm.cmd run prepare:third-party-notices
npm.cmd run check:manifest
npm.cmd run version:check
npm.cmd run check:release
npm.cmd run check:licenses
npm.cmd run verify:binaries
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
```

También se deben regenerar y revisar `THIRD_PARTY_NOTICES.txt`, el SBOM y el
inventario Cargo después de cualquier cambio a lockfiles, runtimes o contenido
del paquete. El build por sí solo no demuestra el cumplimiento de licencias;
verifica el paquete final y sus fuentes/ofertas junto con cada runtime GPL.

## Flujo de publicación futuro

Solo después de cerrar todos los bloqueos anteriores y obtener autorización
explícita para esa publicación:

1. Alinear la versión convencional de `package.json` con Tauri, Cargo y la
   extensión; `npm run version:check` debe confirmar la consistencia.
2. Revisar el diff, `MANIFEST.sha256`, avisos de terceros, SBOM, fuente
   correspondiente/ofertas GPL, derechos de assets y reporte del bundle.
3. Obtener la aprobación humana final del mantenedor antes de ejecutar el
   mecanismo de release. El workflow de GitHub acepta tags `v*` y despacho
   manual; ambos deben quedar protegidos por las reglas remotas verificadas.
4. Tras una ejecución aprobada, verificar en el repositorio principal la
   Release, instaladores, firma Tauri, `latest.json`, hashes y materiales de
   código fuente/ofertas que apliquen.
5. La compatibilidad antigua puede requerir un release puente en
   `CacaPlay/cacatools-download-manager-releases` con el mismo catálogo
   `latest.json` apuntando al artefacto firmado principal. Es un repositorio
   remoto independiente y requiere su propia aprobación y verificación.

El archivo privado histórico
`CacaPlay/cacatools-download-manager-releases-private-archive` debe permanecer
privado. Esta guía no autoriza cambios de GitHub, tags, publicación ni copia de
artefactos.
