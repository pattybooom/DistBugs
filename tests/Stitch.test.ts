import {
  ANTENNA_FROM_CENTRE_CM,
  BEZEL_MM,
  classifySwipe,
  computeStitch,
  matchSwipes,
  MovedApartCheck,
  parseStitchMessage,
  PointMm,
  POINTS_PER_MM,
  predictedAntennaDistanceCm,
  ScreenPose,
  screenPoses,
  ScreenSize,
  serializeStitchMessage,
  stitchedLayout,
  SwipeReport,
  tableToScreen,
  TouchSample,
} from '../src/spatial/Stitch';
import { wrapAngle } from '../src/spatial/SpatialMath';

const IPHONE_17: ScreenSize = { widthPt: 402, heightPt: 874 };
const IPHONE_14_PLUS: ScreenSize = { widthPt: 428, heightPt: 926 };
const DEG = Math.PI / 180;

/** A phone's screen on the table: centre in mm in Phone A's motion frame, heading of its top edge. */
type Pose = { x: number; y: number; heading: number; screen: ScreenSize };

const rotate = ({ x, y }: PointMm, angle: number): PointMm => ({
  x: x * Math.cos(angle) - y * Math.sin(angle),
  y: x * Math.sin(angle) + y * Math.cos(angle),
});

/** Screen +x lies a quarter turn clockwise of the top edge. */
const screenToWorld = (point: PointMm, pose: Pose): PointMm => {
  const turned = rotate(point, pose.heading - Math.PI / 2);
  return { x: pose.x + turned.x, y: pose.y + turned.y };
};

const worldToTouch = (point: PointMm, pose: Pose): { xPt: number; yPt: number } => {
  const local = rotate({ x: point.x - pose.x, y: point.y - pose.y }, Math.PI / 2 - pose.heading);
  return { xPt: local.x * POINTS_PER_MM + pose.screen.widthPt / 2, yPt: pose.screen.heightPt / 2 - local.y * POINTS_PER_MM };
};

const onScreen = ({ xPt, yPt }: { xPt: number; yPt: number }, screen: ScreenSize) =>
  xPt >= 0 && xPt <= screen.widthPt && yPt >= 0 && yPt <= screen.heightPt;

/** Deterministic jitter so the tests do not depend on Math.random. */
const jitter = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648 - 0.5;
  };
};

/**
 * Builds Phone B's pose so that a straight swipe leaving A's right edge at `exitYMm`, in
 * direction `swipeRad` (A's screen frame), crosses both bezels and enters B's left edge at
 * `entryYMm`, with B's screen turned `turnRad` against A's.
 */
function layout({ headingA = 40 * DEG, exitYMm = 10, entryYMm = -5, swipeRad = 0, turnRad = 0 } = {}) {
  const phoneA: Pose = { x: 0, y: 0, heading: headingA, screen: IPHONE_17 };
  const exitInA = { x: IPHONE_17.widthPt / POINTS_PER_MM / 2, y: exitYMm };
  const direction = { x: Math.cos(swipeRad), y: Math.sin(swipeRad) };
  const entryInA = { x: exitInA.x + direction.x * 2 * BEZEL_MM, y: exitInA.y + direction.y * 2 * BEZEL_MM };
  const entryInB = rotate({ x: -IPHONE_14_PLUS.widthPt / POINTS_PER_MM / 2, y: entryYMm }, turnRad);
  const centreB = screenToWorld({ x: entryInA.x - entryInB.x, y: entryInA.y - entryInB.y }, phoneA);
  const phoneB: Pose = { x: centreB.x, y: centreB.y, heading: headingA + turnRad, screen: IPHONE_14_PLUS };
  return { phoneA, phoneB, start: screenToWorld({ x: exitInA.x - 40 * direction.x, y: exitInA.y - 40 * direction.y }, phoneA), end: screenToWorld({ x: entryInA.x + 40 * direction.x, y: entryInA.y + 40 * direction.y }, phoneA) };
}

/** Samples a finger moving at `speedMmPerS` every 8 ms; each phone sees only the samples over its own screen. */
function swipe(from: PointMm, to: PointMm, poses: Pose[], { speedMmPerS = 300, noiseMm = 0, seed = 1 } = {}) {
  const next = jitter(seed);
  const lengthMm = Math.hypot(to.x - from.x, to.y - from.y);
  const stepMm = (speedMmPerS * 8) / 1000;
  const trails: { samples: TouchSample[]; firstMs: number; lastMs: number }[] = poses.map(() => ({ samples: [], firstMs: NaN, lastMs: NaN }));
  // Start partway into a step so samples do not land exactly on a screen edge.
  for (let travelled = stepMm * 0.37, tMs = 1000; travelled <= lengthMm; travelled += stepMm, tMs += 8) {
    const fraction = travelled / lengthMm;
    const finger = { x: from.x + (to.x - from.x) * fraction + next() * 2 * noiseMm, y: from.y + (to.y - from.y) * fraction + next() * 2 * noiseMm };
    poses.forEach((pose, index) => {
      const touch = worldToTouch(finger, pose);
      if (!onScreen(touch, pose.screen)) return;
      const trail = trails[index];
      if (trail.samples.length === 0) trail.firstMs = tMs;
      trail.lastMs = tMs;
      trail.samples.push({ ...touch, tMs });
    });
  }
  return trails;
}

