import { BodyShape, EyeStyle, Feature, HornStyle, VisualTraits } from './types';

/**
 * Bugs are drawn from a few hand-made pixel components: a body, then eyes, horns and a feature
 * laid over it. The palette and hue shift recolour the result. Sprites face up (towards -y).
 */
export const SPRITE_WIDTH = 11;
export const SPRITE_HEIGHT = 13;

/** O outline, B body, S shade, L legs, E eye white, P pupil, H horn, A accent, W wing. */
export type Cell = 'O' | 'B' | 'S' | 'L' | 'E' | 'P' | 'H' | 'A' | 'W';
type Placement = [row: number, col: number, cell: Cell];

export type Palette = { name: string; body: string; shade: string; accent: string };

export const PALETTES: readonly Palette[] = [
  { name: 'Ember', body: '#e0533d', shade: '#9c2f22', accent: '#1d1714' },
  { name: 'Moss', body: '#6fbf4a', shade: '#3f7d2a', accent: '#e8e25a' },
  { name: 'Tide', body: '#4aa3df', shade: '#25608f', accent: '#f2f4f5' },
  { name: 'Dusk', body: '#9b6ad8', shade: '#5d3a91', accent: '#f2c14e' },
  { name: 'Sand', body: '#e3b35b', shade: '#a77a2f', accent: '#5a3a1a' },
  { name: 'Bone', body: '#d8d4c8', shade: '#9c978a', accent: '#c0392b' },
];

const FIXED_COLORS = { O: '#16120f', L: '#3a2e25', E: '#f6f3e8', P: '#141210', W: 'rgba(214, 236, 255, 0.6)' };

/** Rows 0–2 hold horns and eye stalks, rows 3–5 the head, rows 6–12 the body. */
const BODIES: Record<BodyShape, string[]> = {
  round: [
    '...........',
    '...........',
    '...........',
    '....OOO....',
    '...OBBBO...',
    '...OBBBO...',
    'L.OOOOOOO.L',
    '.OBBBBBBBO.',
    'LOBBBBBBSOL',
    '.OBBBBBBSO.',
    'LOBBBBBSSOL',
    '.OOBBBSSOO.',
    '...OOOOO...',
  ],
  long: [
    '...........',
    '...........',
    '...........',
    '....OOO....',
    '...OBBBO...',
    '...OBBBO...',
    '..L.OBO.L..',
    '...OBBBO...',
    '..LOBBSOL..',
    '...OBBSO...',
    '..LOBBSOL..',
    '...OBBSO...',
    '....OOO....',
  ],
  beetle: [
    '...........',
    '...........',
    '...........',
    '...OOOOO...',
    '...OBBBO...',
    '..OOBBBOO..',
    'LOBBBOBBBOL',
    '.OBBBOBBSO.',
    'LOBBBOBBSOL',
    '.OBBBOBBSO.',
    'LOBBBOBSSOL',
    '.OOBBOBSOO.',
    '...OOOOO...',
  ],
  spider: [
    '...........',
    '...........',
    '...........',
    '....OOO....',
    'L..OBBBO..L',
    '.L.OBBBO.L.',
    '..LOOOOOL..',
    'LLOBBBBBOLL',
    '..OBBBBSO..',
    'LLOBBBBSOLL',
    '..OBBBSSO..',
    '.L.OOOOO.L.',
    'L.........L',
  ],
};

const EYES: Record<EyeStyle, Placement[]> = {
  dot: [[4, 4, 'P'], [4, 6, 'P']],
  wide: [[4, 4, 'E'], [4, 6, 'E'], [5, 4, 'P'], [5, 6, 'P']],
  stalk: [[3, 3, 'L'], [3, 7, 'L'], [2, 3, 'E'], [2, 7, 'E'], [1, 3, 'P'], [1, 7, 'P']],
  cyclops: [[4, 5, 'E'], [5, 5, 'P'], [4, 4, 'E'], [4, 6, 'E']],
};

