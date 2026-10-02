# Auditoría de assets y marcas

**Base de auditoría:** 2026-09-25; **actualización de medios README:** 2026-10-02
**Alcance inicial:** 238 archivos gráficos. La limpieza del 2026-09-25 retiró
73 en total: los 28 del inventario individual siguiente, 40 marcados después y
cinco logos morados obsoletos (`PNG`, `SVG`, `ICO`,
`ICNS`, `BMP`, `WEBP`, `JPG/JPEG`, `GIF`, `AVIF` y `TIFF`); excluye los
directorios generados `output/`, `dist/`, `dist-store/`, `extension-dist/`,
`target/` y `node_modules/`. Los iconos SVG incluidos como código dentro de
Lucide se registran aparte. El PDF personal en la raíz no es un asset del
producto y no se incluyó ni modificó.

## Inventario por grupo de procedencia

La declaración del 2026-09-25 cubrió 165 imágenes históricas (A+B+C). El titular aprobó
explícitamente la distribución agrupada de los assets el 2026-09-25; la
declaración y su SHA-256 están registrados en rights/owner-asset-rights-attestation.md
y rights/asset-provenance.json. La aprobación no licencia Clear bajo GPL. El
2026-10-02 se autorizaron por separado seis botones diseñados por el titular y
cuatro capturas proporcionadas por él, solo para el README. La categoría E es
un cruce sobre las 165 imágenes históricas y no se suma otra vez.

| Grupo y cantidad | Rutas | Consumidor actual | Origen probable | Evidencia existente | Licencia/acción recomendada |
| --- | --- | --- | --- | --- | --- |
| **A. CLEAR BRAND — 62** | app-ui/assets/brand/ (6); extension/assets/brand/ (6); extension/icons/brand/ (30); src-tauri/icons/brand/ (12); extension/icons/icon16.png, icon32.png, icon48.png, icon128.png (4); src-tauri/windows/artwork/ (2); src-tauri/windows/nsis-header.bmp y nsis-sidebar.bmp (2). | Logo/variantes en app y extensión; identidad empaquetada en la extensión y arte del instalador Windows. | Logo Clear y derivados de color/tamaño del logo. | Rutas, consumidores actuales y scripts de generación local; faltan originales completos y declaración fechada del titular. | Derechos reservados y fuera de GPL. El gate requiere **permiso de distribución** del grupo; no requiere relicenciar el logo bajo GPL. Confirmar por familia o reemplazar si no puede confirmarse. |
| **B. GENERATED / FRAMEWORK — 8** | src-tauri/icons/ excepto src-tauri/icons/brand/: iconos Windows y Store actuales. Se retiraron las cinco variantes cuadradas con el logo morado antiguo, además de las familias Android/iOS y otros iconos heredados. | Tauri Windows usa `32x32.png`, `128x128.png`, `128x128@2x.png` e `icon.ico`; el script MSIX usa `StoreLogo.png`, `Square44x44Logo.png` y `Square150x150Logo.png`. | Variantes derivadas del arte propio según declaración del titular; Tauri/plataforma es el origen probable de algunas salidas. | Configuración Windows/MSIX y declaración del titular; el comando/versión de generación no está registrado. | Distribución separada de GPL. Se conservan los 8 iconos actuales; los cinco logos morados antiguos no tienen consumidor en la configuración actual y fueron retirados. |
| **C. CLEAR PRODUCT ART — 95** | 70 file-type: app-ui/assets/file-types/ y extension/assets/file-types/; 4 news: app-ui/assets/news/; 2 playlist/http: app-ui/assets/playlist-logo.png y http-file-sheet.png; 2 controles: imágenes en app-ui/player/; 17 docs históricos: docs/assets/. Los dos antiguos `favicon.svg` y `media-preview.svg` fueron retirados. | UI/extension usa tipos, novedades y apoyo; el player conserva sus controles y usa el logo Clear existente como fallback; README usa los SVG documentales. | Arte histórico aprobado el 2026-09-25. | rights/asset-provenance.json registra el cruce histórico de 165 imágenes; los diez medios README se registran aparte. | Derecho de distribución separado de GPL. |
| **D. THIRD PARTY KNOWN — 3 archivos de licencia/helper** | app-ui/assets/icons/lucide.js, LICENSE y NOTICE.md; el helper tiene 24 definiciones de glifo. | Ventanas de preparación/subventanas y mapas de iconos de playlist de la interfaz. | El helper está atribuido localmente a Lucide. El snapshot upstream completo no está fijado; list-music sí está cotejado exactamente con el SVG oficial fijado. | Licencia upstream ISC completa, excepción MIT/Feather y commit/SVG oficial en NOTICE. | Mantener avisos ISC y MIT aplicables. No se afirma cotejo individual de los 24 glifos; si alguno no es el upstream atribuido, requiere revisión o sustitución documentada. |
| **E. OWNER ATTESTATION APPROVED — 165, cruce histórico** | Unión histórica de A+B+C del 2026-09-25; no incluye los diez medios README aprobados por separado. | Los mismos consumidores descritos en A, B y C. | El titular confirma autoría/propiedad o los derechos necesarios sobre arte e inputs de ese grupo. | Aprobación explícita del 2026-09-25 en rights/owner-asset-rights-attestation.md; SHA-256 contrastado por el gate. | Permiso de distribución aprobado para el grupo histórico. Clear brand sigue fuera de GPL; PR #5 y el estado global de derechos no cambian por esta aprobación. |
| **F. CUSTOM MODIFIED THIRD PARTY — 1 vector histórico, reemplazado** | El vector previo estaba en app-ui/assets/icons/lucide.js; el mapa duplicado estaba en app-ui/main.js y app-ui/download-manager/view/icons.js. | Icono de playlist/música en los mapas de UI. | Vector musical custom/suministrado sin procedencia demostrable. | Sustituido en los tres mapas por los paths oficiales list-music de Lucide, cotejados con commit 66d8f9fc394b8530377e5f6112f0b8908ba01280. | **REPLACED**. El antiguo vector ya no se conserva; los mapas usan la pieza oficial y sus avisos ISC. |
| **G. README MEDIA — 10, autorización específica** | 6 botones en `docs/assets/download-buttons/` y 4 capturas en `docs/assets/screenshots/`. | Exclusivamente el README; no se copian al producto. | El titular confirmó que diseñó los seis botones y proporcionó las capturas de CDM. | Autorización específica del 2026-10-02, hash-verificada en `rights/asset-provenance.json`. | Uso limitado a los diez archivos listados. No se afirma titularidad ni licencia general de las marcas de terceros mostradas en los botones. |

