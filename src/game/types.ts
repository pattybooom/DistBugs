export const BODY_SHAPES = ['round', 'long', 'beetle', 'spider'] as const;
export const EYE_STYLES = ['dot', 'wide', 'stalk', 'cyclops'] as const;
export const HORN_STYLES = ['none', 'antennae', 'single', 'curled'] as const;
/** Ordered so that a visual mutation only ever steps to a neighbour. */
export const FEATURES = ['none', 'spots', 'stripes', 'wings'] as const;

export type BodyShape = typeof BODY_SHAPES[number];
export type EyeStyle = typeof EYE_STYLES[number];
export type HornStyle = typeof HORN_STYLES[number];
export type Feature = typeof FEATURES[number];

export type VisualTraits = {
  body: BodyShape;
  eyes: EyeStyle;
  horns: HornStyle;
  feature: Feature;
  /** Index into `PALETTES`. */
  palette: number;
  /** Degrees added to the palette's body colours; only visual mutations change it. */
  hueShift: number;
};

export type BehaviourTraits = {
  /** Habitat units per second. */
  speed: number;
  /** 0–1. A clearly more aggressive bug chases a calmer one away. */
  aggression: number;
  lifespanS: number;
  /** Satiety lost per second before speed and aggression costs. */
  hungerRate: number;
  /** Food eaten before the bug lays one offspring. */
  foodForReproduction: number;
};

export type TraitSet = { visual: VisualTraits; behaviour: BehaviourTraits };

/** The habitat is a 2D rectangle in its own units; the screen scales it to fit. */
export type Habitat = { width: number; height: number };

export type Food = { id: string; x: number; y: number; spawnedAtS: number; expiresAtS: number };

export type Biome = 'meadow' | 'swamp' | 'desert' | 'tidepool';
export type ArenaCircle = { x: number; y: number; radius: number; kind: 'water' | 'hazard' | 'cover' };
export type ArenaRect = { x: number; y: number; width: number; height: number; kind: 'rock' | 'ruin' | 'tree' };
export type Arena = { biome: Biome; water: ArenaCircle[]; hazards: ArenaCircle[]; cover: ArenaCircle[]; structures: ArenaRect[]; spawnPoints: { x: number; y: number }[] };
export type PowerId = 'dash' | 'shield' | 'stun-pulse' | 'regeneration' | 'frenzy';

export type DeathCause = 'old-age' | 'starvation' | 'combat';

export type HabitatEdge = 'left' | 'right' | 'top' | 'bottom';

export type Bug = {
  id: string;
  name: string;
  traits: TraitSet;
  /** The parent's traits when this bug was born; null for a starter. */
  inherited: TraitSet | null;
  generation: number;
  parentId: string | null;
  parentName: string | null;
  founderName: string;
  bornAtS: number;
  ageS: number;
  x: number;
  y: number;
  /** Radians, screen convention: 0 is +x, positive turns towards +y (down). */
  heading: number;
  /** 0–100; the bug starves at 0. */
  satiety: number;
  /** Food eaten towards the next offspring. */
  foodEaten: number;
  totalEaten: number;
  offspring: number;
  targetFoodId: string | null;
  /** Seconds left running from a more aggressive bug. */
  fleeS: number;
  /** Current wandering turn rate, radians per second. */
  wanderTurn: number;
  health: number;
  maxHealth: number;
  attackCooldownS: number;
  stunS: number;
  shieldS: number;
  powerCooldownS: number;
  power: PowerId | null;
  owner: 'local' | 'remote' | 'wild';
};

/** `workshop`: building two starters. `running`: live (or paused). `ended`: fewer than two bugs left. */
export type EcosystemStatus = 'workshop' | 'running' | 'ended';

export type EcosystemStats = {
  births: number;
  starvations: number;
  oldAgeDeaths: number;
  peakPopulation: number;
  maxGeneration: number;
};

export type SimulationState = {
  seed: number;
  rngState: number;
  /** Counts up each time the player starts a new ecosystem. */
  ecosystem: number;
  status: EcosystemStatus;
  paused: boolean;
  timeS: number;
  endedAtS: number | null;
  nextId: number;
  habitat: Habitat;
  bugs: Bug[];
  food: Food[];
  /** Seconds until the next food spawns. */
  foodTimerS: number;
  mode: 'battle' | 'ecosystem';
  arena: Arena;
  battleWinner: 'local' | 'remote' | null;
  speedMultiplier: number;
  soundEnabled: boolean;
  stats: EcosystemStats;
};

export type SimulationEvent =
  | { type: 'food-spawned'; foodId: string }
  | { type: 'food-expired'; foodId: string }
  | { type: 'ate'; bugId: string; foodId: string }
  | { type: 'born'; bugId: string; name: string; parentId: string; generation: number; visualMutation: boolean }
  | { type: 'died'; bugId: string; name: string; cause: DeathCause; ageS: number }
  | { type: 'ecosystem-ended'; survivors: number }
  | { type: 'attacked'; attackerId: string; targetId: string; damage: number }
  | { type: 'power-used'; bugId: string; power: PowerId }
  | { type: 'defeated'; bugId: string; name: string; killerId: string | null }
  | { type: 'battle-ended'; winner: 'local' | 'remote' | null }
  /** The bug walked out through an open edge and is no longer in this ecosystem. */
  | { type: 'departed'; bug: Bug; edge: HabitatEdge; x: number; y: number };
