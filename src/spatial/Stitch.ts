import { PositionEstimate, wrapAngle } from './SpatialMath';

export type PhoneRole = 'A' | 'B';
export type ScreenEdge = 'left' | 'right' | 'top' | 'bottom';
/** Millimetres from the screen centre; +x to the right, +y towards the top edge. */
export type PointMm = { x: number; y: number };
/** A touch in screen points from the top-left corner, with the touch event's own clock. */
export type TouchSample = { xPt: number; yPt: number; tMs: number };
export type ScreenSize = { widthPt: number; heightPt: number };

/** Both test phones are about 460 ppi at 3× scale: 460 / 3 / 25.4 ≈ 6.0 points per millimetre. */
export const POINTS_PER_MM = 6.02;
/** Screen edge to the outside of the phone, frame plus a thin case; two of these lie between joined screens. */
export const BEZEL_MM = 3.5;
/** A swipe has to end (or start) within this distance of an edge, along its own direction. */
export const EDGE_REACH_MM = 12;
/** The direction next to the edge needs at least this much trail, and is fitted over up to the span. */
export const DIRECTION_BASE_MM = 8;
export const DIRECTION_SPAN_MM = 25;
/** Lifting a finger near an edge is not leaving the screen; the finger has to be travelling. */
export const MIN_EDGE_SPEED_MM_PER_S = 40;
/** The exit on one phone and the entry on the other have to fall within this window. */
export const SWIPE_MATCH_WINDOW_MS = 700;
/** Allows an entry timed slightly before its exit, because the relayed time ignores Multipeer latency. */
const SWIPE_MATCH_EARLY_MS = 150;
/** Relative yaw within this of a quarter turn snaps to it: phones laid edge to edge are usually square. */
export const SNAP_TOLERANCE_RAD = (12 * Math.PI) / 180;
/** UWB antenna position, from the screen centre towards the top edge. */
export const ANTENNA_FROM_CENTRE_CM = 5.5;
/** UWB disagreeing with the join by more than this, for longer than the hold, means a phone was moved. */
export const MOVED_THRESHOLD_CM = 5;
export const MOVED_HOLD_MS = 700;
const BASELINE_SAMPLES = 5;
const STITCH_MESSAGE_TYPE = 'parallax.stitch';

/** Where a swipe crossed the screen boundary. */
export type EdgeCrossing = {
  edge: ScreenEdge;
  pointMm: PointMm;
  /** Direction of travel in the screen frame, anticlockwise from +x. */
  directionRad: number;
  speedMmPerS: number;
};

export type SwipeReport = EdgeCrossing & {
  kind: 'exit' | 'entry';
  role: PhoneRole;
  /** The reporting phone's table heading in its own motion frame when the swipe happened. */
  headingRad: number | null;
  /** Identifies the reporting phone's motion frame, which restarts when Core Motion restarts. */
  frameId: number | null;
  /** When the finger crossed the edge, on the matching phone's clock. */
  atMs: number;
};

export type Stitch = {
  id: string;
  createdAt: number;
  /** Phone B's centre in Phone A's motion reference frame, in cm; Phone A's centre is the origin. */
  centreB: { xCm: number; yCm: number };
  /** Added to Phone B's own heading to give its heading in Phone A's reference frame. */
  yawOffsetRad: number;
  /** Phone B's screen turned anticlockwise relative to Phone A's, at the moment of joining. */
  relativeYawRad: number;
  snapped: boolean;
  /** The phone the swipe started on. */
  from: PhoneRole;
  frameIds: Record<PhoneRole, number | null>;
};

export type StitchState = { stitch: Stitch; status: 'joined' | 'moved'; reason?: string };

export type StitchResult = { stitch: Stitch; reason?: undefined } | { stitch: null; reason: string };

export type StitchedLayout = { position: PositionEstimate; headingA: number | null; headingB: number | null };

export type StitchMessage =
  | { type: 'swipe'; report: Omit<SwipeReport, 'atMs'>; ageMs: number }
  | { type: 'state'; state: StitchState | null }
  | { type: 'join' };

