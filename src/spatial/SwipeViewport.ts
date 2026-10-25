export type SwipeRole = 'A' | 'B';

export type SwipeViewport = {
  role: SwipeRole;
  centreCm: { x: number; y: number };
  headingRad: number;
  widthCm: number;
  heightCm: number;
  confidence: number;
  receivedAt: number;
  stale: boolean;
};

export type SwipePose = Omit<SwipeViewport, 'receivedAt' | 'stale'>;

const wrap = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));

export function interpolatePose(from: SwipeViewport, to: SwipeViewport, amount: number, now: number): SwipeViewport {
  const t = Math.max(0, Math.min(1, amount));
  return {
    role: to.role,
    centreCm: {
      x: from.centreCm.x + (to.centreCm.x - from.centreCm.x) * t,
      y: from.centreCm.y + (to.centreCm.y - from.centreCm.y) * t,
    },
    headingRad: from.headingRad + wrap(to.headingRad - from.headingRad) * t,
    widthCm: from.widthCm + (to.widthCm - from.widthCm) * t,
    heightCm: from.heightCm + (to.heightCm - from.heightCm) * t,
    confidence: Math.min(from.confidence, to.confidence),
    receivedAt: now,
    stale: false,
  };
}

export function markStale(viewport: SwipeViewport, now: number, timeoutMs = 1200): SwipeViewport {
  return { ...viewport, receivedAt: viewport.receivedAt, stale: now - viewport.receivedAt > timeoutMs };
}

/** Converts tabletop centimetres to a phone-local media transform. */
export function mediaTransform(viewport: SwipeViewport, scalePxPerCm: number, originCm: { x: number; y: number }) {
  return {
    translateX: (originCm.x - viewport.centreCm.x) * scalePxPerCm,
    translateY: (originCm.y - viewport.centreCm.y) * scalePxPerCm,
    rotate: `${(-viewport.headingRad * 180) / Math.PI}deg`,
  };
}
