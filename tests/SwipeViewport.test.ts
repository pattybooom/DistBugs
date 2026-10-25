import { interpolatePose, markStale, mediaTransform, SwipeViewport } from '../src/spatial/SwipeViewport';

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
