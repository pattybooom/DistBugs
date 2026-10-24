import {
  deserializeSimulation,
  KeyValueStore,
  loadSimulation,
  SAVE_VERSION,
  saveSimulation,
  serializeSimulation,
  STORAGE_KEY,
} from '../src/game/persistence';
import { createSimulation, defaultStarterTraits, MATURITY_FRACTION, releaseStarters, STEP_S, stepSimulation } from '../src/game/Simulation';
import { AUTOSAVE_INTERVAL_S, MAX_FRAME_S, SimulationDriver } from '../src/game/SimulationDriver';
import { SimulationState } from '../src/game/types';

function running(seed = 4): SimulationState {
  const state = createSimulation(seed);
  releaseStarters(state, defaultStarterTraits());
  return state;
}

const run = (state: SimulationState, steps: number) => {
  for (let i = 0; i < steps; i += 1) stepSimulation(state);
};

class MemoryStore implements KeyValueStore {
  values = new Map<string, string>();
  async getItem(key: string) { return this.values.get(key) ?? null; }
  async setItem(key: string, value: string) { this.values.set(key, value); }
}

describe('save and restore', () => {
  test('a restored ecosystem is identical and plays on identically', () => {
    const original = running();
    run(original, 600);
    const restored = deserializeSimulation(serializeSimulation(original));
    expect(restored).toEqual(original);

    run(original, 600);
    run(restored!, 600);
    expect(restored).toEqual(original);
  });

  test('a workshop or ended ecosystem round-trips too', () => {
    const workshop = createSimulation(8);
    expect(deserializeSimulation(serializeSimulation(workshop))).toEqual(workshop);
    const ended = running();
    ended.bugs = ended.bugs.slice(0, 1);
    stepSimulation(ended);
    expect(deserializeSimulation(serializeSimulation(ended))).toEqual(ended);
  });

  test('broken, foreign or outdated saves are rejected rather than half-loaded', () => {
    const good = JSON.parse(serializeSimulation(running()));
    expect(deserializeSimulation(null)).toBeNull();
    expect(deserializeSimulation('not json')).toBeNull();
    expect(deserializeSimulation(JSON.stringify({ ...good, version: SAVE_VERSION + 1 }))).toBeNull();
    const badBug = structuredClone(good);
    badBug.state.bugs[0].traits.visual.body = 'dragon';
    expect(deserializeSimulation(JSON.stringify(badBug))).toBeNull();
    const badFood = structuredClone(good);
    badFood.state.food = [{ id: 'x' }];
    expect(deserializeSimulation(JSON.stringify(badFood))).toBeNull();
  });

  test('loading a running ecosystem brings it back paused', async () => {
    const store = new MemoryStore();
    const state = running();
    run(state, 100);
    await saveSimulation(store, state);
    expect(store.values.has(STORAGE_KEY)).toBe(true);

    const loaded = await loadSimulation(store);
    expect(loaded?.paused).toBe(true);
    expect(loaded?.timeS).toBe(state.timeS);
    expect(loaded?.bugs).toEqual(state.bugs);
  });

  test('nothing saved loads as null', async () => {
    expect(await loadSimulation(new MemoryStore())).toBeNull();
  });
});

describe('driver', () => {
  function driven(state = running()) {
    const saves: SimulationState[] = [];
    const driver = new SimulationDriver(state, (saved) => saves.push(JSON.parse(JSON.stringify(saved))));
    return { driver, saves, state };
  }

  test('turns frame time into fixed steps, carrying the remainder', () => {
    const { driver, state } = driven();
    driver.advance(STEP_S * 2.5);
    expect(state.timeS).toBeCloseTo(STEP_S * 2, 9);
    driver.advance(STEP_S * 0.5);
    expect(state.timeS).toBeCloseTo(STEP_S * 3, 9);
  });

  test('a long frame advances at most a quarter second: no catch-up', () => {
    const { driver, state } = driven();
    driver.advance(30);
    expect(state.timeS).toBeLessThanOrEqual(MAX_FRAME_S + 1e-9);
  });

  test('no simulated time passes while the app is in the background', () => {
    const { driver, saves, state } = driven();
    driver.advance(0.2);
    const timeBefore = state.timeS;

    driver.setAppActive(false);
    expect(state.paused).toBe(true);
    expect(saves.at(-1)?.paused).toBe(true);
    expect(saves.at(-1)?.timeS).toBe(timeBefore);

    for (let i = 0; i < 100; i += 1) driver.advance(0.1);
    expect(state.timeS).toBe(timeBefore);

    // Coming back shows the ecosystem paused until the player resumes it.
    driver.setAppActive(true);
    driver.advance(0.2);
    expect(state.timeS).toBe(timeBefore);
    driver.setPaused(false);
    driver.advance(0.2);
    expect(state.timeS).toBeGreaterThan(timeBefore);
  });

  test('saves on births and deaths, and periodically', () => {
    const { driver, saves, state } = driven();
    const [parent] = state.bugs;
    Object.assign(parent, { ageS: parent.traits.behaviour.lifespanS * MATURITY_FRACTION + 1, foodEaten: 10, satiety: 90 });
    driver.advance(STEP_S);
    expect(saves).toHaveLength(1);
    expect(saves[0].bugs).toHaveLength(3);

    const quiet = driven(running(5));
    quiet.state.bugs.forEach((bug) => Object.assign(bug, { foodEaten: 0 }));
    for (let i = 0; i < AUTOSAVE_INTERVAL_S / 0.2 + 1; i += 1) quiet.driver.advance(0.2);
    expect(quiet.saves.length).toBeGreaterThanOrEqual(1);
  });

  test('pausing through the driver stops the clock and saves', () => {
    const { driver, saves, state } = driven();
    driver.setPaused(true);
    expect(saves.at(-1)?.paused).toBe(true);
    const time = state.timeS;
    driver.advance(1);
    expect(state.timeS).toBe(time);
  });
});