La limpieza original fue **238 iniciales → 73 retiradas → 165 retenidas**. El
2026-10-02 el titular autorizó volver a distribuir seis botones diseñados por él
en el README, y se añadieron cuatro capturas actuales de CDM: el inventario
histórico queda en **171 retenidas y 67 retiradas**, más cuatro capturas nuevas,
para **175 imágenes actuales**. Se retiraron dos XML auxiliares de Android.
`check:asset-rights` exige que los 22 paths aún marcados `REMOVE` estén ausentes
y que los seis botones tengan disposición `KEEP_WITH_DOCUMENTED_RIGHTS` en el
grupo README exacto. `check:asset-provenance` conserva el cruce histórico de 212
assets y valida las diez imágenes de README por separado. El estado GPL continúa
separado.

La declaración agrupada aprobada y su SHA-256 están registrados en
rights/owner-asset-rights-attestation.md y rights/asset-provenance.json. Los
grupos A, B, C1 y C2 tienen autorización de distribución; el nombre, logo,
marcas y arte de Clear siguen fuera de GPL.
## Registro individual de los 28 assets retirados

La búsqueda por ruta/nombre cubrió código, referencias estáticas, README,
scripts de build y manifiestos del producto, excluyendo este inventario y el
manifiesto de hashes. Los archivos fuente se eliminaron manualmente el
2026-09-24 siguiendo la lista autorizada; su ausencia se volvió a comprobar en
el checkout. El manifiesto fuente se regenera tras esta actualización.
“Origen desconocido” no significa que el archivo sea de autoría de Clear.