const rotate = ({ x, y }: PointMm, angleRad: number): PointMm => ({
  x: x * Math.cos(angleRad) - y * Math.sin(angleRad),
  y: x * Math.sin(angleRad) + y * Math.cos(angleRad),
});

const toMm = (sample: TouchSample, screen: ScreenSize, pointsPerMm: number): PointMm => ({
  x: (sample.xPt - screen.widthPt / 2) / pointsPerMm,
  y: (screen.heightPt / 2 - sample.yPt) / pointsPerMm,
});

/** First screen edge hit travelling from `point` along unit `direction`, and how far away it is. */
function rayToEdge(point: PointMm, direction: PointMm, halfWidth: number, halfHeight: number): { edge: ScreenEdge; distanceMm: number } {
  const alongX = direction.x > 1e-9 ? (halfWidth - point.x) / direction.x : direction.x < -1e-9 ? (-halfWidth - point.x) / direction.x : Infinity;
  const alongY = direction.y > 1e-9 ? (halfHeight - point.y) / direction.y : direction.y < -1e-9 ? (-halfHeight - point.y) / direction.y : Infinity;
  return alongX <= alongY
    ? { edge: direction.x > 0 ? 'right' : 'left', distanceMm: Math.max(0, alongX) }
    : { edge: direction.y > 0 ? 'top' : 'bottom', distanceMm: Math.max(0, alongY) };
}

/** Unit direction of the best-fit line through `points`, pointing the same way as `along`. */
function fitDirection(points: readonly PointMm[], along: PointMm): PointMm {
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  points.forEach(({ x, y }) => {
    xx += (x - meanX) ** 2;
    yy += (y - meanY) ** 2;
    xy += (x - meanX) * (y - meanY);
  });
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  const direction = { x: Math.cos(angle), y: Math.sin(angle) };
  return direction.x * along.x + direction.y * along.y >= 0 ? direction : { x: -direction.x, y: -direction.y };
}

/**
 * Reads one finger trail for the two halves of a join: leaving this screen across an edge
 * (`exit`) and arriving from across an edge (`entry`). The last (or first) touch sample is
 * rarely on the edge itself, so a line fitted to the trail next to that end is followed out
 * to the screen boundary. One trail can be both, when a finger crosses a phone completely.
 */
export function classifySwipe(
  trail: readonly TouchSample[],
  screen: ScreenSize,
  pointsPerMm = POINTS_PER_MM,
): { exit: EdgeCrossing | null; entry: EdgeCrossing | null } {
  const points = trail.map((sample) => toMm(sample, screen, pointsPerMm));
  const halfWidth = screen.widthPt / pointsPerMm / 2;
  const halfHeight = screen.heightPt / pointsPerMm / 2;
  const distance = (left: PointMm, right: PointMm) => Math.hypot(left.x - right.x, left.y - right.y);

  const crossing = (end: number, step: 1 | -1, kind: 'exit' | 'entry'): EdgeCrossing | null => {
    let base = end;
    while (base + step >= 0 && base + step < points.length && distance(points[end], points[base + step]) <= DIRECTION_SPAN_MM) base += step;
    const lengthMm = distance(points[end], points[base]);
    if (lengthMm < DIRECTION_BASE_MM) return null;
    const span = points.slice(Math.min(base, end), Math.max(base, end) + 1);
    // Exit travels towards the end of the trail, entry away from its start.
    const travel = kind === 'exit'
      ? fitDirection(span, { x: points[end].x - points[base].x, y: points[end].y - points[base].y })
      : fitDirection(span, { x: points[base].x - points[end].x, y: points[base].y - points[end].y });
    const elapsedMs = Math.abs(trail[end].tMs - trail[base].tMs);
    const speedMmPerS = elapsedMs > 0 ? (lengthMm / elapsedMs) * 1000 : Infinity;
    if (speedMmPerS < MIN_EDGE_SPEED_MM_PER_S) return null;
    const outward = kind === 'exit' ? travel : { x: -travel.x, y: -travel.y };
    const hit = rayToEdge(points[end], outward, halfWidth, halfHeight);
    if (hit.distanceMm > EDGE_REACH_MM) return null;
    return {
      edge: hit.edge,
      pointMm: { x: points[end].x + outward.x * hit.distanceMm, y: points[end].y + outward.y * hit.distanceMm },
      directionRad: Math.atan2(travel.y, travel.x),
      speedMmPerS,
    };
  };

  if (points.length < 2) return { exit: null, entry: null };
  return { exit: crossing(points.length - 1, -1, 'exit'), entry: crossing(0, 1, 'entry') };
}

