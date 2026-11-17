#!/usr/bin/env python3
"""
tools/make_ascii_moai.py  (one-off generator, NOT shipped with the extension)

Builds the static background texture of the settings page: a field of
sparse, faint characters with the moai (the Noto 3D emoji used as the
extension icon) drawn in ASCII on the right. The result is plain text,
written to newextention/options/moai.txt and shown as-is by the page,
frozen: no canvas, no animation.

Usage (from the extentiondf folder):
    python3 tools/make_ascii_moai.py

Needs Pillow. The character cell is JetBrains Mono at 13 px with a 1.32 line
height: 7.8 x 17.16 px, i.e. one character is 2.2 times taller than wide.
"""
import random
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent / "newextention"
SOURCE = ROOT / "icons" / "source" / "emoji_u1f5ff_3d.png"
OUTPUT = ROOT / "options" / "moai.txt"

COLS, ROWS = 220, 40  # wide enough for big screens; the page clips the rest
MOAI_ROWS = 38  # height of the statue, in lines
MOAI_RIGHT_MARGIN = 12  # columns between the statue and the right edge
CELL_RATIO = 2.2  # character height / width
RAMP = " .:-=+*#%@"  # light to dense
FIELD = ".   :    .      ·        "  # sparse background marks (mostly spaces)


def moai_block():
    image = Image.open(SOURCE).convert("RGBA")
    image = image.crop(image.getchannel("A").getbbox())  # just the statue
    width = round(MOAI_ROWS * CELL_RATIO * image.width / image.height)
    small = image.resize((width, MOAI_ROWS), Image.LANCZOS)
    lines = []
    for y in range(MOAI_ROWS):
        line = []
        for x in range(width):
            r, g, b, a = small.getpixel((x, y))
            if a < 60:
                line.append(None)  # transparent: let the field show through
                continue
            # Darker stone = denser character (reads as shading on white).
            luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
            index = 1 + round((1 - luminance) * (len(RAMP) - 2))
            line.append(RAMP[index])
        lines.append(line)
    return lines, width


def main():
    rng = random.Random(1794)  # fixed seed: the texture is always the same
    grid = [[rng.choice(FIELD) for _ in range(COLS)] for _ in range(ROWS)]
    moai, width = moai_block()
    left = COLS - width - MOAI_RIGHT_MARGIN
    top = ROWS - MOAI_ROWS
    for y, line in enumerate(moai):
        for x, char in enumerate(line):
            if char is not None:
                grid[top + y][left + x] = char
    OUTPUT.write_text("\n".join("".join(row).rstrip() for row in grid) + "\n", encoding="utf-8")
    print(f"{OUTPUT} written: {COLS}x{ROWS} characters, statue {width}x{MOAI_ROWS}")


if __name__ == "__main__":
    main()
