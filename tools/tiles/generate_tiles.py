"""Draws the hex tile atlases for each biome: assets/tiles/<biome>.png, @2x and @3x.

Run from the repository root: python3 tools/tiles/generate_tiles.py [--preview out.png]

Each atlas has two rows. The top row holds hex tiles, 16 x 18 art pixels, that interlock on a
lattice 16 across and 14 down (odd rows shifted 8 right). The bottom row holds objects drawn over
a hex (trees, rocks, tufts), 20 x 28, standing on the hex centre. Slot order and sizes are mirrored
in src/ui/tileset.ts; change both together. The art is seeded, so reruns give identical files.
"""

import argparse
import math
import os
import random

from PIL import Image

HEX_W, HEX_H = 16, 18
HEX_CENTER = (8, 9)
ROW_STEP = 14
OBJ_W, OBJ_H = 20, 28
# Art pixel where an object's hex centre sits.
OBJ_FOOT = (10, 23)
PAD = 2
# Softens every tile's rim shading; 1 draws a strong board-game grid.
BEVEL = 0.55
HEX_SLOTS = ['ground0', 'ground1', 'ground2', 'patch0', 'patch1', 'shore', 'shallow', 'deep', 'waterDecor', 'hazard']
OBJECT_SLOTS = ['tree', 'rock', 'ruin', 'cover', 'decor0', 'decor1']
ATLAS_W = max(len(HEX_SLOTS) * (HEX_W + PAD), len(OBJECT_SLOTS) * (OBJ_W + PAD))
ATLAS_H = HEX_H + PAD + OBJ_H
# Device pixels per art pixel for @1x, @2x, @3x: an art pixel is 2 points.
SCALES = {'': 2, '@2x': 4, '@3x': 6}


def hex_mask():
    """Pixels nearer this hex's centre than any neighbour's; ties go to the upper, then left, hex."""
    cx, cy = HEX_CENTER
    neighbours = [(16, 0), (-16, 0), (8, ROW_STEP), (-8, ROW_STEP), (8, -ROW_STEP), (-8, -ROW_STEP)]
    mask = set()
    for y in range(HEX_H):
        for x in range(HEX_W):
            px, py = x + 0.5, y + 0.5
            mine = (px - cx) ** 2 + (py - cy) ** 2
            if all(mine < (px - cx - dx) ** 2 + (py - cy - dy) ** 2 or (mine == (px - cx - dx) ** 2 + (py - cy - dy) ** 2 and (dy, dx) > (0, 0)) for dx, dy in neighbours):
                mask.add((x, y))
    return mask


MASK = hex_mask()


def rgb(value):
    value = value.lstrip('#')
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4)) + (255,)


def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3)) + (a[3],)


class Tile:
    """A hex tile being painted; writes outside the hex are dropped."""

    def __init__(self, base, seed):
        self.px = {p: rgb(base) for p in MASK}
        self.rng = random.Random(seed)

    def set(self, x, y, color):
        if (x, y) in self.px:
            self.px[(x, y)] = rgb(color) if isinstance(color, str) else color

    def get(self, x, y):
        return self.px.get((x, y))

    def blobs(self, color, count, rmin=1.0, rmax=2.4, stretch=1.0):
        for _ in range(count):
            cx, cy = self.rng.uniform(-1, HEX_W + 1), self.rng.uniform(0, HEX_H)
            r = self.rng.uniform(rmin, rmax)
            for (x, y) in MASK:
                if ((x + 0.5 - cx) / (r * stretch)) ** 2 + ((y + 0.5 - cy) / r) ** 2 < 1:
                    self.set(x, y, color)

    def speckle(self, color, count, avoid=None):
        cells = sorted(MASK)
        for _ in range(count):
            x, y = self.rng.choice(cells)
            if avoid and self.get(x, y) in [rgb(c) for c in avoid]:
                continue
            self.set(x, y, color)

    def tufts(self, dark, light, count):
        """Little two-blade grass tufts: a dark root with light tips."""
        cells = [p for p in sorted(MASK) if 3 <= p[1] <= 15 and 1 <= p[0] <= 14]
        for _ in range(count):
            x, y = self.rng.choice(cells)
            self.set(x, y, dark)
            self.set(x - 1, y - 1, light)
            self.set(x + 1, y - 1, light)
            self.set(x - 1, y, dark)
            self.set(x + 1, y, dark)

    def ripples(self, light, dark, count, length=(3, 5)):
        cells = [p for p in sorted(MASK) if 2 <= p[1] <= 15]
        for _ in range(count):
            x, y = self.rng.choice(cells)
            n = self.rng.randint(*length)
            for i in range(n):
                lift = 1 if 0 < i < n - 1 else 0
                self.set(x + i, y - lift, light)
                self.set(x + i, y - lift + 1, dark)

    def bevel(self, light=0.12, dark=0.2):
        """Lights the upper-left rim and shades the lower-right, so each hex reads as a tile without a hard grid."""
        light, dark = light * BEVEL, dark * BEVEL
        out = dict(self.px)
        for (x, y), c in self.px.items():
            if (x, y - 1) not in MASK or (x - 1, y) not in MASK:
                out[(x, y)] = mix(c, (255, 255, 240, 255), light)
            elif (x, y + 1) not in MASK or (x + 1, y) not in MASK:
                out[(x, y)] = mix(c, (10, 8, 20, 255), dark)
        self.px = out

    def image(self):
        img = Image.new('RGBA', (HEX_W, HEX_H), (0, 0, 0, 0))
        for p, c in self.px.items():
            img.putpixel(p, c)
        return img


