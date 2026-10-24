import { DistanceEvent, MotionEvent, Quaternion, ReferenceFrame, Vector3 } from '../native/ParallaxModule';

export type GeometrySource = 'measured' | 'estimated' | 'manual' | 'unknown';

export type PositionEstimate = {
  source: GeometrySource;
  xCm: number | null;
  yCm: number | null;
  /** Direction from A to B, kept separately so it survives a zero distance. */
  bearingRad: number | null;
  distanceCm: number | null;
  reason: string;
};

export type RelativeRotation = {
  quaternion: Quaternion | null;
  yaw: number | null;
  pitch: number | null;
  roll: number | null;
  source: GeometrySource;
};

export const ZERO_VECTOR: Vector3 = { x: 0, y: 0, z: 0 };
export const IDENTITY_QUATERNION: Quaternion = { x: 0, y: 0, z: 0, w: 1 };
export const STALE_AFTER_MS = 1000;
/** Directions steeper than about 75° above or below the table say too little about where the peer is on it. */
export const MIN_HORIZONTAL_FRACTION = 0.25;

export function isFiniteVector(vector: Vector3 | undefined): vector is Vector3 {
  if (!vector) return false;
  return Number.isFinite(vector.x)
    && Number.isFinite(vector.y)
    && Number.isFinite(vector.z);
}

export function vectorMagnitude(vector: Vector3): number {
  return Math.sqrt(vector.x ** 2 + vector.y ** 2 + vector.z ** 2);
}

export function normalizeVector(vector: Vector3): Vector3 | null {
  const magnitude = vectorMagnitude(vector);
  if (!Number.isFinite(magnitude) || magnitude < 1e-6) return null;
  return { x: vector.x / magnitude, y: vector.y / magnitude, z: vector.z / magnitude };
}

export function quaternionNormalize(quaternion: Quaternion): Quaternion | null {
  const magnitude = Math.sqrt(quaternion.x ** 2 + quaternion.y ** 2 + quaternion.z ** 2 + quaternion.w ** 2);
  if (!Number.isFinite(magnitude) || magnitude < 1e-6) return null;
  return {
    x: quaternion.x / magnitude,
    y: quaternion.y / magnitude,
    z: quaternion.z / magnitude,
    w: quaternion.w / magnitude,
  };
}

export function quaternionMultiply(left: Quaternion, right: Quaternion): Quaternion {
  return {
    x: left.w * right.x + left.x * right.w + left.y * right.z - left.z * right.y,
    y: left.w * right.y - left.x * right.z + left.y * right.w + left.z * right.x,
    z: left.w * right.z + left.x * right.y - left.y * right.x + left.z * right.w,
    w: left.w * right.w - left.x * right.x - left.y * right.y - left.z * right.z,
  };
}

export function quaternionConjugate(quaternion: Quaternion): Quaternion {
  return { x: -quaternion.x, y: -quaternion.y, z: -quaternion.z, w: quaternion.w };
}

export function quaternionInverse(quaternion: Quaternion): Quaternion | null {
  const normalized = quaternionNormalize(quaternion);
  return normalized ? quaternionConjugate(normalized) : null;
}

export function rotateVectorByQuaternion(vector: Vector3, quaternion: Quaternion): Vector3 | null {
  const normalized = quaternionNormalize(quaternion);
  if (!normalized || !isFiniteVector(vector)) return null;
  const vectorQuaternion: Quaternion = { x: vector.x, y: vector.y, z: vector.z, w: 0 };
  const rotated = quaternionMultiply(quaternionMultiply(normalized, vectorQuaternion), quaternionConjugate(normalized));
  return { x: rotated.x, y: rotated.y, z: rotated.z };
}

/**
 * Core Motion's attitude quaternion rotates a device-local vector into the selected
 * reference frame (v_ref = q · v · q*). Nearby Interaction directions use the same
 * device axes. Device check: gravity transformed this way should read close to
 * (0, 0, -1) in any pose; the diagnostics panel shows it as WORLD GRAVITY.
 */
export function transformDirectionToReferenceFrame(
  direction: Vector3,
  attitudeQuaternion: Quaternion | undefined,
): Vector3 | null {
  if (!isFiniteVector(direction) || !attitudeQuaternion) return null;
  return rotateVectorByQuaternion(direction, attitudeQuaternion);
}

export function projectOntoTablePlane(vector: Vector3, gravity: Vector3 | undefined): Vector3 | null {
  if (!isFiniteVector(vector)) return null;
  const normalizedGravity = gravity && normalizeVector(gravity);
  if (!normalizedGravity) return { x: vector.x, y: vector.y, z: 0 };
  const dot = vector.x * normalizedGravity.x + vector.y * normalizedGravity.y + vector.z * normalizedGravity.z;
  return {
    x: vector.x - dot * normalizedGravity.x,
    y: vector.y - dot * normalizedGravity.y,
    z: vector.z - dot * normalizedGravity.z,
  };
}

