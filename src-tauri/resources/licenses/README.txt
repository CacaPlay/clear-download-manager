Los avisos definitivos de yt-dlp, aria2 y FFmpeg se generan mediante scripts/prepare-windows-binaries.ps1 al preparar una compilación de Windows.
La preparación valida hashes SHA-256 antes de incorporar cualquier ejecutable al instalador.
También incorpora el archivo oficial de licencias de terceros de yt-dlp, la licencia incluida en el archivo verificado de FFmpeg y los textos COPYING y LICENSE.OpenSSL incluidos en el lanzamiento verificado de aria2.
El instalador agrega los avisos y textos completos en THIRD_PARTY_NOTICES.txt; los archivos individuales se conservan junto a este índice para facilitar su consulta.
No se incluyen claves, tokens, cookies ni credenciales.
