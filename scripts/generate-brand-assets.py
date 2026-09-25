from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


COLORS = ("azul", "celeste", "morado", "naranja", "rojo", "verde")
STATIC_COLOR = "celeste"
ICON_SIZE = 512
ICO_SIZES = ((16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256))


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = (
        "C:/Windows/Fonts/seguisb.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arial.ttf",
    )
    for candidate in candidates:
        path = Path(candidate)
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def centered_paste(canvas: Image.Image, image: Image.Image, bounds: tuple[int, int, int, int]) -> None:
    left, top, right, bottom = bounds
    copy = image.copy()
    copy.thumbnail((right - left, bottom - top), Image.Resampling.LANCZOS)
    x = left + ((right - left) - copy.width) // 2
    y = top + ((bottom - top) - copy.height) // 2
    canvas.alpha_composite(copy, (x, y))


def build_nsis_header(icon: Image.Image, path: Path) -> None:
    canvas = Image.new("RGB", (150, 57), "#0a1523")
    logo = icon.copy()
    # alpha_composite needs an RGBA target; keep the final card opaque BMP.
    rgba = canvas.convert("RGBA")
    centered_paste(rgba, logo, (7, 7, 50, 50))
    draw = ImageDraw.Draw(rgba)
    draw.rectangle((0, 55, 150, 56), fill="#24b8e8")
    draw.text((57, 16), "Clear Download", font=font(11, True), fill="#f1f5f9")
    draw.text((57, 31), "Manager", font=font(11, True), fill="#a8b7c9")
    rgba.convert("RGB").save(path, format="BMP")


def build_nsis_sidebar(icon: Image.Image, path: Path) -> None:
    rgba = Image.new("RGBA", (164, 314), "#0a1523")
    draw = ImageDraw.Draw(rgba)
    draw.rectangle((0, 0, 3, 314), fill="#24b8e8")
    centered_paste(rgba, icon, (25, 28, 139, 140))
    draw.text((16, 165), "Clear Download", font=font(16, True), fill="#f1f5f9")
    draw.text((16, 188), "Manager", font=font(16, True), fill="#f1f5f9")
    draw.text((16, 226), "Gestor local de", font=font(9), fill="#a8b7c9")
    draw.text((16, 241), "descargas", font=font(9), fill="#a8b7c9")
    draw.rectangle((16, 274, 148, 275), fill="#22354a")
    draw.text((16, 286), "CacaPlay", font=font(8, True), fill="#7489a2")
    rgba.convert("RGB").save(path, format="BMP")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: generate-brand-assets.py <source-folder>", file=sys.stderr)
        return 2

    source_dir = Path(sys.argv[1]).expanduser().resolve()
    if not source_dir.is_dir():
        print(f"source folder not found: {source_dir}", file=sys.stderr)
        return 2

    repo = Path(__file__).resolve().parents[1]
    frontend_dir = repo / "app-ui" / "assets" / "brand"
    native_dir = repo / "src-tauri" / "icons" / "brand"
    frontend_dir.mkdir(parents=True, exist_ok=True)
    native_dir.mkdir(parents=True, exist_ok=True)

    images: dict[str, Image.Image] = {}
    for color in COLORS:
        source = source_dir / f"{color}.png"
        if not source.is_file():
            print(f"missing source asset: {source}", file=sys.stderr)
            return 2
        image = Image.open(source).convert("RGBA")
        if image.width != image.height:
            print(f"source asset is not square: {source}", file=sys.stderr)
            return 2
        image = image.resize((ICON_SIZE, ICON_SIZE), Image.Resampling.LANCZOS)
        images[color] = image
        image.save(frontend_dir / f"clear-download-manager-{color}.png", format="PNG", optimize=True)
        image.save(native_dir / f"clear-download-manager-{color}.png", format="PNG", optimize=True)
        image.save(native_dir / f"clear-download-manager-{color}.ico", format="ICO", sizes=ICO_SIZES)

    static = images[STATIC_COLOR]
    static.save(repo / "src-tauri" / "icons" / "icon.png", format="PNG", optimize=True)
    static.resize((32, 32), Image.Resampling.LANCZOS).save(repo / "src-tauri" / "icons" / "32x32.png", format="PNG", optimize=True)
    static.resize((128, 128), Image.Resampling.LANCZOS).save(repo / "src-tauri" / "icons" / "128x128.png", format="PNG", optimize=True)
    static.resize((256, 256), Image.Resampling.LANCZOS).save(repo / "src-tauri" / "icons" / "128x128@2x.png", format="PNG", optimize=True)
    static.save(repo / "src-tauri" / "icons" / "icon.ico", format="ICO", sizes=ICO_SIZES)

    windows_dir = repo / "src-tauri" / "windows"
    build_nsis_header(static, windows_dir / "nsis-header.bmp")
    build_nsis_sidebar(static, windows_dir / "nsis-sidebar.bmp")
    print(f"generated {len(images)} brand variants in {frontend_dir} and {native_dir}")
    print(f"static icon: {STATIC_COLOR}; installer cards: {windows_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