export function positionFromDistanceAndDirection(
  distanceCm: number | undefined,
  direction: Vector3 | undefined,
  gravity?: Vector3,
): PositionEstimate {
  if (distanceCm == null || !Number.isFinite(distanceCm) || distanceCm < 0) {
    return { source: 'unknown', xCm: null, yCm: null, bearingRad: null, distanceCm: null, reason: 'distance unavailable' };
  }
  if (!direction || !isFiniteVector(direction)) {
    return { source: 'unknown', xCm: null, yCm: null, bearingRad: null, distanceCm, reason: 'direction unavailable' };
  }
  const unit = normalizeVector(direction);
  if (!unit) {
    return { source: 'unknown', xCm: null, yCm: null, bearingRad: null, distanceCm, reason: 'direction invalid' };
  }
  // The projection of a unit vector is the horizontal share of the distance, so it is not renormalized.
  const horizontal = projectOntoTablePlane(unit, gravity);
  if (!horizontal || vectorMagnitude(horizontal) < MIN_HORIZONTAL_FRACTION) {
    return { source: 'unknown', xCm: null, yCm: null, bearingRad: null, distanceCm, reason: 'direction mostly vertical' };
  }
  return {
    source: 'measured',
    xCm: horizontal.x * distanceCm,
    yCm: horizontal.y * distanceCm,
    bearingRad: Math.atan2(horizontal.y, horizontal.x),
    distanceCm,
    reason: 'native direction and distance',
  };
}

export function invertPositionEstimate(position: PositionEstimate): PositionEstimate {
  if (position.xCm == null || position.yCm == null) return position;
  return {
    ...position,
    xCm: -position.xCm,
    yCm: -position.yCm,
    bearingRad: position.bearingRad == null ? null : wrapAngle(position.bearingRad + Math.PI),
  };
}

export function calculateRelativeRotation(
  rotationA: Quaternion | undefined,
  rotationB: Quaternion | undefined,
  source: GeometrySource = 'measured',
): RelativeRotation {
  if (!rotationA || !rotationB) return { quaternion: null, yaw: null, pitch: null, roll: null, source: 'unknown' };
  const inverseA = quaternionInverse(rotationA);
  const normalizedB = quaternionNormalize(rotationB);
  if (!inverseA || !normalizedB) return { quaternion: null, yaw: null, pitch: null, roll: null, source: 'unknown' };
  const relative = quaternionNormalize(quaternionMultiply(inverseA, normalizedB));
  if (!relative) return { quaternion: null, yaw: null, pitch: null, roll: null, source: 'unknown' };
  const { x, y, z, w } = relative;
  return {
    quaternion: relative,
    yaw: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)),
    pitch: Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x)))),
    roll: Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)),
    source,
  };
}

/**
 * Heading of a phone on the table plane, in radians anticlockwise from the reference X axis.
 * Uses the top edge, or the back of the phone once it is held more upright than about 60°,
 * because the top edge then points mostly upward and Euler yaw becomes unstable.
 */
export function tablePlaneHeading(attitudeQuaternion: Quaternion | undefined): number | null {
  if (!attitudeQuaternion) return null;
  const top = rotateVectorByQuaternion({ x: 0, y: 1, z: 0 }, attitudeQuaternion);
  if (!top) return null;
  const pointer = Math.hypot(top.x, top.y) >= 0.5
    ? top
    : rotateVectorByQuaternion({ x: 0, y: 0, z: -1 }, attitudeQuaternion);
  if (!pointer || Math.hypot(pointer.x, pointer.y) < 1e-6) return null;
  return Math.atan2(pointer.y, pointer.x);
}

export function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/**
 * Readings are timed with this phone's clock on arrival (`receivedAt`), so remote clock skew
 * cannot make them stale. A slightly negative age only means the reading arrived after the
 * caller's clock last ticked; anything further in the future is rejected.
 */
export function isFresh(timestamp: number | undefined, now = Date.now(), staleAfterMs = STALE_AFTER_MS): boolean {
  if (timestamp == null || !Number.isFinite(timestamp)) return false;
  const age = now - timestamp;
  return age <= staleAfterMs && age >= -staleAfterMs;
}

export function hasCommonFrame(
  frameA: ReferenceFrame | undefined,
  frameB: ReferenceFrame | undefined,
): boolean {
  return Boolean(frameA && frameB && frameA !== 'unavailable' && frameA === frameB && frameA === 'xMagneticNorthZVertical');
}

export function selectPositionMeasurement(
  measurementA: DistanceEvent | null,
  measurementB: DistanceEvent | null,
  motionA: MotionEvent | null,
  motionB: MotionEvent | null,
  _role: 'A' | 'B' = 'A',
  now = Date.now(),
): PositionEstimate {
  const distanceCm = measurementA?.distanceCm ?? measurementB?.distanceCm ?? null;
  if (!hasCommonFrame(motionA?.referenceFrame, motionB?.referenceFrame) || !motionA?.valid || !motionB?.valid) {
    return { source: 'unknown', xCm: null, yCm: null, bearingRad: null, distanceCm, reason: 'common magnetic frame unavailable' };
  }

  const candidates = [
    { role: 'A' as const, measurement: measurementA, motion: motionA },
    { role: 'B' as const, measurement: measurementB, motion: motionB },
  ];
  const first = candidates.find(({ measurement, motion }) =>
    measurement?.directionValid
    && measurement.distanceAvailable
    && isFresh(measurement.receivedAt ?? measurement.measurementTimestamp, now)
    && isFresh(motion.receivedAt ?? motion.timestamp, now));
  if (!first?.measurement) return { source: 'unknown', xCm: null, yCm: null, bearingRad: null, distanceCm, reason: 'no fresh valid direction' };

  const transformedDirection = transformDirectionToReferenceFrame(
    first.measurement.direction!,
    first.motion.attitudeQuaternion,
  );
  const transformedGravity = first.motion.gravity && first.motion.attitudeQuaternion
    ? transformDirectionToReferenceFrame(first.motion.gravity, first.motion.attitudeQuaternion) ?? undefined
    : undefined;
  const position = positionFromDistanceAndDirection(first.measurement.distanceCm, transformedDirection ?? undefined, transformedGravity);
  return first.role === 'B' ? invertPositionEstimate(position) : position;
}
