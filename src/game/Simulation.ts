import { Random } from './Random';
import { generateArena, isBlocked, resolveArenaCollision } from './arena';
import { BEHAVIOUR_SPECS, defaultTraits, inheritBattleTraits, inheritTraits, randomTraits } from './traits';
import { Bug, DeathCause, EcosystemStats, Food, Habitat, HabitatEdge, PowerId, SimulationEvent, SimulationState, TraitSet } from './types';

/** Fixed timestep: the simulation always advances in steps of this length, whatever the frame rate. */
export const STEP_S = 0.05;
export const DEFAULT_HABITAT: Habitat = { width: 360, height: 520 };
/** Habitats are this many units wide; their height follows the screen's shape. */
export const HABITAT_WIDTH = 360;

export const MAX_SATIETY = 100;
export const STARTER_SATIETY = 80;
export const OFFSPRING_SATIETY = 60;
export const FOOD_SATIETY = 30;

/** Mean seconds between food spawns in a default-sized habitat; each interval is jittered ±50%. */
export const FOOD_SPAWN_INTERVAL_S = 0.55;
export const FOOD_LIFETIME_S = 20;
/** Most food at once in a default-sized habitat. Larger habitats get more, at the same density. */
export const MAX_FOOD = 28;
export const STARTER_FOOD = 3;

/** How far a bug notices food. */
export const SENSE_RADIUS = 120;
export const EAT_RADIUS = 9;
/** A bug this close to a clearly more aggressive one runs away. */
export const CONTACT_RADIUS = 20;
export const AGGRESSION_MARGIN = 0.15;
/** Bugs fuller than this don't bother chasing others off. */
export const BULLY_SATIETY = 85;
export const FLEE_S = 1.2;
export const FLEE_SPEED_FACTOR = 1.35;
export const ATTACK_RANGE = 18;
export const ATTACK_COOLDOWN_S = 0.8;
export const BASE_HEALTH = 100;
const WANDER_JITTER = 4;
const WANDER_TURN_LIMIT = 1.5;
const WALL_MARGIN = 6;

export const MAX_POPULATION = 40;
export const STARTING_BATTLE_BUGS = 10;
/** Bugs breed only after this share of their lifespan. */
export const MATURITY_FRACTION = 0.15;
export const BREEDING_MIN_SATIETY = 35;
export const BREEDING_SATIETY_COST = 20;
const OFFSPRING_DISTANCE = 10;
/** Bugs only leave through an open edge while more than this many stay behind, so leaving never ends an ecosystem. */
export const MIN_HOME_POPULATION = 2;

/** Says whether the wall at `point` opens onto somewhere else (another phone's habitat). */
export type ExitCheck = (point: { x: number; y: number }, edge: HabitatEdge) => boolean;
export type StepOptions = { dt?: number; canExit?: ExitCheck | null };

const NAME_SYLLABLES = ['bo', 'zi', 'ka', 'mu', 'pi', 'ro', 'ta', 'ne', 'lu', 'vo', 'sa', 'do', 'fe', 'gri', 'mo', 'ti', 'bu', 'xi'];

const emptyStats = (): EcosystemStats => ({ births: 0, starvations: 0, oldAgeDeaths: 0, peakPopulation: 0, maxGeneration: 0 });

/** Runs `fn` with the state's generator and stores where the generator ended up. */
function withRandom<T>(state: SimulationState, fn: (rng: Random) => T): T {
  const rng = new Random(state.rngState);
  const result = fn(rng);
  state.rngState = rng.state;
  return result;
}

const nextId = (state: SimulationState, prefix: string) => `${prefix}-${state.nextId++}`;

export function bugName(rng: Random): string {
  const syllables = rng.int(2, 3);
  const name = Array.from({ length: syllables }, () => rng.pick(NAME_SYLLABLES)).join('');
  return name[0].toUpperCase() + name.slice(1);
}

const wrapAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

/** A habitat with the screen's proportions, so it can fill the screen edge to edge. */
export const habitatForScreen = (widthPt: number, heightPt: number): Habitat =>
  ({ width: HABITAT_WIDTH, height: Math.round((HABITAT_WIDTH * heightPt) / widthPt) });

