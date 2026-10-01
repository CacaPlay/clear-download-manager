# Seguridad

## Reportar una vulnerabilidad

No publiques credenciales, claves privadas ni detalles explotables en un issue.
Envía el reporte al propietario del repositorio mediante un aviso privado de
GitHub o solicita contacto al propietario `@CacaPlay`.

Incluye la versión afectada, pasos reproducibles, impacto y una propuesta de
mitigación si la tienes. Las descargas y actualizaciones deben conservar la
verificación de firma; nunca se debe desactivar para probar una compilación.

## Reglas del proyecto

- Las claves privadas Tauri permanecen fuera del repositorio y solo se guardan
  en `TAURI_SIGNING_PRIVATE_KEY` de GitHub Actions.
- Los instaladores se publican únicamente como artefactos de GitHub Releases.
- Las modificaciones a `main` deben entrar mediante pull request revisada.
- No se aceptan binarios, carpetas de compilación, logs ni datos personales en
  el código fuente.

## Frontera de red de procesos externos

CDM aplica controles de red dentro de su propio proceso y en sus clientes HTTP
cuando corresponde. Algunos mecanismos delegados pueden resolver nombres DNS y
establecer conexiones fuera del proceso principal, incluidos el proxy o la
configuración de red del sistema, yt-dlp, aria2, los pares torrent y otros
procesos externos gestionados por CDM. Por ello, los controles de resolución y
red internos de CDM no garantizan todas las conexiones efectuadas por esos
procesos ni por la pila o el proxy del sistema. Esta es una frontera residual
conocida; no implica que fallen los controles aplicados dentro de CDM.

Consulta [`docs/GITHUB-RELEASE-SETUP.md`](docs/GITHUB-RELEASE-SETUP.md) para
los controles de repositorio necesarios antes de una publicación. Esta guía no
afirma que se haya realizado una prueba de penetración ni que un release esté
habilitado.