| Archivo | Referencia o consumidor comprobado | Build de producto | Uso / estado | Marca, titularidad y procedencia | Acción |
| --- | --- | --- | --- | --- | --- |
| `app-ui/assets/platforms/YouTube_23392.ico` | Sin referencia activa por nombre en código o build. | No: el directorio `platforms/` se excluye del web bundle; tampoco va al ZIP de extensión. | Sin consumidor; el selector de host usa `link` genérico. | Marca externa YouTube/Google; no es arte propio acreditado; fuente del ICO desconocida. | REMOVE |
| `app-ui/assets/platforms/youtube.ico` | Solo comprobación obsoleta en `scripts/build-windows-beta.ps1`; esa exigencia se retiró. | No: exclusión del web bundle; ya no es requisito del wrapper Windows. | Sin consumidor. | Marca externa YouTube/Google; fuente desconocida. | REMOVE |
| `app-ui/assets/platforms/twitter.ico` | Solo comprobación obsoleta en `scripts/build-windows-beta.ps1`; esa exigencia se retiró. | No: exclusión del web bundle; ya no es requisito del wrapper Windows. | Sin consumidor. | Marca externa X/Twitter; fuente desconocida. | REMOVE |
| `app-ui/assets/platforms/tiktok.png` | Sin referencia activa por nombre en código o build. | No: exclusión del web bundle. | Sin consumidor. | Marca externa TikTok; fuente desconocida. | REMOVE |
| `app-ui/assets/platforms/spotify_logo_icon_170709.ico` | Sin referencia activa por nombre en código o build. | No: exclusión del web bundle. | Sin consumidor. | Marca externa Spotify; fuente desconocida. | REMOVE |
| `app-ui/assets/platforms/spotify.ico` | Sin referencia activa por nombre en código o build. | No: exclusión del web bundle. | Sin consumidor. | Marca externa Spotify; fuente desconocida. | REMOVE |
| `app-ui/assets/platforms/pinterest_19134.ico` | Solo comprobación obsoleta en `scripts/build-windows-beta.ps1`; esa exigencia se retiró. | No: exclusión del web bundle; ya no es requisito del wrapper Windows. | Sin consumidor. | Marca externa Pinterest; fuente desconocida. | REMOVE |
| `app-ui/assets/platforms/pinterest.ico` | Sin referencia activa por nombre en código o build. | No: exclusión del web bundle. | Sin consumidor. | Marca externa Pinterest; fuente desconocida. | REMOVE |
| `app-ui/assets/platforms/media_social_tiktok_icon_124256.ico` | Solo comprobación obsoleta en `scripts/build-windows-beta.ps1`; esa exigencia se retiró. | No: exclusión del web bundle; ya no es requisito del wrapper Windows. | Sin consumidor. | Marca externa TikTok; fuente desconocida. | REMOVE |
| `app-ui/assets/platforms/instagram_logo_icon_168715.ico` | Solo comprobación obsoleta en `scripts/build-windows-beta.ps1`; esa exigencia se retiró. | No: exclusión del web bundle; ya no es requisito del wrapper Windows. | Sin consumidor. | Marca externa Instagram/Meta; fuente desconocida. | REMOVE |
| `app-ui/assets/platforms/instagram.ico` | Sin referencia activa por nombre en código o build. | No: exclusión del web bundle. | Sin consumidor. | Marca externa Instagram/Meta; fuente desconocida. | REMOVE |
| `app-ui/assets/platforms/facebook.ico` | Sin referencia activa por nombre en código o build. | No: exclusión del web bundle. | Sin consumidor. | Marca externa Facebook/Meta; fuente desconocida. | REMOVE |
| `app-ui/assets/platforms/4202110facebooklogosocialsocialmedia-115707_115594.ico` | Solo comprobación obsoleta en `scripts/build-windows-beta.ps1`; esa exigencia se retiró. | No: exclusión del web bundle; ya no es requisito del wrapper Windows. | Sin consumidor. | Marca externa Facebook/Meta; fuente desconocida. | REMOVE |
| `app-ui/assets/file-types/docs.png` | No hay uso en la UI. Solo figura en la lista de exclusión del build y su comprobación estática. | No: `scripts/build.mjs` lo excluye del web bundle. | Icono heredado sin consumidor. | Gráfico de documento con apariencia asociada a Google Docs; no se acredita autoría Clear ni origen/licencia. | REMOVE |
| `app-ui/assets/file-types/powerpoint.png` | No hay uso en la UI. Solo figura en la lista de exclusión del build y su comprobación estática. | No: `scripts/build.mjs` lo excluye del web bundle. | Icono heredado sin consumidor. | Composición asociada a Microsoft PowerPoint; no se acredita autoría Clear ni origen/licencia. | REMOVE |
| `app-ui/assets/file-types/pdf.png` | No hay uso en la UI. Solo figura en la lista de exclusión del build y su comprobación estática. | No: `scripts/build.mjs` lo excluye del web bundle. | Rótulo genérico sin consumidor. | No se aprecia marca identificable; autoría y procedencia desconocidas. | REMOVE |
| `docs/assets/chrome-web-store.png` | Sin referencia actual; el README usa enlace de texto. | No: documentación fuera de app, Store y extensión. | Huérfano en documentación. | Marca/insignia Chrome Web Store; originalidad de la composición y fuente no verificadas. | REMOVE |
| `docs/assets/microsoft-store.png` | Sin referencia actual; el README usa enlace de texto. | No: documentación fuera de app, Store y extensión. | Huérfano en documentación. | Marca Microsoft Store; originalidad de la composición y fuente no verificadas. | REMOVE |
| `docs/assets/windows-11-logo.png` | Sin referencia actual. | No: documentación fuera de app, Store y extensión. | Huérfano en documentación. | Marca Windows/Microsoft; fuente desconocida. | REMOVE |
| `docs/assets/download-buttons/chrome-web-store-light.png` | Botón usado por README para enlazar a Chrome Web Store. | No: uso exclusivo en documentación. | Insignia diseñada y suministrada por el titular. | El titular confirmó autoría y autorizó distribuir este archivo en el README el 2026-10-02; no reclama titularidad del logo de Chrome. | KEEP_WITH_DOCUMENTED_RIGHTS |
| `docs/assets/download-buttons/chrome-web-store-dark.png` | Botón usado por README para enlazar a Chrome Web Store. | No: uso exclusivo en documentación. | Insignia diseñada y suministrada por el titular. | El titular confirmó autoría y autorizó distribuir este archivo en el README el 2026-10-02; no reclama titularidad del logo de Chrome. | KEEP_WITH_DOCUMENTED_RIGHTS |
| `docs/assets/download-buttons/microsoft-store-light.png` | Botón usado por README para enlazar a Microsoft Store. | No: uso exclusivo en documentación. | Insignia diseñada y suministrada por el titular. | El titular confirmó autoría y autorizó distribuir este archivo en el README el 2026-10-02; no reclama titularidad del logo de Microsoft. | KEEP_WITH_DOCUMENTED_RIGHTS |
| `docs/assets/download-buttons/microsoft-store-dark.png` | Botón usado por README para enlazar a Microsoft Store. | No: uso exclusivo en documentación. | Insignia diseñada y suministrada por el titular. | El titular confirmó autoría y autorizó distribuir este archivo en el README el 2026-10-02; no reclama titularidad del logo de Microsoft. | KEEP_WITH_DOCUMENTED_RIGHTS |
| `docs/assets/download-buttons/windows-light.png` | Botón usado por README para enlazar al instalador de Windows. | No: uso exclusivo en documentación. | Insignia diseñada y suministrada por el titular. | El titular confirmó autoría y autorizó distribuir este archivo en el README el 2026-10-02; no reclama titularidad de la marca Windows. | KEEP_WITH_DOCUMENTED_RIGHTS |
| `docs/assets/download-buttons/windows-dark.png` | Botón usado por README para enlazar al instalador de Windows. | No: uso exclusivo en documentación. | Insignia diseñada y suministrada por el titular. | El titular confirmó autoría y autorizó distribuir este archivo en el README el 2026-10-02; no reclama titularidad de la marca Windows. | KEEP_WITH_DOCUMENTED_RIGHTS |
| `docs/assets/download-cards/chrome-web-store.svg` | Ningún consumidor README/documentación/build. | No: documentación fuera de los paquetes de producto. | Tarjeta vectorial huérfana. | Diseño local aparente con marca Chrome; autoría y fuente no verificadas. | REMOVE |
| `docs/assets/download-cards/microsoft-store.svg` | Ningún consumidor README/documentación/build. | No: documentación fuera de los paquetes de producto. | Tarjeta vectorial huérfana. | Diseño local aparente con marca Microsoft; autoría y fuente no verificadas. | REMOVE |
| `docs/assets/download-cards/windows.svg` | Ningún consumidor README/documentación/build. | No: documentación fuera de los paquetes de producto. | Tarjeta vectorial huérfana. | Diseño local aparente con marca Windows; autoría y fuente no verificadas. | REMOVE |

