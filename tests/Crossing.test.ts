import {
  CrossingLink,
  crossingLanding,
  crossingPoses,
  facingEdge,
  FIXED_JOIN_HEADING,
  HabitatLayout,
  habitatToScreen,
  openGates,
  parseCrossingMessage,
  screenToTable,
  serializeCrossingMessage,
  withFacing,
} from '../src/game/crossing';
import {
  admitBug,
  canAdmit,
  createSimulation,
  defaultStarterTraits,
  habitatForScreen,
  MAX_POPULATION,
  releaseStarters,
  STEP_S,
  stepSimulation,
} from '../src/game/Simulation';
import { SimulationDriver } from '../src/game/SimulationDriver';
import { Bug, SimulationEvent, SimulationState } from '../src/game/types';
import { BEZEL_MM, computeStitch, POINTS_PER_MM, ScreenPose, ScreenSize, serializeStitchMessage, Stitch, SwipeReport, tableToScreen } from '../src/spatial/Stitch';

const SCREEN: ScreenSize = { widthPt: 402, heightPt: 874 };
const HALF_WIDTH_MM = SCREEN.widthPt / POINTS_PER_MM / 2;
/** A habitat drawn the way the ecosystem screen lays it out: full width less margins, below the header. */
const LAYOUT: HabitatLayout = {
  screen: SCREEN,
  field: { xPt: 16, yPt: 150, widthPt: 370, heightPt: 534 },
  habitat: { width: 360, height: 520 },
};

/** A running ecosystem with three bugs, no food and none due, so movement is all that happens. */
function running(): SimulationState {
  const state = createSimulation(17);
  releaseStarters(state, defaultStarterTraits());
  state.bugs.push({ ...state.bugs[0], id: 'bug-third', name: 'Third' });
  state.food = [];
  state.foodTimerS = 1e6;
  state.bugs.forEach((bug, index) => Object.assign(bug, { x: 100, y: 100 + index * 150, satiety: 90, fleeS: 0, wanderTurn: 0 }));
  return state;
}

/** Joins two phones lying side by side, B turned `turnRad` against A, by a straight swipe from A to B. */
function sideBySide(turnRad = 0): Stitch {
  const base = { headingRad: FIXED_JOIN_HEADING, frameId: null, speedMmPerS: 300 };
  const exit: SwipeReport = { ...base, kind: 'exit', role: 'A', edge: 'right', pointMm: { x: HALF_WIDTH_MM, y: 0 }, directionRad: 0, atMs: 1000 };
  // B's screen turned by `turnRad` sees the same physical direction turned back by it.
  const entryEdgePoint = turnRad === 0 ? { x: -HALF_WIDTH_MM, y: 0 } : { x: HALF_WIDTH_MM, y: 0 };
  const entry: SwipeReport = { ...base, kind: 'entry', role: 'B', edge: turnRad === 0 ? 'left' : 'right', pointMm: entryEdgePoint, directionRad: -turnRad, atMs: 1100 };
  const result = computeStitch(exit, entry, 1100);
  if (!result.stitch) throw new Error(result.reason);
  return result.stitch;
}

function link(stitch: Stitch, role: 'A' | 'B'): CrossingLink {
  return { ...crossingPoses(stitch, role), ownLayout: LAYOUT, otherLayout: LAYOUT };
}

const angleBetween = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

