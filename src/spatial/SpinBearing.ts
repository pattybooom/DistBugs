import { PositionEstimate, wrapAngle } from './SpatialMath';

/**
 * Spin test: the UWB antenna sits near the top of the phone, so swinging a phone flat on the
 * table around its bottom edge moves the antenna round a circle about a phone-length wide. The
 * measured distance then traces one wave per turn, shortest when the antenna faces the other
 * phone. Fitting that wave against the phone's heading gives the bearing to the other phone
 * without Nearby Interaction direction.
 */

export type SpinSample = { t: number; heading: number; distanceCm: number };

export type SpinFit = {
  accepted: boolean;
  reason: string;
  sampleCount: number;
  turnedRad: number;
  amplitudeCm: number | null;
  /** Share of the non-drift distance variation explained by the wave, 0–1. Informational. */
  quality: number | null;
  residualCm: number | null;
  /** One standard error of the bearing. Optimistic if the distance noise is correlated between readings. */
  bearingUncertaintyRad: number | null;
  meanCm: number | null;
  driftCmPerSecond: number | null;
  /** Heading of the phone's top edge when the distance was shortest. */
  closestHeadingRad: number | null;
  /** Direction to the other phone in this phone's reference frame. */
  bearingRad: number | null;
};

/**
 * Direction of the UWB antenna from the pivot, anticlockwise from the phone's top edge.
 * With the pivot on the bottom edge this stays close to 0 wherever the antenna sits across the top.
 */
export const ANTENNA_ANGLE_FROM_TOP_RAD = 0;
export const MIN_SPIN_SAMPLES = 20;
const COVERAGE_BIN_COUNT = 12;
export const MIN_SPIN_COVERAGE_BINS = 10;
export const MIN_WAVE_AMPLITUDE_CM = 1;
export const MAX_WAVE_AMPLITUDE_CM = 25;
export const MAX_BEARING_UNCERTAINTY_RAD = (10 * Math.PI) / 180;

export class SpinRecording {
  private recorded: SpinSample[] = [];
  private lastHeading: number | null = null;
  private unwrappedHeading = 0;
  private minUnwrapped = 0;
  private maxUnwrapped = 0;

  add(t: number, heading: number, distanceCm: number): void {
    if (!Number.isFinite(t) || !Number.isFinite(heading) || !Number.isFinite(distanceCm) || distanceCm < 0) return;
    if (this.lastHeading == null) {
      this.unwrappedHeading = heading;
      this.minUnwrapped = heading;
      this.maxUnwrapped = heading;
    } else {
      this.unwrappedHeading += wrapAngle(heading - this.lastHeading);
      this.minUnwrapped = Math.min(this.minUnwrapped, this.unwrappedHeading);
      this.maxUnwrapped = Math.max(this.maxUnwrapped, this.unwrappedHeading);
    }
    this.lastHeading = heading;
    this.recorded.push({ t, heading, distanceCm });
  }

  get samples(): readonly SpinSample[] {
    return this.recorded;
  }

  get sampleCount(): number {
    return this.recorded.length;
  }

  get turnedRad(): number {
    return this.maxUnwrapped - this.minUnwrapped;
  }

  fit(): SpinFit {
    return fitSpin(this.recorded, this.turnedRad);
  }

  reset(): void {
    this.recorded = [];
    this.lastHeading = null;
    this.unwrappedHeading = 0;
    this.minUnwrapped = 0;
    this.maxUnwrapped = 0;
  }
}

