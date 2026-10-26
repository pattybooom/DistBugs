jest.mock('expo-audio', () => ({ createAudioPlayer: jest.fn(), setAudioModeAsync: jest.fn() }));

import { renderSamples, soundsForEvents, soundSpecs } from '../src/game/sound';
import { SimulationEvent } from '../src/game/types';

describe('sound', () => {
  test('every sound renders audible samples without clipping', () => {
    for (const [name, notes] of Object.entries(soundSpecs)) {
      const samples = renderSamples(notes);
      const peak = samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
      expect({ name, audible: peak > 300 }).toEqual({ name, audible: true });
      expect({ name, clipped: peak >= 32767 }).toEqual({ name, clipped: false });
      expect(samples.length / 22050).toBeLessThan(1.5);
    }
  });

  test('rendering is deterministic', () => {
    expect(renderSamples(soundSpecs['power-dash'])).toEqual(renderSamples(soundSpecs['power-dash']));
  });

  test('events map to distinct sounds, once each', () => {
    const events: SimulationEvent[] = [
      { type: 'ate', bugId: 'a', foodId: 'f' },
      { type: 'ate', bugId: 'b', foodId: 'g' },
      { type: 'power-used', bugId: 'a', power: 'shield' },
      { type: 'born', bugId: 'c', name: 'C', parentId: 'a', generation: 2, visualMutation: true },
      { type: 'died', bugId: 'd', name: 'D', cause: 'starvation', ageS: 10 },
      { type: 'died', bugId: 'e', name: 'E', cause: 'combat', ageS: 10 },
      { type: 'battle-ended', winner: 'remote' },
    ];
    expect(soundsForEvents(events)).toEqual(['eat', 'power-shield', 'born-mutant', 'starved', 'loss']);
  });
});