Las 28 rutas se marcaron inicialmente `REMOVE`; el titular autorizó su retirada
y confirmó la ejecución manual. El 2026-10-02 autorizó conservar seis botones
que diseñó para el README, registrados como `KEEP_WITH_DOCUMENTED_RIGHTS` y
respaldados por una autorización exacta de distribución. Resultado actual:
**28 iniciales → 6 conservados → 22 ausentes**. Los gráficos de proveedores y
tipos sin consumidor, los tres antiguos logos de Store/Windows y las tres
tarjetas SVG siguen ausentes. Las rutas genéricas que sí tienen consumidores
(35 iconos de tipo en la app y los equivalentes de extensión) permanecen
intactas.

## Retiro de iconos/arte obsoletos marcados con X

La hoja visual marca como descontinuadas cinco imágenes individuales, la
familia Android completa (15 imágenes y dos XML auxiliares), la familia iOS
completa (18 imágenes) y dos ilustraciones antiguas de la app. Los directorios
móviles no están en los targets de bundle Windows configurados. Tauri Windows y
el staging MSIX usan los iconos Clear sin tachar que quedan en el repositorio.
Las ilustraciones activas de preview ahora usan el PNG de marca Clear existente.

| Archivo o familia retirada | Referencia/consumidor comprobado | Acción |
| --- | --- | --- |
| `src-tauri/icons/64x64.png` | No forma parte del array de iconos de `tauri.conf.json`. | REMOVE |
| `src-tauri/icons/icon.icns` | No forma parte de los targets Windows NSIS/MSI configurados. | REMOVE |
| `src-tauri/icons/Square30x30Logo.png` | No se copia al staging MSIX; ese script consume Square44, Square150 y StoreLogo. | REMOVE |
| `src-tauri/icons/Square310x310Logo.png` | No se copia al staging MSIX ni al bundle Windows configurado. | REMOVE |
| `src-tauri/icons/app-icon.svg` | No tiene consumidor de build/UI; el bundle Tauri declara PNG/ICO. | REMOVE |
| `src-tauri/icons/android/` | Outputs viejos completos; la configuración activa de distribución es Windows y no referencia esta carpeta. | REMOVE |
| `src-tauri/icons/ios/` | Outputs viejos completos; no hay target iOS configurado en los bundles actuales. | REMOVE |
| `app-ui/favicon.svg` | No hay uso necesario; index, subventana y player usan el logo Clear de `assets/brand/`. | REMOVE |
| `app-ui/media-preview.svg` | Tenía usos como thumbnail/fallback. Las referencias runtime y fixtures apuntan ahora al PNG Clear existente. | REMOVE |

