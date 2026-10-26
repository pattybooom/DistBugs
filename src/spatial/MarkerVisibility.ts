export type MarkerTrackingState = {
  motionAvailable: boolean;
  moving: boolean;
  markerVisible: boolean;
  revision: number;
};

const magnitude = (value: unknown): number => {
  if (!value || typeof value !== 'object') return 0;
  const v = value as Record<string, unknown>;
  return [v.x, v.y, v.z].every(n => typeof n === 'number' && Number.isFinite(n))
    ? Math.hypot(v.x as number, v.y as number, v.z as number) : 0;
};

// Once hidden, the code only comes back for a deliberate move: a clear shove or turn, or a
// small disturbance that keeps going. Taps and table knocks are brief and stay hidden.
const WAKE_ACCELERATION_G = .12;
const WAKE_ANGULAR_VELOCITY = .6;
const WAKE_YAW = .1;
const WAKE_SUSTAINED_MS = 300;

/** Motion wakes the code; only a camera acknowledgement for this move can hide it. */
export class MarkerVisibility {
  private lastMotion: number | null = null;
  private settledSince: number | null = null;
  private goodSince: number | null = null;
  private lastGood: number | null = null;
  private yaw: number | null = null;
  private hiddenYaw: number | null = null;
  private disturbedSince: number | null = null;
  private state: MarkerTrackingState = { motionAvailable: false, moving: true, markerVisible: true, revision: 0 };

  observeMotion(value: unknown, now: number): boolean {
    if (!value || typeof value !== 'object') return false;
    const event = value as Record<string, unknown>;
    if (event.source !== 'local' || event.valid !== true || typeof event.stationary !== 'boolean') return false;
    this.lastMotion = now;
    this.state.motionAvailable = true;
    this.yaw = typeof event.yaw === 'number' && Number.isFinite(event.yaw) ? event.yaw : null;
    const acceleration = magnitude(event.userAcceleration);
    const angularVelocity = magnitude(event.angularVelocity);
    const disturbed = !event.stationary || acceleration > .018 || angularVelocity > .05;
    if (!disturbed) this.disturbedSince = null;
    else this.disturbedSince ??= now;
    let moving = disturbed;
    if (!this.state.markerVisible) {
      const turned = this.yaw !== null && this.hiddenYaw !== null
        && Math.abs(Math.atan2(Math.sin(this.yaw - this.hiddenYaw), Math.cos(this.yaw - this.hiddenYaw))) > WAKE_YAW;
      moving = turned || acceleration > WAKE_ACCELERATION_G || angularVelocity > WAKE_ANGULAR_VELOCITY
        || (this.disturbedSince !== null && now - this.disturbedSince >= WAKE_SUSTAINED_MS);
    }
    if (moving) {
      if (!this.state.moving) this.reacquire();
      this.state.moving = true;
      this.settledSince = null;
    } else {
      if (this.state.moving) this.settledSince = now;
      this.state.moving = false;
    }
    return true;
  }

  observeLayout(revision: number | undefined, now: number): boolean {
    if (revision !== this.state.revision) return false;
    if (this.lastGood === null || now - this.lastGood > 400) this.goodSince = now;
    this.goodSince ??= now;
    this.lastGood = now;
    return true;
  }

  reacquire(): void {
    this.state.revision += 1;
    this.state.markerVisible = true;
    this.goodSince = this.lastGood = null;
    this.hiddenYaw = null;
  }

  snapshot(now: number): MarkerTrackingState {
    if (this.lastMotion === null || now - this.lastMotion > 600) {
      if (this.state.motionAvailable) this.reacquire();
      this.state.motionAvailable = false;
      this.state.moving = true;
      this.state.markerVisible = true;
      this.settledSince = null;
    }
    if (this.state.markerVisible && this.state.motionAvailable && !this.state.moving
      && this.settledSince !== null && now - this.settledSince >= 800
      && this.goodSince !== null && now - this.goodSince >= 600
      && this.lastGood !== null && now - this.lastGood <= 400) {
      this.state.markerVisible = false;
      this.hiddenYaw = this.yaw;
    }
    return { ...this.state };
  }
}
