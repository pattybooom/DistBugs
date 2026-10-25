import { Platform } from 'react-native';

export const COLORS = {
  background: '#0f0d0b',
  panel: '#1a1612',
  panelBorder: '#2f2820',
  soil: '#2a2119',
  soilEdge: '#4a3a2a',
  pebble: '#3a2e23',
  text: '#f3ead8',
  muted: '#9c8f7a',
  faint: '#5f5546',
  accent: '#f0b36f',
  good: '#8fd46a',
  warn: '#f0b36f',
  bad: '#ef6d5a',
  food: '#b6e35a',
  foodCore: '#f4f7c8',
  select: '#fff3c4',
  travel: '#8fc7ef',
};

export const PIXEL_FONT = Platform.select({ ios: 'Menlo', default: 'monospace' });

export const formatClock = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};
