import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { Biome, PowerId, SimulationEvent } from './types';

export type SoundName =
  | 'eat' | 'hit' | 'defeat' | 'food'
  | 'power-dash' | 'power-shield' | 'power-stun-pulse' | 'power-regeneration' | 'power-frenzy'
  | 'born' | 'born-mutant' | 'starved' | 'old-age'
  | 'victory' | 'loss' | 'draw' | 'ecosystem-ended'
  | 'departed' | 'arrived' | 'release' | 'sound-on'
  | 'ambient-meadow' | 'ambient-swamp' | 'ambient-desert' | 'ambient-tidepool';

type Wave = 'sine' | 'triangle' | 'square' | 'noise';
/** One voice of a sound: a tone (or noise) that glides from `from` to `to` Hz between `at` and `at + length` seconds. */
type Note = { from: number; to?: number; at?: number; length: number; wave?: Wave; volume?: number; tremolo?: number };

const SAMPLE_RATE = 22050;
const cache = new Map<SoundName, ReturnType<typeof createAudioPlayer>>();
const lastPlayed = new Map<SoundName, number>();
let audioMode: Promise<void> | null = null;

// A pentatonic-ish set of pitches keeps the jingles friendly.
const C5 = 523, D5 = 587, E5 = 659, G5 = 784, A5 = 880, C6 = 1047;

export const soundSpecs: Record<SoundName, Note[]> = {
  eat: [{ from: 480, to: 720, length: 0.07, wave: 'triangle' }],
  hit: [{ from: 160, to: 70, length: 0.12, wave: 'square', volume: 0.12 }, { from: 900, length: 0.05, wave: 'noise', volume: 0.12 }],
  defeat: [{ from: 220, to: 55, length: 0.4, wave: 'triangle' }, { from: 400, length: 0.2, wave: 'noise', volume: 0.08 }],
  food: [{ from: 1200, to: 1500, length: 0.04, volume: 0.06 }],
  'power-dash': [{ from: 300, to: 3000, length: 0.18, wave: 'noise', volume: 0.14 }, { from: 300, to: 900, length: 0.12, wave: 'triangle', volume: 0.08 }],
  'power-shield': [E5, G5, C6].map((from, i): Note => ({ from, at: i * 0.02, length: 0.32, volume: 0.07, tremolo: 18 })),
  'power-stun-pulse': [{ from: 1400, to: 200, length: 0.22, wave: 'square', volume: 0.08, tremolo: 40 }],
  'power-regeneration': [C5, E5, G5, C6].map((from, i): Note => ({ from, at: i * 0.06, length: 0.12, wave: 'triangle', volume: 0.12 })),
  'power-frenzy': [0, 1, 2, 3, 4, 5].map((i): Note => ({ from: i % 2 ? 330 : 440, at: i * 0.035, length: 0.035, wave: 'square', volume: 0.07 })),
  born: [{ from: G5, length: 0.06, wave: 'triangle' }, { from: C6, at: 0.06, length: 0.09, wave: 'triangle' }],
  'born-mutant': [C5, E5, G5, C6, E5 * 2].map((from, i): Note => ({ from, at: i * 0.045, length: 0.09, volume: 0.12 })),
  starved: [{ from: 330, to: 150, length: 0.45, volume: 0.12, tremolo: 6 }],
  'old-age': [{ from: E5, length: 0.18, wave: 'triangle', volume: 0.12 }, { from: C5, at: 0.18, length: 0.3, wave: 'triangle', volume: 0.1 }],
  victory: [C5, E5, G5].map((from, i): Note => ({ from, at: i * 0.1, length: 0.1, wave: 'square', volume: 0.08 }))
    .concat([{ from: C6, at: 0.3, length: 0.4, wave: 'square', volume: 0.08 }, { from: G5, at: 0.3, length: 0.4, wave: 'triangle', volume: 0.1 }]),
  loss: [G5, E5, C5].map((from, i): Note => ({ from, at: i * 0.15, length: 0.15, wave: 'triangle', volume: 0.12 }))
    .concat([{ from: 262, to: 247, at: 0.45, length: 0.5, wave: 'triangle', volume: 0.12 }]),
  draw: [{ from: D5, length: 0.15, wave: 'triangle' }, { from: D5, at: 0.2, length: 0.25, wave: 'triangle' }],
  'ecosystem-ended': [A5 / 2, G5 / 2, E5 / 2, C5 / 2].map((from, i): Note => ({ from, at: i * 0.18, length: i === 3 ? 0.6 : 0.18, wave: 'triangle', volume: 0.13 })),
  departed: [{ from: 400, to: 1600, length: 0.3, wave: 'noise', volume: 0.1 }, { from: 500, to: 1200, length: 0.25, volume: 0.08 }],
  arrived: [{ from: 1600, to: 400, length: 0.25, wave: 'noise', volume: 0.1 }, { from: G5, at: 0.22, length: 0.08, wave: 'triangle' }, { from: C6, at: 0.3, length: 0.12, wave: 'triangle' }],
  release: [C5, D5, E5, G5, A5, C6].map((from, i): Note => ({ from, at: i * 0.05, length: 0.1, wave: 'triangle', volume: 0.13 })),
  'sound-on': [{ from: G5, length: 0.05, wave: 'triangle' }, { from: C6, at: 0.05, length: 0.07, wave: 'triangle' }],
  // Ambient beds are quiet and sparse so they sit under the action.
  'ambient-meadow': [0, 0.09, 0.6, 0.69].map((at): Note => ({ from: 4200, at, length: 0.06, volume: 0.025, tremolo: 60 })),
  'ambient-swamp': [{ from: 110, to: 95, length: 0.22, wave: 'square', volume: 0.04, tremolo: 25 }, { from: 130, to: 110, at: 0.5, length: 0.2, wave: 'square', volume: 0.035, tremolo: 25 }],
  'ambient-desert': [{ from: 250, to: 500, length: 1.2, wave: 'noise', volume: 0.04 }],
  'ambient-tidepool': [0, 0.25, 0.4, 0.8].map((at, i): Note => ({ from: 300 + i * 120, to: 900 + i * 200, at, length: 0.07, volume: 0.05 })),
};

