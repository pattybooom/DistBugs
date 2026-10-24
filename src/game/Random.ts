/**
 * Mulberry32. Its whole state is one 32-bit number, so the generator saves with the ecosystem
 * and a restored ecosystem continues exactly where it stopped.
 */
export class Random {
  state: number;

  constructor(state: number) {
    this.state = state >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.min(max, Math.floor(this.range(min, max + 1)));
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.min(items.length - 1, Math.floor(this.next() * items.length))];
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }
}
