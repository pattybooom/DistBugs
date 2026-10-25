/** Estimates the Mac's wall clock on this phone so both phones can play the same moment of a video. */
export class SharedClock {
  private samples: { at: number; offset: number }[] = [];

  constructor(private windowMs = 5000) {}

  reset() { this.samples = []; }

  /** `remoteMs` is the Mac's timestamp in a message; `localMs` is this phone's clock when it arrived. */
  observe(remoteMs: number, localMs: number) {
    this.samples.push({ at: localMs, offset: localMs - remoteMs });
    while (this.samples.length > 1 && localMs - this.samples[0].at > this.windowMs) this.samples.shift();
  }

  /** Network delay only ever adds to the apparent offset, so the smallest recent offset is the best estimate. */
  remoteNow(localMs: number): number | null {
    if (!this.samples.length) return null;
    return localMs - Math.min(...this.samples.map(sample => sample.offset));
  }
}

/** Where a looping video should be, in seconds, given the Mac time and when playback started there. */
export function loopPosition(remoteNowMs: number, startedAtMs: number, startOffsetSec: number, durationSec: number): number {
  const elapsed = (remoteNowMs - startedAtMs) / 1000 + startOffsetSec;
  return ((elapsed % durationSec) + durationSec) % durationSec;
}

/** Signed difference a - b around a loop, in (-duration/2, duration/2]. */
export function loopDrift(a: number, b: number, durationSec: number): number {
  const diff = (((a - b) % durationSec) + durationSec) % durationSec;
  return diff > durationSec / 2 ? diff - durationSec : diff;
}
