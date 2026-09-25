# Configuración pendiente de protección de releases

The current release workflow reads these repository secrets in
`CacaPlay/clear-download-manager`:

- `TAURI_SIGNING_PRIVATE_KEY`: the production Tauri updater private key.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: its password, when configured.

**No habilitar un release todavía.** La lectura de GitHub del 2026-09-24 no
mostró environment ni ruleset de tags, y el workflow actual no declara un
environment. El remoto no se modificó. Configuración exacta pendiente:

1. En `Settings → Environments`, crear `release`. Agregar un required reviewer
   (preferiblemente otro maintainer) y activar **Prevent self-review**. En
   Deployment branches and tags seleccionar solo tags de release protegidos
   que coincidan con `v*`; no dejar `All branches and tags`.
2. Mover `TAURI_SIGNING_PRIVATE_KEY` y
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` a los **environment secrets** de
   `release`. Quitar las copias a nivel repositorio una vez verificada la nueva
   ubicación, sin imprimir valores durante la comprobación.
3. En `.github/workflows/release-windows.yml`, asignar `environment: release`
   al job que usa esos secretos. La aprobación debe ocurrir antes de iniciar el
   job. Mantener `contents: read` para jobs que solo compilan y `contents:
   write` únicamente en el job que crea/sube assets; no conceder `id-token`,
   `packages: write` u otros permisos sin necesidad. Mantener el token de
   publicación solo donde se sube el release.
4. En `Settings → Rules → Rulesets`, crear un ruleset activo para **Tags** con
   patrón `v*`. Restringir creación, actualización y eliminación a maintainers
   autorizados; usar bypass solo para el operador de release imprescindible y
   no para workflows generales. No permitir reemplazar tags publicados.
5. Proteger la rama fuente (normalmente `main`): PR requerido, checks actuales
   requeridos, bloquear force-push y borrado, y limitar quién puede modificar
   workflows/scripts de publicación. No crear tags de release desde una rama
   sin protección.
6. Antes de ingresar secretos, comprobar en la UI que el environment tiene
   reviewer y filtro `v*`, que el ruleset aplica a tags y que el workflow
   declara el environment. Hacer una ejecución de ensayo sin secretos de firma
   desde un tag de QA protegido; comprobar que una rama no autorizada no puede
   arrancar el job. Después, cargar los secretos con acceso restringido y
   revisar logs por ausencia de valores.

La configuración de environment y rulesets requiere una persona con permisos
de administración del repositorio. No está resuelta hasta verificar su efecto
remoto; este checkout no puede resolverla ni reemplazar esa comprobación.
Mantener el release bloqueado hasta completar estos pasos y cerrar también el
gate de fuente GPL.

Keep the signing key out of commits, logs, artifacts, and pull requests. The
workflow uses the repository-scoped `GITHUB_TOKEN`, reads the publication target
from `src-tauri/resources/updater/updater-config.json`, publishes `latest.json`,
and verifies the downloaded catalog and Windows asset before finishing.

Older installers still reference the legacy releases endpoint. Keep
`CacaPlay/cacatools-download-manager-releases` public and publish a same-version
bridge release containing the main repository's `latest.json`; verify that it
points to the signed main-repository asset. The private historical archive is
`CacaPlay/cacatools-download-manager-releases-private-archive` and must remain
private.
