# Inventario de runtimes de terceros

**Revisión:** 2026-09-26. Los hashes de los runtimes preparados se comparan
con `src-tauri/resources/bin/runtime-manifest.json` mediante
`npm run verify:binaries`. Los hashes de archivo son SHA-256.

## Inventario de runtimes fijados

El runtime-manifest identifica versión, URL de origen, hash del archivo
extraído y, cuando se conserva, hash del archivo descargado. Desde Component
Manager V1, los instaladores Windows normal y Store incluyen avisos y licencias, pero excluyen los ejecutables de resources/bin/. Esos runtimes se preparan para pruebas locales y para generar paquetes opcionales versionados. Consulta docs/COMPONENT-MANAGER.md para la arquitectura y el alcance de distribución.

| Componente | Versión exacta | Licencia/aviso del artefacto Windows | Fuente y SHA-256 del ejecutable | Textos/build |
| --- | --- | --- | --- | --- |
| yt-dlp | 2026.08.19 | El proyecto yt-dlp usa Unlicense; el ejecutable PyInstaller combinado está bajo GPL-3.0-or-later e incluye Mutagen GPL-2.0-or-later. | Release oficial; ejecutable 66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a. | Candidato fuente: yt-dlp-2026.08.19-win64-corresponding-source.tar.xz, 89,850,884 bytes, SHA-256 03063667338e2e2f6b0f5c4ddb348f7690699f8f43e1f6017590c915427265bb. Build-input SHA-256 ed9eccf0231bb37367a53913b30a3b0d92b3c687b02fb976ba0cf7955960b6e4. Revisión humana pendiente; no hubo rebuild limpio de Windows. |
| Deno | 2.9.7, `x86_64-pc-windows-msvc` | MIT. | [Asset oficial](https://github.com/denoland/deno/releases/tag/v2.9.7); ejecutable `e020f3e232bd16e33768dee528e5983349c962952051ced0a5d58ad42f5d9b33`; ZIP `a0c3101b4158d1dfb7d6a78a7bf0f3de80c96bb423c152beec8beb22786f2238`. | `DENO-LICENSE.txt`, `DENO-NOTICE.txt`; la herramienta se usa como runtime de challenges EJS de yt-dlp. |
| aria2c | 1.37.0 | GPL-2.0-or-later; la configuración MinGW archivada usa --without-openssl. | Release oficial release-1.37.0; ejecutable be2099c214f63a3cb4954b09a0becd6e2e34660b886d4c898d260febfe9d70c2; ZIP fijado 67d015301eef0b612191212d564c5bb0a14b5b9c4796b76454276a4d28d9b288. | ARIA2-COPYING.txt, aviso OpenSSL conservado del release y ARIA2-NOTICE.txt; candidato de fuente preparado y revisión humana pendiente. |
| FFmpeg/FFprobe | 9.0.2 SAFE LEAN, reconstruido desde el paquete correspondiente aprobado. | GPL-3.0-or-later (`--enable-gpl`, `--enable-version3`). | FFmpeg `e88ac9e6896275df773cde74e48a88312c3c76814956682440a0f8e52c35b74f`; FFprobe `787482513fe1031d2b8ec400aae34204f6f18d1ea9cc27d8b0643e5d3772c6c3`. | Fuente: `ffmpeg-9.0.2-safe-lean-win64-corresponding-source.tar.xz`, SHA-256 `b2891ffafd30bf26e7db0a6d68c1f98844fa02977919a895da561d297208cf58`. Build inputs y revisión humana fijados en `corresponding-source.json`. La entrega del asset correspondiente y la inspección del paquete siguen siendo requisitos antes de un release binario. |

Estos registros describen los runtimes opcionales aunque no estén dentro del
instalador Core. La preparación local aún puede colocar los ejecutables en
`resources/bin/` para construir los paquetes de prueba; Tauri no los incorpora
al NSIS/MSI/MSIX por defecto.

El README del release exacto de yt-dlp declara que sus ejecutables PyInstaller incluyen código GPLv3+ y que la obra combinada queda bajo GPLv3+. El standalone incluye dependencias marcadas con *, entre ellas Mutagen (GPL-2.0-or-later). Por eso el runtime, no solo el proyecto fuente Unlicense, figura en el gate GPL. El candidato fuente/build está preparado con yt-dlp, PyInstaller, builder, Python, módulos observados y dependencias nativas fijadas. No se hizo reconstrucción Windows limpia: aquí no están instalados Python 3.10/MSVC/CMake y el workflow upstream selecciona un runner Windows móvil. La revisión del distribuidor sigue PENDING. Deno 2.9.7 conserva MIT y no tiene evidencia equivalente de copyleft.

El hash del asset de aria2 no se publica como digest del GitHub API en el
runtime-manifest (`officialAssetSha256: null`); el build fija el SHA-256 del ZIP
y la prueba local verifica el ejecutable extraído contra el manifiesto. No se
presenta como una firma upstream independiente.

## Estado técnico de la fuente correspondiente GPL

`third-party-source/corresponding-source.json` es el inventario de release y
`third-party-source/README.md` describe la entrada de materiales. FFmpeg/FFprobe
SAFE LEAN tiene fuente, build inputs y revisión aprobados. aria2 y yt-dlp ya tienen candidatos técnicos de fuente correspondiente con hashes y build-input records fijados. Ambos requieren revisión humana del distribuidor; por eso el gate global y cualquier distribución binaria siguen PENDING. Los assets exactos de fuente deben adjuntarse al release que anuncie esos componentes.

| Componente | Configuración conocida | Material que falta para cerrar la correspondencia | Método automatizable |
| --- | --- | --- | --- |
| aria2 1.37.0 | Release release-1.37.0 y asset oficial Win64. El candidato incluye source tarball, Dockerfile.mingw, mingw-config, makerelease, mingw-release y fuentes/hash/licencias de seis dependencias estáticas; mingw-config declara --without-openssl. | aria2-1.37.0-win64-corresponding-source.tar.xz, 11,482,952 bytes, SHA-256 ef538f14aa306fd66c7bf8b0d09ae82ba7f881e013d8c0f8eee9eed0ed1e0234. No afirma rebuild bit a bit: Dockerfile/apt son móviles y no hubo rebuild independiente. Revisión humana pendiente. | El gate coteja source commit, runtime hash, archivo, build-input record y nombre/hash del asset de release; la revisión humana sigue obligatoria. |
| FFmpeg/FFprobe 9.0.2 SAFE LEAN | Build estático determinista con `--enable-gpl`, `--enable-version3`; fuente FFmpeg `946fcce07b6dcd0331c8cc609192aeff5e1924f8`, x264, LAME y dav1d fijados en el paquete correspondiente. | No falta material de fuente o revisión local para este runtime. El asset exacto debe estar presente junto al paquete que lo distribuye y pasar inspección de hashes. | El gate coteja los hashes de ambos ejecutables, fuente, build inputs, revisión humana y nombre/hash del asset de release. |

El gate valida inventario, presencia e integridad local y forma parte de check:release, por lo que los flujos GitHub Windows y Store fallan cerrados mientras el estado sea PENDIENTE. El Core installer excluye estos ejecutables; una publicación que incluya paquetes opcionales debe adjuntar assets exactos de fuente con sus hashes. Una URL upstream enlazada aquí no sustituye esa entrega.

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
npm run check:binary-release -- --source-archive <source.tar> --package <Core-installer> --inspection-dir <Core-expandido> --component-packages-dir <component-packages> --release-assets-dir <release-assets>
```

Además del source gate, exige check:gpl-source, catálogo firmado con raíz pública de producción, los dos paquetes opcionales con contenidos y hashes contra runtime-manifest.json, assets correspondientes con nombre y SHA-256 exactos e inspección del instalador Core sin runtimes opcionales. Sin paquete ni árbol de inspección declara
**PENDING**. Este gate no relaja el `check:release` existente, que sigue
exigiendo el gate GPL completo para publicar paquetes Windows.

Estos gates separan la composición de los artefactos; no concluyen por sí solos que una publicación source-only cumpla toda obligación aplicable ni sustituyen una revisión legal del distribuidor. Los candidatos aria2/yt-dlp y la revisión humana siguen pendientes. El gate binario también exige catálogo firmado, confianza de producción, assets correspondientes exactos, inspección del Core installer y los dos paquetes opcionales.