def sprite(rows, palette):
    """Pixel art from strings: '.' is clear, other characters index the palette."""
    width = max(len(r) for r in rows)
    img = Image.new('RGBA', (width, len(rows)), (0, 0, 0, 0))
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch != '.':
                color = palette[ch]
                img.putpixel((x, y), color if isinstance(color, tuple) else rgb(color))
    return img


SHADOW = (12, 10, 18, 80)

# --- Shared object shapes, recoloured per biome. ---

ROCK = [
    '.....OOOOOO.....',
    '...OOHHHHAAOO...',
    '..OHHAAAAAMMAO..',
    '.OHAAAAAAAAMMAO.',
    '.OHAAAAAAAAAAAO.',
    'OHAAAAAAAAAAAADO',
    'OAAAAAAAAAAAADDO',
    'OAAAAMAAAAAAADDO',
    'OAAAAAAAAAAADDDO',
    '.ODAAAAAAAADDDO.',
    '..OODDDDDDDDOO..',
    '.ssOOOOOOOOOOss.',
    '...ssssssssss...',
]

PILLAR = [
    '...OOOOO.....',
    '..OHHAAO.....',
    '..OHAAAOOO...',
    '..OHAAAAADO..',
    '..OHAAAAADO..',
    '..ODDDDDDDO..',
    '..OHAAVAADO..',
    '..OHAVVAADO..',
    '..OHAAVAADO..',
    '..OHAAAVADO..',
    '..OHAAVVADO..',
    '..ODDDDDDDO..',
    '..OHAAAAADO..',
    '..OHAAAVVDO..',
    '.OOHHAAAADOO.',
    '.OHHAAAAAADO.',
    '.ODDDDDDDDDO.',
    '.OOOOOOOOOOO.',
    'sssssssssssss',
]

TUFT = [
    '..O......O....',
    '.OLO....OLO...',
    '.OLO.O..OLO.O.',
    '.OHLOLO.OHLOLO',
    '..OHLLOOHLLOLO',
    '..OLHLLLHLLHO.',
    '.OLLLHLLLLHLO.',
    'OLLDLLLDLLLDLO',
    'ODDDDDDDDDDDDO',
    '.OOOOOOOOOOOO.',
]


def pal(**colors):
    base = {'O': '#1b1714', 's': SHADOW}
    base.update(colors)
    return base


# --- Biomes ---