describe('open walls in the simulation', () => {
  test('a bug walking through an open wall departs and leaves the ecosystem', () => {
    const state = running();
    const [walker] = state.bugs;
    Object.assign(walker, { x: state.habitat.width - 7, y: 200, heading: 0 });
    const events = stepSimulation(state, { canExit: (_, edge) => edge === 'right' });
    const departed = events.find((event): event is Extract<SimulationEvent, { type: 'departed' }> => event.type === 'departed');
    expect(departed?.bug.id).toBe(walker.id);
    expect(departed?.edge).toBe('right');
    expect(departed?.x).toBe(state.habitat.width);
    expect(departed?.y).toBeCloseTo(200, 0);
    expect(state.bugs.map((bug) => bug.id)).not.toContain(walker.id);
    expect(state.status).toBe('running');
  });

  test('closed walls still bounce', () => {
    const state = running();
    const [walker] = state.bugs;
    Object.assign(walker, { x: state.habitat.width - 7, y: 200, heading: 0 });
    expect(stepSimulation(state, { canExit: (_, edge) => edge === 'left' }).some((event) => event.type === 'departed')).toBe(false);
    expect(stepSimulation(state).some((event) => event.type === 'departed')).toBe(false);
    expect(state.bugs).toContain(walker);
    expect(Math.cos(walker.heading)).toBeLessThan(0);
  });

  test('the last two bugs never leave, so crossing cannot end an ecosystem', () => {
    const state = running();
    state.bugs.forEach((bug) => Object.assign(bug, { x: state.habitat.width - 7, heading: 0 }));
    const events = stepSimulation(state, { canExit: () => true });
    expect(events.filter((event) => event.type === 'departed')).toHaveLength(1);
    expect(state.bugs).toHaveLength(2);
    expect(stepSimulation(state, { canExit: () => true }).some((event) => event.type === 'departed')).toBe(false);
    expect(state.status).toBe('running');
  });

  test('the driver passes its exit check to every step', () => {
    const state = running();
    const [walker] = state.bugs;
    Object.assign(walker, { x: state.habitat.width - 7, y: 200, heading: 0 });
    const saves: number[] = [];
    const driver = new SimulationDriver(state, () => saves.push(1));
    driver.setExitCheck(() => true);
    const events = driver.advance(STEP_S);
    expect(events.some((event) => event.type === 'departed')).toBe(true);
    expect(saves).toHaveLength(1);
    driver.setExitCheck(null);
    Object.assign(state.bugs[0], { x: state.habitat.width - 7, heading: 0 });
    expect(driver.advance(STEP_S).some((event) => event.type === 'departed')).toBe(false);
  });
});

describe('admitting bugs', () => {
  const visitor = (state: SimulationState): Bug => ({ ...state.bugs[0], id: 'bug-1', name: 'Visitor', generation: 7 });

  test('an arriving bug gets a fresh id and keeps everything else', () => {
    const state = running();
    const before = state.bugs.map((bug) => bug.id);
    const guest = visitor(state);
    const admitted = admitBug(state, guest, { x: 5, y: 300 }, 0.5);
    expect(before).not.toContain(admitted.id);
    expect(admitted.name).toBe('Visitor');
    expect(admitted.traits).toEqual(guest.traits);
    expect(admitted.x).toBeGreaterThan(5);
    expect(admitted.y).toBe(300);
    expect(admitted.heading).toBeCloseTo(0.5, 9);
    expect(state.stats.maxGeneration).toBe(7);
  });

  test('only a running, unpaused ecosystem with room takes visitors', () => {
    const state = running();
    expect(canAdmit(state)).toBe(true);
    state.paused = true;
    expect(canAdmit(state)).toBe(false);
    state.paused = false;
    state.bugs = Array.from({ length: MAX_POPULATION }, (_, i) => ({ ...state.bugs[0], id: `b${i}` }));
    expect(canAdmit(state)).toBe(false);
    expect(canAdmit(createSimulation(1))).toBe(false);
  });
});

