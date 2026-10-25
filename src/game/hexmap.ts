import { Arena, ArenaCircle } from './types';

/**
 * The arena is laid on a grid of pointy-top hexes. The arena keeps its generated shapes; each
 * hex takes the terrain of the shape its centre falls in, and both drawing and collisions read
 * the hexes, so a bug is stopped exactly where the water or rock is drawn.
 */

/** Habitat units across one hex. The tile art is 16 pixels across. */
export const HEX_WIDTH = 30;
/** Rows interlock 14 art pixels apart (a regular hexagon would be 13.86). */
export const HEX_ROW_STEP = (HEX_WIDTH * 14) / 16;

export type Terrain = 'ground' | 'water' | 'hazard' | 'cover' | 'rock' | 'ruin' | 'tree';
export type HexCell = { col: number; row: number };

const BLOCKING: ReadonlySet<Terrain> = new Set(['water', 'rock', 'ruin', 'tree']);
export const isSolid = (terrain: Terrain) => BLOCKING.has(terrain);

/** Odd rows sit half a hex to the right. */
export const hexCenter = ({ col, row }: HexCell) => ({ x: (col + (row & 1) * 0.5) * HEX_WIDTH, y: row * HEX_ROW_STEP });

/** The hex a point lies in: the one with the nearest centre. */
export function hexAt({ x, y }: { x: number; y: number }): HexCell {
  const guessRow = Math.round(y / HEX_ROW_STEP);
  let best: HexCell = { col: 0, row: guessRow };
  let bestDistance = Infinity;
  for (let row = guessRow - 1; row <= guessRow + 1; row += 1) {
    const guessCol = Math.round(x / HEX_WIDTH - (row & 1) * 0.5);
    for (let col = guessCol - 1; col <= guessCol + 1; col += 1) {
      const center = hexCenter({ col, row });
      const distance = (center.x - x) ** 2 + (center.y - y) ** 2;
      if (distance < bestDistance) {
        best = { col, row };
        bestDistance = distance;
      }
    }
  }
  return best;
}

const sameHex = (a: HexCell, b: HexCell) => a.col === b.col && a.row === b.row;

/** A shape owns the hexes whose centres it covers, and always at least the hex at its own centre, so small ones don't vanish. */
const circleOwns = (circle: ArenaCircle, cell: HexCell, center: { x: number; y: number }) =>
  Math.hypot(center.x - circle.x, center.y - circle.y) < circle.radius || sameHex(hexAt(circle), cell);

/** Terrain is fixed for an arena's lifetime, and collisions ask about the same hexes every step. */
const terrainCache = new WeakMap<Arena, Map<string, Terrain>>();

export function terrainAt(arena: Arena, cell: HexCell): Terrain {
  let cache = terrainCache.get(arena);
  if (!cache) {
    cache = new Map();
    terrainCache.set(arena, cache);
  }
  const key = `${cell.col},${cell.row}`;
  let terrain = cache.get(key);
  if (!terrain) {
    terrain = classify(arena, cell);
    cache.set(key, terrain);
  }
  return terrain;
}

function classify(arena: Arena, cell: HexCell): Terrain {
  const center = hexCenter(cell);
  if (arena.water.some((item) => circleOwns(item, cell, center))) return 'water';
  const structure = arena.structures.find((item) =>
    (center.x >= item.x && center.x < item.x + item.width && center.y >= item.y && center.y < item.y + item.height)
    || sameHex(hexAt({ x: item.x + item.width / 2, y: item.y + item.height / 2 }), cell));
  if (structure) return structure.kind;
  if (arena.hazards.some((item) => circleOwns(item, cell, center))) return 'hazard';
  if (arena.cover.some((item) => circleOwns(item, cell, center))) return 'cover';
  return 'ground';
}

/** The six neighbours of a hex, east first, going clockwise on screen. */
export function hexNeighbors({ col, row }: HexCell): HexCell[] {
  const shift = row & 1;
  return [
    { col: col + 1, row },
    { col: col + shift, row: row + 1 },
    { col: col + shift - 1, row: row + 1 },
    { col: col - 1, row },
    { col: col + shift - 1, row: row - 1 },
    { col: col + shift, row: row - 1 },
  ];
}

/** Every hex that shows on a habitat of this size, row by row from the top. */
export function hexesCovering(width: number, height: number): HexCell[] {
  const cells: HexCell[] = [];
  const lastRow = Math.ceil(height / HEX_ROW_STEP) + 1;
  const lastCol = Math.ceil(width / HEX_WIDTH) + 1;
  for (let row = -1; row <= lastRow; row += 1) {
    for (let col = -1; col <= lastCol; col += 1) {
      const { x, y } = hexCenter({ col, row });
      if (x > -HEX_WIDTH && x < width + HEX_WIDTH && y > -HEX_WIDTH && y < height + HEX_WIDTH) cells.push({ col, row });
    }
  }
  return cells;
}

/** Solid if the point, or any point `radius` away from it, lies in a solid hex. */
export function isSolidAt(arena: Arena, point: { x: number; y: number }, radius = 0): boolean {
  if (isSolid(terrainAt(arena, hexAt(point)))) return true;
  if (radius <= 0) return false;
  for (let i = 0; i < 6; i += 1) {
    const angle = (i * Math.PI) / 3;
    if (isSolid(terrainAt(arena, hexAt({ x: point.x + Math.cos(angle) * radius, y: point.y + Math.sin(angle) * radius })))) return true;
  }
  return false;
}