def meadow():
    G, Gd, Gl, Gh = '#5c9a3e', '#4a8233', '#70b04b', '#8cc85c'
    tiles = {}
    t = Tile(G, 1); t.blobs(Gd, 3, 1.5, 3); t.blobs(Gl, 2, 1, 2); t.tufts(Gd, Gh, 5); t.bevel(); tiles['ground0'] = t
    t = Tile(G, 2); t.blobs(Gl, 3, 1.5, 3); t.tufts(Gd, Gh, 6); t.speckle(Gd, 8); t.bevel(); tiles['ground1'] = t
    t = Tile(G, 3); t.blobs(Gd, 2, 1.5, 2.5); t.tufts(Gd, Gh, 3)
    for x, y, petal in [(4, 6, '#f4f1de'), (10, 9, '#f2d14b'), (6, 12, '#e48ab0'), (11, 4, '#f4f1de')]:
        for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            t.set(x + dx, y + dy, petal)
        t.set(x, y, '#f7c948' if petal != '#f2d14b' else '#c9702e')
    t.bevel(); tiles['ground2'] = t
    t = Tile(Gl, 4); t.blobs(Gh, 3, 1, 2.2); t.speckle('#5aa040', 10)
    for x, y in [(3, 5), (9, 7), (12, 11), (5, 12)]:
        t.set(x, y, '#3f7a30'); t.set(x + 1, y, '#3f7a30'); t.set(x, y + 1, '#3f7a30'); t.set(x + 1, y + 1, '#64a647')
    t.bevel(); tiles['patch0'] = t
    t = Tile('#8a6b43', 5); t.blobs('#9c7c50', 3, 1.2, 2.5); t.speckle('#6e5333', 10); t.speckle('#b39a72', 5)
    for x in range(HEX_W):
        if t.rng.random() < 0.6:
            t.set(x, 3 + (x % 2), G); t.set(x, 14 - (x % 2), G)
    t.bevel(); tiles['patch1'] = t
    t = Tile('#7f8a45', 6); t.blobs('#9a8a55', 3, 1.5, 3); t.speckle('#5f6a35', 10); t.tufts('#3f6b2c', '#86b453', 4); t.bevel(); tiles['shore'] = t
    W, Wd, Wl, Wf = '#3d86bb', '#2f6c9f', '#62a7d4', '#a5daf0'
    t = Tile(W, 7); t.blobs(Wl, 2, 1.5, 3); t.ripples(Wf, W, 3); t.bevel(0.08, 0.12); tiles['shallow'] = t
    t = Tile(Wd, 8); t.blobs('#285e8d', 3, 1.5, 3); t.ripples(Wl, Wd, 2); t.bevel(0.06, 0.12); tiles['deep'] = t
    t = Tile(W, 9); t.blobs(Wl, 1, 1.5, 2.5); t.ripples(Wf, W, 2)
    t.blobs('#4f9a3a', 0)
    for (x, y, r) in [(6, 8, 2.6), (11, 12, 1.8)]:
        for (px, py) in MASK:
            d = math.hypot(px + 0.5 - x, py + 0.5 - y)
            if d < r and not (px + 0.5 > x and abs(py + 0.5 - y) < 0.6):
                t.set(px, py, '#5aa83e' if py + 0.5 < y else '#3f8a2e')
    t.set(5, 7, '#f6c7d8'); t.set(6, 7, '#f6c7d8'); t.set(5, 6, '#f6c7d8'); t.set(6, 6, '#f7c948')
    t.bevel(0.08, 0.12); tiles['waterDecor'] = t
    t = Tile('#3f5f2c', 10); t.blobs('#33492a', 4, 1.2, 2.5)
    for _ in range(14):
        x, y = t.rng.randint(1, 14), t.rng.randint(3, 15)
        t.set(x, y, '#5b3d25'); t.set(x + 1, y + 1, '#5b3d25'); t.set(x + 1, y - 1, '#5b3d25')
    t.speckle('#c8423a', 7); t.speckle('#e9e2c5', 4); t.bevel(); tiles['hazard'] = t

    objects = {
        'tree': sprite([
            '.....OOOOOO.....',
            '...OOLLHHLLOO...',
            '..OLLHHHHLLLLO..',
            '.OLLHHHLLLLLDLO.',
            '.OLHHLLLLLDLLDO.',
            'OLLLLLLDLLLLDDLO',
            'OLHLLLLLLLDLLDDO',
            'OLLLLDLLLLLLDDDO',
            'OLLLLLLLLDLLDDDO',
            '.OLDLLLDLLLDDDO.',
            '.ODLLDDLLDDDDDO.',
            '..ODDDDDDDDDDO..',
            '...OODDDDDDOO...',
            '.....OOTTOO.....',
            '......OTtO......',
            '......OTtO......',
            '.....OTTttO.....',
            '..ssOOTTttOOss..',
            '...ssssssssss...',
        ], pal(L='#4f9a3a', H='#7cc456', D='#3a7430', T='#8a5a34', t='#5e3b22')),
        'rock': sprite(ROCK, pal(H='#c9c6bb', A='#9a978e', D='#6c6a64', M='#5f9a3e')),
        'ruin': sprite(PILLAR, pal(H='#d8d2c0', A='#b3ab96', D='#7f7867', V='#4f9a3a')),
        'cover': sprite(TUFT, pal(L='#6fb44a', H='#9ad468', D='#47853a')),
        'decor0': sprite([
            '.W...Y..',
            'WCW.YCY.',
            '.W.L.Y..',
            '..L.L...',
        ], {'W': '#f4f1de', 'Y': '#f2d14b', 'C': '#e0a030', 'L': '#3a7430'}),
        'decor1': sprite([
            '.OOOO.',
            'ORWRRO',
            'ORRRWO',
            '.OSSO.',
            '..SS..',
            '.ssss.',
        ], {'O': '#1b1714', 'R': '#d2453a', 'W': '#f6efe0', 'S': '#efe2c8', 's': SHADOW}),
    }
    return tiles, objects


