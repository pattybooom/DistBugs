import { Random } from './Random';
import { Arena, Habitat } from './types';

const BIOMES = ['meadow', 'swamp', 'desert', 'tidepool'] as const;
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

export function generateArena(seed: number, habitat: Habitat): Arena {
  const rng = new Random(seed ^ 0xa51ced);
  const biome = rng.pick(BIOMES);
  const water = Array.from({ length: biome === 'desert' ? 1 : 3 }, () => ({ x: rng.range(50, habitat.width - 50), y: rng.range(90, habitat.height - 70), radius: rng.range(18, 38), kind: 'water' as const }));
  const hazards = Array.from({ length: biome === 'swamp' ? 4 : 2 }, () => ({ x: rng.range(35, habitat.width - 35), y: rng.range(70, habitat.height - 35), radius: rng.range(8, 16), kind: 'hazard' as const }));
  const cover = Array.from({ length: 5 }, () => ({ x: rng.range(30, habitat.width - 30), y: rng.range(70, habitat.height - 30), radius: rng.range(8, 14), kind: 'cover' as const }));
  const structures = Array.from({ length: 6 }, () => ({ x: rng.range(25, habitat.width - 65), y: rng.range(70, habitat.height - 65), width: rng.range(18, 42), height: rng.range(18, 42), kind: rng.pick(['rock', 'ruin', 'tree'] as const) }));
  const candidates = [{ x: habitat.width * 0.2, y: habitat.height * 0.5 }, { x: habitat.width * 0.8, y: habitat.height * 0.5 }];
  const spawnPoints = candidates.map((point) => {
    if (water.some((item) => distance(point, item) < item.radius + 20) || structures.some((item) => point.x > item.x - 20 && point.x < item.x + item.width + 20 && point.y > item.y - 20 && point.y < item.y + item.height + 20)) {
      return { x: point.x, y: point.y < habitat.height / 2 ? habitat.height * 0.25 : habitat.height * 0.75 };
    }
    return point;
  });
  return { biome, water, hazards, cover, structures, spawnPoints };
}

export function isBlocked(arena: Arena, point: { x: number; y: number }, radius = 0): boolean {
  return arena.water.some((item) => distance(point, item) < item.radius + radius)
    || arena.structures.some((item) => point.x > item.x - radius && point.x < item.x + item.width + radius && point.y > item.y - radius && point.y < item.y + item.height + radius);
}

export function resolveArenaCollision(arena: Arena, point: { x: number; y: number }, previous: { x: number; y: number }, radius = 6): void {
  if (isBlocked(arena, point, radius)) { point.x = previous.x; point.y = previous.y; }
}
