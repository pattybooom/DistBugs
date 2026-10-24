export class SmoothingBuffer {
  private values: number[] = [];
  private smoothedValue: number | null = null;

  constructor(
    private readonly size = 10,
    private readonly alpha = 0.25,
  ) {
    if (!Number.isInteger(size) || size < 1) {
      throw new Error('Smoothing window size must be a positive integer');
    }
    if (alpha <= 0 || alpha > 1) {
      throw new Error('Smoothing alpha must be greater than 0 and at most 1');
    }
  }

  push(value: number): number {
    if (!Number.isFinite(value) || value < 0) {
      return this.smoothedValue ?? 0;
    }

    this.values = [...this.values, value].slice(-this.size);
    const sorted = [...this.values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];

    this.smoothedValue = this.smoothedValue == null
      ? median
      : this.smoothedValue + this.alpha * (median - this.smoothedValue);

    return this.smoothedValue;
  }

  reset(): void {
    this.values = [];
    this.smoothedValue = null;
  }
}
