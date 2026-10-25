import { interpolatePose, markStale, mediaTransform, tabletopMediaPlacement, SwipeViewport } from '../src/spatial/SwipeViewport';

const viewport = (overrides: Partial<SwipeViewport> = {}): SwipeViewport => ({
  role: 'A', centreCm: { x: 10, y: 20 }, headingRad: 0, widthCm: 7, heightCm: 15,
  confidence: 1, receivedAt: 1000, stale: false, ...overrides,
});

test('interpolates translation and shortest rotation path', () => {
  const result = interpolatePose(viewport(), viewport({ centreCm: { x: 20, y: 40 }, headingRad: Math.PI }), .5, 1100);
  expect(result.centreCm).toEqual({ x: 15, y: 30 });
  expect(result.headingRad).toBeCloseTo(Math.PI / 2);
});

test('freezes and marks a viewport stale after the watchdog window', () => {
  const result = markStale(viewport(), 2301);
  expect(result.stale).toBe(true);
  expect(result.centreCm).toEqual({ x: 10, y: 20 });
});

test('maps tabletop position into a phone-local media transform', () => {
  expect(mediaTransform(viewport(), 10, { x: 0, y: 0 })).toEqual({ translateX: -100, translateY: -200, rotate: '0deg' });
});

test.each([0, Math.PI / 2, Math.PI, -.72])('world points remain aligned on a rotated screen at %s', angle => {
  const phone = viewport({ headingRad: angle, centreCm: { x: -3, y: 5 }, widthCm: 7, heightCm: 15 });
  const placement = tabletopMediaPlacement(phone, { width: 350, height: 750 }, { width: 1600, height: 900 }, { widthCm: 32, heightCm: 18 });
  const m = placement.matrix;
  // Media is centred at world (16,9), with a physical extent of 32 x 18 cm.
  const local = { x: (phone.centreCm.x - 16) * 50, y: (9 - phone.centreCm.y) * 50 };
  expect(m[0] * local.x + m[4] * local.y + m[12]).toBeCloseTo(0);
  expect(m[1] * local.x + m[5] * local.y + m[13]).toBeCloseTo(0);
  expect(placement.width).toBeCloseTo(1600);
  expect(placement.height).toBeCloseTo(900);
});

test('different screen sizes map the same world distance using each screen scale', () => {
  const phone = viewport({ headingRad: Math.PI / 2, centreCm: { x: 16, y: 9 } });
  const placement = tabletopMediaPlacement(phone, { width: 420, height: 750 }, { width: 100, height: 100 }, { widthCm: 32, heightCm: 18 });
  expect(placement.width).toBeCloseTo(18 * 60);
  expect(placement.height).toBeCloseTo(18 * 50);
  expect(placement.matrix[12]).toBeCloseTo(0);
  expect(placement.matrix[13]).toBeCloseTo(0);
});
