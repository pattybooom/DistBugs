import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Dimensions } from 'react-native';
import { loadSimulation, saveSimulation } from '../game/persistence';
import { Landing } from '../game/crossing';
import {
  admitBug,
  canAdmit,
  createSimulation,
  defaultStarterTraits,
  ExitCheck,
  habitatForScreen,
  releaseStarters,
  resizeHabitat,
  restartEcosystem,
  rollStarterTraits,
} from '../game/Simulation';
import { SimulationDriver } from '../game/SimulationDriver';
import { playEvents } from '../game/sound';
import { Bug, DeathCause, PowerId, SimulationEvent, SimulationState, TraitSet } from '../game/types';

/** About 30 redraws a second; the simulation itself steps at its own fixed rate. */
const RENDER_INTERVAL_MS = 33;
const LOG_LENGTH = 4;

export type LogEntry = { id: number; text: string; tone: 'birth' | 'death' | 'info' | 'travel' };
export type Obituary = { name: string; cause: DeathCause; ageS: number };
export type DepartedEvent = Extract<SimulationEvent, { type: 'departed' }>;

export type Ecosystem = {
  loaded: boolean;
  /** Mutated in place by the simulation; `frame` changes whenever it should be redrawn. */
  state: SimulationState | null;
  frame: number;
  running: boolean;
  log: LogEntry[];
  obituaries: Record<string, Obituary>;
  release: (starters: [TraitSet], power: PowerId) => void;
  restart: () => void;
  setPaused: (paused: boolean) => void;
  toggleSound: () => void;
  rollStarters: () => [TraitSet, TraitSet];
  /** Opens walls onto the other phone and hands over bugs that walk through them; nulls close them. */
  setCrossing: (canExit: ExitCheck | null, onDeparted: ((event: DepartedEvent) => void) | null) => void;
  /** Takes in a bug from the other phone. False when this ecosystem can't take it now. */
  admit: (bug: Bug, landing: Landing) => boolean;
  /** Puts back a bug whose crossing failed, turned around at the wall it left by. False if it was lost. */
  returnBug: (bug: Bug, at: { x: number; y: number }, heading: number) => boolean;
  note: (text: string, tone?: LogEntry['tone']) => void;
};

const save = (state: SimulationState) => {
  saveSimulation(AsyncStorage, state).catch((error) => console.warn('Could not save the ecosystem', error));
};

/**
 * Owns this phone's ecosystem: loads it, runs it while `visible` and the app is in the
 * foreground, and saves it. Leaving the foreground pauses it.
 */