def swamp():
    G, Gd, Gl = '#4c5a2e', '#3c4824', '#5f6f38'
    tiles = {}
    t = Tile(G, 11); t.blobs(Gd, 4, 1.5, 3); t.blobs('#55503a', 2, 1, 2); t.tufts('#323d1e', '#6f8040', 3); t.bevel(); tiles['ground0'] = t
    t = Tile(G, 12); t.blobs(Gl, 2, 1.5, 2.5); t.speckle(Gd, 12); t.tufts('#323d1e', '#6f8040', 4); t.bevel(); tiles['ground1'] = t
    t = Tile(G, 13); t.blobs(Gd, 2, 1.5, 2.5)
    t.blobs('#33493f', 1, 2, 2.6, 1.6)
    t.ripples('#5e7d68', '#33493f', 1, (2, 3))
    t.speckle('#7c8a3e', 6); t.bevel(); tiles['ground2'] = t
    t = Tile('#4a3b2a', 14); t.blobs('#56452f', 3, 1.5, 3); t.speckle('#3a2d20', 12)
    for x, y in [(4, 6), (10, 10), (6, 13)]:
        t.set(x, y, '#7e6a50'); t.set(x + 1, y, '#6a5840')
    t.bevel(); tiles['patch0'] = t
    t = Tile('#4f4a2c', 15); t.blobs('#3f3a22', 3, 1.5, 3)
    for _ in range(4):
        x, y = t.rng.randint(1, 10), t.rng.randint(4, 14)
        for i in range(t.rng.randint(3, 5)):
            t.set(x + i, y + (i % 2), '#2e2416')
    t.speckle('#7a7a3a', 8); t.bevel(); tiles['patch1'] = t
    t = Tile('#3b3122', 16); t.blobs('#463a28', 3, 1.5, 3); t.speckle('#2c241a', 10)
    for x in [3, 6, 10, 12]:
        y = t.rng.randint(6, 12)
        for i in range(3):
            t.set(x, y - i, '#5f7a34')
        t.set(x, y - 3, '#8a9a48')
    t.bevel(); tiles['shore'] = t
    W, Wd, Wl = '#3f5d48', '#2f4a3a', '#56755a'
    t = Tile(W, 17); t.blobs(Wl, 2, 1.5, 3); t.speckle('#6f8f4a', 9); t.ripples('#86a08a', W, 2, (2, 4)); t.bevel(0.06, 0.12); tiles['shallow'] = t
    t = Tile(Wd, 18); t.blobs('#26402f', 3, 1.5, 3); t.speckle('#4c6a42', 5); t.ripples('#5f7d68', Wd, 1); t.bevel(0.05, 0.12); tiles['deep'] = t
    t = Tile(W, 19); t.speckle('#6f8f4a', 6)
    for (x, y, r) in [(5, 7, 2.6), (11, 10, 2.2), (6, 13, 1.6)]:
        for (px, py) in MASK:
            d = math.hypot(px + 0.5 - x, py + 0.5 - y)
            if d < r and not (px + 0.5 > x and abs(py + 0.5 - y) < 0.6):
                t.set(px, py, '#7aa53e' if py + 0.5 < y else '#5a8a30')
    t.bevel(0.06, 0.12); tiles['waterDecor'] = t
    t = Tile('#3a2a35', 20); t.blobs('#2a1f28', 3, 1.5, 3); t.blobs('#4c3646', 2, 1, 2)
    for x, y in [(4, 6), (10, 8), (7, 12), (12, 13)]:
        t.set(x, y - 1, '#a7c46a'); t.set(x - 1, y, '#a7c46a'); t.set(x + 1, y, '#7f9a4a'); t.set(x, y + 1, '#7f9a4a'); t.set(x, y, '#2a1f28')
    t.speckle('#c3d88a', 4); t.bevel(); tiles['hazard'] = t

    objects = {
        'tree': sprite([
            '..O.......O.....',
            '.OTO..O..OTO....',
            '..OTOOTO.OTO..O.',
            '...OTTTOOTO..OTO',
            '....OTTTTTOOOTO.',
            '.OOOOOTtTTTTTO..',
            'OTTTTTTtTOOOO...',
            '.OOOOOTtTO......',
            '.M...OTtTO......',
            '.M...OTtTOM.....',
            '.....OTtTOM.....',
            '.....OTtTO......',
            '....OTTtTTO.....',
            '...OTTOtOTTO....',
            '..OTO.OtO.OTO...',
            '.ssOsssOsssOss..',
            '..ssssssssss....',
        ], pal(T='#6a5a44', t='#4a3d2e', M='#7f9a4a')),
        'rock': sprite(ROCK, pal(H='#6f7660', A='#545a48', D='#3c4034', M='#7f9a3e')),
        'ruin': sprite(PILLAR, pal(H='#8a8a74', A='#6c6c5a', D='#4a4a3c', V='#6f8f3a')),
        'cover': sprite([
            '..O.....O.....',
            '.OBO...OBO..O.',
            '.OBO...OBO.OBO',
            '.OBO.O.OBO.OBO',
            '..OLOLO.OLO.OBO',
            '..OLOLO.OLO.OL.',
            '.OLOLO.OLOLOLO.',
            '.OLOL.OLOL.OLO.',
            'OLLDLLLDLLLDLO.',
            'ODDDDDDDDDDDDO.',
            '.OOOOOOOOOOOO..',
        ], pal(B='#6b4528', L='#7f9a48', D='#55703a')),
        'decor0': sprite([
            '.OOO..',
            'OPPPO.',
            'OPWPO.',
            '.OSO.O',
            '.OSOOPO',
            '.sss.Os',
        ], {'O': '#1b1714', 'P': '#8a5aa8', 'W': '#d8c4e8', 'S': '#cfc4a8', 's': SHADOW}),
        'decor1': sprite([
            '.B....',
            'B.B...',
            '.B..B.',
            '...B.B',
            '....B.',
        ], {'B': '#a7c46a'}),
    }
    return tiles, objects


