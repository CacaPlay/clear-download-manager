# Retirada de la integración Spotify/spotDL

La aplicación ya no detecta ni inicia sesión en Spotify, no resuelve enlaces de
Spotify mediante spotDL y no ofrece comandos, pantallas ni rutas de extensión
específicas para esa integración. Las URL HTTP(S) ordinarias continúan usando
las rutas genéricas de descarga.

## Historial local

La migración aditiva `playlist_items.spotify_url` permanece en el esquema para
que las bases de datos existentes sigan siendo compatibles. Esta limpieza no
abre, copia, migra ni borra bases de datos de usuario, valores guardados,
credenciales o tokens. Tampoco reescribe los estados históricos al iniciar.

Los trabajos en cola que aún tienen marcadores de la integración retirada se
conservan para consulta histórica, pero las rutas de recuperación y ejecución
los dejan fuera para que el descargador genérico no los reinterprete. Los
nuevos elementos de playlist no escriben metadatos propios de esa integración.

## Verificación automatizada

`scripts/validation/source-boundaries.mjs` comprueba que las superficies activas
de la interfaz y la extensión no vuelvan a exponer la integración, que la
migración histórica siga presente y que no exista una migración destructiva.
La prueba unitaria en Rust crea una base temporal en memoria, conserva un valor
de ejemplo en `spotify_url` y comprueba que la tarea heredada no se reanuda.

La revisión de titularidad y la decisión final sobre la licencia del proyecto
siguen pendientes en `docs/OPEN-SOURCE-RIGHTS-REVIEW.md`; esta retirada técnica
no representa una conclusión legal.

## Referencias conservadas durante la transición

- `src-tauri/src/db/mod.rs`, `src-tauri/src/lib.rs` y la prueba de regresión
  conservan únicamente el nombre de la columna y marcadores históricos para
  compatibilidad y bloqueo seguro de trabajos antiguos.
- `scripts/validation/source-boundaries.mjs` y gates históricos nombran la
  integración para comprobar que sus rutas activas no regresen.
- `scripts/prepare-windows-binaries.ps1` elimina un ejecutable residual con ese
  nombre de una carpeta de binarios reutilizada antes de empaquetar.
- `src-tauri/resources/bin/runtime-manifest.json` es un archivo generado e
  ignorado por Git. Se preservó como salida existente; el generador ya no
  escribe una sección para el runtime retirado y la próxima preparación limpia
  eliminará cualquier binario residual antes de empaquetar.
- `NOTICE.md` y `docs/ASSET-MARKS-AUDIT.md` documentan ahora las imágenes
  externas que quedan como archivos fuente inactivos. Los avisos/licencias de
  terceros se actualizarán después de la auditoría de la Fase 12.
- `MANIFEST.sha256` se regenerará en la Fase 13, después de terminar los cambios
  de código, para no dejar hashes obsoletos.
