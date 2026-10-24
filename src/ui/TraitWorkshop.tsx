import { useState } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { defaultStarterTraits } from '../game/Simulation';
import { PALETTES } from '../game/sprites';
import { adjustBehaviour, BEHAVIOUR_KEYS, BEHAVIOUR_SPECS, BehaviourKey, cycleVisual, VisualOptionKey } from '../game/traits';
import { TraitSet } from '../game/types';
import { BugSprite } from './BugSprite';
import { COLORS, PIXEL_FONT } from './theme';

const VISUAL_ROWS: { key: VisualOptionKey | 'palette'; label: string }[] = [
  { key: 'body', label: 'Body' },
  { key: 'eyes', label: 'Eyes' },
  { key: 'horns', label: 'Horns' },
  { key: 'feature', label: 'Feature' },
  { key: 'palette', label: 'Colour' },
];

const BEHAVIOUR_HINTS: Record<BehaviourKey, string> = {
  speed: 'Reaches food first, but burns more energy',
  aggression: 'Chases calmer bugs off, at a hunger cost',
  lifespanS: 'Seconds before it dies of old age',
  hungerRate: 'How fast it gets hungry',
  foodForReproduction: 'Meals needed to lay one offspring',
};

function Stepper({ label, value, onPrev, onNext, prev = '‹', next = '›' }: {
  label: string;
  value: string;
  onPrev: () => void;
  onNext: () => void;
  prev?: string;
  next?: string;
}) {
  return (
    <View style={styles.stepperRow}>
      <Text style={styles.stepperLabel}>{label}</Text>
      <View style={styles.stepperControls}>
        <TouchableOpacity style={styles.stepperButton} onPress={onPrev} hitSlop={8}>
          <Text style={styles.stepperButtonText}>{prev}</Text>
        </TouchableOpacity>
        <Text style={styles.stepperValue}>{value}</Text>
        <TouchableOpacity style={styles.stepperButton} onPress={onNext} hitSlop={8}>
          <Text style={styles.stepperButtonText}>{next}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/** Where a value sits in its allowed range, as a small pixel bar. */
function RangeBar({ share }: { share: number }) {
  return (
    <View style={styles.rangeBar}>
      <View style={[styles.rangeFill, { width: `${Math.round(Math.max(0.04, share) * 100)}%` }]} />
    </View>
  );
}

const visualValue = (traits: TraitSet, key: VisualOptionKey | 'palette') =>
  key === 'palette' ? PALETTES[traits.visual.palette].name : traits.visual[key];

export function TraitWorkshop({ ecosystemNumber, onRelease, onRoll, onOpenLab }: {
  ecosystemNumber: number;
  onRelease: (starters: [TraitSet, TraitSet]) => void;
  onRoll: () => [TraitSet, TraitSet];
  onOpenLab: () => void;
}) {
  const [starters, setStarters] = useState<[TraitSet, TraitSet]>(defaultStarterTraits);
  const [selected, setSelected] = useState<0 | 1>(0);
  const traits = starters[selected];
  const update = (next: TraitSet) => setStarters((current) => (selected === 0 ? [next, current[1]] : [current[0], next]));

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.eyebrow}>ECOSYSTEM #{ecosystemNumber} · WORKSHOP</Text>
            <Text style={styles.title}>Design two starters</Text>
            <Text style={styles.subtitle}>Once released they look after themselves: they hunt for food, breed, age and die.</Text>
          </View>
          <TouchableOpacity onPress={onOpenLab} hitSlop={8}>
            <Text style={styles.labLink}>Spatial Lab</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.slots}>
          {starters.map((starter, index) => (
            <TouchableOpacity
              key={index}
              style={[styles.slot, selected === index && styles.slotSelected]}
              onPress={() => setSelected(index as 0 | 1)}
            >
              <BugSprite visual={starter.visual} pixel={4} />
              <Text style={[styles.slotLabel, selected === index && styles.slotLabelSelected]}>STARTER {index + 1}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.preview}>
          <BugSprite visual={traits.visual} pixel={9} />
        </View>

        <View style={styles.panel}>
          <Text style={styles.sectionLabel}>LOOK</Text>
          {VISUAL_ROWS.map(({ key, label }) => (
            <Stepper
              key={key}
              label={label}
              value={visualValue(traits, key)}
              onPrev={() => update(cycleVisual(traits, key, -1))}
              onNext={() => update(cycleVisual(traits, key, 1))}
            />
          ))}
        </View>

        <View style={styles.panel}>
          <Text style={styles.sectionLabel}>BEHAVIOUR</Text>
          {BEHAVIOUR_KEYS.map((key) => {
            const spec = BEHAVIOUR_SPECS[key];
            const value = traits.behaviour[key];
            return (
              <View key={key} style={styles.behaviourBlock}>
                <Stepper
                  label={spec.label}
                  value={spec.format(value)}
                  prev="−"
                  next="+"
                  onPrev={() => update(adjustBehaviour(traits, key, -1))}
                  onNext={() => update(adjustBehaviour(traits, key, 1))}
                />
                <RangeBar share={(value - spec.min) / (spec.max - spec.min)} />
                <Text style={styles.hint}>{BEHAVIOUR_HINTS[key]}</Text>
              </View>
            );
          })}
        </View>

        <View style={styles.actions}>
          <TouchableOpacity style={styles.secondary} onPress={() => setStarters(onRoll())}>
            <Text style={styles.secondaryText}>Randomise</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.primary} onPress={() => onRelease(starters)}>
            <Text style={styles.primaryText}>Release into habitat</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.background },
  container: { padding: 20, gap: 14 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingTop: 8, gap: 12 },
  headerText: { flex: 1 },
  eyebrow: { color: COLORS.accent, fontSize: 10, fontWeight: '900', letterSpacing: 1.5, fontFamily: PIXEL_FONT },
  title: { color: COLORS.text, fontSize: 28, fontWeight: '900', letterSpacing: -0.6, marginTop: 6 },
  subtitle: { color: COLORS.muted, fontSize: 13, lineHeight: 18, marginTop: 6 },
  labLink: { color: COLORS.muted, fontSize: 12, fontWeight: '700', paddingTop: 4 },
  slots: { flexDirection: 'row', gap: 12 },
  slot: { flex: 1, alignItems: 'center', gap: 8, paddingVertical: 12, borderRadius: 14, borderWidth: 2, borderColor: COLORS.panelBorder, backgroundColor: COLORS.panel },
  slotSelected: { borderColor: COLORS.accent },
  slotLabel: { color: COLORS.muted, fontSize: 10, fontWeight: '900', letterSpacing: 1.2, fontFamily: PIXEL_FONT },
  slotLabelSelected: { color: COLORS.accent },
  preview: { alignItems: 'center', justifyContent: 'center', paddingVertical: 18, borderRadius: 18, backgroundColor: COLORS.soil, borderWidth: 2, borderColor: COLORS.soilEdge },
  panel: { backgroundColor: COLORS.panel, borderRadius: 16, borderWidth: 1, borderColor: COLORS.panelBorder, padding: 14, gap: 10 },
  sectionLabel: { color: COLORS.faint, fontSize: 10, fontWeight: '900', letterSpacing: 1.4, fontFamily: PIXEL_FONT },
  stepperRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stepperLabel: { color: COLORS.text, fontSize: 14, fontWeight: '700' },
  stepperControls: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepperButton: { width: 34, height: 30, borderRadius: 8, backgroundColor: COLORS.soil, alignItems: 'center', justifyContent: 'center' },
  stepperButtonText: { color: COLORS.accent, fontSize: 18, fontWeight: '900' },
  stepperValue: { color: COLORS.text, fontSize: 13, fontWeight: '700', minWidth: 76, textAlign: 'center', fontFamily: PIXEL_FONT },
  behaviourBlock: { gap: 5 },
  rangeBar: { height: 6, backgroundColor: COLORS.soil, borderRadius: 1, overflow: 'hidden' },
  rangeFill: { height: 6, backgroundColor: COLORS.accent },
  hint: { color: COLORS.faint, fontSize: 11 },
  actions: { flexDirection: 'row', gap: 10, paddingBottom: 20 },
  primary: { flex: 1, backgroundColor: COLORS.accent, borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  primaryText: { color: '#241b12', fontWeight: '900' },
  secondary: { paddingHorizontal: 18, paddingVertical: 16, borderRadius: 14, borderWidth: 1, borderColor: COLORS.panelBorder, alignItems: 'center' },
  secondaryText: { color: COLORS.text, fontWeight: '700' },
});
