# Inventario de runtimes de terceros

**Revisión:** 2026-09-26. Los hashes de los runtimes preparados se comparan
con `src-tauri/resources/bin/runtime-manifest.json` mediante
`npm run verify:binaries`. Los hashes de archivo son SHA-256.

## Inventario de runtimes fijados

El runtime-manifest identifica versión, URL de origen, hash del archivo
extraído y, cuando se conserva, hash del archivo descargado. Desde Component
Manager V1, los instaladores Windows normal y Store incluyen los avisos y
licencias, pero excluyen los ejecutables de `resources/bin/`. Las versiones
fijadas sirven también para validar paquetes locales de componentes. Consulta
`docs/COMPONENT-MANAGER.md` para la arquitectura y el alcance de distribución.

| Componente | Versión exacta | Licencia/aviso del artefacto Windows | Fuente y SHA-256 del ejecutable | Textos/build |
| --- | --- | --- | --- | --- |
| yt-dlp | 2026.08.19 | El proyecto yt-dlp usa Unlicense; el ejecutable Windows PyInstaller incorpora componentes GPL-3.0-or-later y publica el inventario de terceros. | [Release oficial](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19); `66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a`. Coincide con el asset y `SHA2-256SUMS` del release. | `YT-DLP-LICENSE.txt`, `YT-DLP-THIRD-PARTY-LICENSES.txt`, `YT-DLP-NOTICE.txt`; la lista de licencias está fijada al commit `3a08beaf031ab68f966401ead017ac81fe8486cf` y su SHA-256 es `472aefe951c7db35e1657c1d13fd337140511ed6f2b329205105ad441c5a02b7`. |
| Deno | 2.9.7, `x86_64-pc-windows-msvc` | MIT. | [Asset oficial](https://github.com/denoland/deno/releases/tag/v2.9.7); ejecutable `e020f3e232bd16e33768dee528e5983349c962952051ced0a5d58ad42f5d9b33`; ZIP `a0c3101b4158d1dfb7d6a78a7bf0f3de80c96bb423c152beec8beb22786f2238`. | `DENO-LICENSE.txt`, `DENO-NOTICE.txt`; la herramienta se usa como runtime de challenges EJS de yt-dlp. |
| aria2c | 1.37.0 | GPL-2.0-or-later con texto de excepción/licencia OpenSSL procedente del archivo distribuido. | [Release oficial](https://github.com/aria2/aria2/releases/tag/release-1.37.0); ejecutable `be2099c214f63a3cb4954b09a0becd6e2e34660b886d4c898d260febfe9d70c2`; ZIP fijado `67d015301eef0b612191212d564c5bb0a14b5b9c4796b76454276a4d28d9b288`. | `ARIA2-COPYING.txt`, `ARIA2-OPENSSL-LICENSE.txt`, `ARIA2-NOTICE.txt`. Falta preparar la fuente correspondiente o una oferta escrita que acompañe una distribución binaria. |
| FFmpeg/FFprobe | 9.0.2 SAFE LEAN, reconstruido desde el paquete correspondiente aprobado. | GPL-3.0-or-later (`--enable-gpl`, `--enable-version3`). | FFmpeg `e88ac9e6896275df773cde74e48a88312c3c76814956682440a0f8e52c35b74f`; FFprobe `787482513fe1031d2b8ec400aae34204f6f18d1ea9cc27d8b0643e5d3772c6c3`. | Fuente: `ffmpeg-9.0.2-safe-lean-win64-corresponding-source.tar.xz`, SHA-256 `b2891ffafd30bf26e7db0a6d68c1f98844fa02977919a895da561d297208cf58`. Build inputs y revisión humana fijados en `corresponding-source.json`. La entrega del asset correspondiente y la inspección del paquete siguen siendo requisitos antes de un release binario. |

Estos registros describen los runtimes opcionales aunque no estén dentro del
instalador Core. La preparación local aún puede colocar los ejecutables en
`resources/bin/` para construir los paquetes de prueba; Tauri no los incorpora
al NSIS/MSI/MSIX por defecto.

El README del release exacto de yt-dlp declara que los ejecutables PyInstaller
incluyen código GPLv3+ y que la obra combinada queda bajo GPLv3+. También indica
que los standalone incluyen las dependencias marcadas con `*`, entre ellas
Mutagen (`GPL-2.0-or-later`). El código fuente/tarball de yt-dlp contiene solo
código Unlicense; el inventario de licencias no es el source de Mutagen. Por eso
`yt-dlp.exe` forma parte de `corresponding-source.json` y permanece PENDING hasta
que el source/build package o una alternativa revisada esté completo. Deno
2.9.7 conserva su licencia MIT y no tiene evidencia equivalente de copyleft.

El hash del asset de aria2 no se publica como digest del GitHub API en el
runtime-manifest (`officialAssetSha256: null`); el build fija el SHA-256 del ZIP
y la prueba local verifica el ejecutable extraído contra el manifiesto. No se
presenta como una firma upstream independiente.

## Estado técnico de la fuente correspondiente GPL

`third-party-source/corresponding-source.json` es el inventario de release y
`third-party-source/README.md` describe la entrada de materiales. FFmpeg/FFprobe
SAFE LEAN tiene fuente, build inputs y revisión aprobados; el contrato confirma
que sus hashes activos corresponden a esos registros. aria2 y yt-dlp siguen
**PENDIENTES**. El gate global y la entrega de assets de release permanecen
bloqueados hasta resolver ambos runtimes y acompañar cada asset con su fuente
correspondiente exacta.

| Componente | Configuración conocida | Material que falta para cerrar la correspondencia | Método automatizable |
| --- | --- | --- | --- |
| aria2 1.37.0 | Release `release-1.37.0`, asset Win64 y hashes indicados arriba; incluye licencia/excepción OpenSSL. La receta exacta del build Windows y sus opciones no están acreditadas. | Archivo de fuentes que corresponda al build distribuido, receta/parches/configuración Windows exactos, fuentes correspondientes de dependencias enlazadas y revisión de integridad. | `check:gpl-source` coteja versión/hash con `runtime-manifest.json`, comprueba archivos y SHA-256 declarados y bloquea si falta registro del distribuidor. |
| FFmpeg/FFprobe 9.0.2 SAFE LEAN | Build estático determinista con `--enable-gpl`, `--enable-version3`; fuente FFmpeg `946fcce07b6dcd0331c8cc609192aeff5e1924f8`, x264, LAME y dav1d fijados en el paquete correspondiente. | No falta material de fuente o revisión local para este runtime. El asset exacto debe estar presente junto al paquete que lo distribuye y pasar inspección de hashes. | El gate coteja los hashes de ambos ejecutables, fuente, build inputs, revisión humana y nombre/hash del asset de release. |

El gate valida inventario, presencia e integridad local y forma parte de
`check:release`, por lo que los flujos GitHub Windows y Store fallan cerrados
mientras el estado sea PENDIENTE. Cuando se complete, las fuentes o la oferta
escrita elegida deben acompañar el canal que distribuye cada binario. Una URL
upstream enlazada en este documento no sustituye esa entrega.

**Requiere decisión del distribuidor:** seleccionar archivo de fuente
correspondiente u oferta escrita, comprobar su suficiencia legal y duración,
confirmar que los destinatarios de cada canal pueden obtenerla y aprobar el
registro. El gate no hace una conclusión jurídica. Si no se consigue la fuente
exacta, no publicar los bundles Windows con estos runtimes GPL.

Para los canales de descarga actuales, el plan operativo preferido es adjuntar
el archivo de fuente correspondiente al release/paquete que ofrece el binario,
con acceso equivalente. Si el archivo se aloja en otra ubicación, el enlace y
las instrucciones deben estar junto al binario, y la fuente debe mantenerse
disponible mientras se distribuyan esos binarios. Un escrito no es una URL
genérica: el distribuidor debe validar su método conforme a la versión exacta de
GPL y al canal; GPLv2 §3(b) exige, para esa opción, una oferta escrita de al
menos tres años. GPLv3 §6 tiene rutas distintas: el método de descarga de fuente
en red y la oferta para productos físicos no son intercambiables sin revisión.
Véanse [GPLv2 §3](https://www.gnu.org/licenses/old-licenses/gpl-2.0.en.html),
[GPLv3 §6](https://www.gnu.org/licenses/gpl-3.0.en.html) y el
[FAQ oficial de FSF](https://www.gnu.org/licenses/gpl-faq.en.html).

## Inventarios de dependencias del código

- `NPM-SBOM.spdx.json`: SPDX-2.3 generado desde el `package-lock.json` actual,
  con 40 paquetes. Incluye dependencias de build/desarrollo del flujo npm; es
  un inventario de entradas del build, no una afirmación de que 45 módulos se
  distribuyan dentro del ejecutable.
- `CARGO-DEPENDENCY-LICENSES.txt`: 359 entradas de paquetes de registro
  resueltos desde los lockfiles de la aplicación y el native host, filtradas a
  Windows x64. Cada fila conserva versión y expresión de licencia declarada
  por su upstream; no sustituye esos textos de licencia. La compilación Tauri
  normal, la variante Store y el native host se construyen desde esos proyectos
  y lockfiles.
- `THIRD_PARTY_NOTICES.txt`: artefacto generado que agrega `LICENSE.md`, el
  texto GPL completo `COPYING`, `NOTICE.md`, licencia Lucide y avisos/textos de
  los cinco runtimes anteriores.
- El ZIP de la extensión incorpora `LICENSE.md`, `COPYING` y `NOTICE.md`; no
  empaqueta estos binarios de Windows.

## Estado de cumplimiento para una publicación

Se aprobaron los materiales correspondientes del runtime SAFE LEAN y la
preparación activa reconstruye sus hashes canónicos desde el paquete
correspondiente. Esto no demuestra por sí solo suficiencia legal para cada
canal ni que un archivo de fuente acompañe ya a un release publicado. aria2 y
yt-dlp siguen pendientes, y no se ha creado ni publicado un paquete de release
con los materiales GPL exactos. El gate binario permanece **PENDING / NO
PUBLICAR** hasta completar esos runtimes y verificar los assets del paquete.

La revisión del titular para PR #5 está registrada por separado en
`rights/release-rights.json`; este inventario de componentes terceros no
reabre ni sustituye esa revisión.

## Fuente de código frente a distribución de binarios GPL

El gate `check:gpl-source` valida materiales que deben acompañar una
distribución de los binarios GPL de aria2, FFmpeg y yt-dlp: revisión del
distribuidor, método elegido, fuente/inputs correspondientes o una oferta
escrita revisada, hashes y nombre del asset que acompaña a los binarios. No es
por sí solo una evaluación legal completa.

| Escenario | Tratamiento de aria2/FFmpeg | Bloqueos relevantes |
| --- | --- | --- |
| **A. Solo fuente**: publicar la baseline de código fuente; no adjuntar instaladores ni redistribuir `aria2c.exe`, `ffmpeg.exe` o `ffprobe.exe`. | El source release gate excluye runtimes e instaladores; mantiene avisos, SBOM, inventarios y registros de derechos. | El gate `check:source-release` valida la preparación source-only. No autoriza una distribución binaria ni reabre por sí solo PR #5. |
| **B. Binarios**: publicar NSIS/MSI/MSIX o cualquier paquete que incluya esos runtimes. | El Core installer omite `resources/bin/*`. Si un release distribuye paquetes opcionales aparte, debe reconstruirse/verificarse SAFE LEAN desde su fuente correspondiente y revisar el paquete exacto. | Se necesita completar aria2 y yt-dlp, adjuntar los assets exactos de fuente correspondiente y verificar hashes/notices antes de publicar. |

### Gates separados implementados

**Source Release Readiness** se ejecuta con:

```powershell
npm run source:archive
npm run check:source-release -- --archive "<ruta al .tar generado>"
```

El generador toma los archivos de `MANIFEST.sha256` y añade el propio
manifiesto, los dos lockfiles Cargo, `package-lock.json` y
`THIRD_PARTY_NOTICES.txt`. Conserva el SBOM, el inventario Cargo, el inventario
textual `resources/bin/runtime-manifest.json`, GPL `LICENSE.md`/`COPYING`,
`NOTICE.md`, los avisos individuales disponibles y los registros de derechos.
No empaqueta ejecutables bajo `src-tauri/resources/bin/`, instaladores,
paquetes de extensión, salidas/caches ni PDFs. El gate inspecciona
el `.tar` exacto, rechaza rutas/links peligrosos, exige el inventario, compara
el manifiesto al extraerlo temporalmente y corre los gates de licencia,
derechos, assets, alcance y escaneo heurístico de secretos. No invoca
`check:gpl-source` ni `verify:binaries`.

`cargo check` funciona con solo ese inventario textual. Tres pruebas de
integración que ejecutan el `yt-dlp.exe` incluido regresan de forma explícita
cuando el binario no está preparado en el source-only tree; ejecutarlas contra
el runtime real requiere el paso separado de preparación de binarios.

El gate es deliberadamente fail-closed para titularidad: devuelve **PENDING**
si `check:rights` o `check:asset-provenance` tienen pendientes reales. Un
archivo saneado puede existir como candidato no publicable aunque ese estado
siga PENDING.

**Binary Release Readiness** se ejecuta con el mismo archivo fuente más el
paquete binario exacto y su árbol expandido de inspección:

```powershell
npm run check:binary-release -- --source-archive "<source.tar>" `
  --package "<paquete exacto>" --inspection-dir "<contenido expandido>"
```

Además del source gate, exige `check:gpl-source`, `verify:binaries`, los hashes
de `aria2c.exe`, `ffmpeg.exe` y `ffprobe.exe` contra `runtime-manifest.json`,
avisos/licencias GPL en el contenido inspeccionado y material de fuente
correspondiente u oferta escrita. Sin paquete ni árbol de inspección declara
**PENDING**. Este gate no relaja el `check:release` existente, que sigue
exigiendo el gate GPL completo para publicar paquetes Windows.

Estos gates separan la composición de los artefactos; no concluyen por sí solos
que una publicación source-only cumpla toda obligación aplicable ni sustituyen
una revisión legal del distribuidor. El estado binario sigue **PENDING** hasta
que los materiales de aria2 y yt-dlp, el asset correspondiente de FFmpeg/FFprobe,
sus avisos y el paquete concreto queden verificados.
