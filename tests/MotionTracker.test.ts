import { MotionEvent } from '../src/native/ParallaxModule';
import { MotionTracker, RESPIN_BEARING_UNCERTAINTY_RAD } from '../src/spatial/MotionTracker';
import { PositionEstimate } from '../src/spatial/SpatialMath';

const DEG = Math.PI / 180;

const motion = (role: 'A' | 'B', x: number, y: number, stationary = true, movingSeconds = 0): MotionEvent => ({
  role,
  source: 'local',
  referenceFrame: 'xMagneticNorthZVertical',
  commonFrameAvailable: true,
  valid: true,
  timestamp: 0,
  displacementCm: { x, y, z: 0 },
  stationary,
  movingSeconds,
});

const spinAt = (xCm: number, yCm: number): PositionEstimate => ({
  source: 'estimated',
  xCm,
  yCm,
  bearingRad: Math.atan2(yCm, xCm),
  distanceCm: Math.hypot(xCm, yCm),
  reason: 'spin test on Phone A',
});

/** B starts 30 cm along A's +X; both phones begin still at the origin of their dead reckoning. */
const startedTracker = (bearingUncertaintyRad = 0) => {
  const tracker = new MotionTracker();
  tracker.start(spinAt(30, 0), bearingUncertaintyRad, motion('A', 0, 0), motion('B', 0, 0));
  return tracker;
};

/** A brisk slide: moving for `seconds`, then settled at the end point. */
const slide = (tracker: MotionTracker, role: 'A' | 'B', x: number, y: number, seconds = 0.8) => {
  tracker.observe(role, motion(role, x / 2, y / 2, false, seconds / 2));
  tracker.observe(role, motion(role, x, y, true, seconds));
};

test('stays at the spin position while neither phone moves', () => {
  const tracker = startedTracker(3 * DEG);
  tracker.observe('A', motion('A', 0, 0));
  const tracked = tracker.estimate(30, 0);
  expect(tracked?.position.xCm).toBeCloseTo(30);
  expect(tracked?.position.yCm).toBeCloseTo(0);
  expect(tracked?.movedCm).toBeCloseTo(0);
  expect(tracked?.bearingUncertaintyRad).toBeCloseTo(3 * DEG);
  expect(tracked?.position.reason).toBe('spin test on Phone A');
});

test('follows Phone A sliding sideways, which UWB distance alone cannot see', () => {
  const tracker = startedTracker();
  slide(tracker, 'A', 0, 10);
  const tracked = tracker.estimate(Math.hypot(30, 10), 0);
  expect(tracked?.position.xCm).toBeCloseTo(30);
  expect(tracked?.position.yCm).toBeCloseTo(-10);
  expect(tracked?.position.reason).toBe('spin test on Phone A + motion');
});

test('follows Phone B sliding when both phones share a frame', () => {
  const tracker = startedTracker();
  slide(tracker, 'B', 0, 20);
  const tracked = tracker.estimate(Math.hypot(30, 20), 0);
  expect(tracked?.position.xCm).toBeCloseTo(30);
  expect(tracked?.position.yCm).toBeCloseTo(20);
  expect(tracked?.needsRespin).toBe(false);
});

test('turns B\'s slide into A\'s frame with the frame offset', () => {
  const tracker = startedTracker();
  slide(tracker, 'B', 20, 0);
  const tracked = tracker.estimate(Math.hypot(30, 20), Math.PI / 2);
  expect(tracked?.position.xCm).toBeCloseTo(30);
  expect(tracked?.position.yCm).toBeCloseTo(20);
});

test('asks for a re-spin when B slides without a shared frame', () => {
  const tracker = startedTracker();
  slide(tracker, 'B', 10, 0);
  const tracked = tracker.estimate(30, null);
  expect(tracked?.needsRespin).toBe(true);
  expect(tracked?.position.xCm).toBeCloseTo(30);
});

test('takes the range from UWB rather than dead reckoning', () => {
  const tracker = startedTracker();
  slide(tracker, 'A', 10, 0);
  expect(tracker.estimate(22, 0)?.position.xCm).toBeCloseTo(22);
  expect(tracker.estimate(null, 0)?.position.xCm).toBeCloseTo(20);
});

test('grows the bearing uncertainty with how long each slide lasted', () => {
  const brief = startedTracker();
  slide(brief, 'A', 0, 5, 1);
  // A 1 s slide allows 0.5 × 15 cm/s² × 1 s² = 7.5 cm sideways, about 14° at 30 cm.
  expect(brief.estimate(30, 0)?.bearingUncertaintyRad).toBeCloseTo(7.5 / 30, 2);
  expect(brief.estimate(30, 0)?.needsRespin).toBe(false);

  const slow = startedTracker();
  slide(slow, 'A', 0, 5, 2);
  expect(slow.estimate(30, 0)?.bearingUncertaintyRad).toBeGreaterThan(RESPIN_BEARING_UNCERTAINTY_RAD);
  expect(slow.estimate(30, 0)?.needsRespin).toBe(true);
});

test('counts a slide that is still under way', () => {
  const tracker = startedTracker();
  tracker.observe('A', motion('A', 0, 2, false, 0.5));
  tracker.observe('A', motion('A', 0, 4, false, 1));
  expect(tracker.estimate(30, 0)?.bearingUncertaintyRad).toBeCloseTo(7.5 / 30, 2);
});

test('keeps the slide so far when native dead reckoning restarts', () => {
  const tracker = startedTracker();
  slide(tracker, 'A', 0, 10, 1);
  tracker.observe('A', motion('A', 0, 0, true, 0));
  const tracked = tracker.estimate(Math.hypot(30, 10), 0);
  expect(tracked?.position.yCm).toBeCloseTo(-10);
});

test('has no estimate until started, and none after a reset', () => {
  const tracker = new MotionTracker();
  expect(tracker.estimate(30, 0)).toBeNull();
  tracker.start(spinAt(30, 0), 0, null, null);
  expect(tracker.active).toBe(true);
  tracker.reset();
  expect(tracker.estimate(30, 0)).toBeNull();
});