/** Each phone reads its own trail; B's own motion frame is turned `frameOffsetB` against A's. */
function reportsFor(poses: Pose[], trails: ReturnType<typeof swipe>, frameOffsetB = 1.1): SwipeReport[] {
  const roles = ['A', 'B'] as const;
  return poses.flatMap((pose, index) => {
    const { exit, entry } = classifySwipe(trails[index].samples, pose.screen);
    const base = { role: roles[index], headingRad: index === 0 ? pose.heading : wrapAngle(pose.heading - frameOffsetB), frameId: 7 };
    return [
      ...(exit ? [{ ...exit, ...base, kind: 'exit' as const, atMs: trails[index].lastMs }] : []),
      ...(entry ? [{ ...entry, ...base, kind: 'entry' as const, atMs: trails[index].firstMs }] : []),
    ];
  });
}

function joinError(options: Parameters<typeof layout>[0], swipeOptions: Parameters<typeof swipe>[3] = {}, reverse = false) {
  const { phoneA, phoneB, start, end } = layout(options);
  const poses = [phoneA, phoneB];
  const trails = reverse ? swipe(end, start, poses, swipeOptions) : swipe(start, end, poses, swipeOptions);
  const reports = reportsFor(poses, trails);
  const match = matchSwipes(reports);
  expect(match).not.toBeNull();
  const result = computeStitch(match!.exit, match!.entry, 5000);
  expect(result.reason).toBeUndefined();
  const placed = stitchedLayout(result.stitch!, phoneA.heading, wrapAngle(phoneB.heading - 1.1));
  return {
    stitch: result.stitch!,
    positionErrorMm: Math.hypot(placed.position.xCm! * 10 - phoneB.x, placed.position.yCm! * 10 - phoneB.y),
    headingErrorRad: Math.abs(wrapAngle(placed.headingB! - phoneB.heading)),
  };
}

describe('classifySwipe', () => {
  const screen = IPHONE_17;
  const widthMm = screen.widthPt / POINTS_PER_MM;
  const line = (fromMm: PointMm, toMm: PointMm, count: number, durationMs: number): TouchSample[] =>
    Array.from({ length: count }, (_, index) => {
      const fraction = index / (count - 1);
      return {
        xPt: (fromMm.x + (toMm.x - fromMm.x) * fraction) * POINTS_PER_MM + screen.widthPt / 2,
        yPt: screen.heightPt / 2 - (fromMm.y + (toMm.y - fromMm.y) * fraction) * POINTS_PER_MM,
        tMs: fraction * durationMs,
      };
    });

  test('follows a swipe that stops short of the edge out to the edge', () => {
    const { exit, entry } = classifySwipe(line({ x: 0, y: 0 }, { x: widthMm / 2 - 6, y: 0 }, 12, 150), screen);
    expect(exit?.edge).toBe('right');
    expect(exit?.pointMm.x).toBeCloseTo(widthMm / 2);
    expect(exit?.pointMm.y).toBeCloseTo(0);
    expect(entry).toBeNull();
  });

  test('reads an arrival from the left edge, travelling right', () => {
    const { exit, entry } = classifySwipe(line({ x: -widthMm / 2 + 3, y: 20 }, { x: 0, y: 20 }, 12, 150), screen);
    expect(entry?.edge).toBe('left');
    expect(entry?.pointMm.x).toBeCloseTo(-widthMm / 2);
    expect(entry?.directionRad).toBeCloseTo(0);
    expect(exit).toBeNull();
  });

  test('ignores a swipe that ends in the middle of the screen', () => {
    expect(classifySwipe(line({ x: -10, y: 0 }, { x: 10, y: 0 }, 12, 150), screen)).toEqual({ exit: null, entry: null });
  });

  test('ignores a finger lifted slowly near an edge', () => {
    expect(classifySwipe(line({ x: widthMm / 2 - 30, y: 0 }, { x: widthMm / 2 - 4, y: 0 }, 40, 2000), screen).exit).toBeNull();
  });

  test('ignores a swipe running along an edge rather than across it', () => {
    const { exit, entry } = classifySwipe(line({ x: widthMm / 2 - 4, y: -30 }, { x: widthMm / 2 - 4, y: 30 }, 20, 200), screen);
    expect(exit).toBeNull();
    expect(entry).toBeNull();
  });
});

