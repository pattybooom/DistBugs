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

/** RN matrix about the image centre: inverse phone pose, +Y up table to +Y down display. */
export function tabletopMediaPlacement(viewport: SwipeViewport, screen: { width: number; height: number },
  media: { width: number; height: number }, area: { widthCm: number; heightCm: number }) {
  const cmPerPixel = Math.min(area.widthCm / media.width, area.heightCm / media.height);
  const sx = screen.width / viewport.widthCm, sy = screen.height / viewport.heightCm;
  const s = Math.sin(viewport.headingRad), c = Math.cos(viewport.headingRad);
  const dx = area.widthCm / 2 - viewport.centreCm.x, dy = area.heightCm / 2 - viewport.centreCm.y;
  return {
    width: media.width * cmPerPixel * sx, height: media.height * cmPerPixel * sy,
    matrix: [s, -c * sy / sx, 0, 0, c * sx / sy, s, 0, 0, 0, 0, 1, 0,
      (dx * s - dy * c) * sx, (-dx * c - dy * s) * sy, 0, 1],
  };
}