describe('crossing geometry', () => {
  test('the join places B beside A, across both bezels', () => {
    const { own, other } = crossingPoses(sideBySide(), 'A');
    expect(own.centreMm).toEqual({ x: 0, y: 0 });
    expect(other.centreMm.x).toBeCloseTo(2 * HALF_WIDTH_MM + 2 * BEZEL_MM, 6);
    expect(other.centreMm.y).toBeCloseTo(0, 6);
  });

  test('screen and table conversions are inverses', () => {
    const { other } = crossingPoses(sideBySide(Math.PI / 2), 'A');
    const point = { xPt: 123, yPt: 456 };
    const back = tableToScreen(screenToTable(point, other, SCREEN), other, SCREEN);
    expect(back.xPt).toBeCloseTo(point.xPt, 6);
    expect(back.yPt).toBeCloseTo(point.yPt, 6);
  });

  test('a bug leaving A on the right arrives on B on the left, at the same height and heading', () => {
    const landing = crossingLanding(link(sideBySide(), 'A'), { x: 360, y: 260 }, 'right', 0.2);
    expect(landing).not.toBeNull();
    expect(landing!.x).toBeLessThan(20);
    expect(landing!.y).toBeCloseTo(260, 0);
    expect(landing!.heading).toBeCloseTo(0.2, 6);
  });

  test('a bug heading along the wall is turned to walk in', () => {
    const landing = crossingLanding(link(sideBySide(), 'A'), { x: 360, y: 260 }, 'right', Math.PI / 2 - 0.05);
    expect(angleBetween(landing!.heading, 0)).toBeLessThan(1e-6);
  });

  test('walls that face away from the other phone stay closed', () => {
    const a = link(sideBySide(), 'A');
    expect(crossingLanding(a, { x: 0, y: 260 }, 'left', Math.PI)).toBeNull();
    expect(crossingLanding(a, { x: 180, y: 0 }, 'top', -Math.PI / 2)).toBeNull();
    expect(crossingLanding(a, { x: 180, y: 520 }, 'bottom', Math.PI / 2)).toBeNull();
  });

  test('B can send bugs back, and a round trip ends where it started', () => {
    const stitch = sideBySide();
    const there = crossingLanding(link(stitch, 'A'), { x: 360, y: 300 }, 'right', 0)!;
    const back = crossingLanding(link(stitch, 'B'), { x: 0, y: there.y }, 'left', Math.PI)!;
    expect(back).not.toBeNull();
    expect(back.x).toBeGreaterThan(340);
    expect(back.y).toBeCloseTo(300, 0);
    expect(angleBetween(back.heading, Math.PI)).toBeLessThan(1e-6);
  });

  test('with B turned upside down, its right edge meets A and directions flip', () => {
    const stitch = sideBySide(Math.PI);
    const landing = crossingLanding(link(stitch, 'A'), { x: 360, y: 150 }, 'right', 0)!;
    expect(landing).not.toBeNull();
    expect(landing.x).toBeGreaterThan(340);
    // Upside down, a point above A's screen centre is the same distance below B's.
    const { field } = LAYOUT;
    const exitYPt = field.yPt + (150 / 520) * field.heightPt;
    const mirroredYPt = SCREEN.heightPt - exitYPt;
    expect(landing.y).toBeCloseTo(((mirroredYPt - field.yPt) / field.heightPt) * 520, 0);
    expect(angleBetween(landing.heading, Math.PI)).toBeLessThan(1e-6);
    expect(crossingLanding(link(stitch, 'B'), { x: 360, y: 300 }, 'right', 0)).not.toBeNull();
    expect(crossingLanding(link(stitch, 'B'), { x: 0, y: 300 }, 'left', Math.PI)).toBeNull();
  });

  test('gates cover the right wall of A and nothing else', () => {
    const gates = openGates(link(sideBySide(), 'A'));
    expect(gates).toHaveLength(1);
    expect(gates[0].edge).toBe('right');
    expect(gates[0].from).toBe(0);
    expect(gates[0].to).toBe(520);
  });

  test('a habitat placed lower on the other phone only opens where the two overlap', () => {
    const lower: HabitatLayout = { ...LAYOUT, field: { ...LAYOUT.field, yPt: 450 } };
    const gates = openGates({ ...crossingPoses(sideBySide(), 'A'), ownLayout: LAYOUT, otherLayout: lower });
    expect(gates).toHaveLength(1);
    const overlapStart = ((450 - LAYOUT.field.yPt) / LAYOUT.field.heightPt) * 520;
    expect(Math.abs(gates[0].from - overlapStart)).toBeLessThanOrEqual(4);
    expect(gates[0].to).toBe(520);
  });

  test('habitat and screen points line up with the drawn field', () => {
    expect(habitatToScreen({ x: 0, y: 0 }, LAYOUT)).toEqual({ xPt: 16, yPt: 150 });
    expect(habitatToScreen({ x: 360, y: 520 }, LAYOUT)).toEqual({ xPt: 386, yPt: 684 });
  });
});

