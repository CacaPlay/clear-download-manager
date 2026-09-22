from pathlib import Path

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
WINDOWS = ROOT / "src-tauri" / "windows"
ARTWORK = WINDOWS / "artwork"
HEADER_SOURCE = ARTWORK / "installer-header.png"
SIDEBAR_SOURCE = ARTWORK / "installer-sidebar.png"


def build_header():
    size = (150, 57)
    with Image.open(HEADER_SOURCE) as source:
        return ImageOps.fit(source.convert("RGB"), size, method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))


def build_sidebar():
    size = (164, 314)
    with Image.open(SIDEBAR_SOURCE) as source:
        return ImageOps.fit(source.convert("RGB"), size, method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))


def main():
    for source in (HEADER_SOURCE, SIDEBAR_SOURCE):
        if not source.is_file():
            raise FileNotFoundError(f"Missing user-provided installer artwork: {source}")

    WINDOWS.mkdir(parents=True, exist_ok=True)
    build_header().save(WINDOWS / "nsis-header.bmp", format="BMP")
    build_sidebar().save(WINDOWS / "nsis-sidebar.bmp", format="BMP")
    for filename, expected in (("nsis-header.bmp", (150, 57)), ("nsis-sidebar.bmp", (164, 314))):
        with Image.open(WINDOWS / filename) as image:
            if image.size != expected or image.mode != "RGB":
                raise RuntimeError(f"Unexpected NSIS artwork format for {filename}: {image.size} {image.mode}")
    print("NSIS artwork generated from the provided high-resolution images as RGB BMPs in native installer dimensions.")


if __name__ == "__main__":
    main()