/** Food scales with area, so a taller habitat is no hungrier than the default one. */
const foodScale = ({ width, height }: Habitat) => (width * height) / (DEFAULT_HABITAT.width * DEFAULT_HABITAT.height);
export const maxFood = (habitat: Habitat) => Math.round(MAX_FOOD * foodScale(habitat));
export const foodSpawnIntervalS = (habitat: Habitat) => FOOD_SPAWN_INTERVAL_S / foodScale(habitat);

/** Stretches an ecosystem onto a habitat of another shape (a save from another screen), keeping everything in place. */
export function resizeHabitat(state: SimulationState, habitat: Habitat): void {
  const sx = habitat.width / state.habitat.width;
  const sy = habitat.height / state.habitat.height;
  if (sx === 1 && sy === 1) return;
  for (const item of [...state.bugs, ...state.food]) {
    item.x *= sx;
    item.y *= sy;
  }
  state.habitat = { ...habitat };
}

/** A new, empty ecosystem waiting in the workshop for its two starters. */
export function createSimulation(seed: number, habitat: Habitat = DEFAULT_HABITAT): SimulationState {
  return {
    seed: seed >>> 0,
    rngState: seed >>> 0,
    ecosystem: 1,
    status: 'workshop',
    paused: false,
    timeS: 0,
    endedAtS: null,
    nextId: 1,
    habitat: { ...habitat },
    bugs: [],
    food: [],
    foodTimerS: foodSpawnIntervalS(habitat),
    mode: 'battle',
    arena: generateArena(seed, habitat),
    battleWinner: null,
    speedMultiplier: 1.65,
    soundEnabled: true,
    stats: emptyStats(),
  };
}

/** Two contrasting starters for the workshop to open with. */
export const defaultStarterTraits = (): [TraitSet, TraitSet] => [
  defaultTraits({ body: 'round', eyes: 'dot', horns: 'antennae', feature: 'spots', palette: 0 }),
  defaultTraits({ body: 'beetle', eyes: 'wide', horns: 'single', feature: 'stripes', palette: 2 }),
];

/** Two random starters, drawn from the ecosystem's own generator so the same seed rolls the same pair. */
export const rollStarterTraits = (state: SimulationState): [TraitSet, TraitSet] =>
  withRandom(state, (rng) => [randomTraits(rng), randomTraits(rng)]);

export function createBug(
  state: SimulationState,
  rng: Random,
  traits: TraitSet,
  at: { x: number; y: number },
  parent: Bug | null = null,
): Bug {
  const name = bugName(rng);
  return {
    id: nextId(state, 'bug'),
    name,
    traits,
    inherited: parent ? parent.traits : null,
    generation: parent ? parent.generation + 1 : 1,
    parentId: parent?.id ?? null,
    parentName: parent?.name ?? null,
    founderName: parent?.founderName ?? name,
    bornAtS: state.timeS,
    ageS: 0,
    x: at.x,
    y: at.y,
    heading: rng.range(-Math.PI, Math.PI),
    satiety: parent ? OFFSPRING_SATIETY : STARTER_SATIETY,
    foodEaten: 0,
    totalEaten: 0,
    offspring: 0,
    targetFoodId: null,
    fleeS: 0,
    wanderTurn: 0,
    health: BASE_HEALTH,
    maxHealth: BASE_HEALTH,
    attackCooldownS: 0,
    stunS: 0,
    shieldS: 0,
    powerCooldownS: 0,
    power: null,
    owner: parent?.owner ?? 'wild',
  };
}

function spawnFood(state: SimulationState, rng: Random): Food {
  const margin = WALL_MARGIN * 2;
  let x = state.habitat.width / 2;
  let y = state.habitat.height / 2;
  // Keep food out of water and solid arena geometry. A bounded search preserves
  // deterministic RNG use and avoids hanging if a future arena is crowded.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    x = rng.range(margin, state.habitat.width - margin);
    y = rng.range(margin, state.habitat.height - margin);
    if (!isBlocked(state.arena, { x, y }, EAT_RADIUS)) break;
  }
  const food: Food = {
    id: nextId(state, 'food'),
    x,
    y,
    spawnedAtS: state.timeS,
    expiresAtS: state.timeS + FOOD_LIFETIME_S,
  };
  state.food.push(food);
  return food;
}