/** The closest-timed exit on one phone and entry on the other, if any fall within the window. */
export function matchSwipes(
  reports: readonly SwipeReport[],
  windowMs = SWIPE_MATCH_WINDOW_MS,
): { exit: SwipeReport; entry: SwipeReport } | null {
  let best: { exit: SwipeReport; entry: SwipeReport; gapMs: number } | null = null;
  reports.filter((report) => report.kind === 'exit').forEach((exit) => {
    reports.filter((report) => report.kind === 'entry' && report.role !== exit.role).forEach((entry) => {
      const gapMs = entry.atMs - exit.atMs;
      if (gapMs < -SWIPE_MATCH_EARLY_MS || gapMs > windowMs) return;
      if (!best || Math.abs(gapMs) < Math.abs(best.gapMs)) best = { exit, entry, gapMs };
    });
  });
  const match = best as { exit: SwipeReport; entry: SwipeReport } | null;
  return match && { exit: match.exit, entry: match.entry };
}

/**
 * Joins the two screens from one swipe. The finger keeps one physical direction, so the
 * difference between its direction on each screen is how far one screen is turned against
 * the other. It crosses the two bezels in a straight line, which places the entry point
 * relative to the exit point, and through it the second phone's centre. The phones' own
 * headings at that moment then tie Phone B's motion frame to Phone A's, so the gyroscopes
 * can follow later turns of either phone.
 */
export function computeStitch(
  exit: SwipeReport,
  entry: SwipeReport,
  createdAt: number,
  bezelMm = BEZEL_MM,
): StitchResult {
  if (exit.role === entry.role) return { stitch: null, reason: 'exit and entry are on the same phone' };
  const reportA = exit.role === 'A' ? exit : entry;
  const reportB = exit.role === 'B' ? exit : entry;
  if (reportA.headingRad == null) return { stitch: null, reason: 'Phone A heading unavailable; motion is not running' };
  if (reportB.headingRad == null) return { stitch: null, reason: 'Phone B heading unavailable; motion is not running' };

  // Turn of the entry phone's screen against the exit phone's: the same direction read in both frames.
  let turn = wrapAngle(exit.directionRad - entry.directionRad);
  const quarter = Math.round(turn / (Math.PI / 2)) * (Math.PI / 2);
  const snapped = Math.abs(wrapAngle(turn - quarter)) <= SNAP_TOLERANCE_RAD;
  if (snapped) turn = wrapAngle(quarter);

  const across = 2 * bezelMm;
  const entryInExit = {
    x: exit.pointMm.x + Math.cos(exit.directionRad) * across,
    y: exit.pointMm.y + Math.sin(exit.directionRad) * across,
  };
  const entryOffset = rotate(entry.pointMm, turn);
  const entryCentreInExit = { x: entryInExit.x - entryOffset.x, y: entryInExit.y - entryOffset.y };

  // Express Phone B in Phone A's screen frame, inverting when the swipe ran from B to A.
  const relativeYawRad = exit.role === 'A' ? turn : wrapAngle(-turn);
  const centreBInScreenA = exit.role === 'A' ? entryCentreInExit : rotate(entryCentreInExit, relativeYawRad + Math.PI);

  // Phone A's screen +y (its top edge) points along its heading, so +x lies a quarter turn clockwise of it.
  const centreB = rotate(centreBInScreenA, reportA.headingRad - Math.PI / 2);
  return {
    stitch: {
      id: `${createdAt}`,
      createdAt,
      centreB: { xCm: centreB.x / 10, yCm: centreB.y / 10 },
      yawOffsetRad: wrapAngle(reportA.headingRad + relativeYawRad - reportB.headingRad),
      relativeYawRad,
      snapped,
      from: exit.role,
      frameIds: { A: reportA.frameId, B: reportB.frameId },
    },
  };
}

