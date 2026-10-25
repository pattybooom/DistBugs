import { Random } from './Random';
import { PALETTES } from './sprites';
import { BehaviourTraits, BODY_SHAPES, EYE_STYLES, FEATURES, HORN_STYLES, TraitSet, VisualTraits } from './types';

export type BehaviourKey = keyof BehaviourTraits;

export type BehaviourSpec = {
  label: string;
  min: number;
  max: number;
  default: number;
  /** Workshop increment. */
  step: number;
  /** Retained for save compatibility; battle inheritance never mutates this value. */
  mutation: number;
  integer?: boolean;
  format: (value: number) => string;
};

export const BEHAVIOUR_SPECS: Record<BehaviourKey, BehaviourSpec> = {
  speed: { label: 'Speed', min: 15, max: 60, default: 32, step: 3, mutation: 3, format: (v) => `${Math.round(v)}` },
  aggression: { label: 'Aggression', min: 0, max: 1, default: 0.3, step: 0.1, mutation: 0.06, format: (v) => `${Math.round(v * 100)}%` },
  lifespanS: { label: 'Lifespan', min: 60, max: 180, default: 120, step: 10, mutation: 8, format: (v) => `${Math.round(v)} s` },
  hungerRate: { label: 'Hunger rate', min: 0.8, max: 3, default: 1.6, step: 0.2, mutation: 0.12, format: (v) => `${v.toFixed(1)}/s` },
  foodForReproduction: { label: 'Food to breed', min: 2, max: 8, default: 4, step: 1, mutation: 0.7, integer: true, format: (v) => `${v}` },
};

export const BEHAVIOUR_KEYS = Object.keys(BEHAVIOUR_SPECS) as BehaviourKey[];

/** About one birth in 25 changes how the offspring looks. */
export const VISUAL_MUTATION_CHANCE = 0.04;
export const HUE_SHIFT_LIMIT = 40;
const HUE_SHIFT_STEP: [number, number] = [8, 16];

export const VISUAL_OPTIONS = {
  body: BODY_SHAPES,
  eyes: EYE_STYLES,
  horns: HORN_STYLES,
  feature: FEATURES,
} as const;
export type VisualOptionKey = keyof typeof VISUAL_OPTIONS;

export function clampBehaviour(key: BehaviourKey, value: number): number {
  const spec = BEHAVIOUR_SPECS[key];
  const clamped = Math.min(spec.max, Math.max(spec.min, value));
  // Rounding keeps workshop steps like 0.1 + 0.2 from drifting.
  return spec.integer ? Math.round(clamped) : Math.round(clamped * 1000) / 1000;
}

export const defaultBehaviour = (): BehaviourTraits =>
  Object.fromEntries(BEHAVIOUR_KEYS.map((key) => [key, BEHAVIOUR_SPECS[key].default])) as BehaviourTraits;

export const defaultTraits = (visual: Partial<VisualTraits> = {}): TraitSet => ({
  visual: { body: 'round', eyes: 'dot', horns: 'antennae', feature: 'spots', palette: 0, hueShift: 0, ...visual },
  behaviour: defaultBehaviour(),
});

export function randomTraits(rng: Random): TraitSet {
  const visual: VisualTraits = {
    body: rng.pick(BODY_SHAPES),
    eyes: rng.pick(EYE_STYLES),
    horns: rng.pick(HORN_STYLES),
    feature: rng.pick(FEATURES),
    palette: rng.int(0, PALETTES.length - 1),
    hueShift: 0,
  };
  const behaviour = Object.fromEntries(BEHAVIOUR_KEYS.map((key) => {
    const spec = BEHAVIOUR_SPECS[key];
    const steps = Math.round((spec.max - spec.min) / spec.step);
    return [key, clampBehaviour(key, spec.min + rng.int(0, steps) * spec.step)];
  })) as BehaviourTraits;
  return { visual, behaviour };
}

export function adjustBehaviour(traits: TraitSet, key: BehaviourKey, direction: 1 | -1): TraitSet {
  const value = clampBehaviour(key, traits.behaviour[key] + direction * BEHAVIOUR_SPECS[key].step);
  return { ...traits, behaviour: { ...traits.behaviour, [key]: value } };
}

export function cycleVisual(traits: TraitSet, key: VisualOptionKey | 'palette', direction: 1 | -1): TraitSet {
  if (key === 'palette') {
    const palette = (traits.visual.palette + direction + PALETTES.length) % PALETTES.length;
    return { ...traits, visual: { ...traits.visual, palette } };
  }
  const options: readonly string[] = VISUAL_OPTIONS[key];
  const index = (options.indexOf(traits.visual[key]) + direction + options.length) % options.length;
  return { ...traits, visual: { ...traits.visual, [key]: options[index] } };
}

/** A rare, small change: a nudge of hue, or a step to the neighbouring feature. Shape, eyes and horns never change. */
function mutateVisual(visual: VisualTraits, rng: Random): VisualTraits {
  if (rng.chance(0.5)) {
    const nudge = rng.range(...HUE_SHIFT_STEP) * (rng.chance(0.5) ? 1 : -1);
    // At the limit the nudge turns back rather than doing nothing.
    const shifted = Math.abs(visual.hueShift + nudge) > HUE_SHIFT_LIMIT ? visual.hueShift - nudge : visual.hueShift + nudge;
    return { ...visual, hueShift: Math.round(shifted) };
  }
  const index = FEATURES.indexOf(visual.feature);
  const next = index === 0 ? 1 : index === FEATURES.length - 1 ? index - 1 : index + (rng.chance(0.5) ? 1 : -1);
  return { ...visual, feature: FEATURES[next] };
}

export function inheritTraits(parent: TraitSet, rng: Random): { traits: TraitSet; visualMutation: boolean } {
  const behaviour = Object.fromEntries(BEHAVIOUR_KEYS.map((key) => {
    const spec = BEHAVIOUR_SPECS[key];
    return [key, clampBehaviour(key, parent.behaviour[key] + rng.range(-spec.mutation, spec.mutation))];
  })) as BehaviourTraits;
  const visualMutation = rng.chance(VISUAL_MUTATION_CHANCE);
  return { traits: { visual: visualMutation ? mutateVisual(parent.visual, rng) : { ...parent.visual }, behaviour }, visualMutation };
}

/** Battle breeding keeps the exact parent build; this is intentionally mutation-free. */
export function inheritBattleTraits(parent: TraitSet): { traits: TraitSet; visualMutation: boolean } {
  return { traits: { visual: { ...parent.visual }, behaviour: { ...parent.behaviour } }, visualMutation: false };
}