/** Puts the two starters into the habitat and starts the clock. */
export function releaseStarters(state: SimulationState, starters: [TraitSet, TraitSet] | [TraitSet], power: PowerId = 'dash'): void {
  if (state.status !== 'workshop') throw new Error(`Cannot release starters while the ecosystem is ${state.status}`);
  const { width, height } = state.habitat;
  // A local launch is a peaceful ecosystem. Battle mode is activated when a remote
  // opponent is admitted by the phone bridge, so one device never ends immediately.
  state.mode = 'ecosystem';
  withRandom(state, (rng) => {
    const local = createBug(state, rng, starters[0], state.arena.spawnPoints[0]);
    local.owner = 'local'; local.power = power;
    state.bugs = [local];
    if (starters[1]) { const remote = createBug(state, rng, starters[1], state.arena.spawnPoints[1]); remote.owner = 'remote'; remote.power = power; state.bugs.push(remote); }
    if (starters.length === 1) {
      for (let index = 1; index < STARTING_BATTLE_BUGS; index += 1) {
        const ai = createBug(state, rng, { visual: { ...starters[0].visual }, behaviour: { ...starters[0].behaviour } }, {
          x: rng.range(WALL_MARGIN * 2, width - WALL_MARGIN * 2),
          y: rng.range(WALL_MARGIN * 2, height - WALL_MARGIN * 2),
        });
        ai.owner = 'wild';
        state.bugs.push(ai);
      }
    }
    for (let i = 0; i < STARTER_FOOD; i += 1) spawnFood(state, rng);
  });
  state.status = 'running';
  state.paused = false;
  state.stats = { ...emptyStats(), peakPopulation: state.bugs.length, maxGeneration: 1 };
}

/** Clears an ended (or abandoned) ecosystem and returns to the workshop. The generator carries on. */
export function restartEcosystem(state: SimulationState): void {
  state.ecosystem += 1;
  state.status = 'workshop';
  state.paused = false;
  state.timeS = 0;
  state.endedAtS = null;
  state.bugs = [];
  state.food = [];
  state.foodTimerS = foodSpawnIntervalS(state.habitat);
  state.stats = emptyStats();
}

export function setPaused(state: SimulationState, paused: boolean): void {
  if (state.status === 'running') state.paused = paused;
}

/** Satiety lost per second: fast and aggressive bugs burn more. */
export function hungerDrain(traits: TraitSet): number {
  const { speed, aggression, hungerRate } = traits.behaviour;
  const speedSpec = BEHAVIOUR_SPECS.speed;
  const speedShare = (speed - speedSpec.min) / (speedSpec.max - speedSpec.min);
  return hungerRate * (0.75 + 0.5 * speedShare + 0.25 * aggression);
}

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

function nearestFood(state: SimulationState, bug: Bug): Food | null {
  let best: Food | null = null;
  let bestDistance = SENSE_RADIUS;
  for (const food of state.food) {
    const d = distance(bug, food);
    if (d <= bestDistance) {
      best = food;
      bestDistance = d;
    }
  }
  return best;
}

/** The nearest hungry bug close by that is clearly more aggressive, if any. */
function threatTo(state: SimulationState, bug: Bug): Bug | null {
  let threat: Bug | null = null;
  let threatDistance = CONTACT_RADIUS;
  for (const other of state.bugs) {
    if (other === bug || other.satiety >= BULLY_SATIETY) continue;
    if (other.traits.behaviour.aggression < bug.traits.behaviour.aggression + AGGRESSION_MARGIN) continue;
    const d = distance(bug, other);
    if (d < threatDistance) {
      threat = other;
      threatDistance = d;
    }
  }
  return threat;
}

