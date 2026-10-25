import { HEX_WIDTH, HexCell, hexCenter, hexesCovering, hexNeighbors, terrainAt } from '../game/hexmap';
import { Arena, Habitat } from '../game/types';

/**
 * Picks which tile art goes on each hex. Slot names, sizes and the atlas layout mirror
 * tools/tiles/generate_tiles.py, which draws the atlases; change both together.
 */
export const HEX_SLOTS = ['ground0', 'ground1', 'ground2', 'patch0', 'patch1', 'shore', 'shallow', 'deep', 'waterDecor', 'hazard'] as const;
export const OBJECT_SLOTS = ['tree', 'rock', 'ruin', 'cover', 'decor0', 'decor1'] as const;
export type HexSlot = typeof HEX_SLOTS[number];
export type ObjectSlot = typeof OBJECT_SLOTS[number];

/** All sizes in art pixels. */
export const ART = {
  hex: { width: 16, height: 18, centerX: 8, centerY: 9 },
  object: { width: 20, height: 28, footX: 10, footY: 23 },
  pad: 2,
  atlas: { width: 180, height: 48 },
};
/** Habitat units per art pixel. */
export const ART_UNIT = HEX_WIDTH / ART.hex.width;

/** Where a slot sits in the atlas, in art pixels. */
export const hexSlotOrigin = (slot: HexSlot) => ({ x: HEX_SLOTS.indexOf(slot) * (ART.hex.width + ART.pad), y: 0 });
export const objectSlotOrigin = (slot: ObjectSlot) => ({ x: OBJECT_SLOTS.indexOf(slot) * (ART.object.width + ART.pad), y: ART.hex.height + ART.pad });

/** Top-left corners in habitat units. */
export type PlacedHex = { key: string; x: number; y: number; slot: HexSlot };
export type PlacedObject = { key: string; x: number; y: number; slot: ObjectSlot };
export type TileLayout = { hexes: PlacedHex[]; objects: PlacedObject[] };

/** A repeatable 0–1 value for a hex; `salt` gives independent values for different choices. */
function hash(cell: HexCell, seed: number, salt: number): number {
  let h = Math.imul(cell.col | 0, 0x27d4eb2d) ^ Math.imul(cell.row | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(salt, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Smooth value noise over the habitat, so ground patches come in clumps rather than a checkerboard. */
function patchNoise(point: { x: number; y: number }, seed: number, salt: number): number {
  const size = HEX_WIDTH * 2.6;
  const gx = point.x / size;
  const gy = point.y / size;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const tx = smooth(gx - x0);
  const ty = smooth(gy - y0);
  const corner = (col: number, row: number) => hash({ col, row }, seed, salt);
  const top = corner(x0, y0) + (corner(x0 + 1, y0) - corner(x0, y0)) * tx;
  const bottom = corner(x0, y0 + 1) + (corner(x0 + 1, y0 + 1) - corner(x0, y0 + 1)) * tx;
  return top + (bottom - top) * ty;
}

function groundSlot(cell: HexCell, center: { x: number; y: number }, seed: number): HexSlot {
  if (patchNoise(center, seed, 1) > 0.7) return 'patch0';
  if (patchNoise(center, seed, 2) > 0.72) return 'patch1';
  const roll = hash(cell, seed, 3);
  return roll < 0.45 ? 'ground0' : roll < 0.9 ? 'ground1' : 'ground2';
}

export function layoutTiles(arena: Arena, habitat: Habitat, seed: number): TileLayout {
  const cells = hexesCovering(habitat.width, habitat.height);
  const keyOf = (cell: HexCell) => `${cell.col},${cell.row}`;
  const terrainOf = (cell: HexCell) => terrainAt(arena, cell);

  const hexes: PlacedHex[] = [];
  const objects: PlacedObject[] = [];
  for (const cell of cells) {
    const key = keyOf(cell);
    const center = hexCenter(cell);
    const kind = terrainOf(cell);
    const wetNeighbors = hexNeighbors(cell).filter((neighbor) => terrainOf(neighbor) === 'water').length;
    let slot: HexSlot;
    let object: ObjectSlot | null = null;
    if (kind === 'water') {
      slot = wetNeighbors === 6 ? 'deep' : hash(cell, seed, 4) < 0.22 ? 'waterDecor' : 'shallow';
    } else if (kind === 'hazard') {
      slot = 'hazard';
    } else {
      slot = wetNeighbors > 0 ? 'shore' : groundSlot(cell, center, seed);
      if (kind === 'tree' || kind === 'rock' || kind === 'ruin' || kind === 'cover') object = kind;
      else if (slot !== 'shore') {
        const roll = hash(cell, seed, 5);
        if (roll < 0.05) object = 'decor0';
        else if (roll < 0.09) object = 'decor1';
      }
    }
    hexes.push({ key, slot, x: center.x - ART.hex.centerX * ART_UNIT, y: center.y - ART.hex.centerY * ART_UNIT });
    if (object) objects.push({ key, slot: object, x: center.x - ART.object.footX * ART_UNIT, y: center.y - ART.object.footY * ART_UNIT });
  }
  // Objects overlap the hexes above them, so lower ones are drawn last.
  objects.sort((a, b) => a.y - b.y || a.x - b.x);
  return { hexes, objects };
}
