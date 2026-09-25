# Clear Download Manager — Motion Design Catalog V2

**Estado:** catálogo aprobado; los refinamientos de `FINAL VISUAL POLISH`
quedan registrados aquí junto con su implementación verificable.

Esta revisión responde a la evaluación externa: las propuestas deben sentirse
perceptibles a velocidad normal, pero seguir siendo sobrias, interruptibles y
seguras para el layout. No hay cambios de runtime, dependencias ni build en V2.

## Fuentes concretas y reglas comunes

- [Motion Press example](https://motion.dev/examples/js-press): referencia concreta para el ciclo press/cancel/release y su limpieza de eventos.
- [Motion Gestures example](https://motion.dev/examples/js-gestures): referencia concreta para combinar `hover`, `press` y `animate` sin convertir el gesto en estado funcional.
- [Motion Page Wipe example](https://motion.dev/examples/js-page-wipe): referencia concreta para una transición de superficie/cubierta, adaptada a CDM sin copiar una capa viajera.
- [Motion `animate()`](https://motion.dev/docs/animate): referencia de secuencias, valores explícitos y springs.
- [Motion view animations](https://motion.dev/docs/animate-view): referencia conceptual para transiciones de vista; CDM conserva su autoridad View Transition actual.
- [Animista — Entrances / Fade In](https://animista.net/play/entrances/fade-in): único efecto Animista citado como adaptación concreta para un toast/surface; no se usa como diseño genérico del producto.
- La autoridad de accesibilidad sigue siendo `system`, `on`, `reduced`, `off`; en `system` se respeta `prefers-reduced-motion` sin crear una segunda autoridad.
- La función real ocurre primero. Toda animación puede cancelarse, terminarse o omitirse sin retrasar navegación, selección, descarga, reproducción, focus, Escape o click-outside.

## 1. Main ↔ Settings

**STATUS: APPROVED / PROTECTED**

- **Referencia exacta:** transición humana aprobada en `motion-rescue-clean-baseline` (`73968fd`), implementada por `app-ui/modules/motion/coordinator.js` (`runDocumentTransition`) y usada desde `app-ui/modules/composition/index.js`.
- **Efecto / nombre:** View Transition del documento existente con fallback síncrono; se conserva exactamente, sin rediseño.
- **Descripción visual:** cambio continuo entre Main y Ajustes, sin compactar el Main, sin selección gigante y sin desplazamiento de la estructura.
- **Qué se mueve/cambia:** sólo las superficies/pseudo-elementos que ya pertenecen a la transición de documento; el estado de sección se actualiza inmediatamente.
- **Duración:** conservar la duración aprobada actual; el objetivo de catálogo es aproximadamente 205 ms sólo si coincide con el contrato existente.
- **Easing / spring:** la curva existente de View Transition; no añadir spring.
- **Por qué encaja:** mantiene la transición que el usuario ya aprobó y evita reemplazarla por una versión inferior.
- **Reduced motion:** commit inmediato, preservando estado y foco.
- **Mecanismo:** `existing protected code`; no Motion JS nuevo.
- **Riesgo:** alto si se toca el coordinador; cualquier cambio requiere un defecto reproducible y una nueva revisión humana.

## 2. Navegación interna de Ajustes

**STATUS: PROPOSED / REQUIRES APPROVAL**

- **Referencia exacta:** [Motion `animate()`](https://motion.dev/docs/animate) para una secuencia explícita e interruptible; el patrón de dirección se inspira en la continuidad espacial del [Motion Page Wipe example](https://motion.dev/examples/js-page-wipe), sin wipe global ni blur.
- **Efecto / nombre:** `settings-direction-aware-panel`.
- **Descripción visual:** el panel nuevo entra desde la dirección en la que el usuario recorrió la lista de categorías; se percibe claramente a velocidad normal, sin mover la columna ni el scroll container.
- **Coreografía exacta:** al mover **hacia abajo**, primero el panel viejo mantiene su lugar y baja `opacity: 1 → 0` con `translateY(0 → -10/-12px)`; en la misma transición el panel nuevo parte de `opacity: 0`, `translateY(+14/+16px)` y llega a `opacity: 1`, `translateY(0)`. Al mover **hacia arriba**, se invierten las direcciones espaciales: viejo `translateY(0 → +10/+12px)`, nuevo `translateY(-14/-16px → 0)`. No se usa blur.
- **Qué se mueve/cambia:** únicamente el `motion-inner` del contenido de categoría; la columna, cabecera, scroll position, inputs y focus conservan geometría.
- **Duración:** 280–320 ms.
- **Easing / spring:** entrada/salida con `cubic-bezier(0.22, 0.61, 0.36, 1)`; secuencia cancelable, sin overshoot.
- **Por qué encaja:** hace visible la dirección mental del recorrido sin repetir el cambio de compactación del Main.
- **Reduced motion:** commit inmediato; mantener estado/foco y omitir travel/blur.
- **Mecanismo:** Motion JS `animate()` secuenciado sobre el inner o CSS equivalente con un controlador existente; nunca animar el contenedor de layout.
- **Riesgo:** medio–alto: paneles largos pueden causar scroll jump si se reemplazan antes de capturar/restaurar scroll. Debe probarse con edición, focus y clics rápidos.

## 3. Botón regular

**STATUS: PROPOSED / REQUIRES APPROVAL**

- **Referencia exacta:** [Motion Press example](https://motion.dev/examples/js-press) y [Motion Gestures example](https://motion.dev/examples/js-gestures), reducidos desde sus amplitudes de demostración.
- **Efecto / nombre:** `button-depth-collapse`.
- **Descripción visual:** el hover revela que la superficie tiene profundidad; el press la comprime de forma visible y el release la asienta, sin rebote juguetón.
- **Coreografía exacta:** **hover:** `background-color`, `border-color` y sombra aumentan suavemente. **press:** superficie `translateY(1.5–2px)`, `scale(.975–.985)` según tamaño, sombra/profundidad se colapsa y el borde/acento gana contraste. **release:** vuelve a su estado normal con spring muy amortiguado.
- **Qué se mueve/cambia:** sólo superficie, color, borde, sombra y transform local; no padding, width, height ni el layout padre.
- **Duración:** hover 140–180 ms; press 90–120 ms; settle 180–230 ms.
- **Easing / spring:** propuesta de release `type: "spring", stiffness: 420, damping: 32, mass: 0.72`; el damping alto debe impedir overshoot visible. Si el navegador muestra bounce, sustituir por `cubic-bezier(0.22, 0.61, 0.36, 1)`.
- **Por qué encaja:** el efecto que se siente es profundidad colapsando y asentándose, no un `scale(.985)` genérico.
- **Reduced motion:** conservar color/borde/sombra estáticos; eliminar desplazamiento y scale.
- **Mecanismo:** Motion Press/`animate()` o CSS equivalente sobre la superficie, después de ejecutar el handler funcional.
- **Riesgo:** medio: transformar el wrapper puede producir clipping o texto borroso. El hitbox y el flujo permanecen invariantes.

## 4. Botón de icono

**STATUS: PROPOSED / REQUIRES APPROVAL**

- **Referencia exacta:** [Motion Press example](https://motion.dev/examples/js-press); la diferencia crítica es que CDM anima el glyph interno, no el hitbox.
- **Efecto / nombre:** `icon-glyph-press-settle`.
- **Descripción visual:** el glyph responde localmente, mientras la superficie confirma el estado en paralelo; no aparece una segunda frontera.
- **Coreografía exacta:** **press:** glyph `scale(.90–.94)` y `translateY(1–2px)`; superficie ajusta fondo/borde de forma paralela. **release:** glyph vuelve a `scale(1), translateY(0)` con spring amortiguado.
- **Qué se mueve/cambia:** SVG/glyph interno y superficie local. El hitbox, el contorno externo y el espacio reservado quedan congelados.
- **Duración:** press 90–120 ms; settle 180–220 ms.
- **Easing / spring:** `stiffness: 460, damping: 34, mass: 0.68`; sin overshoot. Fallback a ease-out si el spring no resulta estable en WebView2.
- **Por qué encaja:** da personalidad al clic sin repetir el contorno enorme o las dos capas de selección.
- **Reduced motion:** sólo color/borde de la superficie; glyph estático.
- **Mecanismo:** CSS-first o Motion `animate()` sólo en el inner glyph; nunca en el elemento que define el hitbox.
- **Riesgo:** medio: el SVG debe conservar su caja y `overflow`; focus-visible y accesibilidad no pueden depender de la animación.

## 5. Barra de navegación

**STATUS: PROPOSED / REQUIRES APPROVAL**

- **Referencia exacta:** geometría protegida del navbar y autoridad de color de interfaz; [Motion `animate()`](https://motion.dev/docs/animate) para la activación local. No se usa un shared layout indicator.
- **Efecto / nombre:** `navbar-local-activation`.
- **Descripción visual:** cada botón activa su propia superficie dentro del diseño antiguo; la selección no viaja de un botón a otro.
- **Coreografía exacta:** **nuevo seleccionado:** superficie `opacity: 0 → 1`, `scale(.94/.96) → 1`; icono hace un settle local (`translateY(1–2px)`, `scale(.94) → 1`). **Anterior:** sólo su superficie local baja opacidad; no se desplaza hacia el nuevo botón.
- **Qué se mueve/cambia:** superficie seleccionada e icono de ese botón. Hitbox interactivo permanece 72×72; superficie visible aproximadamente 64×64.
- **Duración:** 200–240 ms.
- **Easing / spring:** `cubic-bezier(0.22, 0.61, 0.36, 1)`; spring no necesario.
- **Por qué encaja:** recupera la estética vieja y vuelve perceptible la selección sin cápsulas que vuelan ni doble contorno.
- **Reduced motion:** estado activo inmediato; no transform del icono.
- **Mecanismo:** CSS local + estado de navegación existente; Motion JS sólo si hace falta cancelar una activación anterior.
- **Riesgo:** alto si se transforma el wrapper/hitbox o si el icono vuelve a tomar el color de iconos en vez del acento de interfaz.

## 6. Segmentado / pestañas

**STATUS: PROPOSED / REQUIRES APPROVAL**

- **Referencia exacta:** [Motion `animate()`](https://motion.dev/docs/animate) para una propiedad visual local; no se usa `layoutId` ni un pill compartido.
- **Efecto / nombre:** `segmented-contained-fill-reveal`.
- **Descripción visual:** cada opción posee su propio fill interno seleccionado; el fill aparece dentro de sus límites, haciendo visible el cambio sin compactar el Main.
- **Coreografía exacta:** **nuevo:** fill interno `opacity: 0 → 1` y `clip-path: inset(0 100% 0 0) → inset(0 0 0 0)`. **Anterior:** invierte localmente el clip y la opacidad. No se anima la pestaña completa.
- **Elección segura:** `clip-path` es preferible a `scaleX` porque conserva la caja del fill y no escala texto, borde ni hitbox; el fallback es sólo opacidad si el WebView no interpola el clip.
- **Qué se mueve/cambia:** fill y color internos de cada opción. Sin cambios de width/height, gap, display, grid ni indicador externo.
- **Duración:** 180–220 ms.
- **Easing / spring:** `cubic-bezier(0.22, 0.61, 0.36, 1)`; sin spring.
- **Por qué encaja:** da una señal clara de Cola/Descargas sin introducir el cambio de densidad que el usuario rechazó.
- **Reduced motion:** fill y texto cambian de forma inmediata.
- **Mecanismo:** CSS `clip-path` local; Motion JS sólo como fallback/cancelación, no como propietario de selección.
- **Riesgo:** medio: `overflow` o stacking mal definidos puede recortar texto. El indicador debe estar contenido en el option y no modificar su rectángulo.

## 7. Menú contextual

**STATUS: PROPOSED / REQUIRES APPROVAL**

- **Referencia exacta:** contrato `floating-position-root > motion-inner` de `docs/CDM-UI-CONTRACT.md`; [Motion `animate()`](https://motion.dev/docs/animate) para la surface; no se animan los hijos.
- **Efecto / nombre:** `context-menu-surface-anchored-entry`.
- **Descripción visual:** la superficie entra con presencia clara pero corta, como un panel que se asienta desde el ancla; iconos, textos, prioridad y límite quedan completamente congelados.
- **Coreografía exacta:** entrada `opacity: 0 → 1`, `translateY(4px) → 0`, `scale(.96/.97) → 1`; `transform-origin` se elige una vez según la dirección de apertura/ancla, sin leer layout durante cada frame. Salida usa la misma superficie con menor recorrido y duración.
- **Qué se mueve/cambia:** sólo `.motion-inner`/superficie visual.
- **Duración:** entrada 140–180 ms; salida 90–120 ms.
- **Easing / spring:** entrada ease-out; salida ease-in; sin spring para no afectar el placement.
- **Por qué encaja:** hace perceptible el menú sin repetir clipping, mala posición o las dos filas del limitador.
- **Reduced motion:** abrir/cerrar instantáneo.
- **Mecanismo:** CSS adaptado o Motion `animate()` en inner, con cleanup al cerrar.
- **Riesgo:** crítico si se transforma el positioning root. Antes/después, los rectángulos de iconos, textos y prioridades deben ser idénticos; jamás tocar `display`, `flex`, `grid`, `gap`, focus, Escape, click-outside, clamp o lifetime.

## 8. Diálogo / toast

**STATUS: PROPOSED / REQUIRES APPROVAL**

- **Referencia exacta:** [Motion `animate()`](https://motion.dev/docs/animate) y [Animista `Fade In`](https://animista.net/play/entrances/fade-in) sólo para calibrar el toast/surface, no para choreografiar sus hijos.
- **Efecto / nombre:** `dialog-damped-surface` y `toast-rise`.
- **Descripción visual:** el diálogo presenta backdrop con opacidad y superficie `scale(.97) → 1` junto con una opacidad corta; el toast entra `translateY(8–10px) → 0` con opacidad.
- **Qué se mueve/cambia:** sólo backdrop opaco y superficie interna; el hitbox, stacking, focus trap y lifetime se aplican inmediatamente. No hay coreografía de texto, inputs ni botones hijos.
- **Duración:** diálogo 200–240 ms; toast 160–200 ms; salida 100–140 ms.
- **Easing / spring:** spring amortiguado `stiffness: 380, damping: 30, mass: 0.75`; si aparece bounce, usar `cubic-bezier(0.22, 0.61, 0.36, 1)`.
- **Por qué encaja:** comunica aparición sin “ventana voladora” y sin bloquear una acción crítica.
- **Reduced motion:** surface/backdrop visibles de inmediato; sólo mantener contraste de estado.
- **Mecanismo:** CSS-first/Motion `animate()` sobre surface; ningún child choreography.
- **Riesgo:** medio–alto si se transforma backdrop/root; click-outside, Escape y focus deben conservar exactamente su autoridad.

## 9. Tema

**STATUS: PROPOSED / REQUIRES APPROVAL; atomic authority protected**

- **Referencia exacta:** `runThemeTransition` existente en `app-ui/modules/motion/coordinator.js`; [Motion Page Wipe example](https://motion.dev/examples/js-page-wipe) y [Motion view animations](https://motion.dev/docs/animate-view) como referencias concretas de cubierta/reveal, no como reemplazo del coordinador.
- **Efecto / nombre:** `theme-circular-collapse`.
- **Descripción visual:** al confirmar el color de interfaz, la apariencia antigua permanece encima y se contrae radialmente desde el centro real del control; el tema nuevo ya está comprometido debajo. No hay anillos compartidos ni elementos que viajen.
- **Coreografía exacta:** capturar una sola vez el centro del control; commit síncrono de variables; la instantánea antigua usa `clip-path: circle(150vmax → 0)` desde ese origen. Main, cards y navbar conservan geometría pixel-identical.
- **Fallback chain:** 1) View Transition soportada y motion permitido: circular reveal de apariencia; 2) WebView sin esa ruta: crossfade limpio del root/overlay actual; 3) excepción/cancelación: commit inmediato sin máscara; 4) reduced motion: commit inmediato.
- **Qué se mueve/cambia:** sólo apariencia del tema y su máscara de transición; nunca layout, estado funcional, iconos internos ni autoridad de color.
- **Duración:** 350 ms; fallback crossfade con la misma duración.
- **Easing / spring:** `cubic-bezier(.4, 0, .2, 1)`; no spring.
- **Por qué encaja:** conserva la autoridad atómica que evita alternancia azul/celeste y hace visible el cambio de tema sin una capa ornamental.
- **Reduced motion:** commit instantáneo.
- **Mecanismo:** `existing protected code` + clip-path/reveal documentado; no una segunda transición global.
- **Riesgo:** alto si se vuelve a actualizar el icono nativo durante el arrastre del selector o si se permite `transition: all`; confirmar el icono sólo al guardar.

## 10. Procesamiento / actividad

**STATUS: PROPOSED / REQUIRES APPROVAL**

- **Referencia exacta:** [Motion `animate()`](https://motion.dev/docs/animate) sólo como comparación de timing; la actividad propuesta es CSS-only. Animista no es necesario aquí porque no se desea un sheen decorativo.
- **Efecto / nombre:** `processing-solid-travelling-segment` (reemplaza/elimina `processing-indeterminate-sheen`).
- **Descripción visual:** sobre el mismo track de progreso aparece un segmento sólido fijo de 28 % del track, que viaja continuamente de izquierda a derecha. No es un brillo, no es una barra circular y no es progreso fingido.
- **Coreografía exacta:** segmento `transform: translateX(-100%) → translateX(357.142857%)`; ancho fijo 28 %; ciclo 900 ms, `linear`, sin pausa entre loops. Se detiene al salir de `processing`.
- **Qué se mueve/cambia:** sólo el elemento hermano indeterminado que representa actividad. El fill determinado conserva su ancho y autoridad.
- **Duración:** 900 ms por ciclo; entrada/salida 100–140 ms si el estado cambia.
- **Easing / spring:** `linear`; sin spring.
- **Por qué encaja:** comunica trabajo activo de forma inequívoca y recuerda al feedback de descarga sin falsear el porcentaje.
- **Reduced motion:** segmento estático o estado textual fijo; cero loop.
- **Mecanismo:** CSS `@keyframes` local preferido; Motion JS no necesario.
- **Riesgo:** medio: un selector que alcance el fill determinado falsearía el progreso. Debe probarse que 1/5/28/48/75/93/100 % siguen midiendo exactamente igual.

## Protección de progreso determinado

Ninguna propuesta puede escribir `width`, `transform: scaleX(...)`, `--progress` ni el
porcentaje de la barra determinada. El segmento sólido es un elemento hermano y una
autoridad distinta. Los valores 1/5/28/48/75/93/100 % continúan bajo el estado real de
descarga y deben coincidir en mediciones asentadas e intermedias.

## Gate de rendimiento y QA para cualquier aprobación posterior

- **Idle:** cero timers/loops nuevos fuera del estado de procesamiento, cero animaciones permanentes y cero actividad CPU/GPU continua añadida.
- **Interacción:** objetivo 60 FPS, ninguna long task nueva atribuible a Motion y sin layout thrashing.
- **Download Manager:** probar 1, 20, 50 y 100+ filas; refresh/progress patch no vuelve a lanzar entry animations ni produce animación masiva.
- **Floating UI:** comparar `getBoundingClientRect`, placement, clamp, focus, Escape y click-outside antes/durante/después; cualquier diferencia no explicada bloquea.
- **Reduced motion:** probar `system`, `on`, `reduced`, `off` y `prefers-reduced-motion` sin segunda autoridad.
- **Visual:** Product Design debe revisar capturas de Main, Ajustes, navbar, tabs, botones, menú, diálogo/toast y procesamiento antes de permitir implementación.

## Estado de aprobación

Esta V2 revisa únicamente `docs/CDM-MOTION-CATALOG.md`. No instala Motion, no añade
dependencias, no modifica runtime UI y no genera build. La implementación queda bloqueada
hasta la aprobación humana final.
