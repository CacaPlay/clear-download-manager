# Lucide Icons

The local helper was previously labeled as a Lucide 1.34.0 subset, but the
repository did not pin the complete original upstream snapshot. The replacement
list-music glyph is verified against the official icons/list-music.svg at
upstream commit 66d8f9fc394b8530377e5f6112f0b8908ba01280. Its path data is used
in app-ui/assets/icons/lucide.js, app-ui/main.js, and
app-ui/download-manager/view/icons.js. This exact source check documents the
replacement; it does not claim that every earlier helper path was independently
matched to an upstream file.

The full upstream license text is in LICENSE. Lucide uses ISC terms, with MIT
terms applying to icons derived from Feather as listed there. The list-music
icon is not in the upstream Feather-derived list and is covered by the
upstream ISC terms. The application keeps the paths locally and has no runtime
icon dependency.

Source references:

- [Official Lucide list-music SVG](https://github.com/lucide-icons/lucide/blob/66d8f9fc394b8530377e5f6112f0b8908ba01280/icons/list-music.svg)
- [Official Lucide license](https://github.com/lucide-icons/lucide/blob/66d8f9fc394b8530377e5f6112f0b8908ba01280/LICENSE)
