import { useState } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { defaultStarterTraits } from '../game/Simulation';
import { PALETTES } from '../game/sprites';
import { adjustBehaviour, BEHAVIOUR_KEYS, BEHAVIOUR_SPECS, BehaviourKey, cycleVisual, VisualOptionKey } from '../game/traits';
import { PowerId, TraitSet } from '../game/types';
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
  aggression: 'Engages sooner, hits harder, but burns more energy and takes more risks',
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
  onRelease: (starters: [TraitSet], power: PowerId) => void;
  onRoll: () => [TraitSet, TraitSet];
  onOpenLab: () => void;
}) {
  const [starter, setStarter] = useState<TraitSet>(defaultStarterTraits()[0]);
  const [power, setPower] = useState<PowerId>('dash');
  const traits = starter;
  const update = (next: TraitSet) => setStarter(next);

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.eyebrow}>ECOSYSTEM #{ecosystemNumber} · WORKSHOP</Text>
            <Text style={styles.title}>Build your battle bug</Text>
            <Text style={styles.subtitle}>Choose one starter and one signature power. Your bug fights autonomously inside a generated arena.</Text>
          </View>
          <TouchableOpacity onPress={onOpenLab} hitSlop={8}>
            <Text style={styles.labLink}>Spatial Lab</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.slots}><View style={[styles.slot, styles.slotSelected]}><BugSprite visual={traits.visual} pixel={4} /><Text style={[styles.slotLabel, styles.slotLabelSelected]}>YOUR BUG</Text></View></View>

        <View style={styles.preview}>
          <BugSprite visual={traits.visual} pixel={9} />
        </View>

        <View style={styles.panel}>
          <Text style={styles.sectionLabel}>SIGNATURE POWER</Text>
          {(['dash', 'shield', 'stun-pulse', 'regeneration', 'frenzy'] as PowerId[]).map((id) => <TouchableOpacity key={id} style={[styles.power, power === id && styles.powerSelected]} onPress={() => setPower(id)}><Text style={styles.powerText}>{id.replace('-', ' ').toUpperCase()}</Text></TouchableOpacity>)}
          <Text style={styles.hint}>Aggression: higher values engage sooner, hit harder, and resist retreating; they also increase energy use and risk.</Text>
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
          <TouchableOpacity style={styles.secondary} onPress={() => setStarter(onRoll()[0])}>
            <Text style={styles.secondaryText}>Randomise</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.primary} onPress={() => onRelease([starter], power)}>
            <Text style={styles.primaryText}>Start battle</Text>
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
  power: { padding: 10, borderRadius: 10, backgroundColor: COLORS.soil },
  powerSelected: { borderWidth: 2, borderColor: COLORS.accent },
  powerText: { color: COLORS.text, fontWeight: '800', fontSize: 12 },
});
