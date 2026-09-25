# Publicar novedades en Clear Download Manager

La app ya consulta un único archivo público: `news.json`, en el repositorio
`CacaPlay/clear-download-manager`, archivo `news.json` en la raíz de `main`. No hace falta editar
código ni dar a la aplicación credenciales de GitHub: abre el archivo en GitHub,
pulsa el lápiz **Edit this file**, agrega o actualiza un objeto de `messages` y
confirma el cambio con **Commit changes**. El feed se actualiza al refrescarse la
caché (cada seis horas como máximo) o al iniciar una comprobación manual de
novedades.

Usa [news.template.json](news-feed/news.template.json) como base. Mantén una
lista `messages` con hasta 32 elementos. Cada mensaje debe tener un `id` único,
`title`, `summary` breve (máximo 360 caracteres), fecha ISO 8601, `type` y una
acción `open-url` HTTPS a GitHub. `title` admite hasta 180 caracteres; el cuerpo
de la tarjeta se limita a 360 para que no desborde. Los detalles opcionales
pueden tener hasta 32 líneas de 400 caracteres cada una.

Antes de guardar la plantilla, reemplaza `X.Y.Z`, el ID y
`YYYY-MM-DDTHH:mm:ssZ` por la versión y fecha reales; la fecha debe incluir zona
horaria y no debe dejarse como marcador.

Incluye título, resumen, detalles y etiqueta del botón en `translations.es` y
`translations.en`. La interfaz usa español como respaldo. Usa un identificador y
un título que incluyan la versión semántica, por ejemplo `...-v0-96-0...` y
`Clear Download Manager 0.96.0`. La app protege de borrado la novedad `release`
con la versión más alta del feed; el resto puede quitarse desde la tarjeta. Al
instalar versiones posteriores, la categoría **Historial** conserva el registro
de versiones instaladas y permite ocultar registros anteriores.

Para una novedad nueva, `dismissible` normalmente debe ser `false` en la plantilla
(la protección de la versión mayor también se aplica automáticamente). Cuando se
publique una versión más nueva, las anteriores pueden cambiarse a `true` para
que cada persona decida si las quita. No pongas tokens, datos privados, imágenes
grandes ni enlaces fuera de los hosts permitidos (`github.com` y
`chromewebstore.google.com`). El validador rechaza mensajes inválidos y conserva
la última copia válida en caché.

Esto evita credenciales dentro de la app y mantiene el flujo en un archivo que
puedes editar desde la web de GitHub. La noticia de la versión 0.95.4 se añadió
en `news.json` con versiones en español e inglés y enlace al release principal.
