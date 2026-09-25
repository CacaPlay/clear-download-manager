# Build QA de cierre — 2026-09-24

Builds y empaquetado ejecutados en el clon temporal:

`%TEMP%\cdm-closeout-qa-36964e1484e24a2ea968e89fe8c21b4e`

Se excluyeron `.git`, caches/builds/outputs previos y todos los PDFs; npm
instaló dependencias en el clon. No se tocó ni reemplazó `dist/`, `dist-store/`,
`extension-dist/`, `output/` ni los targets del checkout principal.

| Artefacto QA | Resultado | SHA-256 / alcance |
| --- | --- | --- |
| Tauri desktop | Compiló en release; runtime manifest, cinco runtimes Windows, notices, inventario Cargo, SBOM npm y host nativo presentes. | El MSI se extrajo como imagen administrativa para inspección; la app no se lanzó contra un perfil real. |
| NSIS | Bundle creado con `--no-sign`; `Get-AuthenticodeSignature` reportó `NotSigned`. | `6224c048b56bda60d0ab0ecfca5854822510d3292e977b5670354237395397ab`. |
| MSI | Bundle creado con `--no-sign`; imagen administrativa extraída sin instalar. Comprobados hashes runtime contra `runtime-manifest.json`, notices, NPM SBOM, inventario Cargo y host nativo. | `d86217da5a582fc1da2884114ac018e33be68943434365a982c4a5e70354813c`. |
| Store/MSIX QA | Variante Tauri `microsoft-store` compilada sin updater. MakeAppx pack/unpack pasó; bridge ID/AUMID y hashes runtime correctos, notices/SBOM/inventario presentes, updater ausente. Manifiesto con identidad QA sintética, no apta para Partner Center. | `ecf3c1cbb267bf94bc6921b4da62382fc146fdf65704046bc63e9e3a15530fbe`; `NotSigned`. |
| Extensión Chrome | ZIP de 93 entradas, versión 0.95.4; `LICENSE.md`, `COPYING`, `NOTICE.md`, manifest y service worker presentes. | `9b9b377b1c7c2f25cd1422d464700511357e115575895d32e43e3409283d6692`. |
| Native host | Compilación release desde `extension/native-host`; protocolo 1 y acciones requeridas pasaron `native-host-handshake.mjs`. | Target nuevo dentro del clon QA. |

Estos artefactos incluyen aria2/FFmpeg GPL solo para QA local; no incluyen
fuentes correspondientes ni oferta escrita y no se publicaron. `check:release`
ejecuta `check:rights` y `check:gpl-source`, que mantienen bloqueada la
publicación. El gate estático `check:store-edition` pasa, pero el MSIX sintético
no valida Partner Center ni la identidad real de publicación.
