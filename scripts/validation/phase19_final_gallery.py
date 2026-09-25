#!/usr/bin/env python3
"""Build the deterministic Phase 19 visual handoff gallery."""
from __future__ import annotations

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[2]
MAIN = ROOT / "docs" / "screenshots" / "phase19"
DIALOGS = ROOT / "docs" / "screenshots" / "phase19-dialogs"
OUTPUT = MAIN / "final-gallery.png"
CASES = (
    (MAIN / "command-center-dark-1180x780.png", "Command Center · oscuro · 1180×780"),
    (MAIN / "zen-sidebar-dark-1180x780.png", "Zen Sidebar · oscuro · 1180×780"),
    (MAIN / "command-center-light-1180x780.png", "Command Center · claro · 1180×780"),
    (MAIN / "zen-sidebar-light-1180x780.png", "Zen Sidebar · claro · 1180×780"),
    (DIALOGS / "command-dark-video-1180x780.png", "Análisis unificado de vídeo"),
    (DIALOGS / "command-dark-playlist-queue-1180x780.png", "Playlist, historial y alternativas"),
)
CANVAS_WIDTH = 1800
MARGIN = 48
GAP = 28
HEADER_HEIGHT = 132
COLUMNS = 2
TILE_WIDTH = (CANVAS_WIDTH - MARGIN * 2 - GAP) // COLUMNS
IMAGE_HEIGHT = 455
CAPTION_HEIGHT = 64
TILE_HEIGHT = IMAGE_HEIGHT + CAPTION_HEIGHT
ROWS = (len(CASES) + COLUMNS - 1) // COLUMNS
CANVAS_HEIGHT = HEADER_HEIGHT + MARGIN + ROWS * TILE_HEIGHT + (ROWS - 1) * GAP + MARGIN


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
        Path("C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


def fit_image(source: Image.Image) -> Image.Image:
    return ImageOps.fit(source.convert("RGB"), (TILE_WIDTH, IMAGE_HEIGHT), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))


def main() -> int:
    missing = [str(path) for path, _ in CASES if not path.is_file()]
    if missing:
        raise SystemExit("Faltan capturas Phase 19:\n" + "\n".join(missing))
    canvas = Image.new("RGB", (CANVAS_WIDTH, CANVAS_HEIGHT), (6, 10, 15))
    draw = ImageDraw.Draw(canvas)
    draw.text((MARGIN, 34), "CacaTools Download Manager · Fase 19", font=font(42, True), fill=(242, 246, 250))
    draw.text((MARGIN, 88), "Zen predeterminado, escala 120 %, espacios integrados y flujos de descarga unificados.", font=font(22), fill=(148, 160, 176))
    for index, (path, caption) in enumerate(CASES):
        row, column = divmod(index, COLUMNS)
        x = MARGIN + column * (TILE_WIDTH + GAP)
        y = HEADER_HEIGHT + MARGIN + row * (TILE_HEIGHT + GAP)
        draw.rounded_rectangle((x, y, x + TILE_WIDTH, y + TILE_HEIGHT), radius=22, fill=(15, 20, 27), outline=(46, 58, 72), width=2)
        with Image.open(path) as source:
            fitted = fit_image(source)
        mask = Image.new("L", fitted.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, TILE_WIDTH, IMAGE_HEIGHT + 18), radius=20, fill=255)
        canvas.paste(fitted, (x, y), mask)
        draw.text((x + 22, y + IMAGE_HEIGHT + 17), caption, font=font(23, True), fill=(231, 236, 242))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUTPUT, format="PNG", optimize=True)
    print(f"OK: galería Phase 19 creada en {OUTPUT.relative_to(ROOT)} ({CANVAS_WIDTH}x{CANVAS_HEIGHT}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