Resultado de esta tanda: **40 imágenes + 2 XML auxiliares retirados; 0
pendientes**. Los archivos marcados en verde para la documentación de GitHub se
conservaron.

## Retiro de logos morados de versiones antiguas

El titular identificó el logo morado como una identidad de las primeras
versiones del app y confirmó que esas variantes no deben formar parte de la
versión actual. Se verificó que el bundle Tauri no las declara y que el staging
MSIX solo copia `StoreLogo.png`, `Square44x44Logo.png` y
`Square150x150Logo.png`.

| Archivo retirado | Referencia/consumidor comprobado | Acción |
| --- | --- | --- |
| `src-tauri/icons/Square71x71Logo.png` | Sin referencia en configuración Tauri ni en el script de staging MSIX. | REMOVE |
| `src-tauri/icons/Square89x89Logo.png` | Sin referencia en configuración Tauri ni en el script de staging MSIX. | REMOVE |
| `src-tauri/icons/Square107x107Logo.png` | Sin referencia en configuración Tauri ni en el script de staging MSIX. | REMOVE |
| `src-tauri/icons/Square142x142Logo.png` | Sin referencia en configuración Tauri ni en el script de staging MSIX. | REMOVE |
| `src-tauri/icons/Square284x284Logo.png` | Sin referencia en configuración Tauri ni en el script de staging MSIX. | REMOVE |