function enemyTarget(state: SimulationState, bug: Bug): Bug | null {
  let target: Bug | null = null; let best = Infinity;
  for (const other of state.bugs) {
    if (other === bug || other.owner === bug.owner || other.health <= 0) continue;
    const d = distance(bug, other);
    if (d < best) { best = d; target = other; }
  }
  return target;
}

const powerCooldown = (power: PowerId) => power === 'dash' ? 5 : power === 'shield' ? 8 : power === 'regeneration' ? 10 : power === 'frenzy' ? 9 : 7;

function usePower(state: SimulationState, bug: Bug, target: Bug | null, events: SimulationEvent[]) {
  if (!bug.power || bug.powerCooldownS > 0) return;
  const power = bug.power;
  if (power === 'dash' && target) { bug.x += Math.cos(bug.heading) * 28; bug.y += Math.sin(bug.heading) * 28; }
  if (power === 'shield') bug.shieldS = 2.5;
  if (power === 'regeneration') bug.health = Math.min(bug.maxHealth, bug.health + 28);
  if (power === 'frenzy') bug.attackCooldownS = 0;
  if (power === 'stun-pulse' && target && distance(bug, target) < 55) target.stunS = 1.4;
  bug.powerCooldownS = powerCooldown(power);
  events.push({ type: 'power-used', bugId: bug.id, power });
}

function attack(state: SimulationState, bug: Bug, target: Bug, events: SimulationEvent[]) {
  if (bug.attackCooldownS > 0 || distance(bug, target) > ATTACK_RANGE) return;
  const damage = 8 + Math.round(bug.traits.behaviour.aggression * 12);
  const actual = target.shieldS > 0 ? Math.round(damage * 0.25) : damage;
  target.health = Math.max(0, target.health - actual);
  bug.attackCooldownS = Math.max(0.25, ATTACK_COOLDOWN_S - bug.traits.behaviour.aggression * 0.35);
  events.push({ type: 'attacked', attackerId: bug.id, targetId: target.id, damage: actual });
  if (target.health === 0) events.push({ type: 'defeated', bugId: target.id, name: target.name, killerId: bug.id });
}

/** The wall a bug has walked through this step, and where it crossed, if any. */
function wallCrossed(state: SimulationState, bug: Bug): { edge: HabitatEdge; point: { x: number; y: number } } | null {
  const { width, height } = state.habitat;
  const x = Math.min(width, Math.max(0, bug.x));
  const y = Math.min(height, Math.max(0, bug.y));
  if (bug.x < WALL_MARGIN) return { edge: 'left', point: { x: 0, y } };
  if (bug.x > width - WALL_MARGIN) return { edge: 'right', point: { x: width, y } };
  if (bug.y < WALL_MARGIN) return { edge: 'top', point: { x, y: 0 } };
  if (bug.y > height - WALL_MARGIN) return { edge: 'bottom', point: { x, y: height } };
  return null;
}

function keepInside(state: SimulationState, bug: Bug) {
  const { width, height } = state.habitat;
  if (bug.x < WALL_MARGIN || bug.x > width - WALL_MARGIN) {
    bug.x = Math.min(width - WALL_MARGIN, Math.max(WALL_MARGIN, bug.x));
    bug.heading = Math.PI - bug.heading;
  }
  if (bug.y < WALL_MARGIN || bug.y > height - WALL_MARGIN) {
    bug.y = Math.min(height - WALL_MARGIN, Math.max(WALL_MARGIN, bug.y));
    bug.heading = -bug.heading;
  }
  bug.heading = wrapAngle(bug.heading);
}

