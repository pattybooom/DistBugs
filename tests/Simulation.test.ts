import { Random } from '../src/game/Random';
import {
  CONTACT_RADIUS,
  createSimulation,
  DEFAULT_HABITAT,
  defaultStarterTraits,
  EAT_RADIUS,
  FOOD_SATIETY,
  FOOD_SPAWN_INTERVAL_S,
  foodSpawnIntervalS,
  habitatForScreen,
  MATURITY_FRACTION,
  MAX_FOOD,
  maxFood,
  OFFSPRING_SATIETY,
  releaseStarters,
  resizeHabitat,
  restartEcosystem,
  rollStarterTraits,
  setPaused,
  STEP_S,
  stepSimulation,
} from '../src/game/Simulation';
import { BEHAVIOUR_KEYS, BEHAVIOUR_SPECS, HUE_SHIFT_LIMIT, inheritTraits, randomTraits } from '../src/game/traits';
import { Bug, FEATURES, SimulationEvent, SimulationState } from '../src/game/types';

/** A running ecosystem with its two starters, no food, and no food due for a long while. */
function running(seed = 1): SimulationState {
  const state = createSimulation(seed);
  releaseStarters(state, defaultStarterTraits());
  state.food = [];
  state.foodTimerS = 1e6;
  return state;
}

/** Moves a bug somewhere and makes it content, so it neither starves nor gets chased mid-test. */
function place(bug: Bug, x: number, y: number, overrides: Partial<Bug> = {}): Bug {
  return Object.assign(bug, { x, y, satiety: 90, fleeS: 0, ...overrides });
}

function run(state: SimulationState, steps: number): SimulationEvent[] {
  const events: SimulationEvent[] = [];
  for (let i = 0; i < steps; i += 1) events.push(...stepSimulation(state));
  return events;
}

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe('bug creation', () => {
  test('the same seed rolls, names and places the same starters', () => {
    const build = (seed: number) => {
      const state = createSimulation(seed);
      releaseStarters(state, rollStarterTraits(state));
      return state;
    };
    expect(build(42).bugs).toEqual(build(42).bugs);
    expect(build(42).bugs).not.toEqual(build(43).bugs);
  });

  test('the same seed plays out the same ecosystem', () => {
    const a = createSimulation(9);
    const b = createSimulation(9);
    releaseStarters(a, defaultStarterTraits());
    releaseStarters(b, defaultStarterTraits());
    run(a, 1200);
    run(b, 1200);
    expect(a).toEqual(b);
  });

  test('starters begin as generation 1 founders with no inherited traits', () => {
    const state = running();
    expect(state.status).toBe('running');
    expect(state.bugs).toHaveLength(2);
    for (const bug of state.bugs) {
      expect(bug.generation).toBe(1);
      expect(bug.inherited).toBeNull();
      expect(bug.founderName).toBe(bug.name);
    }
  });

  test('random traits stay inside every behaviour range', () => {
    const rng = new Random(5);
    for (let i = 0; i < 200; i += 1) {
      const { behaviour } = randomTraits(rng);
      for (const key of BEHAVIOUR_KEYS) {
        expect(behaviour[key]).toBeGreaterThanOrEqual(BEHAVIOUR_SPECS[key].min);
        expect(behaviour[key]).toBeLessThanOrEqual(BEHAVIOUR_SPECS[key].max);
      }
    }
  });
});

describe('food', () => {
  test('spawns when its timer runs out, inside the habitat', () => {
    const state = running();
    state.foodTimerS = STEP_S / 2;
    const events = stepSimulation(state);
    expect(events.filter((event) => event.type === 'food-spawned')).toHaveLength(1);
    expect(state.food).toHaveLength(1);
    const [food] = state.food;
    expect(food.x).toBeGreaterThan(0);
    expect(food.x).toBeLessThan(state.habitat.width);
    expect(food.y).toBeGreaterThan(0);
    expect(food.y).toBeLessThan(state.habitat.height);
    expect(state.foodTimerS).toBeGreaterThan(0);
  });

  test('never spawns food inside a structure or water', () => {
    const state = running(1);
    state.arena = {
      ...state.arena,
      water: [{ x: 180, y: 260, radius: 34, kind: 'water' }],
      structures: [{ x: 80, y: 180, width: 70, height: 70, kind: 'rock' }],
    };
    for (let i = 0; i < 100; i += 1) {
      state.foodTimerS = STEP_S / 2;
      stepSimulation(state);
      const food = state.food[state.food.length - 1];
      const insideRock = food.x >= 80 - EAT_RADIUS && food.x <= 150 + EAT_RADIUS
        && food.y >= 180 - EAT_RADIUS && food.y <= 250 + EAT_RADIUS;
      const insideWater = distance(food, { x: 180, y: 260 }) < 34 + EAT_RADIUS;
      expect(insideRock || insideWater).toBe(false);
      state.food = [];
    }
  });

  test('stops spawning at the cap', () => {
    const state = running();
    place(state.bugs[0], 10, 10, { traits: { ...state.bugs[0].traits, behaviour: { ...state.bugs[0].traits.behaviour, speed: 15 } } });
    state.food = Array.from({ length: MAX_FOOD }, (_, i) => ({ id: `f${i}`, x: 300, y: 500, spawnedAtS: 0, expiresAtS: 1e6 }));
    state.foodTimerS = STEP_S / 2;
    stepSimulation(state);
    expect(state.food).toHaveLength(MAX_FOOD);
  });

  test('expires if nobody eats it', () => {
    const state = running();
    place(state.bugs[0], 20, 20);
    place(state.bugs[1], 40, 20);
    state.food = [{ id: 'old', x: 340, y: 500, spawnedAtS: 0, expiresAtS: state.timeS + 0.12 }];
    const events = run(state, 3);
    expect(state.food).toHaveLength(0);
    expect(events).toContainEqual({ type: 'food-expired', foodId: 'old' });
  });
});

