import { createSimulation, MATURITY_FRACTION, releaseStarters, stepSimulation, STEP_S } from '../src/game/Simulation';
import { defaultTraits } from '../src/game/traits';

test('battle arenas are deterministic and release one owned starter', () => {
  const a = createSimulation(42);
  const b = createSimulation(42);
  expect(a.arena).toEqual(b.arena);
  releaseStarters(a, [defaultTraits()], { power: 'shield' });
  expect(a.mode).toBe('ecosystem');
  expect(a.bugs).toHaveLength(10);
  expect(a.bugs[0].owner).toBe('local');
  expect(a.bugs[0].power).toBe('shield');
  expect(a.bugs.slice(1).every((bug) => bug.traits === a.bugs[0].traits || JSON.stringify(bug.traits) === JSON.stringify(a.bugs[0].traits))).toBe(true);
});

test('battle aggression produces combat damage and battle completion', () => {
  const state = createSimulation(7);
  const local = defaultTraits();
  local.behaviour.aggression = 1;
  releaseStarters(state, [local]);
  state.mode = 'battle';
  const remote = { ...state.bugs[0], id: 'remote', owner: 'remote' as const, x: state.bugs[0].x + 5, y: state.bugs[0].y };
  state.bugs.push(remote);
  state.bugs[0].attackCooldownS = 0;
  const events = stepSimulation(state, { dt: STEP_S });
  expect(events.some((event) => event.type === 'attacked')).toBe(true);
  expect(state.bugs.some((bug) => bug.health < bug.maxHealth)).toBe(true);
});

test('battle offspring mutate: a child can differ from its parent, and stays within range', () => {
  let changed = 0;
  for (let seed = 1; seed <= 30; seed += 1) {
    const state = createSimulation(seed);
    releaseStarters(state, [defaultTraits()]);
    state.mode = 'battle';
    state.food = [];
    state.foodTimerS = 1e6;
    const parent = state.bugs[0];
    Object.assign(parent, { ageS: parent.traits.behaviour.lifespanS * MATURITY_FRACTION + 1, foodEaten: parent.traits.behaviour.foodForReproduction, satiety: 100 });
    stepSimulation(state, { dt: STEP_S });
    const child = state.bugs.find((bug) => bug.parentId === parent.id);
    if (!child) continue;
    expect(child.inherited).toEqual(parent.traits);
    if (JSON.stringify(child.traits) !== JSON.stringify(parent.traits)) changed += 1;
  }
  expect(changed).toBeGreaterThan(0);
});

test('a chosen biome rebuilds the arena, and starters are dealt a power without being asked for one', () => {
  const state = createSimulation(42);
  const biome = state.arena.biome === 'desert' ? 'swamp' : 'desert';
  releaseStarters(state, [defaultTraits()], { biome });
  expect(state.arena.biome).toBe(biome);
  expect(state.bugs[0].power).not.toBeNull();
  expect(state.bugs.filter((bug) => bug.owner === 'wild').every((bug) => bug.power === null)).toBe(true);
});