def desert():
    S, Sd, Sl, Sr = '#d9b36a', '#c49a52', '#e8c886', '#b58a46'
    tiles = {}
    t = Tile(S, 21); t.blobs(Sl, 2, 1.5, 3, 1.6); t.ripples(Sl, Sr, 4, (4, 6)); t.bevel(0.1, 0.16); tiles['ground0'] = t
    t = Tile(S, 22); t.blobs(Sd, 2, 1.5, 3, 1.6); t.ripples(Sl, Sr, 3, (3, 5)); t.speckle(Sd, 8); t.bevel(0.1, 0.16); tiles['ground1'] = t
    t = Tile(S, 23); t.ripples(Sl, Sr, 2)
    for x, y in [(4, 7), (11, 5), (9, 12), (5, 13)]:
        t.set(x, y, '#9a8670'); t.set(x + 1, y, '#7c6a58'); t.set(x, y - 1, '#c2b29a')
    t.speckle('#e9d6a8', 6); t.bevel(0.1, 0.16); tiles['ground2'] = t
    t = Tile('#c48a52', 24); t.blobs('#cf9760', 3, 1.5, 3)
    cracks = [(2, 6), (3, 6), (4, 7), (5, 7), (6, 7), (6, 8), (6, 9), (7, 10), (8, 10), (9, 10), (10, 9), (11, 9), (12, 8), (13, 8),
              (6, 6), (6, 5), (7, 4), (9, 11), (9, 12), (9, 13), (10, 14), (3, 11), (4, 11), (5, 12), (6, 12), (7, 12), (8, 12), (12, 9), (12, 10), (13, 11)]
    for x, y in cracks:
        t.set(x, y, '#8a5a33')
        t.set(x, y + 1, '#d9a56e') if (x, y + 1) not in cracks else None
    t.bevel(0.1, 0.16); tiles['patch0'] = t
    t = Tile(Sd, 25)
    for y in range(HEX_H):
        for x in range(HEX_W):
            band = (x * 0.5 + y) % 5
            if band < 1:
                t.set(x, y, Sl)
            elif band < 2:
                t.set(x, y, Sr)
    t.speckle(S, 10); t.bevel(0.1, 0.16); tiles['patch1'] = t
    t = Tile('#b89a5a', 26); t.blobs('#a8894c', 3, 1.5, 3); t.tufts('#4f7a30', '#7fb04a', 4); t.speckle('#cdb47a', 6); t.bevel(0.1, 0.16); tiles['shore'] = t
    W, Wd, Wl, Wf = '#3ea7b6', '#2a8597', '#6cc8cf', '#c6f1ee'
    t = Tile(W, 27); t.blobs(Wl, 2, 1.5, 3); t.ripples(Wf, W, 3); t.bevel(0.08, 0.12); tiles['shallow'] = t
    t = Tile(Wd, 28); t.blobs('#237584', 3, 1.5, 3); t.ripples(Wl, Wd, 2); t.bevel(0.06, 0.12); tiles['deep'] = t
    t = Tile(W, 29); t.blobs(Wl, 1, 1.5, 2.5); t.ripples(Wf, W, 2)
    for x in [4, 6, 11]:
        for i in range(5):
            t.set(x + (1 if i > 3 and x == 6 else 0), 12 - i, '#4f8a34' if i < 3 else '#7fb04a')
        t.set(x, 7, '#8a5a34')
    t.bevel(0.08, 0.12); tiles['waterDecor'] = t
    t = Tile('#c7a062', 30)
    for (px, py) in MASK:
        d = math.hypot(px + 0.5 - 8, (py + 0.5 - 9) * 1.2)
        if d < 7:
            ring = int(d) % 3
            t.set(px, py, ['#a8834c', '#bb9458', '#cfaa6a'][ring])
    t.set(7, 8, '#7d5e34'); t.set(8, 8, '#7d5e34'); t.set(8, 9, '#6a4f2c'); t.set(7, 9, '#8a6a3c')
    t.bevel(0.1, 0.16); tiles['hazard'] = t

    objects = {
        'tree': sprite([
            '......OOO.......',
            '.....OHGGO......',
            '.....OHGDO......',
            '.....OHGDO..OOO.',
            '.OOO.OHGDO.OHGO.',
            'OHGO.OHGDO.OHDO.',
            'OHDO.OHGDO.OHDO.',
            'OHDOOOHGDOOOHDO.',
            'OHGGGGHGDGGGGDO.',
            '.OODDDHGDDDDOO..',
            '...OOOHGDOOO....',
            '.....OHGDO......',
            '.....OHGDO......',
            '.....OHGDO......',
            '....OHHGDDO.....',
            '..ssOOOOOOOss...',
            '...sssssssss....',
        ], pal(H='#8cc06a', G='#5f9a48', D='#3f7034')),
        'rock': sprite([
            '....OOOOOOOO....',
            '..OOHHHHAAAAOO..',
            '.OHHAAAAAAAAADO.',
            '.ODDDDDDDDDDDDO.',
            'OHHAAAAAAAAAADDO',
            'OHAAAAAAAAAAADDO',
            'OBBBBBBBBBBBBBBO',
            'OHAAAAAAAAAAADDO',
            'OHAAAAAAAAAAADDO',
            'ODDDDDDDDDDDDDDO',
            '.OOOOOOOOOOOOOO.',
            'ssssssssssssssss',
        ], pal(H='#f0c88a', A='#d4975c', D='#a8693c', B='#b97a48')),
        'ruin': sprite(PILLAR, pal(H='#f2deb0', A='#d6b47a', D='#a8844e', V='#c49a52')),
        'cover': sprite([
            '...O.O..O.O...',
            '..OBOBOOBOBO..',
            '.OBOBBOBBOBBO.',
            'OBBOBBBBOBBBO.',
            'OBOBBOBBBOBOBO',
            '.OBBOBBOBBOBO.',
            '..OBBBOBBBBO..',
            '...OOOOOOOO...',
            '..ssssssssss..',
        ], pal(B='#a8844e')),
        'decor0': sprite([
            '.OOOOO.',
            'OWWWWWO',
            'OWKWKWO',
            'OWWWWWO',
            '.OWOWO.',
            '.sssss.',
        ], {'O': '#5a4a3a', 'W': '#eee6d0', 'K': '#3a2e25', 's': SHADOW}),
        'decor1': sprite([
            '..OO....',
            '.OAAO.OO',
            '.OADO.OAO',
            '..OO..OO.',
            '.ssss.ss.',
        ], {'O': '#5a4a3a', 'A': '#b8a890', 'D': '#8a7a66', 's': SHADOW}),
    }
    return tiles, objects


