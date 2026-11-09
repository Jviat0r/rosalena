"""Render the Rosalena icon (packaging/assets/icon/rosalena-icon.svg) to the PNG sizes the
icon containers need. make-icon.mjs then packs those PNGs into rosalena.ico and
rosalena.icns with no dependencies, so the release build never needs this script.

Run it only after changing the SVG:

    python packaging/tools/render-icon.py

It draws the SVG once at 1024 px with Microsoft Edge (or Chrome) in headless mode, on a
transparent background, then makes every smaller size from that render with Pillow's
Lanczos filter, which keeps small sizes sharp instead of letting the browser hint them.
"""

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
ICON_DIR = ROOT / "packaging" / "assets" / "icon"
SVG = ICON_DIR / "rosalena-icon.svg"
SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
BROWSERS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    shutil.which("google-chrome") or "",
    shutil.which("chromium") or "",
]


def browser():
    for path in BROWSERS:
        if path and os.path.exists(path):
            return path
    sys.exit("render-icon: no Edge or Chrome found to draw the SVG with")


def main():
    if not SVG.exists():
        sys.exit(f"render-icon: {SVG} is missing")
    work = Path(tempfile.mkdtemp(prefix="rosalena-icon-"))
    page = work / "icon.html"
    page.write_text(
        "<!doctype html><html><head><meta charset='utf-8'><style>"
        "html,body{margin:0;background:transparent}img{display:block;width:1024px;height:1024px}"
        f"</style></head><body><img src='{SVG.as_uri()}'></body></html>",
        encoding="utf-8",
    )
    shot = work / "icon-1024.png"
    subprocess.run(
        [
            browser(),
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--default-background-color=00000000",
            f"--user-data-dir={work / 'profile'}",
            "--window-size=1024,1024",
            f"--screenshot={shot}",
            page.as_uri(),
        ],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=120,
    )
    if not shot.exists():
        sys.exit("render-icon: the browser did not write a screenshot")
    big = Image.open(shot).convert("RGBA")
    if big.size != (1024, 1024):
        sys.exit(f"render-icon: the render is {big.size}, expected 1024x1024")
    corner = big.getpixel((0, 0))[3]
    middle = big.getpixel((512, 512))[3]
    if corner > 16 or middle < 250:
        sys.exit(f"render-icon: the render is not a cut-out tile (corner alpha {corner}, middle alpha {middle})")
    for size in SIZES:
        out = ICON_DIR / f"rosalena-{size}.png"
        image = big if size == 1024 else big.resize((size, size), Image.LANCZOS)
        image.save(out, optimize=True)
        print(f"wrote {out.relative_to(ROOT)} ({out.stat().st_size:,} bytes)")
    shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
