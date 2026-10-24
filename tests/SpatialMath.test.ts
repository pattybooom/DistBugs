import {
  calculateRelativeRotation,
  hasCommonFrame,
  isFresh,
  positionFromDistanceAndDirection,
  quaternionInverse,
  quaternionMultiply,
  rotateVectorByQuaternion,
  selectPositionMeasurement,
  tablePlaneHeading,
  transformDirectionToReferenceFrame,
} from '../src/spatial/SpatialMath';
import { DistanceEvent, MotionEvent, Quaternion } from '../src/native/ParallaxModule';

const quarterTurnAbout = (axis: 'x' | 'z'): Quaternion => ({
  x: axis === 'x' ? Math.SQRT1_2 : 0,
  y: 0,
  z: axis === 'z' ? Math.SQRT1_2 : 0,
  w: Math.SQRT1_2,
});

const measuredDistance = (role: 'A' | 'B', direction?: { x: number; y: number; z: number }, receivedAt = 1_000): DistanceEvent => ({
  role,
  source: 'measured',
  distanceCm: 100,
  distanceAvailable: true,
  direction,
  directionAvailable: Boolean(direction),
  directionValid: Boolean(direction),
  horizontalAngleAvailable: false,
  timestamp: 1_000,
  measurementTimestamp: 1_000,
  sessionState: 'ranging',
  receivedAt,
});

const motion = (role: 'A' | 'B', attitudeQuaternion: Quaternion = { x: 0, y: 0, z: 0, w: 1 }, receivedAt = 1_000): MotionEvent => ({
  role,
  source: 'local',
  attitudeQuaternion,
  gravity: { x: 0, y: 0, z: -1 },
  referenceFrame: 'xMagneticNorthZVertical',
  commonFrameAvailable: true,
  valid: true,
  timestamp: 1_000,
  receivedAt,
});

test('multiplies a quaternion by its inverse to produce identity', () => {
  const rotation = quarterTurnAbout('z');
  const inverse = quaternionInverse(rotation);
  expect(inverse).not.toBeNull();
  const identity = quaternionMultiply(rotation, inverse!);
  expect(identity.x).toBeCloseTo(0);
  expect(identity.y).toBeCloseTo(0);
  expect(identity.z).toBeCloseTo(0);
  expect(identity.w).toBeCloseTo(1);
});

test('rotates cardinal vectors around the vertical axis', () => {
  const quarterTurn = quarterTurnAbout('z');
  const fromX = rotateVectorByQuaternion({ x: 1, y: 0, z: 0 }, quarterTurn);
  const fromY = rotateVectorByQuaternion({ x: 0, y: 1, z: 0 }, quarterTurn);
  expect(fromX?.x).toBeCloseTo(0);
  expect(fromX?.y).toBeCloseTo(1);
  expect(fromY?.x).toBeCloseTo(-1);
  expect(fromY?.y).toBeCloseTo(0);
});

test('transforms a device-local direction into the reference frame with the attitude', () => {
  // A phone turned a quarter anticlockwise has its top edge pointing along reference -X.
  const transformed = transformDirectionToReferenceFrame({ x: 0, y: 1, z: 0 }, quarterTurnAbout('z'));
  expect(transformed?.x).toBeCloseTo(-1);
  expect(transformed?.y).toBeCloseTo(0);
});

test('maps an upright phone\'s gravity to reference down', () => {
  // Core Motion reports pitch +90° (a quarter turn about device X) and gravity (0, -1, 0) for an upright phone.
  const worldGravity = transformDirectionToReferenceFrame({ x: 0, y: -1, z: 0 }, quarterTurnAbout('x'));
  expect(worldGravity?.x).toBeCloseTo(0);
  expect(worldGravity?.y).toBeCloseTo(0);
  expect(worldGravity?.z).toBeCloseTo(-1);
});