describe('crossing messages', () => {
  const bug = (): Bug => {
    const state = running();
    return state.bugs[0];
  };

  test('every message round-trips', () => {
    const messages = [
      { type: 'layout' as const, layout: LAYOUT },
      { type: 'layout' as const, layout: null },
      { type: 'bug' as const, transferId: 't1', bug: bug(), landing: { x: 10, y: 20, heading: 1 } },
      { type: 'bug-ack' as const, transferId: 't1', accepted: false },
    ];
    for (const message of messages) expect(parseCrossingMessage(serializeCrossingMessage(message))).toEqual(message);
  });

  test('malformed or foreign messages are ignored', () => {
    expect(parseCrossingMessage('nope')).toBeNull();
    expect(parseCrossingMessage(serializeStitchMessage({ type: 'join' }))).toBeNull();
    const broken = JSON.parse(serializeCrossingMessage({ type: 'bug', transferId: 't', bug: bug(), landing: { x: 1, y: 2, heading: 0 } }));
    broken.message.bug.traits.visual.body = 'dragon';
    expect(parseCrossingMessage(JSON.stringify(broken))).toBeNull();
    const noLanding = JSON.parse(serializeCrossingMessage({ type: 'bug', transferId: 't', bug: bug(), landing: { x: 1, y: 2, heading: 0 } }));
    delete noLanding.message.landing;
    expect(parseCrossingMessage(JSON.stringify(noLanding))).toBeNull();
    const badLayout = JSON.parse(serializeCrossingMessage({ type: 'layout', layout: LAYOUT }));
    badLayout.message.layout.field.widthPt = 0;
    expect(parseCrossingMessage(JSON.stringify(badLayout))).toBeNull();
  });
});

