import { isSolidAt } from './hexmap';
import { Random } from './Random';
import { Arena, Biome, Habitat } from './types';

export const BIOMES = ['meadow', 'swamp', 'desert', 'tidepool'] as const satisfies readonly Biome[];
/** A desert has one oasis, a meadow a couple of ponds, a swamp is boggy and a tidepool is mostly small pools. */
const WATER: Record<Biome, { pools: number; minRadius: number; maxRadius: number }> = {
  meadow: { pools: 2, minRadius: 22, maxRadius: 38 },
  swamp: { pools: 4, minRadius: 20, maxRadius: 40 },
  desert: { pools: 1, minRadius: 18, maxRadius: 30 },
  tidepool: { pools: 6, minRadius: 12, maxRadius: 28 },
};
/** Habitat units a starter needs around it, so it can walk away from its spawn. */
const SPAWN_CLEARANCE = 12;

/** `biome` overrides the seed's own pick; the rest of the layout still comes from the seed. */
export function generateArena(seed: number, habitat: Habitat, chosen?: Biome): Arena {
  const rng = new Random(seed ^ 0xa51ced);
  const rolled = rng.pick(BIOMES);
  const biome = chosen ?? rolled;
  const { pools, minRadius, maxRadius } = WATER[biome];
  const water = Array.from({ length: pools }, () => ({ x: rng.range(50, habitat.width - 50), y: rng.range(90, habitat.height - 70), radius: rng.range(minRadius, maxRadius), kind: 'water' as const }));
  const hazards = Array.from({ length: biome === 'swamp' ? 4 : 2 }, () => ({ x: rng.range(35, habitat.width - 35), y: rng.range(70, habitat.height - 35), radius: rng.range(8, 16), kind: 'hazard' as const }));
  const cover = Array.from({ length: 5 }, () => ({ x: rng.range(30, habitat.width - 30), y: rng.range(70, habitat.height - 30), radius: rng.range(8, 14), kind: 'cover' as const }));
  const structures = Array.from({ length: 6 }, () => ({ x: rng.range(25, habitat.width - 65), y: rng.range(70, habitat.height - 65), width: rng.range(18, 42), height: rng.range(18, 42), kind: rng.pick(['rock', 'ruin', 'tree'] as const) }));
  const terrain = { biome, water, hazards, cover, structures, spawnPoints: [] };
  // Each starter spawns on its own side, moving up or down its side until it is clear of solid hexes.
  const spawnPoints = [0.2, 0.8].map((side) => {
    const x = habitat.width * side;
    const point = [0.5, 0.25, 0.75, 0.375, 0.625, 0.15, 0.85].map((share) => ({ x, y: habitat.height * share }))
      .find((candidate) => !isSolidAt(terrain, candidate, SPAWN_CLEARANCE));
    return point ?? { x, y: habitat.height / 2 };
  });
  return { biome, water, hazards, cover, structures, spawnPoints };
}

/** Water and structures block whole hexes, matching what is drawn. */
export function isBlocked(arena: Arena, point: { x: number; y: number }, radius = 0): boolean {
  return isSolidAt(arena, point, radius);
}

export function resolveArenaCollision(arena: Arena, point: { x: number; y: number }, previous: { x: number; y: number }, radius = 6): void {
  if (isBlocked(arena, point, radius)) { point.x = previous.x; point.y = previous.y; }
}
