import { ExitCheck, setPaused, STEP_S, stepSimulation } from './Simulation';
import { SimulationEvent, SimulationState } from './types';

/** A long frame (a hitch, or the first frame after a pause) advances at most this much: no catch-up. */
export const MAX_FRAME_S = 0.25;
/** Saves at least this often while running, besides saving on births, deaths and the end. */
export const AUTOSAVE_INTERVAL_S = 15;

const MEANINGFUL_EVENTS = new Set<SimulationEvent['type']>(['born', 'died', 'ecosystem-ended', 'departed']);

/**
 * Turns real frame time into fixed simulation steps and decides when to save. It owns the
 * "app in the background" rule: leaving the foreground pauses the ecosystem and saves it, so
 * no simulated time passes while the app is closed.
 */
export class SimulationDriver {
  state: SimulationState;
  private readonly save: (state: SimulationState) => void;
  private accumulatorS = 0;
  private sinceSaveS = 0;
  private appActive = true;
  private canExit: ExitCheck | null = null;

  constructor(state: SimulationState, save: (state: SimulationState) => void) {
    this.state = state;
    this.save = save;
  }

  get running(): boolean {
    return this.appActive && this.state.status === 'running' && !this.state.paused;
  }

  setAppActive(active: boolean): void {
    if (active === this.appActive) return;
    this.appActive = active;
    this.accumulatorS = 0;
    if (!active) {
      setPaused(this.state, true);
      this.saveNow();
    }
  }

  setPaused(paused: boolean): void {
    setPaused(this.state, paused);
    this.accumulatorS = 0;
    this.saveNow();
  }

  /** Opens habitat walls that lead somewhere else; null closes them all again. */
  setExitCheck(canExit: ExitCheck | null): void {
    this.canExit = canExit;
  }

  saveNow(): void {
    this.sinceSaveS = 0;
    this.save(this.state);
  }

  /** Runs as many fixed steps as `realDeltaS` covers and returns their events. */
  advance(realDeltaS: number): SimulationEvent[] {
    if (!this.running || !(realDeltaS > 0)) return [];
    this.accumulatorS += Math.min(realDeltaS, MAX_FRAME_S);
    const events: SimulationEvent[] = [];
    // The tolerance stops float error in the remainder from dropping a step.
    while (this.accumulatorS >= STEP_S - 1e-9 && this.running) {
      events.push(...stepSimulation(this.state, { canExit: this.canExit }));
      this.accumulatorS -= STEP_S;
      this.sinceSaveS += STEP_S;
    }
    if (events.some((event) => MEANINGFUL_EVENTS.has(event.type)) || this.sinceSaveS >= AUTOSAVE_INTERVAL_S) this.saveNow();
    return events;
  }
}