def tidepool():
    S, Sd, Sl = '#bfae86', '#a8966e', '#d4c49e'
    R, Rd, Rl = '#5e6b73', '#48545c', '#7a868c'
    tiles = {}
    t = Tile(S, 31); t.blobs(Sd, 3, 1.5, 3); t.speckle(Sl, 10); t.speckle('#8f7f5c', 6); t.bevel(0.1, 0.16); tiles['ground0'] = t
    t = Tile(S, 32); t.blobs(Sl, 2, 1.5, 3); t.ripples(Sl, Sd, 2); t.speckle('#8f7f5c', 5); t.bevel(0.1, 0.16); tiles['ground1'] = t
    t = Tile(S, 33); t.blobs(Sd, 2, 1.5, 2.5)
    for x, y, c in [(4, 6, '#f2e6dc'), (11, 8, '#e8b0a0'), (7, 12, '#f2e6dc')]:
        t.set(x, y, c); t.set(x + 1, y, c); t.set(x, y + 1, '#c2a890')
    t.speckle(Sl, 6); t.bevel(0.1, 0.16); tiles['ground2'] = t
    t = Tile(R, 34); t.blobs(Rl, 3, 1.5, 3); t.blobs(Rd, 2, 1.2, 2.5)
    for _ in range(9):
        x, y = t.rng.randint(1, 14), t.rng.randint(3, 15)
        t.set(x, y, '#e6e2d6'); t.set(x, y + 1, '#9aa2a4')
    t.bevel(0.1, 0.18); tiles['patch0'] = t
    t = Tile(R, 35); t.blobs(Rd, 2, 1.5, 3); t.blobs('#4f7a4a', 3, 1.2, 2.5); t.speckle('#6f9a5a', 8); t.speckle(Rl, 6); t.bevel(0.1, 0.18); tiles['patch1'] = t
    t = Tile('#9a8a68', 36); t.blobs('#a8996f', 2, 1.5, 3)
    for _ in range(5):
        t.ripples('#eef6f2', '#9a8a68', 1, (3, 5))
    t.speckle('#dfeeea', 6); t.bevel(0.1, 0.16); tiles['shore'] = t
    W, Wd, Wl, Wf = '#2f8fa6', '#1f6f8a', '#5ab4c4', '#bfeef0'
    t = Tile(W, 37); t.blobs(Wl, 2, 1.5, 3); t.ripples(Wf, W, 3); t.speckle('#8a8a6a', 4); t.bevel(0.08, 0.12); tiles['shallow'] = t
    t = Tile(Wd, 38); t.blobs('#195e78', 3, 1.5, 3); t.ripples(Wl, Wd, 2); t.bevel(0.06, 0.12); tiles['deep'] = t
    t = Tile(W, 39); t.blobs(Wl, 1, 1.5, 2.5); t.ripples(Wf, W, 1)
    for (x, y) in [(5, 8), (11, 11)]:
        for dx, dy in [(-1, -1), (1, -1), (-2, 0), (2, 0), (-1, 1), (1, 1), (0, -2)]:
            t.set(x + dx, y + dy, '#e86a8a')
        t.set(x, y, '#f4b0c0')
    for dx, dy in [(0, 0), (-1, 0), (1, 0), (0, -1), (-1, 1), (1, 1)]:
        t.set(9 + dx, 5 + dy, '#f08a3a')
    t.bevel(0.08, 0.12); tiles['waterDecor'] = t
    t = Tile(Rd, 40); t.blobs(R, 2, 1.5, 3)
    for (x, y) in [(4, 6), (10, 7), (7, 12), (12, 13)]:
        for dx, dy in [(-1, -1), (1, -1), (-1, 1), (1, 1), (0, -2), (0, 2), (-2, 0), (2, 0)]:
            t.set(x + dx, y + dy, '#2a1838')
        t.set(x, y, '#5a2e6a'); t.set(x - 1, y, '#3c2048'); t.set(x + 1, y, '#3c2048'); t.set(x, y - 1, '#3c2048'); t.set(x, y + 1, '#3c2048')
    t.bevel(0.1, 0.18); tiles['hazard'] = t

    objects = {
        'tree': sprite([
            '..O.....O.......',
            '.OCO...OCO..O...',
            '.OCO.O.OCO.OCO..',
            '..OCOCO.OCOOCO..',
            '..OCOCO.OCOCO...',
            '...OCCOOCCCO.O..',
            '....OCCCCCO.OCO.',
            '.O...OCCCCOOCCO.',
            'OCO..OCCCCCCCO..',
            '.OCOOCCCCCOOO...',
            '..OCCCCCCO......',
            '...OOCCCO.......',
            '....OCCCO.......',
            '...OCCDCCO......',
            '..ssOOOOOss.....',
            '...sssssss......',
        ], pal(C='#e8708a', D='#b84a6a')),
        'rock': sprite(ROCK, pal(H='#8a959b', A='#68747a', D='#4a555c', M='#eee8da')),
        'ruin': sprite([
            '....OOOO....',
            '...OHWWDO...',
            '...OHWWDO...',
            '...OHWWDO...',
            '.OOORRRROOO.',
            '.ORRRHWDRRO.',
            '.OOOHWWDOOO.',
            '...OHWWDO...',
            '...OHWWDO...',
            '...OHWWDO...',
            '..OOHMWDOO..',
            '..OMMMMMMO..',
            '..OMMMMMMO..',
            '..OOOOOOOO..',
            '.ssssssssss.',
        ], pal(H='#a88a64', W='#8a6c4a', D='#5e4a32', R='#d8c8a0', M='#4f7a4a')),
        'cover': sprite([
            '...O....O...O.',
            '..OKO..OKO.OKO',
            '..OKO..OKO.OK.',
            '.OKO..OKO.OKO.',
            '.OKO..OKO.OKO.',
            '..OKO.OKO..OKO',
            '..OKOOKO..OKO.',
            '.OKKOKKO.OKO..',
            'OKKDKKDKKKDKO.',
            'ODDDDDDDDDDDO.',
            '.OOOOOOOOOOO..',
        ], pal(K='#4f8a4a', D='#356a3a')),
        'decor0': sprite([
            '..O..',
            '.OSO.',
            'OSSSO',
            'OSDSO',
            '.OOO.',
            '.sss.',
        ], {'O': '#6a5040', 'S': '#f2dccc', 'D': '#d8a890', 's': SHADOW}),
        'decor1': sprite([
            '..O..',
            '.OSO.',
            'OSSSO',
            '.OSO.',
            'O.O.O',
        ], {'O': '#a8402a', 'S': '#f08a3a'}),
    }
    return tiles, objects