describe('food seeking', () => {
  test('a bug heads for food it can sense and eats it', () => {
    const state = running();
    const [hunter, other] = state.bugs;
    place(hunter, 100, 100, { satiety: 50 });
    place(other, 330, 500);
    const food = { id: 'meal', x: 160, y: 140, spawnedAtS: 0, expiresAtS: 1e6 };
    state.food = [food];

    const before = distance(hunter, food);
    run(state, 10);
    const speed = hunter.traits.behaviour.speed;
    expect(before - distance(hunter, food)).toBeCloseTo(speed * 10 * STEP_S, 3);

    const events = run(state, 100);
    expect(events).toContainEqual({ type: 'ate', bugId: hunter.id, foodId: 'meal' });
    expect(state.food).toHaveLength(0);
    expect(hunter.foodEaten).toBe(1);
    expect(hunter.totalEaten).toBe(1);
    expect(hunter.satiety).toBeGreaterThan(50 + FOOD_SATIETY - 10);
  });

  test('a bug picks the nearest of several foods', () => {
    const state = running();
    const [hunter, other] = state.bugs;
    place(hunter, 100, 100);
    place(other, 330, 500);
    state.food = [
      { id: 'far', x: 100, y: 200, spawnedAtS: 0, expiresAtS: 1e6 },
      { id: 'near', x: 140, y: 100, spawnedAtS: 0, expiresAtS: 1e6 },
    ];
    stepSimulation(state);
    expect(hunter.targetFoodId).toBe('near');
    expect(hunter.heading).toBeCloseTo(0, 5);
  });

  test('a bug wanders when no food is in range, and stays in the habitat', () => {
    const state = running();
    const [wanderer] = state.bugs;
    place(wanderer, 5, 5);
    for (let i = 0; i < 400; i += 1) {
      stepSimulation(state);
      expect(wanderer.x).toBeGreaterThanOrEqual(0);
      expect(wanderer.x).toBeLessThanOrEqual(state.habitat.width);
      expect(wanderer.y).toBeGreaterThanOrEqual(0);
      expect(wanderer.y).toBeLessThanOrEqual(state.habitat.height);
      wanderer.satiety = 90;
    }
    expect(wanderer.targetFoodId).toBeNull();
  });

  test('a clearly more aggressive hungry bug chases a calmer one away', () => {
    const state = running();
    const [bully, timid] = state.bugs;
    bully.traits = { ...bully.traits, behaviour: { ...bully.traits.behaviour, aggression: 0.9 } };
    timid.traits = { ...timid.traits, behaviour: { ...timid.traits.behaviour, aggression: 0.1 } };
    place(bully, 100, 100, { satiety: 50 });
    place(timid, 100 + CONTACT_RADIUS / 2, 100);
    stepSimulation(state);
    expect(timid.fleeS).toBeGreaterThan(0);
    expect(bully.fleeS).toBe(0);
    expect(distance(bully, timid)).toBeGreaterThan(CONTACT_RADIUS / 2);
  });
});