describe('swipe join', () => {
  test('places Phone B exactly from a clean A → B swipe with the phones square', () => {
    const { stitch, positionErrorMm, headingErrorRad } = joinError({});
    expect(stitch.from).toBe('A');
    expect(stitch.snapped).toBe(true);
    expect(positionErrorMm).toBeLessThan(0.5);
    expect(headingErrorRad).toBeLessThan(0.01 * DEG);
  });

  test('gives the same layout when the swipe runs from B to A', () => {
    const { stitch, positionErrorMm, headingErrorRad } = joinError({}, {}, true);
    expect(stitch.from).toBe('B');
    expect(positionErrorMm).toBeLessThan(0.5);
    expect(headingErrorRad).toBeLessThan(0.01 * DEG);
  });

  test('snaps a slanted swipe between square phones back to square', () => {
    const { stitch, positionErrorMm, headingErrorRad } = joinError({ swipeRad: 20 * DEG });
    expect(stitch.snapped).toBe(true);
    expect(stitch.relativeYawRad).toBeCloseTo(0);
    expect(positionErrorMm).toBeLessThan(0.5);
    expect(headingErrorRad).toBeLessThan(0.01 * DEG);
  });

  test('measures a phone turned 30° without snapping it', () => {
    const { stitch, positionErrorMm, headingErrorRad } = joinError({ turnRad: 30 * DEG, entryYMm: 15 });
    expect(stitch.snapped).toBe(false);
    expect(stitch.relativeYawRad).toBeCloseTo(30 * DEG, 3);
    expect(positionErrorMm).toBeLessThan(0.5);
    expect(headingErrorRad).toBeLessThan(0.05 * DEG);
  });

  test('stays within a few millimetres with touch jitter, for square phones', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const { positionErrorMm, headingErrorRad } = joinError({ swipeRad: 8 * DEG }, { noiseMm: 0.4, seed });
      expect(positionErrorMm).toBeLessThan(3);
      expect(headingErrorRad).toBeLessThan(0.01 * DEG);
    }
  });

  test('stays within about a centimetre with touch jitter, for a turned phone', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const { positionErrorMm, headingErrorRad } = joinError({ turnRad: 30 * DEG }, { noiseMm: 0.4, seed });
      expect(positionErrorMm).toBeLessThan(10);
      expect(headingErrorRad).toBeLessThan(5 * DEG);
    }
  });

  test('maps a path between the centres onto both screens as the real layout does', () => {
    const { phoneA, phoneB, start, end } = layout({ turnRad: 30 * DEG, entryYMm: 15 });
    const reports = reportsFor([phoneA, phoneB], swipe(start, end, [phoneA, phoneB]));
    const match = matchSwipes(reports)!;
    const { stitch } = computeStitch(match.exit, match.entry, 0);
    const placed = stitchedLayout(stitch!, phoneA.heading, wrapAngle(phoneB.heading - 1.1));
    const poses = screenPoses(stitch!, placed.headingA!, placed.headingB!);
    [0, 0.25, 0.5, 0.75, 1].forEach((fraction) => {
      const point = { x: phoneB.x * fraction, y: phoneB.y * fraction };
      [[poses.A, phoneA], [poses.B, phoneB]].forEach(([pose, truth]) => {
        const drawn = tableToScreen(point, pose as ScreenPose, (truth as typeof phoneA).screen);
        const expected = worldToTouch(point, truth as typeof phoneA);
        expect(Math.hypot(drawn.xPt - expected.xPt, drawn.yPt - expected.yPt)).toBeLessThan(1);
      });
    });
    // Each centre sits at its own screen's centre and off the other screen.
    expect(tableToScreen(poses.B.centreMm, poses.B, IPHONE_14_PLUS).xPt).toBeCloseTo(IPHONE_14_PLUS.widthPt / 2);
    expect(tableToScreen(poses.B.centreMm, poses.A, IPHONE_17).xPt).toBeGreaterThan(IPHONE_17.widthPt);
    expect(tableToScreen(poses.A.centreMm, poses.B, IPHONE_14_PLUS).xPt).toBeLessThan(0);
  });

  test('follows later gyro turns of Phone B about its centre', () => {
    const { phoneA, phoneB, start, end } = layout({});
    const reports = reportsFor([phoneA, phoneB], swipe(start, end, [phoneA, phoneB]));
    const match = matchSwipes(reports)!;
    const { stitch } = computeStitch(match.exit, match.entry, 0);
    const turnedB = wrapAngle(phoneB.heading - 1.1 + 45 * DEG);
    const placed = stitchedLayout(stitch!, phoneA.heading, turnedB);
    expect(wrapAngle(placed.headingB! - (phoneB.heading + 45 * DEG))).toBeCloseTo(0);
    expect(placed.position.xCm! * 10).toBeCloseTo(phoneB.x, 0);
  });
});

