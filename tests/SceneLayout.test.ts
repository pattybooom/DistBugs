import { layoutPhonePair, phoneHalfExtentCm, PHONE_SIZE_CM, rotatePosition, viewRotation } from '../src/spatial/SceneLayout';
import { PositionEstimate } from '../src/spatial/SpatialMath';

const TOP_UP = Math.PI / 2;
const { widthCm, lengthCm } = PHONE_SIZE_CM;

const at = (gapCm: number, bearingRad: number): PositionEstimate => ({
  source: 'estimated',
  xCm: Math.cos(bearingRad) * gapCm,
  yCm: Math.sin(bearingRad) * gapCm,
  bearingRad,
  distanceCm: gapCm,
  reason: 'test',
});

test('measures half a phone across its width and along its length', () => {
  expect(phoneHalfExtentCm(0, TOP_UP)).toBeCloseTo(widthCm / 2);
  expect(phoneHalfExtentCm(TOP_UP, TOP_UP)).toBeCloseTo(lengthCm / 2);
  expect(phoneHalfExtentCm(0, 0)).toBeCloseTo(lengthCm / 2);
});

test('draws 0 cm as phones touching side by side, not stacked', () => {
  const layout = layoutPhonePair(at(0, 0), TOP_UP, TOP_UP);
  expect(layout?.centreB.xCm).toBeCloseTo(widthCm);
  expect(layout?.centreB.yCm).toBeCloseTo(0);
  expect(layout).toMatchObject({ gapCm: 0, touching: true });
});

test('keeps the bearing for 0 cm above Phone A', () => {
  const layout = layoutPhonePair(at(0, TOP_UP), TOP_UP, TOP_UP);
  expect(layout?.centreB.xCm).toBeCloseTo(0);
  expect(layout?.centreB.yCm).toBeCloseTo(lengthCm);
});

test('places Phone B\'s centre at the measured distance and takes half of each phone off the gap', () => {
  const layout = layoutPhonePair(at(22, 0), TOP_UP, TOP_UP);
  expect(layout?.centreB.xCm).toBeCloseTo(22);
  expect(layout?.distanceCm).toBeCloseTo(22);
  expect(layout?.gapCm).toBeCloseTo(22 - widthCm);
  expect(layout?.gapStart.xCm).toBeCloseTo(widthCm / 2);
  expect(layout?.gapEnd.xCm).toBeCloseTo(22 - widthCm / 2);
  expect(layout?.touching).toBe(false);
});

test('draws a distance shorter than the phones as touching', () => {
  const layout = layoutPhonePair(at(5, 0), TOP_UP, TOP_UP);
  expect(layout?.centreB.xCm).toBeCloseTo(widthCm);
  expect(layout).toMatchObject({ distanceCm: 5, gapCm: 0, touching: true });
});

test('allows for Phone B lying sideways', () => {
  const touching = layoutPhonePair(at(0, 0), TOP_UP, 0);
  const apart = layoutPhonePair(at(22, 0), TOP_UP, 0);
  expect(touching?.centreB.xCm).toBeCloseTo(widthCm / 2 + lengthCm / 2);
  expect(apart?.gapCm).toBeCloseTo(22 - widthCm / 2 - lengthCm / 2);
});

test('draws unknown headings top edge up', () => {
  const layout = layoutPhonePair(at(10, 0), null, null);
  expect(layout?.centreB.xCm).toBeCloseTo(10);
  expect(layout?.gapCm).toBeCloseTo(10 - widthCm);
});

test('turns the view so Phone A\'s starting heading points up', () => {
  // A started pointing along reference +X with B straight ahead of it, so B should be drawn above A.
  const rotation = viewRotation(0);
  const position = rotatePosition(at(30, 0), rotation);
  expect(rotation).toBeCloseTo(TOP_UP);
  expect(position.xCm).toBeCloseTo(0);
  expect(position.yCm).toBeCloseTo(30);
  expect(position.bearingRad).toBeCloseTo(TOP_UP);
});

test('leaves the view unturned until Phone A has a heading', () => {
  expect(viewRotation(null)).toBe(0);
  expect(viewRotation(TOP_UP)).toBeCloseTo(0);
  const unknown: PositionEstimate = { source: 'unknown', xCm: null, yCm: null, bearingRad: null, distanceCm: null, reason: 'none' };
  expect(rotatePosition(unknown, 1)).toBe(unknown);
});

test('has no layout without a position', () => {
  expect(layoutPhonePair({ source: 'unknown', xCm: null, yCm: null, bearingRad: null, distanceCm: null, reason: 'none' }, TOP_UP, TOP_UP)).toBeNull();
});