describe('full-screen habitats on the two test phones', () => {
  const IPHONE_17: ScreenSize = { widthPt: 402, heightPt: 874 };
  const IPHONE_14_PLUS: ScreenSize = { widthPt: 428, heightPt: 926 };
  const fullScreen = (screen: ScreenSize): HabitatLayout => ({
    screen,
    field: { xPt: 0, yPt: 0, ...screen },
    habitat: habitatForScreen(screen.widthPt, screen.heightPt),
  });
  const A = fullScreen(IPHONE_17);
  const B = fullScreen(IPHONE_14_PLUS);

  /** A swipe straight across from A's right edge into B's left edge, centres level, `gapMm` between the screens. */
  function joined(gapMm = 2 * BEZEL_MM) {
    const base = { headingRad: FIXED_JOIN_HEADING, frameId: null, speedMmPerS: 300, directionRad: 0 };
    const exit: SwipeReport = { ...base, kind: 'exit', role: 'A', edge: 'right', pointMm: { x: IPHONE_17.widthPt / POINTS_PER_MM / 2, y: 0 }, atMs: 0 };
    const entry: SwipeReport = { ...base, kind: 'entry', role: 'B', edge: 'left', pointMm: { x: -IPHONE_14_PLUS.widthPt / POINTS_PER_MM / 2, y: 0 }, atMs: 50 };
    const result = computeStitch(exit, entry, 50, gapMm / 2);
    if (!result.stitch) throw new Error(result.reason);
    return {
      a: { ...crossingPoses(result.stitch, 'A'), ownLayout: A, otherLayout: B },
      b: { ...crossingPoses(result.stitch, 'B'), ownLayout: B, otherLayout: A },
    };
  }

  test('a bug has to reach the very edge of the screen to cross', () => {
    const { a } = joined();
    const { width, height } = A.habitat;
    expect(crossingLanding(a, { x: width, y: height / 2 }, 'right', 0)).not.toBeNull();
    // The walls are the screen's edges: there is no margin left to walk into.
    expect(habitatToScreen({ x: width, y: height / 2 }, A).xPt).toBe(IPHONE_17.widthPt);
  });

  test("the shorter phone's whole edge opens; the taller one opens only where the other phone is", () => {
    const { a, b } = joined();
    const gatesA = openGates(a);
    expect(gatesA).toEqual([{ edge: 'right', from: 0, to: A.habitat.height }]);

    const gatesB = openGates(b);
    expect(gatesB).toHaveLength(1);
    expect(gatesB[0].edge).toBe('left');
    // B's screen is about 4.3 mm taller above and below A's.
    const overhang = ((IPHONE_14_PLUS.heightPt - IPHONE_17.heightPt) / 2 / IPHONE_14_PLUS.heightPt) * B.habitat.height;
    expect(Math.abs(gatesB[0].from - overhang)).toBeLessThanOrEqual(4);
    expect(Math.abs(B.habitat.height - gatesB[0].to - overhang)).toBeLessThanOrEqual(4);
  });

  test('phones a few centimetres apart do not connect', () => {
    const { a } = joined(30);
    expect(openGates(a)).toEqual([]);
  });

  test('a crossing keeps the bug at the same height on the table', () => {
    const { a } = joined();
    const landing = crossingLanding(a, { x: A.habitat.width, y: A.habitat.height * 0.25 }, 'right', 0)!;
    const leftAt = screenToTable(habitatToScreen({ x: A.habitat.width, y: A.habitat.height * 0.25 }, A), a.own, IPHONE_17);
    const arrivedAt = screenToTable(habitatToScreen(landing, B), a.other, IPHONE_14_PLUS);
    expect(arrivedAt.y).toBeCloseTo(leftAt.y, 0);
  });
});

describe('only the wall facing the other phone opens', () => {
  const pose = (x: number, y: number, headingRad = Math.PI / 2): ScreenPose => ({ centreMm: { x, y }, headingRad, screenSizeCm: { width: 7, height: 15 } });
  const facing = (x: number, y: number) => facingEdge({ own: pose(0, 0), other: pose(x, y) });

  test('the wall is the side along which the screens are adjacent', () => {
    expect(facing(80, 0)).toBe('right');
    expect(facing(-80, 0)).toBe('left');
    expect(facing(0, 170)).toBe('top');
    expect(facing(0, -170)).toBe('bottom');
    expect(facing(80, 100)).toBe('right');
    expect(facing(50, 140)).toBe('top');
  });

  test('turning this phone turns the facing wall with it', () => {
    // Heading is where the screen's top points; with the top pointing along -x, up the table is the screen's right.
    expect(facingEdge({ own: pose(0, 0, Math.PI), other: pose(0, 170, Math.PI) })).toBe('right');
  });

  test('crossing is limited to that wall and to the link\'s own reach', () => {
    const stitch = sideBySide();
    const a = withFacing(link(stitch, 'A'));
    const mid = { x: LAYOUT.habitat.width, y: LAYOUT.habitat.height / 2 };
    expect(a.facing).toBe('right');
    expect(withFacing(link(stitch, 'B')).facing).toBe('left');
    expect(crossingLanding(a, mid, 'right', 0)).not.toBeNull();
    expect(crossingLanding({ ...a, facing: 'left' }, mid, 'right', 0)).toBeNull();
    expect(crossingLanding({ ...a, maxGapMm: 1 }, mid, 'right', 0)).toBeNull();
  });
});