/**
 * Current layout from a join and both phones' gyro headings. Each phone is assumed to turn
 * about its own centre; sliding a phone is not tracked, which the UWB check catches instead.
 */
export function stitchedLayout(stitch: Stitch, headingA: number | null, ownHeadingB: number | null): StitchedLayout {
  const { xCm, yCm } = stitch.centreB;
  return {
    position: {
      source: 'stitched',
      xCm,
      yCm,
      bearingRad: Math.atan2(yCm, xCm),
      distanceCm: Math.hypot(xCm, yCm),
      reason: 'swipe join',
    },
    headingA,
    headingB: ownHeadingB == null ? null : wrapAngle(ownHeadingB + stitch.yawOffsetRad),
  };
}

/** Antenna-to-antenna distance the join predicts, for comparison with UWB; headings are in A's frame. */
export function predictedAntennaDistanceCm(stitch: Stitch, headingA: number, headingB: number): number {
  const antennaA = { x: Math.cos(headingA) * ANTENNA_FROM_CENTRE_CM, y: Math.sin(headingA) * ANTENNA_FROM_CENTRE_CM };
  const antennaB = {
    x: stitch.centreB.xCm + Math.cos(headingB) * ANTENNA_FROM_CENTRE_CM,
    y: stitch.centreB.yCm + Math.sin(headingB) * ANTENNA_FROM_CENTRE_CM,
  };
  return Math.hypot(antennaB.x - antennaA.x, antennaB.y - antennaA.y);
}

/**
 * Uses UWB only to notice that the phones have been moved apart (or together) since the join.
 * UWB's absolute bias near touching phones is unknown, so only its change is compared with
 * the change the join predicts from rotation, starting from the median of the first readings.
 */
export class MovedApartCheck {
  private offsets: number[] = [];
  private baselineCm: number | null = null;
  private outsideSince: number | null = null;

  constructor(
    private readonly thresholdCm = MOVED_THRESHOLD_CM,
    private readonly holdMs = MOVED_HOLD_MS,
  ) {}

  observe(measuredCm: number, predictedCm: number, now: number): { residualCm: number | null; moved: boolean } {
    if (!Number.isFinite(measuredCm) || !Number.isFinite(predictedCm)) return { residualCm: null, moved: false };
    const offset = measuredCm - predictedCm;
    if (this.baselineCm == null) {
      this.offsets.push(offset);
      if (this.offsets.length < BASELINE_SAMPLES) return { residualCm: null, moved: false };
      const sorted = [...this.offsets].sort((left, right) => left - right);
      this.baselineCm = sorted[Math.floor(sorted.length / 2)];
    }
    const residualCm = offset - this.baselineCm;
    if (Math.abs(residualCm) <= this.thresholdCm) {
      this.outsideSince = null;
      return { residualCm, moved: false };
    }
    this.outsideSince = this.outsideSince ?? now;
    return { residualCm, moved: now - this.outsideSince >= this.holdMs };
  }

  reset(): void {
    this.offsets = [];
    this.baselineCm = null;
    this.outsideSince = null;
  }
}

export function serializeStitchMessage(message: StitchMessage): string {
  return JSON.stringify({ type: STITCH_MESSAGE_TYPE, version: 1, message });
}

export function parseStitchMessage(text: string): StitchMessage | null {
  try {
    const parsed = JSON.parse(text) as { type?: unknown; message?: { type?: unknown } };
    if (parsed.type !== STITCH_MESSAGE_TYPE || !parsed.message || typeof parsed.message !== 'object') return null;
    const kind = parsed.message.type;
    return kind === 'swipe' || kind === 'state' || kind === 'join' ? parsed.message as StitchMessage : null;
  } catch {
    return null;
  }
}
