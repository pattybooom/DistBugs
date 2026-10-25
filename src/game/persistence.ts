import { PALETTES } from './sprites';
import { BEHAVIOUR_KEYS } from './traits';
import { generateArena } from './arena';
import { BODY_SHAPES, Bug, EYE_STYLES, FEATURES, Food, HORN_STYLES, SimulationState, TraitSet } from './types';

export const STORAGE_KEY = 'distbugs.ecosystem';
export const SAVE_VERSION = 2;

/** The part of AsyncStorage this module uses, so tests can pass an in-memory store. */
export type KeyValueStore = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

type SaveFile = { version: number; savedAt: number; state: SimulationState };

export const serializeSimulation = (state: SimulationState, savedAt = Date.now()): string =>
  JSON.stringify({ version: SAVE_VERSION, savedAt, state } satisfies SaveFile);

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const oneOf = (options: readonly string[], value: unknown) => typeof value === 'string' && options.includes(value);

function isTraitSet(value: unknown): value is TraitSet {
  if (!isObject(value) || !isObject(value.visual) || !isObject(value.behaviour)) return false;
  const { visual, behaviour } = value;
  return oneOf(BODY_SHAPES, visual.body)
    && oneOf(EYE_STYLES, visual.eyes)
    && oneOf(HORN_STYLES, visual.horns)
    && oneOf(FEATURES, visual.feature)
    && Number.isInteger(visual.palette) && (visual.palette as number) >= 0 && (visual.palette as number) < PALETTES.length
    && isNumber(visual.hueShift)
    && BEHAVIOUR_KEYS.every((key) => isNumber(behaviour[key]));
}

export const isBug = (value: unknown): value is Bug =>
  isObject(value)
  && typeof value.id === 'string'
  && typeof value.name === 'string'
  && isTraitSet(value.traits)
  && (value.inherited === null || isTraitSet(value.inherited))
  && ['generation', 'ageS', 'x', 'y', 'heading', 'satiety', 'foodEaten', 'totalEaten', 'offspring', 'fleeS', 'wanderTurn'].every((key) => isNumber(value[key]));

const isFood = (value: unknown): value is Food =>
  isObject(value) && typeof value.id === 'string' && ['x', 'y', 'spawnedAtS', 'expiresAtS'].every((key) => isNumber(value[key]));

/** Returns null for anything that is not a complete save of this version, so the app starts fresh instead. */
export function deserializeSimulation(json: string | null): SimulationState | null {
  if (!json) return null;
  let file: unknown;
  try {
    file = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isObject(file) || ![1, SAVE_VERSION].includes(file.version as number) || !isObject(file.state)) return null;
  const state = file.state;
  if (file.version === 1) {
    state.mode = 'ecosystem';
    state.arena = generateArena(isNumber(state.seed) ? state.seed : 1, state.habitat as SimulationState['habitat']);
    state.battleWinner = null;
    state.speedMultiplier = 1;
    state.soundEnabled = true;
    if (Array.isArray(state.bugs)) for (const bug of state.bugs) {
      bug.health = 100; bug.maxHealth = 100; bug.attackCooldownS = 0; bug.stunS = 0; bug.shieldS = 0; bug.powerCooldownS = 0; bug.power = null; bug.owner = 'wild';
    }
  }
  const valid = oneOf(['workshop', 'running', 'ended'], state.status)
    && typeof state.paused === 'boolean'
    && ['seed', 'rngState', 'ecosystem', 'timeS', 'nextId', 'foodTimerS'].every((key) => isNumber(state[key]))
    && isObject(state.habitat) && isNumber(state.habitat.width) && isNumber(state.habitat.height)
    && isObject(state.stats)
    && Array.isArray(state.bugs) && state.bugs.every(isBug)
    && Array.isArray(state.food) && state.food.every(isFood);
  return valid ? state as unknown as SimulationState : null;
}

export async function saveSimulation(store: KeyValueStore, state: SimulationState): Promise<void> {
  await store.setItem(STORAGE_KEY, serializeSimulation(state));
}

/** Loads the saved ecosystem. A running one comes back paused: no time passed while the app was closed. */
export async function loadSimulation(store: KeyValueStore): Promise<SimulationState | null> {
  const state = deserializeSimulation(await store.getItem(STORAGE_KEY));
  if (state?.status === 'running') state.paused = true;
  return state;
}
