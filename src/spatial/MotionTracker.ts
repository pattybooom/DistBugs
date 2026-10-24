import { MotionEvent, Vector3 } from '../native/ParallaxModule';
import { PositionEstimate } from './SpatialMath';

/**
 * Follows Phone B after a spin. UWB says how far apart the phones are but not which way either
 * moved, so each phone's dead-reckoned slide (native, velocity zeroed whenever it is still) moves
 * B from where the spin put it, and the UWB distance then sets how far away it is.
 */

type PhoneRole = 'A' | 'B';

/** Assumed acceleration error while a phone slides: sensor bias plus gravity leaking through tilt error. */
export const ACCELERATION_ERROR_CM_S2 = 15;
export const RESPIN_BEARING_UNCERTAINTY_RAD = (25 * Math.PI) / 180;
/** Without a shared frame B's own slide cannot be turned into A's frame, so a slide this big needs a re-spin. */
export const UNTRACKED_MOVE_CM = 3;

export type TrackedPosition = {
  position: PositionEstimate;
  bearingUncertaintyRad: number;
  /** How far B has moved relative to A since the spin. */
  movedCm: number;
  needsRespin: boolean;
};

type PhoneMotion = {
  baseline: Vector3 | null;
  latest: Vector3 | null;
  /** Moving time when the current slide began, or null while still. */
  slideStart: number | null;
  movingSeconds: number;
  settledVarianceCm2: number;
};

const slideVarianceCm2 = (seconds: number): number => (0.5 * ACCELERATION_ERROR_CM_S2 * seconds ** 2) ** 2;

const phoneFrom = (motion: MotionEvent | null): PhoneMotion => ({
  baseline: motion?.displacementCm ?? null,
  latest: motion?.displacementCm ?? null,
  slideStart: motion?.stationary === false ? motion.movingSeconds ?? 0 : null,
  movingSeconds: motion?.movingSeconds ?? 0,
  settledVarianceCm2: 0,
});

export class MotionTracker {
  private anchor: { xCm: number; yCm: number; bearingUncertaintyRad: number; reason: string } | null = null;
  private phones: Record<PhoneRole, PhoneMotion> = { A: phoneFrom(null), B: phoneFrom(null) };

  get active(): boolean {
    return this.anchor != null;
  }

  /** Starts from a spin estimate, taking each phone's current displacement as its baseline. */
  start(position: PositionEstimate, bearingUncertaintyRad: number, motionA: MotionEvent | null, motionB: MotionEvent | null): void {
    if (position.xCm == null || position.yCm == null) {
      this.reset();
      return;
    }
    this.anchor = { xCm: position.xCm, yCm: position.yCm, bearingUncertaintyRad, reason: position.reason };
    this.phones = { A: phoneFrom(motionA), B: phoneFrom(motionB) };
  }

  observe(role: PhoneRole, motion: MotionEvent): void {
    const phone = this.phones[role];
    if (!this.anchor || !motion.displacementCm) return;
    const movingSeconds = motion.movingSeconds ?? phone.movingSeconds;
    // Native dead reckoning restarts with ranging; carry the slide so far over to the new zero.
    if (movingSeconds < phone.movingSeconds && phone.baseline && phone.latest) {
      phone.baseline = {
        x: motion.displacementCm.x - (phone.latest.x - phone.baseline.x),
        y: motion.displacementCm.y - (phone.latest.y - phone.baseline.y),
        z: 0,
      };
      phone.slideStart = phone.slideStart == null ? null : 0;
    }
    phone.baseline = phone.baseline ?? motion.displacementCm;
    phone.latest = motion.displacementCm;

    const moving = motion.stationary === false;
    if (moving && phone.slideStart == null) phone.slideStart = phone.movingSeconds;
    if (!moving && phone.slideStart != null) {
      phone.settledVarianceCm2 += slideVarianceCm2(movingSeconds - phone.slideStart);
      phone.slideStart = null;
    }
    phone.movingSeconds = movingSeconds;
  }

  /**
   * @param distanceCm Current UWB distance, or null to keep the dead-reckoned distance.
   * @param frameOffsetB Rotation from B's reference frame into A's, or null when unknown.
   */
  estimate(distanceCm: number | null, frameOffsetB: number | null): TrackedPosition | null {
    if (!this.anchor) return null;
    const moveA = this.slide('A');
    const ownMoveB = this.slide('B');
    const moveB = frameOffsetB == null ? null : {
      x: ownMoveB.x * Math.cos(frameOffsetB) - ownMoveB.y * Math.sin(frameOffsetB),
      y: ownMoveB.x * Math.sin(frameOffsetB) + ownMoveB.y * Math.cos(frameOffsetB),
    };
    const untrackedB = moveB == null && Math.hypot(ownMoveB.x, ownMoveB.y) > UNTRACKED_MOVE_CM;

    const relativeX = (moveB?.x ?? 0) - moveA.x;
    const relativeY = (moveB?.y ?? 0) - moveA.y;
    const x = this.anchor.xCm + relativeX;
    const y = this.anchor.yCm + relativeY;
    const bearingRad = Math.hypot(x, y) > 1 ? Math.atan2(y, x) : Math.atan2(this.anchor.yCm, this.anchor.xCm);
    const rangeCm = distanceCm != null && Number.isFinite(distanceCm) && distanceCm >= 0 ? distanceCm : Math.hypot(x, y);

    // Slide errors are sideways distances; at range r they turn into bearing error of about error / r.
    const varianceCm2 = this.variance('A') + (moveB ? this.variance('B') : 0);
    const bearingUncertaintyRad = Math.sqrt(this.anchor.bearingUncertaintyRad ** 2 + varianceCm2 / Math.max(rangeCm, 10) ** 2);
    const movedCm = Math.hypot(relativeX, relativeY);

    return {
      position: {
        source: 'estimated',
        xCm: Math.cos(bearingRad) * rangeCm,
        yCm: Math.sin(bearingRad) * rangeCm,
        bearingRad,
        distanceCm: rangeCm,
        reason: movedCm >= 1 ? `${this.anchor.reason} + motion` : this.anchor.reason,
      },
      bearingUncertaintyRad,
      movedCm,
      needsRespin: untrackedB || bearingUncertaintyRad > RESPIN_BEARING_UNCERTAINTY_RAD,
    };
  }

  reset(): void {
    this.anchor = null;
    this.phones = { A: phoneFrom(null), B: phoneFrom(null) };
  }

  private slide(role: PhoneRole): { x: number; y: number } {
    const { baseline, latest } = this.phones[role];
    return baseline && latest ? { x: latest.x - baseline.x, y: latest.y - baseline.y } : { x: 0, y: 0 };
  }

  private variance(role: PhoneRole): number {
    const phone = this.phones[role];
    const current = phone.slideStart == null ? 0 : slideVarianceCm2(phone.movingSeconds - phone.slideStart);
    return phone.settledVarianceCm2 + current;
  }
}