BIOMES = {'meadow': meadow, 'swamp': swamp, 'desert': desert, 'tidepool': tidepool}


def atlas(tiles, objects):
    img = Image.new('RGBA', (ATLAS_W, ATLAS_H), (0, 0, 0, 0))
    for i, name in enumerate(HEX_SLOTS):
        img.paste(tiles[name].image(), (i * (HEX_W + PAD), 0))
    for i, name in enumerate(OBJECT_SLOTS):
        art = objects[name]
        assert art.width <= OBJ_W and art.height <= OBJ_H, name
        # Objects stand on the slot's foot point: centred, base just below the hex centre.
        x = i * (OBJ_W + PAD) + OBJ_FOOT[0] - art.width // 2
        y = HEX_H + PAD + min(OBJ_H - art.height, OBJ_FOOT[1] + 3 - art.height)
        img.alpha_composite(art, (x, y))
    return img


def preview(atlases, path):
    """A sample map per biome, to eyeball the tiles together."""
    cols, rows, scale = 9, 9, 4
    width = cols * HEX_W + HEX_W // 2
    height = rows * ROW_STEP + 4
    sheet = Image.new('RGBA', (width * len(atlases) + 8 * (len(atlases) - 1), height), (20, 18, 16, 255))
    for b, (name, art) in enumerate(atlases.items()):
        rng = random.Random(b)
        hexes = {}
        water = {(4, 4), (5, 4), (3, 4), (4, 3), (4, 5), (5, 5), (3, 3), (5, 3)}
        for r in range(-1, rows + 1):
            for c in range(-1, cols + 1):
                hexes[(c, r)] = 'water' if (c, r) in water else 'ground'
        layer = Image.new('RGBA', (width, height), (0, 0, 0, 0))
        objects = []
        for r in range(-1, rows + 1):
            for c in range(-1, cols + 1):
                x = c * HEX_W + (r & 1) * 8
                y = r * ROW_STEP - 4
                if hexes[(c, r)] == 'water':
                    slot = 'deep' if (c, r) == (4, 4) else ('waterDecor' if (c, r) == (5, 5) else 'shallow')
                else:
                    near = any(abs(c - wc) <= 1 and abs(r - wr) <= 1 for wc, wr in water)
                    slot = 'shore' if near else rng.choice(['ground0', 'ground0', 'ground1', 'ground1', 'ground2', 'patch0', 'patch1', 'hazard'])
                    if not near and rng.random() < 0.25:
                        objects.append((x, y, rng.choice(OBJECT_SLOTS)))
                i = HEX_SLOTS.index(slot)
                layer.alpha_composite(art.crop((i * (HEX_W + PAD), 0, i * (HEX_W + PAD) + HEX_W, HEX_H)), (x, y)) if x >= 0 and y >= 0 else None
        for x, y, name_ in objects:
            i = OBJECT_SLOTS.index(name_)
            crop = art.crop((i * (OBJ_W + PAD), HEX_H + PAD, i * (OBJ_W + PAD) + OBJ_W, HEX_H + PAD + OBJ_H))
            ox, oy = x + HEX_CENTER[0] - OBJ_FOOT[0], y + HEX_CENTER[1] - OBJ_FOOT[1]
            if ox >= 0 and oy >= 0:
                layer.alpha_composite(crop, (ox, oy))
        sheet.alpha_composite(layer, (b * (width + 8), 0))
    sheet.resize((sheet.width * scale, sheet.height * scale), Image.NEAREST).save(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--preview', help='also write a sample map of every biome here')
    args = parser.parse_args()
    out = os.path.join('assets', 'tiles')
    os.makedirs(out, exist_ok=True)
    atlases = {}
    for name, draw in BIOMES.items():
        tiles, objects = draw()
        art = atlas(tiles, objects)
        atlases[name] = art
        for suffix, scale in SCALES.items():
            art.resize((art.width * scale, art.height * scale), Image.NEAREST).save(os.path.join(out, f'{name}{suffix}.png'), optimize=True)
    if args.preview:
        preview(atlases, args.preview)


if __name__ == '__main__':
    main()