export function fitSpin(samples: readonly SpinSample[], turnedRad = 0): SpinFit {
  const rejected = (reason: string): SpinFit => ({
    accepted: false,
    reason,
    sampleCount: samples.length,
    turnedRad,
    amplitudeCm: null,
    quality: null,
    residualCm: null,
    bearingUncertaintyRad: null,
    meanCm: null,
    driftCmPerSecond: null,
    closestHeadingRad: null,
    bearingRad: null,
  });

  if (samples.length < MIN_SPIN_SAMPLES) return rejected('too few readings');
  const bins = new Set(samples.map(({ heading }) => {
    const turn = ((heading % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return Math.min(COVERAGE_BIN_COUNT - 1, Math.floor(turn / (2 * Math.PI / COVERAGE_BIN_COUNT)));
  }));
  if (bins.size < MIN_SPIN_COVERAGE_BINS) return rejected('turn through a full circle');

  // A linear time term absorbs slow drift, such as the pivot wandering during the turn.
  const startT = samples[0].t;
  const seconds = samples.map(({ t }) => (t - startT) / 1000);
  const distances = samples.map(({ distanceCm }) => distanceCm);
  const waveModel = leastSquares(samples.map(({ heading }, index) => [1, Math.cos(heading), Math.sin(heading), seconds[index]]), distances);
  const driftModel = leastSquares(seconds.map((second) => [1, second]), distances);
  if (!waveModel || !driftModel) return rejected('fit failed');

  const [meanCm, cosine, sine, driftCmPerSecond] = waveModel.coefficients;
  const amplitudeCm = Math.hypot(cosine, sine);
  const quality = driftModel.squaredError > 0 ? Math.max(0, 1 - waveModel.squaredError / driftModel.squaredError) : 0;

  // Propagate the coefficient covariance, σ²·(XᵀX)⁻¹, through atan2(sine, cosine).
  const variance = waveModel.squaredError / Math.max(1, samples.length - 4);
  const [varCosine, varSine, covariance] = [waveModel.inverse[1][1], waveModel.inverse[2][2], waveModel.inverse[1][2]].map((value) => value * variance);
  const bearingUncertaintyRad = amplitudeCm > 0
    ? Math.sqrt(Math.max(0, sine ** 2 * varCosine + cosine ** 2 * varSine - 2 * cosine * sine * covariance)) / amplitudeCm ** 2
    : Number.POSITIVE_INFINITY;

  // The fitted wave peaks at atan2(sine, cosine), so the distance is shortest half a turn later.
  const closestHeadingRad = wrapAngle(Math.atan2(sine, cosine) + Math.PI);
  const fit: SpinFit = {
    accepted: true,
    reason: 'wave found',
    sampleCount: samples.length,
    turnedRad,
    amplitudeCm,
    quality,
    residualCm: Math.sqrt(waveModel.squaredError / samples.length),
    bearingUncertaintyRad,
    meanCm,
    driftCmPerSecond,
    closestHeadingRad,
    bearingRad: wrapAngle(closestHeadingRad + ANTENNA_ANGLE_FROM_TOP_RAD),
  };

  if (amplitudeCm < MIN_WAVE_AMPLITUDE_CM) return { ...fit, accepted: false, reason: 'wave too small' };
  if (amplitudeCm > MAX_WAVE_AMPLITUDE_CM) return { ...fit, accepted: false, reason: 'wave too large; phone moved' };
  if (bearingUncertaintyRad > MAX_BEARING_UNCERTAINTY_RAD) return { ...fit, accepted: false, reason: 'readings too noisy' };
  return fit;
}

const SHARED_SPIN_TYPE = 'spinFits';

/** Message for the other phone, so one spin places both phones on both screens. */
export function serializeSpinFits(fits: Partial<Record<'A' | 'B', SpinFit>>): string {
  return JSON.stringify({ type: SHARED_SPIN_TYPE, version: 1, fits });
}

/** Reads a spin result sent by the other phone; JSON turns an infinite uncertainty into null. */
export function parseSharedSpinFits(message: string): Partial<Record<'A' | 'B', SpinFit>> | null {
  try {
    const parsed = JSON.parse(message) as { type?: unknown; fits?: Record<string, unknown> };
    if (parsed.type !== SHARED_SPIN_TYPE || !parsed.fits || typeof parsed.fits !== 'object') return null;
    const fits: Partial<Record<'A' | 'B', SpinFit>> = {};
    (['A', 'B'] as const).forEach((role) => {
      const fit = parsed.fits?.[role] as SpinFit | undefined;
      if (fit && typeof fit.accepted === 'boolean' && typeof fit.reason === 'string') fits[role] = fit;
    });
    return fits;
  } catch {
    return null;
  }
}

/** Rotation that takes Phone B's reference frame into Phone A's, from a spin on each phone. */
export function spinFrameOffset(fitA: SpinFit | undefined, fitB: SpinFit | undefined): number | null {
  if (!fitA?.accepted || !fitB?.accepted || fitA.bearingRad == null || fitB.bearingRad == null) return null;
  // Seen from A, the bearing from B back to A is the A-to-B bearing plus half a turn.
  return wrapAngle(fitA.bearingRad + Math.PI - fitB.bearingRad);
}

export function selectSpinPosition(
  fitA: SpinFit | undefined,
  fitB: SpinFit | undefined,
  distanceCm: number | null,
  commonFrame: boolean,
): PositionEstimate {
  if (distanceCm == null || !Number.isFinite(distanceCm) || distanceCm < 0) {
    return { source: 'unknown', xCm: null, yCm: null, bearingRad: null, distanceCm: null, reason: 'distance unavailable or stale' };
  }
  const place = (bearing: number, reason: string): PositionEstimate => ({
    source: 'estimated',
    xCm: Math.cos(bearing) * distanceCm,
    yCm: Math.sin(bearing) * distanceCm,
    bearingRad: wrapAngle(bearing),
    distanceCm,
    reason,
  });
  if (fitA?.accepted && fitA.bearingRad != null) return place(fitA.bearingRad, 'spin test on Phone A');
  // B's bearing to A is in B's frame, so it only places B when both phones share magnetic north.
  if (fitB?.accepted && fitB.bearingRad != null && commonFrame) return place(fitB.bearingRad + Math.PI, 'spin test on Phone B');
  return { source: 'unknown', xCm: null, yCm: null, bearingRad: null, distanceCm, reason: 'no accepted spin test' };
}

function leastSquares(
  rows: number[][],
  values: number[],
): { coefficients: number[]; squaredError: number; inverse: number[][] } | null {
  const size = rows[0]?.length ?? 0;
  // Normal matrix XᵀX augmented with the identity, so Gauss–Jordan yields its inverse for the error estimate.
  const matrix: number[][] = Array.from({ length: size }, (_, row) => Array.from({ length: 2 * size }, (__, column) => (column === size + row ? 1 : 0)));
  const projected = new Array<number>(size).fill(0);
  rows.forEach((row, index) => {
    for (let i = 0; i < size; i += 1) {
      for (let j = 0; j < size; j += 1) matrix[i][j] += row[i] * row[j];
      projected[i] += row[i] * values[index];
    }
  });

  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
    }
    if (Math.abs(matrix[pivot][column]) < 1e-9) return null;
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    const scale = matrix[column][column];
    for (let k = 0; k < 2 * size; k += 1) matrix[column][k] /= scale;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = matrix[row][column];
      for (let k = 0; k < 2 * size; k += 1) matrix[row][k] -= factor * matrix[column][k];
    }
  }

  const inverse = matrix.map((row) => row.slice(size));
  const coefficients = inverse.map((row) => row.reduce((sum, value, column) => sum + value * projected[column], 0));
  const squaredError = rows.reduce((sum, row, index) => {
    const predicted = row.reduce((total, value, column) => total + value * coefficients[column], 0);
    return sum + (values[index] - predicted) ** 2;
  }, 0);
  return { coefficients, squaredError, inverse };
}
