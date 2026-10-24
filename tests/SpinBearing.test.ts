import { wrapAngle } from '../src/spatial/SpatialMath';
import {
  parseSharedSpinFits,
  selectSpinPosition,
  serializeSpinFits,
  SpinFit,
  spinFrameOffset,
  SpinRecording,
} from '../src/spatial/SpinBearing';

const DEG = Math.PI / 180;

type SpinOptions = {
  bearingDeg: number;
  separationCm?: number;
  antennaCm?: number;
  fromDeg?: number;
  toDeg?: number;
  backAgain?: boolean;
  noiseCm?: number;
  driftCmPerSecond?: number;
  samples?: number;
};

/** Simulates a phone swung flat about a pivot, with its antenna straight up from it, ranging a fixed peer. */
const simulateSpin = ({
  bearingDeg,
  separationCm = 80,
  antennaCm = 6,
  fromDeg = 0,
  toDeg = 360,
  backAgain = true,
  noiseCm = 0.5,
  driftCmPerSecond = 0,
  samples = 120,
}: SpinOptions): SpinRecording => {
  const recording = new SpinRecording();
  const peerX = separationCm * Math.cos(bearingDeg * DEG);
  const peerY = separationCm * Math.sin(bearingDeg * DEG);
  const sweep = Array.from({ length: samples }, (_, index) => fromDeg + ((toDeg - fromDeg) * index) / (samples - 1));
  const headings = backAgain ? [...sweep, ...[...sweep].reverse()] : sweep;
  headings.forEach((headingDeg, index) => {
    const heading = headingDeg * DEG;
    const t = index * 50;
    const distance = Math.hypot(peerX - antennaCm * Math.cos(heading), peerY - antennaCm * Math.sin(heading));
    const noise = noiseCm * Math.sin(index * 12.9898 + 0.5);
    recording.add(t, wrapAngle(heading), distance + noise + (driftCmPerSecond * t) / 1000);
  });
  return recording;
};

const acceptedFit = (bearingDeg: number): SpinFit => ({
  accepted: true,
  reason: 'wave found',
  sampleCount: 100,
  turnedRad: 2 * Math.PI,
  amplitudeCm: 6,
  quality: 0.9,
  residualCm: 0.5,
  bearingUncertaintyRad: DEG,
  meanCm: 80,
  driftCmPerSecond: 0,
  closestHeadingRad: bearingDeg * DEG,
  bearingRad: wrapAngle(bearingDeg * DEG),
});

test('recovers the bearing to the other phone from a full spin', () => {
  const fit = simulateSpin({ bearingDeg: 30 }).fit();
  expect(fit.accepted).toBe(true);
  expect(Math.abs(wrapAngle(fit.bearingRad! - 30 * DEG))).toBeLessThan(3 * DEG);
  expect(fit.amplitudeCm).toBeCloseTo(6, 0);
  expect(fit.bearingUncertaintyRad).toBeLessThan(2 * DEG);
});

test('accepts a noisy wave when enough readings pin down the bearing', () => {
  // Per-reading noise as large as the wave, which a variance-share test would reject.
  const fit = simulateSpin({ bearingDeg: 120, antennaCm: 4, noiseCm: 5.5, samples: 200 }).fit();
  expect(fit.quality).toBeLessThan(0.6);
  expect(fit.accepted).toBe(true);
  expect(Math.abs(wrapAngle(fit.bearingRad! - 120 * DEG))).toBeLessThan(3 * fit.bearingUncertaintyRad!);
});

test('bottom-edge pivot gives a phone-length wave', () => {
  const fit = simulateSpin({ bearingDeg: -20, antennaCm: 14, noiseCm: 3 }).fit();
  expect(fit.accepted).toBe(true);
  expect(fit.amplitudeCm).toBeGreaterThan(12);
  expect(fit.bearingUncertaintyRad).toBeLessThan(2 * DEG);
});

test('recovers bearings on every side, including across the ±180° seam', () => {
  [-150, -60, 90, 179].forEach((bearingDeg) => {
    const fit = simulateSpin({ bearingDeg, fromDeg: 100, toDeg: 460 }).fit();
    expect(fit.accepted).toBe(true);
    expect(Math.abs(wrapAngle(fit.bearingRad! - bearingDeg * DEG))).toBeLessThan(3 * DEG);
  });
});

