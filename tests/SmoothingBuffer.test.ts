import { SmoothingBuffer } from '../src/state/SmoothingBuffer';
test('keeps a bounded moving average', () => { const buffer = new SmoothingBuffer(3); expect(buffer.push(10)).toBe(10); expect(buffer.push(20)).toBe(15); expect(buffer.push(30)).toBe(20); expect(buffer.push(40)).toBe(30); });
test('can reset state', () => { const buffer = new SmoothingBuffer(2); buffer.push(10); buffer.reset(); expect(buffer.push(30)).toBe(30); });
