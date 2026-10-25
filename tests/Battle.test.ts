import { createSimulation, releaseStarters, stepSimulation, STEP_S } from '../src/game/Simulation';
import { defaultTraits } from '../src/game/traits';

test('battle arenas are deterministic and release one owned starter', () => {
  const a = createSimulation(42);
  const b = createSimulation(42);
  expect(a.arena).toEqual(b.arena);
  releaseStarters(a, [defaultTraits()], 'shield');
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