test('unwraps the heading to measure how far the phone turned', () => {
  const recording = simulateSpin({ bearingDeg: 0, fromDeg: 170, toDeg: 530, backAgain: false });
  expect(recording.turnedRad).toBeCloseTo(2 * Math.PI, 1);
});

test('tolerates slow drift of the spin centre', () => {
  const fit = simulateSpin({ bearingDeg: -45, driftCmPerSecond: 2 }).fit();
  expect(fit.accepted).toBe(true);
  expect(Math.abs(wrapAngle(fit.bearingRad! + 45 * DEG))).toBeLessThan(3 * DEG);
});

test('rejects a spin that does not cover a full circle', () => {
  const fit = simulateSpin({ bearingDeg: 30, toDeg: 180 }).fit();
  expect(fit).toMatchObject({ accepted: false, reason: 'turn through a full circle', bearingRad: null });
});

test('rejects too few readings', () => {
  expect(simulateSpin({ bearingDeg: 30, samples: 8, backAgain: false }).fit().reason).toBe('too few readings');
});

test('rejects a spin with no visible wave', () => {
  const fit = simulateSpin({ bearingDeg: 30, antennaCm: 0 }).fit();
  expect(fit).toMatchObject({ accepted: false, reason: 'wave too small' });
});

test('rejects a wave buried in noise', () => {
  const fit = simulateSpin({ bearingDeg: 30, antennaCm: 1.5, noiseCm: 12, samples: 40 }).fit();
  expect(fit).toMatchObject({ accepted: false, reason: 'readings too noisy' });
  expect(fit.bearingUncertaintyRad).toBeGreaterThan(10 * DEG);
});

test('derives the frame offset between phones from a spin on each', () => {
  // B's frame is turned 50° from A's: A sees B at 30°, so B sees A at 210° − 50° = 160° in its own frame.
  expect(spinFrameOffset(acceptedFit(30), acceptedFit(160))).toBeCloseTo(50 * DEG);
  expect(spinFrameOffset(acceptedFit(30), undefined)).toBeNull();
  expect(spinFrameOffset(acceptedFit(30), { ...acceptedFit(160), accepted: false })).toBeNull();
});

test('places Phone B as estimated from a spin on Phone A', () => {
  const position = selectSpinPosition(acceptedFit(90), undefined, 100, false);
  expect(position.source).toBe('estimated');
  expect(position.xCm).toBeCloseTo(0);
  expect(position.yCm).toBeCloseTo(100);
});

test('uses a spin on Phone B only when both phones share magnetic north', () => {
  expect(selectSpinPosition(undefined, acceptedFit(180), 100, false).source).toBe('unknown');
  const position = selectSpinPosition(undefined, acceptedFit(180), 100, true);
  expect(position.source).toBe('estimated');
  expect(position.xCm).toBeCloseTo(100);
  expect(position.yCm).toBeCloseTo(0);
});

test('keeps the position unknown without a fresh distance or an accepted spin', () => {
  expect(selectSpinPosition(acceptedFit(90), undefined, null, false).reason).toBe('distance unavailable or stale');
  expect(selectSpinPosition({ ...acceptedFit(90), accepted: false }, undefined, 100, false).reason).toBe('no accepted spin test');
});

test('shares a spin result with the other phone', () => {
  const rejected = simulateSpin({ bearingDeg: 30, toDeg: 180 }).fit();
  const shared = parseSharedSpinFits(serializeSpinFits({ A: acceptedFit(30), B: rejected }));
  expect(shared?.A).toEqual(acceptedFit(30));
  expect(shared?.B).toMatchObject({ accepted: false, reason: 'turn through a full circle' });
});

test('ignores messages that are not spin results', () => {
  expect(parseSharedSpinFits('not json')).toBeNull();
  expect(parseSharedSpinFits(JSON.stringify({ type: 'other', fits: {} }))).toBeNull();
  expect(parseSharedSpinFits(JSON.stringify({ type: 'spinFits', fits: { A: { bearingRad: 1 } } }))).toEqual({});
});
