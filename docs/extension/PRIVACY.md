# Privacidad de la extensión

Esta descripción se basa en la fuente de la extensión revisada el 2026-09-24.
La extensión no declara el permiso `cookies` y no se encontró lectura de
`document.cookie` ni uso de la API de cookies. Esto no describe la opción
separada de cookies multimedia de Clear Download Manager para yt-dlp.

## Qué lee y cuándo

En YouTube, Pinterest y TikTok, el detector procesa localmente URL, título,
miniatura pública y metadatos visibles para encontrar medios. En otros sitios,
la extensión solo analiza si el usuario abre el panel o solicita la acción. Si
el usuario activa la captura automática, Chrome/Edge puede entregar detalles
de la descarga al detector para transferirla al gestor local.

## Qué guarda en el perfil del navegador

`chrome.storage.local` conserva preferencias de formato/calidad, captura,
ventana y apariencia; enlaces y colecciones manuales; el journal de operaciones
para evitar reenvíos duplicados; y `lastAppState`, copia local de hasta 80
trabajos que puede incluir URL de origen, destino, título, estado y progreso.
El estado también se escribe en un archivo local del puente para que Native
Messaging pueda mantener sincronizado el panel. Estos datos persisten al cerrar
la aplicación y se administran desde el perfil del navegador o desde la app.

## Comunicación y solicitudes externas

Las selecciones confirmadas y las capturas automáticas que el usuario haya
activado se entregan por Chrome Native Messaging a Clear Download Manager en el
mismo equipo. No se encontró un servicio remoto de Clear ni una integración de
analítica en la extensión. Al añadir un enlace de YouTube a una colección, la
extensión puede consultar `youtube.com/oembed` y `i.ytimg.com` para recuperar
título y miniatura; esos servicios reciben la URL/ID pública solicitada. El
navegador sigue haciendo sus solicitudes normales a la página abierta.

La fuente no contiene lectura de contraseñas, encabezados `Authorization` ni
tokens de la página. Esta revisión estática no inspeccionó el almacenamiento
real del navegador ni capturó tráfico.