/** Moves a bug one step. Returns where it left the habitat if it walked out through an open edge. */
function moveBug(state: SimulationState, bug: Bug, rng: Random, dt: number, canExit: ExitCheck | null) {
  let speed = bug.traits.behaviour.speed * (state.mode === 'battle' ? state.speedMultiplier : 1);
  const target = state.mode === 'battle' ? enemyTarget(state, bug) : null;
  if (target) bug.heading = Math.atan2(target.y - bug.y, target.x - bug.x);
  const threat = threatTo(state, bug);
  if (threat && bug.traits.behaviour.aggression < threat.traits.behaviour.aggression) {
    bug.fleeS = FLEE_S;
    bug.targetFoodId = null;
    bug.heading = Math.atan2(bug.y - threat.y, bug.x - threat.x);
  }
  if (bug.fleeS > 0) {
    bug.fleeS = Math.max(0, bug.fleeS - dt);
    speed *= FLEE_SPEED_FACTOR;
  } else {
    const food = target ? null : nearestFood(state, bug);
    bug.targetFoodId = food?.id ?? null;
    if (food) {
      bug.heading = Math.atan2(food.y - bug.y, food.x - bug.x);
      // Never overshoot the food it is about to reach.
      speed = Math.min(speed, distance(bug, food) / dt);
    } else {
      bug.wanderTurn = Math.max(-WANDER_TURN_LIMIT, Math.min(WANDER_TURN_LIMIT, bug.wanderTurn + rng.range(-1, 1) * WANDER_JITTER * dt));
      bug.heading += bug.wanderTurn * dt;
    }
  }
  const previous = { x: bug.x, y: bug.y };
  bug.x += Math.cos(bug.heading) * speed * dt;
  bug.y += Math.sin(bug.heading) * speed * dt;
  resolveArenaCollision(state.arena, bug, previous);
  const crossed = canExit ? wallCrossed(state, bug) : null;
  if (crossed && canExit?.(crossed.point, crossed.edge)) return crossed;
  keepInside(state, bug);
  return null;
}

function eat(state: SimulationState, bug: Bug, events: SimulationEvent[]) {
  const index = state.food.findIndex((food) => distance(bug, food) <= EAT_RADIUS);
  if (index < 0) return;
  const [food] = state.food.splice(index, 1);
  bug.satiety = Math.min(MAX_SATIETY, bug.satiety + FOOD_SATIETY);
  bug.foodEaten += 1;
  bug.totalEaten += 1;
  bug.targetFoodId = null;
  events.push({ type: 'ate', bugId: bug.id, foodId: food.id });
}

export const isMature = (bug: Bug) => bug.ageS >= bug.traits.behaviour.lifespanS * MATURITY_FRACTION;

export const canBreed = (bug: Bug) =>
  isMature(bug) && bug.foodEaten >= bug.traits.behaviour.foodForReproduction && bug.satiety >= BREEDING_MIN_SATIETY;

function breed(state: SimulationState, parent: Bug, rng: Random, events: SimulationEvent[]) {
  const { traits, visualMutation } = state.mode === 'battle' ? inheritBattleTraits(parent.traits) : inheritTraits(parent.traits, rng);
  const angle = rng.range(-Math.PI, Math.PI);
  const { width, height } = state.habitat;
  const at = {
    x: Math.min(width - WALL_MARGIN, Math.max(WALL_MARGIN, parent.x + Math.cos(angle) * OFFSPRING_DISTANCE)),
    y: Math.min(height - WALL_MARGIN, Math.max(WALL_MARGIN, parent.y + Math.sin(angle) * OFFSPRING_DISTANCE)),
  };
  const child = createBug(state, rng, traits, at, parent);
  parent.foodEaten -= parent.traits.behaviour.foodForReproduction;
  parent.satiety -= BREEDING_SATIETY_COST;
  parent.offspring += 1;
  state.bugs.push(child);
  state.stats.births += 1;
  state.stats.maxGeneration = Math.max(state.stats.maxGeneration, child.generation);
  events.push({ type: 'born', bugId: child.id, name: child.name, parentId: parent.id, generation: child.generation, visualMutation });
}

const deathCause = (bug: Bug): DeathCause | null => bug.health <= 0 ? 'combat' : bug.ageS >= bug.traits.behaviour.lifespanS ? 'old-age' : bug.satiety <= 0 ? 'starvation' : null;

/**
 * Advances the ecosystem by one fixed step, in place, and returns what happened. Does nothing
 * unless the ecosystem is running and not paused. Walls bounce bugs back unless `canExit` opens them.
 */
