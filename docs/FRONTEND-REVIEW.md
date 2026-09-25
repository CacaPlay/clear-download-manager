# Revisión del frontend

**Alcance:** revisión estática de HTML, CSS, JavaScript y extensión, sin rediseño.
**Fecha:** 2026-09-24.

## Mapa revisado

- `index.html` carga `app-ui/main.js` y el agregador `app-ui/styles.css`.
- La aplicación compone módulos en `app-ui/modules/` y el gestor de descargas
  en `app-ui/download-manager/`.
- Reproductor, subventanas Tauri, editor de imágenes y panel de extensión tienen
  ciclos de vida y plantillas separados (`app-ui/player/`, `app-ui/subwindow.*`,
  `app-ui/modules/images/` y `extension/sidepanel.*`).
- El orden de hojas CSS y las plantillas generadas por JavaScript impiden inferir
  que una regla o exportación sea huérfana usando solo búsquedas de texto.

## Cambios acotados

- Se tradujo al inglés una instrucción de ayuda estática del panel de extensión
  que el verificador de interfaz detectó sin localización.
- Se actualizaron validadores estáticos obsoletos para que comprueben los
  contratos presentes: tamaños mínimos reales, tres densidades, hoja CSS
  modular, estado accesible, fallback de apertura de panel, permiso
  `contextMenus` usado y APIs actuales de subventanas. No se cambiaron esos
  comportamientos de producto.
- Se retiró el controlador/estado del carrusel de herramientas y sus reglas CSS
  únicamente después de confirmar que ninguna plantilla ni consumidor actual
  lo crea o llama. La búsqueda final de referencias de runtime no encontró
  controlador, estado, clases ni botones de ese carrusel.
- Se eliminó `scripts/validation/phase15_visual_smoke.py`: era un smoke test
  independiente sin referencia desde `package.json`, `scripts/check.mjs` o CI,
  y sus selectores de carrusel/diálogo no correspondían a la UI actual.

## Decisiones conservadoras

- `npx knip` no se usó como base para borrar módulos: sin configuración de
  entradas, reportó como no usados archivos de entrada y exports alcanzados
  mediante composición dinámica. Ningún borrado se derivó de ese informe.
- No se podaron reglas CSS a partir de un barrido de selectores. La carga
  modular, plantillas dinámicas y cascada heredada requieren evidencia de uso
  más fuerte.
- Se inspeccionó estáticamente el ciclo de vida: listeners ligados a nodos
  reemplazados desaparecen con esos nodos; los listeners globales del gestor
  tienen funciones de liberación; listeners de aplicación, player y subventana
  se registran una vez; el editor revoca URLs de objeto al cerrar. No se abrió
  una sesión WebView ni se midió heap en ejecución.

## Verificación y límites

Pasaron `check:i18n`, `check:0.24.1:responsive`, `check:ui-v5`,
`check:phase13:subwindows`, `check:ui-static`, `check:extension-ui`,
`check:extension-modules` y `check:extension-sync`. `node --check` pasó para
todos los archivos JavaScript de `app-ui/` y `extension/`; `git diff --check`
no encontró errores de whitespace (solo avisos de conversión CRLF/LF).

La fase queda completada en su alcance estático. No se declara validación visual
en navegador, lector de pantalla, teclado manual, contraste de todos los
estados, tamaños reales de viewport ni prueba de memoria en ejecución; esos
límites se incluyen en la verificación final.