export function useEcosystem(visible: boolean): Ecosystem {
  const driverRef = useRef<SimulationDriver | null>(null);
  const obituaries = useRef<Record<string, Obituary>>({});
  const nextLogId = useRef(1);
  const exitCheck = useRef<ExitCheck | null>(null);
  const onDeparted = useRef<((event: DepartedEvent) => void) | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [frame, setFrame] = useState(0);
  const [log, setLog] = useState<LogEntry[]>([]);

  const refresh = useCallback(() => setFrame((current) => current + 1), []);
  const addLog = useCallback((entries: Omit<LogEntry, 'id'>[]) => {
    if (entries.length === 0) return;
    const numbered = entries.map((entry) => ({ ...entry, id: nextLogId.current++ }));
    setLog((current) => [...numbered.reverse(), ...current].slice(0, LOG_LENGTH));
  }, []);

  const record = useCallback((events: SimulationEvent[]) => {
    const entries: Omit<LogEntry, 'id'>[] = [];
    for (const event of events) {
      if (event.type === 'born') {
        entries.push({ text: `${event.name} hatched · gen ${event.generation}${event.visualMutation ? ' · new look!' : ''}`, tone: 'birth' });
      } else if (event.type === 'died') {
        obituaries.current[event.bugId] = { name: event.name, cause: event.cause, ageS: event.ageS };
        entries.push({ text: `${event.name} ${event.cause === 'starvation' ? 'starved' : 'died of old age'} at ${Math.round(event.ageS)} s`, tone: 'death' });
      } else if (event.type === 'departed') {
        onDeparted.current?.(event);
      } else if (event.type === 'ecosystem-ended') {
        entries.push({ text: event.survivors === 1 ? 'One bug left: the ecosystem has ended' : 'No bugs left: the ecosystem has ended', tone: 'info' });
      } else if (event.type === 'battle-ended') {
        entries.push({ text: event.winner ? `${event.winner === 'local' ? 'You win' : 'Opponent wins'} · battle ended` : 'Draw · battle ended', tone: event.winner === 'local' ? 'birth' : 'death' });
      }
    }
    if (driverRef.current?.state) playEvents(events, driverRef.current.state.soundEnabled, driverRef.current.state.arena.biome);
    addLog(entries);
  }, [addLog]);

  useEffect(() => {
    let cancelled = false;
    loadSimulation(AsyncStorage)
      .catch((error) => {
        console.warn('Could not load the saved ecosystem', error);
        return null;
      })
      .then((saved) => {
        if (cancelled) return;
        // The habitat fills the screen, so it takes this phone's shape; older saves are stretched to it.
        const window = Dimensions.get('window');
        const habitat = habitatForScreen(window.width, window.height);
        if (saved) resizeHabitat(saved, habitat);
        const driver = new SimulationDriver(saved ?? createSimulation(Date.now() % 2 ** 32, habitat), save);
        driver.setAppActive(AppState.currentState === 'active');
        driver.setExitCheck(exitCheck.current);
        driverRef.current = driver;
        if (saved?.status === 'running') addLog([{ text: 'Restored · paused while the app was closed', tone: 'info' }]);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [addLog]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      driverRef.current?.setAppActive(next === 'active');
      refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  useEffect(() => {
    if (!visible || !loaded) return;
    let handle = 0;
    let lastMs: number | null = null;
    let lastRenderMs = 0;
    const tick = (nowMs: number) => {
      const driver = driverRef.current;
      if (driver) {
        const events = driver.advance(lastMs == null ? 0 : (nowMs - lastMs) / 1000);
        lastMs = nowMs;
        if (events.length > 0) record(events);
        if ((driver.running && nowMs - lastRenderMs >= RENDER_INTERVAL_MS) || events.some((event) => event.type === 'ecosystem-ended')) {
          lastRenderMs = nowMs;
          refresh();
        }
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(handle);
      driverRef.current?.saveNow();
    };
  }, [visible, loaded, record, refresh]);

  const setCrossing = useCallback((canExit: ExitCheck | null, departed: ((event: DepartedEvent) => void) | null) => {
    exitCheck.current = canExit;
    onDeparted.current = departed;
    driverRef.current?.setExitCheck(canExit);
  }, []);

  const admit = useCallback((bug: Bug, landing: Landing) => {
    const driver = driverRef.current;
    if (!driver || !canAdmit(driver.state)) return false;
    admitBug(driver.state, bug, landing, landing.heading);
    driver.saveNow();
    addLog([{ text: `${bug.name} arrived from the other phone`, tone: 'travel' }]);
    refresh();
    return true;
  }, [addLog, refresh]);

  const returnBug = useCallback((bug: Bug, at: { x: number; y: number }, heading: number) => {
    const driver = driverRef.current;
    // A restarted ecosystem has no place for a bug from the old one.
    if (!driver || driver.state.status !== 'running') {
      addLog([{ text: `${bug.name} was lost on the way`, tone: 'death' }]);
      return false;
    }
    admitBug(driver.state, bug, at, heading + Math.PI);
    driver.saveNow();
    addLog([{ text: `${bug.name} turned back`, tone: 'travel' }]);
    refresh();
    return true;
  }, [addLog, refresh]);

  const note = useCallback((text: string, tone: LogEntry['tone'] = 'info') => addLog([{ text, tone }]), [addLog]);

  const withDriver = (fn: (driver: SimulationDriver) => void) => {
    const driver = driverRef.current;
    if (!driver) return;
    fn(driver);
    refresh();
  };

  return {
    loaded,
    state: driverRef.current?.state ?? null,
    frame,
    running: driverRef.current?.running ?? false,
    log,
    obituaries: obituaries.current,
    release: (starters, power) => withDriver((driver) => {
      releaseStarters(driver.state, starters, power);
      driver.saveNow();
      obituaries.current = {};
      setLog([]);
      addLog([{ text: 'Starters released into the habitat', tone: 'info' }]);
    }),
    restart: () => withDriver((driver) => {
      restartEcosystem(driver.state);
      driver.saveNow();
      obituaries.current = {};
      setLog([]);
    }),
    setPaused: (paused) => withDriver((driver) => driver.setPaused(paused)),
    toggleSound: () => withDriver((driver) => { driver.state.soundEnabled = !driver.state.soundEnabled; driver.saveNow(); }),
    rollStarters: () => driverRef.current ? rollStarterTraits(driverRef.current.state) : defaultStarterTraits(),
    setCrossing,
    admit,
    returnBug,
    note,
  };
}