const POWER_SOUNDS: Record<PowerId, SoundName> = {
  dash: 'power-dash', shield: 'power-shield', 'stun-pulse': 'power-stun-pulse', regeneration: 'power-regeneration', frenzy: 'power-frenzy',
};

/** Shortest gap before the same sound may play again, so busy frames don't machine-gun. */
function cooldownMs(name: SoundName): number {
  if (name.startsWith('ambient-')) return 4000;
  if (name === 'food') return 1500;
  return 70;
}

/** Mixes a sound's notes into 16-bit mono samples. Deterministic, so the noise is the same every time. */
export function renderSamples(notes: Note[]): Int16Array {
  const total = Math.max(...notes.map((note) => (note.at ?? 0) + note.length));
  const out = new Float32Array(Math.ceil(total * SAMPLE_RATE));
  let seed = 0x2545f491;
  for (const note of notes) {
    const start = Math.floor((note.at ?? 0) * SAMPLE_RATE);
    const count = Math.floor(note.length * SAMPLE_RATE);
    const volume = note.volume ?? 0.16;
    const wave = note.wave ?? 'sine';
    let phase = 0;
    let smoothed = 0;
    for (let i = 0; i < count && start + i < out.length; i += 1) {
      const progress = i / count;
      const frequency = note.from + ((note.to ?? note.from) - note.from) * progress;
      phase += frequency / SAMPLE_RATE;
      let value: number;
      if (wave === 'noise') {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        // A one-pole low-pass whose cutoff follows `frequency` gives the noise a pitch to sweep.
        const alpha = Math.min(1, (2 * Math.PI * frequency) / SAMPLE_RATE);
        smoothed += alpha * ((seed >>> 0) / 0xffffffff * 2 - 1 - smoothed);
        value = smoothed * 2;
      } else if (wave === 'square') value = phase % 1 < 0.5 ? 1 : -1;
      else if (wave === 'triangle') value = 4 * Math.abs((phase % 1) - 0.5) - 1;
      else value = Math.sin(2 * Math.PI * phase);
      const envelope = Math.min(1, i / 120) * Math.min(1, (count - i) / 600);
      const tremolo = note.tremolo ? 0.6 + 0.4 * Math.sin(2 * Math.PI * note.tremolo * i / SAMPLE_RATE) : 1;
      out[start + i] += value * volume * envelope * tremolo;
    }
  }
  return Int16Array.from(out, (value) => Math.round(Math.max(-1, Math.min(1, value)) * 32767));
}

function wavData(samples: Int16Array): string {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const put = (offset: number, text: string) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  put(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); put(8, 'WAVE'); put(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, SAMPLE_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); put(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, sample, true));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 4096) binary += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return `data:audio/wav;base64,${btoa(binary)}`;
}

export async function playSound(name: SoundName, enabled = true): Promise<void> {
  // React Native's global btoa is available in Expo; without it (Jest) audio is skipped.
  if (!enabled || typeof btoa !== 'function') return;
  const now = Date.now();
  if (now - (lastPlayed.get(name) ?? 0) < cooldownMs(name)) return;
  lastPlayed.set(name, now);
  try {
    audioMode ??= setAudioModeAsync({ playsInSilentMode: true });
    await audioMode;
    let sound = cache.get(name);
    if (!sound) { sound = createAudioPlayer(wavData(renderSamples(soundSpecs[name]))); cache.set(name, sound); }
    await sound.seekTo(0);
    sound.play();
  } catch { /* Audio is best-effort; simulation must never depend on it. */ }
}

/** Which sounds a batch of simulation events should make, at most one of each. */
export function soundsForEvents(events: SimulationEvent[]): SoundName[] {
  const names = new Set<SoundName>();
  for (const event of events) {
    if (event.type === 'ate') names.add('eat');
    else if (event.type === 'attacked') names.add('hit');
    else if (event.type === 'power-used') names.add(POWER_SOUNDS[event.power]);
    else if (event.type === 'defeated') names.add('defeat');
    else if (event.type === 'food-spawned') names.add('food');
    else if (event.type === 'born') names.add(event.visualMutation ? 'born-mutant' : 'born');
    // Combat deaths already sounded as 'defeated'.
    else if (event.type === 'died' && event.cause !== 'combat') names.add(event.cause === 'starvation' ? 'starved' : 'old-age');
    else if (event.type === 'battle-ended') names.add(event.winner === 'local' ? 'victory' : event.winner === 'remote' ? 'loss' : 'draw');
    else if (event.type === 'ecosystem-ended') names.add('ecosystem-ended');
    else if (event.type === 'departed') names.add('departed');
  }
  return [...names];
}

export function playEvents(events: SimulationEvent[], enabled: boolean): void {
  for (const name of soundsForEvents(events)) void playSound(name, enabled);
}

/** Call every frame while the habitat runs; the cooldown keeps the biome's bed to an occasional murmur. */
export function playAmbient(biome: Biome, enabled: boolean): void {
  void playSound(`ambient-${biome}`, enabled);
}