export function stepSimulation(state: SimulationState, { dt = STEP_S, canExit = null }: StepOptions = {}): SimulationEvent[] {
  if (state.status !== 'running' || state.paused) return [];
  const events: SimulationEvent[] = [];
  state.timeS += dt;

  withRandom(state, (rng) => {
    state.foodTimerS -= dt;
    if (state.foodTimerS <= 0) {
      state.foodTimerS = foodSpawnIntervalS(state.habitat) * rng.range(0.5, 1.5);
      if (state.food.length < maxFood(state.habitat)) events.push({ type: 'food-spawned', foodId: spawnFood(state, rng).id });
    }
    state.food = state.food.filter((food) => {
      if (state.timeS < food.expiresAtS) return true;
      events.push({ type: 'food-expired', foodId: food.id });
      return false;
    });

    state.bugs = state.bugs.filter((bug) => {
      bug.ageS += dt;
      bug.attackCooldownS = Math.max(0, bug.attackCooldownS - dt);
      bug.powerCooldownS = Math.max(0, bug.powerCooldownS - dt);
      bug.stunS = Math.max(0, bug.stunS - dt);
      bug.shieldS = Math.max(0, bug.shieldS - dt);
      if (bug.power === 'regeneration' && bug.health > 0) bug.health = Math.min(bug.maxHealth, bug.health + dt * 0.5);
      bug.satiety = Math.max(0, bug.satiety - hungerDrain(bug.traits) * dt);
      const cause = deathCause(bug);
      if (!cause) return true;
      if (cause === 'old-age') state.stats.oldAgeDeaths += 1;
      else state.stats.starvations += 1;
      events.push({ type: 'died', bugId: bug.id, name: bug.name, cause, ageS: bug.ageS });
      return false;
    });

    for (const bug of [...state.bugs]) {
      const target = state.mode === 'battle' ? enemyTarget(state, bug) : null;
      if (state.mode === 'battle') usePower(state, bug, target, events);
      if (state.mode === 'battle' && target) attack(state, bug, target, events);
      if (bug.stunS > 0) continue;
      const exitsOpen = canExit && state.bugs.length > MIN_HOME_POPULATION ? canExit : null;
      const departed = moveBug(state, bug, rng, dt, exitsOpen);
      if (departed) {
        state.bugs = state.bugs.filter((other) => other !== bug);
        events.push({ type: 'departed', bug, edge: departed.edge, ...departed.point });
      } else {
        eat(state, bug, events);
      }
    }
    for (const bug of [...state.bugs]) {
      if (state.bugs.length >= MAX_POPULATION) break;
      if (canBreed(bug)) breed(state, bug, rng, events);
    }
  });

  state.stats.peakPopulation = Math.max(state.stats.peakPopulation, state.bugs.length);
  if (state.mode === 'ecosystem' && state.bugs.length < 2) {
    state.status = 'ended'; state.endedAtS = state.timeS; events.push({ type: 'ecosystem-ended', survivors: state.bugs.length });
  }
  return events;
}

export const canAdmit = (state: SimulationState) =>
  state.status === 'running' && !state.paused && state.bugs.length < MAX_POPULATION;

/**
 * Brings a bug in from elsewhere (the other phone, or back from a crossing that failed). It gets
 * a new id here, since ids are only unique within one ecosystem, and keeps everything else.
 */
export function admitBug(state: SimulationState, bug: Bug, at: { x: number; y: number }, heading: number): Bug {
  const { width, height } = state.habitat;
  const admitted: Bug = {
    ...bug,
    id: nextId(state, 'bug'),
    x: Math.min(width - WALL_MARGIN, Math.max(WALL_MARGIN, at.x)),
    y: Math.min(height - WALL_MARGIN, Math.max(WALL_MARGIN, at.y)),
    heading: wrapAngle(heading),
    targetFoodId: null,
    fleeS: 0,
  };
  state.mode = 'battle';
  admitted.owner = 'remote';
  state.bugs.push(admitted);
  state.stats.peakPopulation = Math.max(state.stats.peakPopulation, state.bugs.length);
  state.stats.maxGeneration = Math.max(state.stats.maxGeneration, admitted.generation);
  return admitted;
}