describe('matchSwipes', () => {
  const report = (kind: 'exit' | 'entry', role: 'A' | 'B', atMs: number): SwipeReport => ({
    kind, role, atMs, edge: 'right', pointMm: { x: 0, y: 0 }, directionRad: 0, speedMmPerS: 300, headingRad: 0, frameId: null,
  });

  test('pairs an exit with an entry on the other phone shortly after it', () => {
    const match = matchSwipes([report('exit', 'A', 1000), report('entry', 'B', 1080)]);
    expect(match?.exit.role).toBe('A');
    expect(match?.entry.role).toBe('B');
  });

  test('does not pair halves on the same phone or too far apart', () => {
    expect(matchSwipes([report('exit', 'A', 1000), report('entry', 'A', 1050)])).toBeNull();
    expect(matchSwipes([report('exit', 'A', 1000), report('entry', 'B', 2500)])).toBeNull();
  });

  test('picks the closest-timed pair', () => {
    const match = matchSwipes([report('exit', 'A', 1000), report('exit', 'A', 1400), report('entry', 'B', 1450)]);
    expect(match?.exit.atMs).toBe(1400);
  });

  test('refuses a join without both headings', () => {
    const result = computeStitch(report('exit', 'A', 0), { ...report('entry', 'B', 50), headingRad: null }, 0);
    expect(result.stitch).toBeNull();
    expect(result.reason).toMatch(/Phone B heading/);
  });
});

describe('MovedApartCheck', () => {
  const stitch = computeStitch(
    { kind: 'exit', role: 'A', atMs: 0, edge: 'right', pointMm: { x: 33.4, y: 0 }, directionRad: 0, speedMmPerS: 300, headingRad: Math.PI / 2, frameId: null },
    { kind: 'entry', role: 'B', atMs: 50, edge: 'left', pointMm: { x: -35.5, y: 0 }, directionRad: 0, speedMmPerS: 300, headingRad: Math.PI / 2, frameId: null },
    0,
  ).stitch!;

  const settle = (check: MovedApartCheck, measuredCm: number, predictedCm: number) => {
    for (let index = 0; index < 5; index += 1) check.observe(measuredCm, predictedCm, index * 50);
  };

  test('ignores a constant UWB bias next to touching phones', () => {
    const check = new MovedApartCheck();
    const predicted = predictedAntennaDistanceCm(stitch, Math.PI / 2, Math.PI / 2);
    settle(check, predicted + 6, predicted);
    expect(check.observe(predicted + 6.5, predicted, 300)).toEqual({ residualCm: 0.5, moved: false });
  });

  test('flags a change that lasts longer than the hold time', () => {
    const check = new MovedApartCheck(5, 700);
    settle(check, 10, 7);
    expect(check.observe(20, 7, 1000).moved).toBe(false);
    expect(check.observe(20, 7, 1600).moved).toBe(false);
    expect(check.observe(20, 7, 1700).moved).toBe(true);
  });

  test('a short spike does not count', () => {
    const check = new MovedApartCheck(5, 700);
    settle(check, 10, 7);
    check.observe(30, 7, 1000);
    expect(check.observe(10, 7, 1100)).toEqual({ residualCm: 0, moved: false });
    expect(check.observe(30, 7, 1800).moved).toBe(false);
  });

  test('turning Phone B in place moves its antenna, which the prediction accounts for', () => {
    const check = new MovedApartCheck();
    const before = predictedAntennaDistanceCm(stitch, Math.PI / 2, Math.PI / 2);
    const after = predictedAntennaDistanceCm(stitch, Math.PI / 2, -Math.PI / 2);
    expect(Math.abs(after - before)).toBeGreaterThan(ANTENNA_FROM_CENTRE_CM);
    settle(check, before, before);
    // UWB follows the antenna round, so the measured change matches the predicted change.
    expect(check.observe(after, after, 2000).moved).toBe(false);
    expect(check.observe(after, after, 3000).residualCm).toBeCloseTo(0);
  });
});

test('stitch messages survive the round trip and other messages are ignored', () => {
  const message = { type: 'join' as const };
  expect(parseStitchMessage(serializeStitchMessage(message))).toEqual(message);
  expect(parseStitchMessage('{"type":"parallax.spin","fits":{}}')).toBeNull();
  expect(parseStitchMessage('not json')).toBeNull();
});
