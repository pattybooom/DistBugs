import { isBlocked } from '../src/game/arena';
import { HEX_ROW_STEP, HEX_WIDTH, hexAt, hexCenter, hexesCovering, hexNeighbors, isSolid, terrainAt } from '../src/game/hexmap';
import { createSimulation, habitatForScreen } from '../src/game/Simulation';
import { Arena } from '../src/game/types';
import { HEX_SLOTS, layoutTiles, OBJECT_SLOTS } from '../src/ui/tileLayout';

const emptyArena = (overrides: Partial<Arena> = {}): Arena => ({
  biome: 'meadow', water: [], hazards: [], cover: [], structures: [], spawnPoints: [], ...overrides,
});

describe('hex grid', () => {
  test('a hex centre lies in its own hex, for odd, even and negative rows', () => {
    for (let row = -2; row <= 6; row += 1) {
      for (let col = -2; col <= 6; col += 1) expect(hexAt(hexCenter({ col, row }))).toEqual({ col, row });
    }
  });

  test('neighbours are one hex width away', () => {
    for (const cell of [{ col: 3, row: 4 }, { col: 3, row: 5 }, { col: 0, row: -1 }]) {
      const center = hexCenter(cell);
      const neighbors = hexNeighbors(cell);
      expect(new Set(neighbors.map((n) => `${n.col},${n.row}`)).size).toBe(6);
      for (const neighbor of neighbors) {
        const other = hexCenter(neighbor);
        // Rows are 14/16 of a hex apart rather than a regular hexagon's 0.866, so diagonal neighbours are a little further.
        expect(Math.hypot(other.x - center.x, other.y - center.y)).toBeGreaterThanOrEqual(HEX_WIDTH - 1e-9);
        expect(Math.hypot(other.x - center.x, other.y - center.y)).toBeLessThan(HEX_WIDTH * 1.02);
      }
    }
  });

  test('the covering hexes reach every corner of the habitat', () => {
    const cells = new Set(hexesCovering(360, 780).map((c) => `${c.col},${c.row}`));
    for (const point of [{ x: 0, y: 0 }, { x: 360, y: 0 }, { x: 0, y: 780 }, { x: 360, y: 780 }, { x: 180, y: HEX_ROW_STEP * 7.5 }]) {
      const cell = hexAt(point);
      expect(cells.has(`${cell.col},${cell.row}`)).toBe(true);
    }
  });
});

describe('terrain', () => {
  test('a pond fills the hexes whose centres it covers', () => {
    const pond = { x: 180, y: 260, radius: 40, kind: 'water' as const };
    const arena = emptyArena({ water: [pond] });
    for (const cell of hexesCovering(360, 520)) {
      const center = hexCenter(cell);
      const inside = Math.hypot(center.x - pond.x, center.y - pond.y) < pond.radius;
      if (inside) expect(terrainAt(arena, cell)).toBe('water');
    }
  });

  test('a pond smaller than a hex still claims the hex it sits in', () => {
    const arena = emptyArena({ water: [{ x: 101, y: 203, radius: 4, kind: 'water' }] });
    expect(terrainAt(arena, hexAt({ x: 101, y: 203 }))).toBe('water');
    expect(isBlocked(arena, { x: 101, y: 203 })).toBe(true);
  });

  test('structures block, hazards and cover do not', () => {
    const arena = emptyArena({
      structures: [{ x: 40, y: 100, width: 30, height: 30, kind: 'tree' }],
      hazards: [{ x: 200, y: 300, radius: 10, kind: 'hazard' }],
      cover: [{ x: 250, y: 400, radius: 10, kind: 'cover' }],
    });
    expect(terrainAt(arena, hexAt({ x: 55, y: 115 }))).toBe('tree');
    expect(isBlocked(arena, { x: 55, y: 115 })).toBe(true);
    expect(terrainAt(arena, hexAt({ x: 200, y: 300 }))).toBe('hazard');
    expect(isBlocked(arena, { x: 200, y: 300 })).toBe(false);
    expect(terrainAt(arena, hexAt({ x: 250, y: 400 }))).toBe('cover');
    expect(isBlocked(arena, { x: 250, y: 400 })).toBe(false);
  });

  test('starters never spawn in or against a solid hex', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const habitat = habitatForScreen(390, 844);
      const { arena } = createSimulation(seed, habitat);
      for (const spawn of arena.spawnPoints) expect(isBlocked(arena, spawn, 6)).toBe(false);
    }
  });
});

describe('tile layout', () => {
  test('every hex gets a tile, water edges are shallow and shores ring the water', () => {
    const habitat = habitatForScreen(390, 844);
    const arena = emptyArena({ water: [{ x: 180, y: 400, radius: 70, kind: 'water' }] });
    const layout = layoutTiles(arena, habitat, 9);
    expect(layout.hexes).toHaveLength(hexesCovering(habitat.width, habitat.height).length);
    for (const hex of layout.hexes) expect(HEX_SLOTS).toContain(hex.slot);
    for (const object of layout.objects) expect(OBJECT_SLOTS).toContain(object.slot);
    const slotAt = (point: { x: number; y: number }) => {
      const cell = hexAt(point);
      return layout.hexes.find((hex) => hex.key === `${cell.col},${cell.row}`)?.slot;
    };
    expect(slotAt({ x: 180, y: 400 })).toBe('deep');
    expect(['shallow', 'waterDecor']).toContain(slotAt({ x: 180 + 60, y: 400 }));
    expect(slotAt({ x: 180 + 85, y: 400 })).toBe('shore');
  });

  test('structures and cover stand an object on their hex, drawn top to bottom', () => {
    const habitat = habitatForScreen(390, 844);
    const arena = emptyArena({
      structures: [{ x: 40, y: 300, width: 30, height: 30, kind: 'rock' }, { x: 200, y: 100, width: 30, height: 30, kind: 'tree' }],
      cover: [{ x: 300, y: 500, radius: 10, kind: 'cover' }],
    });
    const { objects } = layoutTiles(arena, habitat, 3);
    const kinds = objects.map((object) => object.slot);
    expect(kinds).toEqual(expect.arrayContaining(['rock', 'tree', 'cover']));
    for (let i = 1; i < objects.length; i += 1) expect(objects[i].y).toBeGreaterThanOrEqual(objects[i - 1].y);
  });

  test('is the same for the same arena and seed', () => {
    const habitat = habitatForScreen(390, 844);
    const { arena } = createSimulation(77, habitat);
    expect(layoutTiles(arena, habitat, 77)).toEqual(layoutTiles(arena, habitat, 77));
  });
});
