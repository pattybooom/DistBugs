export type DistanceRole = 'A' | 'B';

export type DistanceSample = {
  role: DistanceRole;
  distanceCm: number;
  /** This phone's clock on arrival. */
  receivedAt: number;
};

export type FilteredDistance = {
  rawCm: number | null;
  smoothedCm: number | null;
  role: DistanceRole | null;
  fresh: boolean;
};

/**
 * Smooths UWB distance one reading at a time: a short median drops single spikes, then an
 * exponential average whose weight depends on the time since the last reading. Every reading
 * advances the filter, including a repeat of the previous value, so a run of identical close
 * readings converges instead of leaving the display stuck at an older, larger distance.
 *
 * Both phones measure the same distance. Readings from `preferredRole` (this phone) are used;
 * the other phone's relayed readings fill in only while ours are stale.
 */
export class DistanceFilter {
  private window: number[] = [];
  private smoothedCm: number | null = null;
  private lastUsed: DistanceSample | null = null;
  private lastPreferredAt: number | null = null;

  constructor(
    private readonly timeConstantMs = 200,
    private readonly medianSize = 3,
    private readonly staleAfterMs = 1000,
  ) {}

  /** Returns true when the reading was used. */
  push(sample: DistanceSample, preferredRole: DistanceRole | null): boolean {
    if (!Number.isFinite(sample.distanceCm) || sample.distanceCm < 0 || !Number.isFinite(sample.receivedAt)) return false;
    const preferred = preferredRole == null || sample.role === preferredRole;
    if (preferred) this.lastPreferredAt = sample.receivedAt;
    else if (this.lastPreferredAt != null && sample.receivedAt - this.lastPreferredAt <= this.staleAfterMs) return false;

    // After a gap the old average says nothing about where the phones are now.
    const gapMs = this.lastUsed ? sample.receivedAt - this.lastUsed.receivedAt : Infinity;
    if (gapMs > this.staleAfterMs) {
      this.window = [];
      this.smoothedCm = null;
    }

    this.window = [...this.window, sample.distanceCm].slice(-this.medianSize);
    const sorted = [...this.window].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
    const alpha = 1 - Math.exp(-Math.max(0, gapMs) / this.timeConstantMs);
    this.smoothedCm = this.smoothedCm == null ? median : this.smoothedCm + alpha * (median - this.smoothedCm);
    this.lastUsed = sample;
    return true;
  }

  current(now: number): FilteredDistance {
    const fresh = this.lastUsed != null && now - this.lastUsed.receivedAt <= this.staleAfterMs;
    return {
      rawCm: this.lastUsed?.distanceCm ?? null,
      smoothedCm: this.smoothedCm,
      role: this.lastUsed?.role ?? null,
      fresh,
    };
  }

  reset(): void {
    this.window = [];
    this.smoothedCm = null;
    this.lastUsed = null;
    this.lastPreferredAt = null;
  }
}
