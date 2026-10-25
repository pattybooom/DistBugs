import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { Biome, SimulationEvent } from './types';

type SoundName = 'eat' | 'hit' | 'power' | 'defeat' | 'ambient';
const cache = new Map<SoundName, ReturnType<typeof createAudioPlayer>>();
let lastPlayed = new Map<SoundName, number>();

function wavData(frequency: number, durationS: number, volume = 0.18): string {
  const sampleRate = 22050;
  const samples = Math.floor(sampleRate * durationS);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const put = (offset: number, text: string) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  put(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); put(8, 'WAVE'); put(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); put(36, 'data'); view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i += 1) {
    const envelope = Math.min(1, i / 120) * Math.min(1, (samples - i) / 600);
    view.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * frequency * i / sampleRate) * 32767 * volume * envelope), true);
  }
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  // React Native's global btoa is available in Expo; the fallback keeps Jest safe.
  const encoded = typeof btoa === 'function' ? btoa(binary) : '';
  return `data:audio/wav;base64,${encoded}`;
}

const sources: Record<SoundName, string> = {
  eat: wavData(520, 0.08), hit: wavData(120, 0.12), power: wavData(760, 0.18), defeat: wavData(70, 0.35), ambient: wavData(180, 0.7, 0.05),
};

export async function playSound(name: SoundName, enabled = true): Promise<void> {
  if (!enabled || typeof btoa !== 'function') return;
  const now = Date.now();
  if (now - (lastPlayed.get(name) ?? 0) < (name === 'ambient' ? 4000 : 70)) return;
  lastPlayed.set(name, now);
  try {
    await setAudioModeAsync({ playsInSilentMode: true });
    let sound = cache.get(name);
    if (!sound) { sound = createAudioPlayer(sources[name]); cache.set(name, sound); }
    await sound.seekTo(0);
    sound.play();
  } catch { /* Audio is best-effort; simulation must never depend on it. */ }
}

export function playEvents(events: SimulationEvent[], enabled: boolean, biome: Biome): void {
  for (const event of events) {
    if (event.type === 'ate') void playSound('eat', enabled);
    else if (event.type === 'attacked') void playSound('hit', enabled);
    else if (event.type === 'power-used') void playSound('power', enabled);
    else if (event.type === 'defeated') void playSound('defeat', enabled);
  }
  if (events.length === 0) void playSound('ambient', enabled);
  void biome;
}