describe('death', () => {
  test('a bug starves when its satiety runs out', () => {
    const state = running();
    const extra = { ...state.bugs[0], id: 'bug-extra' };
    state.bugs.push(extra);
    const [victim] = state.bugs;
    victim.satiety = 0.001;
    const events = stepSimulation(state);
    expect(events).toContainEqual(expect.objectContaining({ type: 'died', bugId: victim.id, cause: 'starvation' }));
    expect(state.bugs.find((bug) => bug.id === victim.id)).toBeUndefined();
    expect(state.stats.starvations).toBe(1);
  });

  test('a bug dies of old age at the end of its lifespan', () => {
    const state = running();
    state.bugs.push({ ...state.bugs[0], id: 'bug-extra' });
    const [elder] = state.bugs;
    elder.ageS = elder.traits.behaviour.lifespanS - STEP_S / 2;
    const events = stepSimulation(state);
    expect(events).toContainEqual(expect.objectContaining({ type: 'died', bugId: elder.id, cause: 'old-age' }));
    expect(state.stats.oldAgeDeaths).toBe(1);
  });

  test('hunger drains satiety every step, faster for faster bugs', () => {
    const state = running();
    const [slow, fast] = state.bugs;
    slow.traits = { ...slow.traits, behaviour: { ...slow.traits.behaviour, speed: 15 } };
    fast.traits = { ...fast.traits, behaviour: { ...fast.traits.behaviour, speed: 60, aggression: slow.traits.behaviour.aggression, hungerRate: slow.traits.behaviour.hungerRate } };
    place(slow, 50, 50, { satiety: 90 });
    place(fast, 300, 450, { satiety: 90 });
    run(state, 20);
    expect(slow.satiety).toBeLessThan(90);
    expect(fast.satiety).toBeLessThan(slow.satiety);
  });
});

describe('reproduction', () => {
  function readyParent(state: SimulationState): Bug {
    const [parent, other] = state.bugs;
    place(other, 330, 500);
    return place(parent, 100, 100, {
      satiety: 80,
      ageS: parent.traits.behaviour.lifespanS * MATURITY_FRACTION + 1,
      foodEaten: parent.traits.behaviour.foodForReproduction,
    });
  }

  test('a mature bug that has eaten enough lays one offspring', () => {
    const state = running();
    const parent = readyParent(state);
    const events = stepSimulation(state);
    const born = events.filter((event) => event.type === 'born');
    expect(born).toHaveLength(1);
    expect(state.bugs).toHaveLength(3);
    const child = state.bugs[2];
    expect(child.generation).toBe(2);
    expect(child.parentId).toBe(parent.id);
    expect(child.parentName).toBe(parent.name);
    expect(child.founderName).toBe(parent.founderName);
    expect(child.inherited).toEqual(parent.traits);
    expect(child.satiety).toBe(OFFSPRING_SATIETY);
    expect(distance(child, parent)).toBeLessThan(20);
    expect(parent.foodEaten).toBe(0);
    expect(parent.offspring).toBe(1);
    expect(parent.satiety).toBeLessThan(80);
    expect(state.stats.births).toBe(1);
    expect(state.stats.maxGeneration).toBe(2);
  });

  test('one food short of the threshold, nothing is born', () => {
    const state = running();
    const parent = readyParent(state);
    parent.foodEaten -= 1;
    expect(stepSimulation(state).some((event) => event.type === 'born')).toBe(false);
  });

  test('an immature bug waits until it grows up', () => {
    const state = running();
    const parent = readyParent(state);
    parent.ageS = 0;
    expect(stepSimulation(state).some((event) => event.type === 'born')).toBe(false);
  });
});

describe('inheritance', () => {
  const parent = defaultStarterTraits()[0];

  test('behaviour changes by at most one mutation step and stays in range', () => {
    const rng = new Random(11);
    for (let i = 0; i < 1000; i += 1) {
      const { traits } = inheritTraits(parent, rng);
      for (const key of BEHAVIOUR_KEYS) {
        const spec = BEHAVIOUR_SPECS[key];
        const value = traits.behaviour[key];
        expect(value).toBeGreaterThanOrEqual(spec.min);
        expect(value).toBeLessThanOrEqual(spec.max);
        expect(Math.abs(value - parent.behaviour[key])).toBeLessThanOrEqual(spec.integer ? 1 : spec.mutation + 1e-9);
        if (spec.integer) expect(Number.isInteger(value)).toBe(true);
      }
    }
  });

  test('visual mutations are rare, small, and never change shape, eyes or horns', () => {
    const rng = new Random(12);
    const trials = 4000;
    let mutations = 0;
    for (let i = 0; i < trials; i += 1) {
      const { traits, visualMutation } = inheritTraits(parent, rng);
      const { visual } = traits;
      expect([visual.body, visual.eyes, visual.horns, visual.palette]).toEqual([parent.visual.body, parent.visual.eyes, parent.visual.horns, parent.visual.palette]);
      if (!visualMutation) {
        expect(visual).toEqual(parent.visual);
        continue;
      }
      mutations += 1;
      const hueChanged = visual.hueShift !== parent.visual.hueShift;
      const featureChanged = visual.feature !== parent.visual.feature;
      expect(hueChanged !== featureChanged).toBe(true);
      expect(Math.abs(visual.hueShift)).toBeLessThanOrEqual(HUE_SHIFT_LIMIT);
      expect(Math.abs(FEATURES.indexOf(visual.feature) - FEATURES.indexOf(parent.visual.feature))).toBeLessThanOrEqual(1);
    }
    expect(mutations / trials).toBeGreaterThan(0.02);
    expect(mutations / trials).toBeLessThan(0.07);
  });

  test('hue drift stays within its limit over many generations', () => {
    const rng = new Random(13);
    let traits = parent;
    for (let i = 0; i < 3000; i += 1) {
      traits = inheritTraits(traits, rng).traits;
      expect(Math.abs(traits.visual.hueShift)).toBeLessThanOrEqual(HUE_SHIFT_LIMIT);
    }
  });
});