const HORNS: Record<HornStyle, Placement[]> = {
  none: [],
  antennae: [[2, 4, 'H'], [1, 3, 'H'], [0, 2, 'H'], [2, 6, 'H'], [1, 7, 'H'], [0, 8, 'H']],
  single: [[2, 5, 'H'], [1, 5, 'H'], [0, 5, 'A']],
  curled: [[2, 4, 'H'], [1, 3, 'H'], [0, 3, 'H'], [0, 4, 'H'], [2, 6, 'H'], [1, 7, 'H'], [0, 7, 'H'], [0, 6, 'H']],
};

const mirrored = (cells: [number, number][]): [number, number][] =>
  cells.flatMap(([row, col]) => [[row, col], [row, SPRITE_WIDTH - 1 - col]] as [number, number][]);

const SPOTS: [number, number][] = [[7, 4], [7, 7], [8, 5], [9, 3], [9, 7], [10, 5], [11, 4], [8, 8]];
const STRIPE_ROWS = [8, 10];
const WINGS = mirrored([[5, 1], [5, 2], [6, 0], [6, 1], [6, 2], [7, 0], [7, 1], [8, 0], [8, 1]]);

/** Features only paint over body cells, except wings, which spread into empty space and legs. */
function applyFeature(grid: (Cell | null)[][], feature: Feature) {
  const isBody = (cell: Cell | null) => cell === 'B' || cell === 'S';
  if (feature === 'spots') {
    for (const [row, col] of SPOTS) if (isBody(grid[row][col])) grid[row][col] = 'A';
  } else if (feature === 'stripes') {
    for (const row of STRIPE_ROWS) grid[row] = grid[row].map((cell) => isBody(cell) ? 'A' : cell);
  } else if (feature === 'wings') {
    for (const [row, col] of WINGS) if (grid[row][col] == null || grid[row][col] === 'L') grid[row][col] = 'W';
  }
}

export function assembleSprite(visual: VisualTraits): (Cell | null)[][] {
  const grid = BODIES[visual.body].map((row) => [...row].map((char) => char === '.' ? null : char as Cell));
  applyFeature(grid, visual.feature);
  for (const [row, col, cell] of [...HORNS[visual.horns], ...EYES[visual.eyes]]) grid[row][col] = cell;
  return grid;
}

const hexToHsl = (hex: string): [number, number, number] => {
  const value = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => channel / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const hue = max === r ? (g - b) / delta + (g < b ? 6 : 0) : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return [hue * 60, saturation, lightness];
};

const hslToHex = ([hue, saturation, lightness]: [number, number, number]): string => {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    const value = lightness - chroma / 2 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
};

export function shiftHue(hex: string, degrees: number): string {
  if (degrees === 0) return hex;
  const [hue, saturation, lightness] = hexToHsl(hex);
  return hslToHex([((hue + degrees) % 360 + 360) % 360, saturation, lightness]);
}

export function spriteColors(visual: VisualTraits): Record<Cell, string> {
  const palette = PALETTES[visual.palette] ?? PALETTES[0];
  const body = shiftHue(palette.body, visual.hueShift);
  const shade = shiftHue(palette.shade, visual.hueShift);
  return { ...FIXED_COLORS, B: body, S: shade, H: shade, A: palette.accent };
}

/** One horizontal run of same-coloured pixels, in sprite cells. */
export type PixelRun = { x: number; y: number; width: number; color: string };

/** Merges each row into runs so a sprite needs a few dozen views rather than one per pixel. */
export function spriteRuns(visual: VisualTraits): PixelRun[] {
  const colors = spriteColors(visual);
  const runs: PixelRun[] = [];
  assembleSprite(visual).forEach((row, y) => {
    let current: PixelRun | null = null;
    row.forEach((cell, x) => {
      const color = cell ? colors[cell] : null;
      if (current && color === current.color) {
        current.width += 1;
        return;
      }
      if (current) runs.push(current);
      current = color ? { x, y, width: 1, color } : null;
    });
    if (current) runs.push(current);
  });
  return runs;
}

export const spriteKey = (visual: VisualTraits): string =>
  `${visual.body}|${visual.eyes}|${visual.horns}|${visual.feature}|${visual.palette}|${visual.hueShift}`;
