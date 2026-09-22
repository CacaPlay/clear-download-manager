# Publicar Clear Download Manager

## Repositorios

- Código fuente y release principal: `CacaPlay/clear-download-manager`.
- Canal puente para clientes antiguos: `CacaPlay/cacatools-download-manager-releases`.
- Archivo privado histórico: `CacaPlay/cacatools-download-manager-releases-private-archive`.

El repositorio principal contiene el código y sus Releases con instaladores,
firmas, `latest.json`, hashes y notas de release. Las claves privadas
permanecen fuera del árbol de trabajo y se guardan solo como secretos de
GitHub Actions.

## Publicar una versión nueva

1. Confirmar una versión coherente en `package.json`, Tauri, Cargo y la
   extensión independiente.
2. Ejecutar en Windows:

   ```powershell
   npm.cmd ci --no-audit --no-fund
   npm.cmd run check:manifest
   npm.cmd run version:check
   npm.cmd run check:release
   ```

3. Crear y enviar un tag de versión, por ejemplo `v0.95.4`, para iniciar el
   workflow de release.
4. El workflow compila en Windows, genera artefactos Tauri firmados,
   `latest.json` y `SHA256SUMS.txt`, y publica todo en una Release del
   repositorio principal.
5. Verificar el endpoint principal, los hashes, la firma y una instalación
   limpia.
6. Para mantener compatibilidad, publicar como release puente en el canal
   legacy una copia del `latest.json` del release principal. Ese catálogo debe
   apuntar al artefacto firmado del repositorio principal. Verificar ambos
   endpoints y la URL del artefacto antes de dar por completada la migración.

Los clientes antiguos pueden tener el endpoint legacy incrustado. Mantén el
repositorio puente público y el archivo privado separado; nunca publiques el
contenido ni cambies la visibilidad del archivo privado.

## No publicar

No publiques desde un checkout con `node_modules`, `target`, `output`, bases de
datos, logs, instaladores sin firma, claves privadas ni perfiles de navegador.
No se considera una release válida un artefacto cuya procedencia o firma no
pueda verificarse.