describe('ecosystem end and restart', () => {
  test('dropping below two bugs ends the ecosystem without inventing a bug', () => {
    const state = running();
    const [doomed, survivor] = state.bugs;
    doomed.satiety = 0.001;
    place(survivor, 300, 400);
    const events = stepSimulation(state);
    expect(events).toContainEqual({ type: 'ecosystem-ended', survivors: 1 });
    expect(state.status).toBe('ended');
    expect(state.bugs).toEqual([survivor]);
    expect(state.endedAtS).toBe(state.timeS);

    const frozen = JSON.stringify(state);
    expect(run(state, 50)).toEqual([]);
    expect(JSON.stringify(state)).toBe(frozen);
  });

  test('restarting returns to the workshop for a new starter pair', () => {
    const state = running();
    run(state, 100);
    state.bugs = state.bugs.slice(0, 1);
    stepSimulation(state);
    expect(state.status).toBe('ended');

    restartEcosystem(state);
    expect(state.status).toBe('workshop');
    expect(state.ecosystem).toBe(2);
    expect(state.bugs).toEqual([]);
    expect(state.food).toEqual([]);
    expect(state.timeS).toBe(0);
    expect(stepSimulation(state)).toEqual([]);

    releaseStarters(state, rollStarterTraits(state));
    expect(state.status).toBe('running');
    expect(state.bugs).toHaveLength(2);
  });

  test('starters can only be released from the workshop', () => {
    const state = running();
    expect(() => releaseStarters(state, defaultStarterTraits())).toThrow();
  });
});

describe('pause', () => {
  test('a paused ecosystem does not advance, and resumes where it stopped', () => {
    const state = running();
    run(state, 20);
    setPaused(state, true);
    const snapshot = JSON.stringify(state);
    expect(run(state, 100)).toEqual([]);
    expect(JSON.stringify(state)).toBe(snapshot);

    setPaused(state, false);
    const before = state.timeS;
    run(state, 10);
    expect(state.timeS).toBeCloseTo(before + 10 * STEP_S, 9);
  });

  test('pausing does nothing outside a running ecosystem', () => {
    const state = createSimulation(3);
    setPaused(state, true);
    expect(state.paused).toBe(false);
  });
});

describe('long run', () => {
  test('a default ecosystem breeds, ages and dies within a few minutes', () => {
    const state = createSimulation(21);
    releaseStarters(state, defaultStarterTraits());
    const events = run(state, (5 * 60) / STEP_S);
    expect(events.some((event) => event.type === 'born')).toBe(true);
    expect(events.some((event) => event.type === 'died')).toBe(true);
    expect(state.stats.maxGeneration).toBeGreaterThan(1);
  });
});

describe('screen-shaped habitats', () => {
  test('a habitat takes the screen\'s proportions at a fixed width', () => {
    expect(habitatForScreen(402, 874)).toEqual({ width: 360, height: 783 });
    expect(habitatForScreen(428, 926)).toEqual({ width: 360, height: 779 });
  });

  test('a taller habitat gets proportionally more food, sooner', () => {
    const tall = habitatForScreen(402, 874);
    expect(maxFood(DEFAULT_HABITAT)).toBe(MAX_FOOD);
    expect(maxFood(tall)).toBe(Math.round(MAX_FOOD * 783 / 520));
    expect(foodSpawnIntervalS(tall)).toBeCloseTo(FOOD_SPAWN_INTERVAL_S * 520 / 783, 9);
  });

  test('resizing keeps bugs and food in the same relative place', () => {
    const state = running();
    const [bug] = state.bugs;
    place(bug, 180, 260);
    state.food = [{ id: 'f', x: 90, y: 130, spawnedAtS: 0, expiresAtS: 1e6 }];
    resizeHabitat(state, { width: 360, height: 780 });
    expect(state.habitat).toEqual({ width: 360, height: 780 });
    expect([bug.x, bug.y]).toEqual([180, 390]);
    expect([state.food[0].x, state.food[0].y]).toEqual([90, 195]);
  });
});
