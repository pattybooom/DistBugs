import { SmoothingBuffer } from '../src/state/SmoothingBuffer';

test('uses a median window followed by an exponential moving average', () => {
  const buffer = new SmoothingBuffer(3, 0.25);

  expect(buffer.push(10)).toBeCloseTo(10);
  expect(buffer.push(20)).toBeCloseTo(11.25);
  expect(buffer.push(30)).toBeCloseTo(13.4375);
});

test('suppresses a one-sample spike', () => {
  const buffer = new SmoothingBuffer(5, 0.25);

  buffer.push(100);
  buffer.push(101);
  buffer.push(99);
  const beforeSpike = buffer.push(100);
  const afterSpike = buffer.push(500);

  expect(afterSpike - beforeSpike).toBeLessThan(2);
});

test('ignores invalid readings and can reset state', () => {
  const buffer = new SmoothingBuffer(2, 0.25);

  expect(buffer.push(30)).toBe(30);
  expect(buffer.push(Number.NaN)).toBe(30);
  expect(buffer.push(Number.POSITIVE_INFINITY)).toBe(30);
  buffer.reset();
  expect(buffer.push(80)).toBe(80);
});
