import { DistanceFilter } from '../src/state/DistanceFilter';

test('identical close readings converge instead of leaving the old larger distance', () => {
  // The earlier display only fed the smoother when the value changed, so it stuck near 89 cm here.
  const filter = new DistanceFilter();
  filter.push({ role: 'A', distanceCm: 100, receivedAt: 0 }, 'A');
  for (let index = 1; index <= 20; index += 1) filter.push({ role: 'A', distanceCm: 10, receivedAt: index * 50 }, 'A');
  // A 200 ms time constant leaves under 1 cm of a 90 cm step after one second.
  expect(filter.current(1000).smoothedCm).toBeLessThan(11);
  for (let index = 21; index <= 40; index += 1) filter.push({ role: 'A', distanceCm: 10, receivedAt: index * 50 }, 'A');
  expect(filter.current(2000).smoothedCm).toBeCloseTo(10, 1);
});

test('drops a single spike', () => {
  const filter = new DistanceFilter();
  [30, 30, 30, 30].forEach((distanceCm, index) => filter.push({ role: 'A', distanceCm, receivedAt: index * 50 }, 'A'));
  filter.push({ role: 'A', distanceCm: 200, receivedAt: 200 }, 'A');
  expect(filter.current(200).smoothedCm).toBeCloseTo(30);
});

test("prefers this phone's readings and uses the other phone's only while ours are stale", () => {
  const filter = new DistanceFilter();
  expect(filter.push({ role: 'A', distanceCm: 20, receivedAt: 0 }, 'A')).toBe(true);
  expect(filter.push({ role: 'B', distanceCm: 50, receivedAt: 100 }, 'A')).toBe(false);
  expect(filter.current(100)).toMatchObject({ rawCm: 20, role: 'A' });
  expect(filter.push({ role: 'B', distanceCm: 50, receivedAt: 1500 }, 'A')).toBe(true);
  expect(filter.current(1500)).toMatchObject({ rawCm: 50, role: 'B', smoothedCm: 50 });
});

test('starts afresh after a gap rather than blending with an old distance', () => {
  const filter = new DistanceFilter();
  filter.push({ role: 'A', distanceCm: 80, receivedAt: 0 }, 'A');
  filter.push({ role: 'A', distanceCm: 12, receivedAt: 5000 }, 'A');
  expect(filter.current(5000).smoothedCm).toBe(12);
});

test('reports staleness and ignores impossible readings', () => {
  const filter = new DistanceFilter();
  expect(filter.push({ role: 'A', distanceCm: -1, receivedAt: 0 }, 'A')).toBe(false);
  filter.push({ role: 'A', distanceCm: 15, receivedAt: 0 }, 'A');
  expect(filter.current(500).fresh).toBe(true);
  expect(filter.current(1500).fresh).toBe(false);
  filter.reset();
  expect(filter.current(0)).toEqual({ rawCm: null, smoothedCm: null, role: null, fresh: false });
});
