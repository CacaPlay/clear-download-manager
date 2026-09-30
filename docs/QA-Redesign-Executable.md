# Ejecutable QA del rediseño

La build manual se produce en `artifacts/qa-redesign/Clear Download Manager QA.exe` desde `scripts/build-local-qa-exe.ps1`. No genera instalador.

## Aislamiento

- Identificador: `lat.cacaplay.cacatools.downloadmanager.qa`.
- El identificador crea un directorio de datos de Tauri separado.
- Las descargas nuevas usan la subcarpeta `Downloads` de esos datos QA; se ignoran los overrides de rutas compartidas.
- La integración con extensiones no registra el host nativo de producción. Sus posibles datos auxiliares usan `%LOCALAPPDATA%/CDM-QA/ExtensionBridge`.
- La build no registra inicio automático al arrancar Windows. Si se activa manualmente en Preferencias, usa el valor `Clear Download Manager QA`.
- La feature QA se activa solo en la orden local de build. La combinación con `github-updater` se rechaza; el actualizador de esta build no tiene clave ni endpoint.
- El inicio valida el identificador, el key ID QA, la huella pública y la ausencia de configuración del plugin updater.
- El frontend temporal vive en `artifacts/qa-redesign/dist-optimized`, sin reemplazar `dist`.

## Imágenes de la build QA

- Las variantes de marca, tipos de archivo, playlist, acciones y ajustes usan WebP lossless con tamaños de salida adecuados a su escala visible: marca 256×256, tipos de archivo 128×128 y acciones/ajustes 64×64. En las 62 conversiones, el WebP decodificado coincide píxel por píxel con la versión redimensionada de alta calidad; el conjunto baja 1 233 505 bytes frente a los PNG fuente.
- Los tres iconos nuevos de multimedia eliminan el panel y el borde azul originales, usan un fondo pizarra fijo y solo recolorean el detalle cian. Sus bases y máscaras WebP también se comprobaron con un ciclo de decodificación lossless.
- Los PNG originales están respaldados fuera del árbol de código, en la carpeta local de originales. La compilación omite cada PNG que tiene su WebP correspondiente; mantener los originales en el checkout no aumenta el ejecutable.

## Catálogo y componentes

- Catálogo: `http://127.0.0.1:49301/component-catalog-v1.json`.
- Key ID: `component-catalog-qa-20260927`.
- Huella SHA-256 de la clave pública: `7910b5251d799b5160471f860db7de4bd478dea5280e5ebd7a63a1ec2a655313`.
- Solo admite `127.0.0.1:49301` para el catálogo, los paquetes y las redirecciones; la firma, el tamaño y el SHA-256 siguen activos.
- MediaTools: `media-tools-1.0.0.cdmcomponent`, 88 670 040 bytes, SHA-256 `fd5426cd214d08cac24ed6477120a449a91a869c93ffeeaa068985668218f800`.
- Torrent Engine: `torrent-engine-1.0.0.cdmcomponent`, 2 525 470 bytes, SHA-256 `bc630045938dc1883f15d413258ae3b82fd61ee10b0f5d8646b1f9615130ac98`.
- Los archivos de fuentes correspondientes son material de distribución; no hacen falta para la instalación runtime de estos componentes.

Antes de instalar un componente, deja activo el servidor local que ya escucha en `127.0.0.1:49301`. Esta build no consulta el endpoint de actualizaciones de la aplicación. Los runtimes opcionales se descargan del servidor QA, no están incorporados en el ejecutable.

## Recompilación

Ejecuta `scripts/build-local-qa-exe.ps1` desde Windows. El script valida el identificador, la feature explícita, la configuración vacía del updater y la huella QA; ejecuta pruebas de aislamiento y firma; compila el frontend bajo `artifacts/qa-redesign/dist-optimized` y el ejecutable con el destino de Cargo bajo `artifacts/qa-redesign/cargo-target`.
