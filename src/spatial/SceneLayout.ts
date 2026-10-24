import { PositionEstimate, wrapAngle } from './SpatialMath';

export type PhoneSize = { widthCm: number; lengthCm: number };
export type ScenePoint = { xCm: number; yCm: number };

/** Between the two test phones: iPhone 17 is about 7.2 × 15.0 cm, iPhone 14 Plus about 7.8 × 16.1 cm. */
export const PHONE_SIZE_CM: PhoneSize = { widthCm: 7.5, lengthCm: 15.5 };
/** Phones without a known heading are drawn top edge up, along reference +Y. */
export const DEFAULT_HEADING_RAD = Math.PI / 2;

export type PhonePairLayout = {
  centreB: ScenePoint;
  gapStart: ScenePoint;
  gapEnd: ScenePoint;
  /** Measured distance, centre to centre. */
  distanceCm: number;
  /** Space left between the outlines once half of each phone is taken off the distance. */
  gapCm: number;
  /** The distance is shorter than the phones allow, so they are drawn touching. */
  touching: boolean;
};

/** Rotation that turns `upHeadingRad`, such as Phone A's starting heading, to point up the view (+Y). */
export function viewRotation(upHeadingRad: number | null): number {
  return upHeadingRad == null ? 0 : wrapAngle(DEFAULT_HEADING_RAD - upHeadingRad);
}

/** Turns a position about Phone A by `angleRad`, for drawing in a rotated view. */
export function rotatePosition(position: PositionEstimate, angleRad: number): PositionEstimate {
  if (position.xCm == null || position.yCm == null) return position;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return {
    ...position,
    xCm: position.xCm * cos - position.yCm * sin,
    yCm: position.xCm * sin + position.yCm * cos,
    bearingRad: position.bearingRad == null ? null : wrapAngle(position.bearingRad + angleRad),
  };
}

/** Half a phone's extent along `directionRad`, for a phone whose top edge points along `headingRad`. */
export function phoneHalfExtentCm(directionRad: number, headingRad: number, size: PhoneSize = PHONE_SIZE_CM): number {
  const relative = directionRad - headingRad;
  return (size.widthCm / 2) * Math.abs(Math.sin(relative)) + (size.lengthCm / 2) * Math.abs(Math.cos(relative));
}

/**
 * Places Phone B around Phone A at the origin. The measured distance runs centre to centre, so
 * the visible gap is that distance less half of each phone along the line joining them. A
 * distance shorter than that draws the phones touching rather than overlapping; outlines whose
 * projections on that line do not overlap cannot overlap at all.
 */
export function layoutPhonePair(
  position: PositionEstimate,
  headingA: number | null,
  headingB: number | null,
  size: PhoneSize = PHONE_SIZE_CM,
): PhonePairLayout | null {
  if (position.xCm == null || position.yCm == null || position.bearingRad == null) return null;
  const distanceCm = Math.hypot(position.xCm, position.yCm);
  const along = (fromACm: number): ScenePoint => ({
    xCm: Math.cos(position.bearingRad!) * fromACm,
    yCm: Math.sin(position.bearingRad!) * fromACm,
  });
  const reachA = phoneHalfExtentCm(position.bearingRad, headingA ?? DEFAULT_HEADING_RAD, size);
  const reachB = phoneHalfExtentCm(position.bearingRad, headingB ?? DEFAULT_HEADING_RAD, size);
  const centreDistanceCm = Math.max(distanceCm, reachA + reachB);
  const gapCm = centreDistanceCm - reachA - reachB;
  return {
    centreB: along(centreDistanceCm),
    gapStart: along(reachA),
    gapEnd: along(reachA + gapCm),
    distanceCm,
    gapCm,
    touching: distanceCm <= reachA + reachB,
  };
}