Resultado: **5 logos morados antiguos retirados; 0 pendientes**. Los 8 iconos
actuales de Tauri/Store siguen inventariados; el logo Clear actual y sus
variantes de marca no fueron modificados.

## Cambios de esta fase

- El selector de host de la ventana genérica ya no clasifica plataformas ni
  carga sus logos: presenta un icono local de enlace y el hostname legible.
- `scripts/build.mjs` deja fuera `app-ui/assets/platforms/` y los tres iconos de
  tipo antiguos sin uso. El wrapper Windows ya no exige esos logos en `dist/`.
  El resto de iconos genéricos locales sigue en el paquete.
- `README.md` conserva los tres destinos de descarga como enlaces textuales y
  elimina los botones gráficos que mezclaban marcas externas.
- Los 28 gráficos listados arriba se eliminaron físicamente tras autorización
  del titular; las rutas históricas permanecen en este inventario como
  evidencia. No se recrearon marcas externas ni se borraron recursos genéricos.
- El logo principal de Clear, los iconos del instalador y la identidad publicada
  de la extensión no se modificaron.
- Se retiraron las familias Android/iOS y los iconos heredados marcados con X;
  no se cambiaron los recursos actuales de Windows/MSIX. Las referencias de
  preview que antes dependían de `media-preview.svg` ahora usan un PNG Clear
  existente.

## Derechos de los gráficos que permanecen

El registro reproducible está en rights/asset-provenance.json. El gate valida
familias, rutas, cantidades, estados de attestación y el alcance de clearance.
Ese alcance es permiso para distribuir: no exige que el nombre, el logo o las
marcas de Clear sean GPL.

| Estado | Grupo y alcance | Pendiente exacto |
| --- | --- | --- |
| CLEAR | Clear brand (62), generado/framework (8), product art histórico (95) y README media (10, separado). | El titular aprobó la distribución agrupada histórica A, B, C1 y C2; diez medios README tienen autorización específica separada. El logo y las marcas siguen fuera de GPL. |
| CLEAR, cruce no aditivo | 165 imágenes del grupo histórico A+B+C; declaración aprobada y SHA-256 verificado. | Diez medios README quedan en grupos separados y no se suman al cruce histórico. |
| THIRD_PARTY_COMPATIBLE | Subconjunto local Lucide con licencia upstream ISC y MIT para los iconos derivados de Feather; licencia y aviso en app-ui/assets/icons/. | Conservar licencia/aviso. El vector musical ambiguo se reemplazó por el icono oficial list-music. |
| REPLACED | 1 vector musical histórico. | Ninguno para el vector antiguo: no permanece en los tres mapas de UI. |
| CLEAR | 67 gráficos ausentes con disposición REMOVE; seis botones tienen retención documentada. | Incluye 22 de los 28 paths individuales, 40 imágenes marcadas con X y cinco logos morados antiguos. Dos XML auxiliares también fueron retirados. |

El borrador de declaración está en rights/owner-asset-rights-attestation.md y
no cambia el estado de ningún grupo. El registro de PR #5 queda
SUFFICIENTLY SUPPORTED / CLOSED FOR FURTHER INVESTIGATION; su acción formal es
un registro separado y no debe mezclarse con permisos de distribución de
marca/arte.
## Fuentes oficiales de condiciones de marca

- Google, [Chrome Web Store branding guidelines](https://developer.chrome.com/docs/webstore/branding): permite usar en un sitio el badge oficial “Available in the Chrome Web Store” bajo sus reglas; no concede por sí sola una licencia para logotipos compuestos o modificados.
- Microsoft, [Trademark and Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks): describe sus activos de marca como propiedad de Microsoft y señala que ciertos usos requieren licencia.
- Microsoft, [Trademark and copyright protection for Windows apps](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/trademark-and-copyright-protection): trata el uso de marcas gráficas de terceros dentro de apps de Windows y recomienda diligencia sobre derechos.

Estas fuentes orientan el inventario y no equivalen a permiso para los archivos
locales específicos ni sustituyen la revisión de titularidad del proyecto.