test('projects measured distance and direction to a table position', () => {
  const position = positionFromDistanceAndDirection(100, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  expect(position).toMatchObject({ source: 'measured', xCm: 100, yCm: 0 });
});

test('scales a raised direction to its horizontal share of the distance', () => {
  const elevation = Math.PI / 3;
  const position = positionFromDistanceAndDirection(100, { x: Math.cos(elevation), y: 0, z: Math.sin(elevation) }, { x: 0, y: 0, z: -1 });
  expect(position.source).toBe('measured');
  expect(position.xCm).toBeCloseTo(50);
});

test('rejects directions that are mostly vertical', () => {
  const elevation = (80 * Math.PI) / 180;
  const position = positionFromDistanceAndDirection(100, { x: Math.cos(elevation), y: 0, z: Math.sin(elevation) }, { x: 0, y: 0, z: -1 });
  expect(position).toMatchObject({ source: 'unknown', xCm: null, reason: 'direction mostly vertical' });
});

test('rejects missing, zero-length, non-finite and negative geometry', () => {
  expect(positionFromDistanceAndDirection(100, undefined).source).toBe('unknown');
  expect(positionFromDistanceAndDirection(100, { x: 0, y: 0, z: 0 }).reason).toBe('direction invalid');
  expect(positionFromDistanceAndDirection(100, { x: Number.NaN, y: 0, z: 0 }).source).toBe('unknown');
  expect(positionFromDistanceAndDirection(-1, { x: 1, y: 0, z: 0 }).reason).toBe('distance unavailable');
  expect(positionFromDistanceAndDirection(Number.POSITIVE_INFINITY, { x: 1, y: 0, z: 0 }).source).toBe('unknown');
});

test('treats readings newer than the caller clock as fresh and old or far-future readings as stale', () => {
  expect(isFresh(1_000, 2_001)).toBe(false);
  expect(isFresh(1_030, 1_000)).toBe(true);
  expect(isFresh(5_000, 1_000)).toBe(false);
  expect(isFresh(undefined, 1_000)).toBe(false);
});

test('keeps a measurement that arrived after the last UI clock tick', () => {
  const position = selectPositionMeasurement(
    measuredDistance('A', { x: 1, y: 0, z: 0 }, 1_030),
    null,
    motion('A'),
    motion('B'),
    'A',
    1_000,
  );
  expect(position.source).toBe('measured');
});

test('rejects stale distance and stale motion', () => {
  const staleDistance = selectPositionMeasurement(measuredDistance('A', { x: 1, y: 0, z: 0 }, 0), null, motion('A'), motion('B'), 'A', 2_000);
  const staleMotion = selectPositionMeasurement(
    measuredDistance('A', { x: 1, y: 0, z: 0 }, 2_000),
    null,
    motion('A', undefined, 0),
    motion('B'),
    'A',
    2_000,
  );
  expect(staleDistance.reason).toBe('no fresh valid direction');
  expect(staleMotion.reason).toBe('no fresh valid direction');
});

test('does not invent a position without a common magnetic frame', () => {
  const position = selectPositionMeasurement(
    measuredDistance('A', { x: 1, y: 0, z: 0 }),
    measuredDistance('B', { x: -1, y: 0, z: 0 }),
    { ...motion('A'), referenceFrame: 'xArbitraryCorrectedZVertical', commonFrameAvailable: false },
    { ...motion('B'), referenceFrame: 'xArbitraryCorrectedZVertical', commonFrameAvailable: false },
    'A',
    1_000,
  );
  expect(position.source).toBe('unknown');
  expect(position.xCm).toBeNull();
  expect(position.reason).toBe('common magnetic frame unavailable');
});

test('inverts a valid B-origin measurement for the A-centred scene', () => {
  const position = selectPositionMeasurement(
    measuredDistance('A'),
    measuredDistance('B', { x: 1, y: 0, z: 0 }),
    motion('A'),
    motion('B'),
    'A',
    1_000,
  );
  expect(position.source).toBe('measured');
  expect(position.xCm).toBeCloseTo(-100);
  expect(position.yCm).toBeCloseTo(0);
});

test('inverts a B-origin measurement from a rotated Phone B', () => {
  // B is turned a quarter anticlockwise and sees A off its top edge, so A lies along reference -X from B.
  const position = selectPositionMeasurement(
    measuredDistance('A'),
    measuredDistance('B', { x: 0, y: 1, z: 0 }),
    motion('A'),
    motion('B', quarterTurnAbout('z')),
    'A',
    1_000,
  );
  expect(position.xCm).toBeCloseTo(100);
  expect(position.yCm).toBeCloseTo(0);
});

test('measures table heading from the top edge, or the back when upright', () => {
  expect(tablePlaneHeading({ x: 0, y: 0, z: 0, w: 1 })).toBeCloseTo(Math.PI / 2);
  expect(Math.abs(tablePlaneHeading(quarterTurnAbout('z'))!)).toBeCloseTo(Math.PI);
  expect(tablePlaneHeading(quarterTurnAbout('x'))).toBeCloseTo(Math.PI / 2);
  expect(tablePlaneHeading(undefined)).toBeNull();
});

test('calculates relative rotation and frame availability', () => {
  const relative = calculateRelativeRotation({ x: 0, y: 0, z: 0, w: 1 }, quarterTurnAbout('z'));
  expect(relative.yaw).toBeCloseTo(Math.PI / 2);
  expect(hasCommonFrame('xMagneticNorthZVertical', 'xMagneticNorthZVertical')).toBe(true);
  expect(hasCommonFrame('xArbitraryCorrectedZVertical', 'xArbitraryCorrectedZVertical')).toBe(false);
});
