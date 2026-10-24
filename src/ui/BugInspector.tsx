import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { isMature } from '../game/Simulation';
import { PALETTES } from '../game/sprites';
import { BEHAVIOUR_KEYS, BEHAVIOUR_SPECS } from '../game/traits';
import { Bug, VisualTraits } from '../game/types';
import { BugSprite } from './BugSprite';
import { COLORS, PIXEL_FONT } from './theme';
import { Obituary } from './useEcosystem';

const describeVisual = (visual: VisualTraits) =>
  `${visual.body} body · ${visual.eyes} eyes · ${visual.horns === 'none' ? 'no horns' : visual.horns} · ${visual.feature === 'none' ? 'plain' : visual.feature}`;

const describeColour = (visual: VisualTraits) =>
  `${PALETTES[visual.palette].name}${visual.hueShift === 0 ? '' : ` · hue ${visual.hueShift > 0 ? '+' : ''}${visual.hueShift}°`}`;

/** What the bug's look changed from its parent's, if anything. */
function visualChanges(own: VisualTraits, parent: VisualTraits): string | null {
  const changes: string[] = [];
  if (own.feature !== parent.feature) changes.push(`${parent.feature} → ${own.feature}`);
  if (own.hueShift !== parent.hueShift) changes.push(`hue ${parent.hueShift}° → ${own.hueShift}°`);
  return changes.length ? changes.join(' · ') : null;
}

function activity(bug: Bug): string {
  if (bug.fleeS > 0) return 'Running away';
  if (bug.targetFoodId) return 'Heading for food';
  return 'Wandering';
}

function Meter({ label, value, share, tone }: { label: string; value: string; share: number; tone: string }) {
  return (
    <View style={styles.meter}>
      <View style={styles.meterHeader}>
        <Text style={styles.meterLabel}>{label}</Text>
        <Text style={styles.meterValue}>{value}</Text>
      </View>
      <View style={styles.meterTrack}>
        <View style={[styles.meterFill, { width: `${Math.round(Math.min(1, Math.max(0, share)) * 100)}%`, backgroundColor: tone }]} />
      </View>
    </View>
  );
}

export function BugInspector({ bug, obituary, parentAlive, onClose }: {
  bug: Bug | null;
  obituary: Obituary | null;
  parentAlive: boolean;
  onClose: () => void;
}) {
  if (!bug) {
    return (
      <View style={styles.sheet}>
        <View style={styles.titleRow}>
          <Text style={styles.name}>{obituary?.name ?? 'Gone'}</Text>
          <TouchableOpacity onPress={onClose} hitSlop={10}><Text style={styles.close}>✕</Text></TouchableOpacity>
        </View>
        <Text style={styles.muted}>
          {obituary ? `${obituary.cause === 'starvation' ? 'Starved' : 'Died of old age'} at ${Math.round(obituary.ageS)} s.` : 'This bug is no longer in the habitat.'}
        </Text>
      </View>
    );
  }

  const { behaviour, visual } = bug.traits;
  const mutation = bug.inherited ? visualChanges(visual, bug.inherited.visual) : null;
  return (
    <View style={styles.sheet}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.titleRow}>
          <View style={styles.identity}>
            <View style={styles.portrait}><BugSprite visual={visual} pixel={4} /></View>
            <View style={styles.identityText}>
              <Text style={styles.name}>{bug.name}</Text>
              <Text style={styles.muted}>
                Gen {bug.generation} · {isMature(bug) ? 'adult' : 'juvenile'} · {activity(bug)}
              </Text>
            </View>
          </View>
          <TouchableOpacity onPress={onClose} hitSlop={10}><Text style={styles.close}>✕</Text></TouchableOpacity>
        </View>

        <Meter label="AGE" value={`${Math.floor(bug.ageS)} / ${Math.round(behaviour.lifespanS)} s`} share={bug.ageS / behaviour.lifespanS} tone={COLORS.muted} />
        <Meter label="FULLNESS" value={`${Math.round(bug.satiety)}%`} share={bug.satiety / 100} tone={bug.satiety < 30 ? COLORS.bad : COLORS.good} />
        <Meter
          label="FOOD TO BREED"
          value={`${bug.foodEaten} / ${behaviour.foodForReproduction}`}
          share={bug.foodEaten / behaviour.foodForReproduction}
          tone={COLORS.accent}
        />

        <View style={styles.table}>
          <View style={styles.tableRow}>
            <Text style={[styles.cellLabel, styles.headerCell]}>TRAIT</Text>
            <Text style={[styles.cellValue, styles.headerCell]}>NOW</Text>
            <Text style={[styles.cellValue, styles.headerCell]}>{bug.inherited ? 'PARENT' : 'STARTER'}</Text>
          </View>
          {BEHAVIOUR_KEYS.map((key) => {
            const spec = BEHAVIOUR_SPECS[key];
            const own = behaviour[key];
            const parent = bug.inherited?.behaviour[key];
            const change = parent == null ? 0 : own - parent;
            const shown = Math.abs(change) >= (spec.integer ? 1 : spec.step / 20);
            return (
              <View key={key} style={styles.tableRow}>
                <Text style={styles.cellLabel}>{spec.label}</Text>
                <Text style={styles.cellValue}>
                  {spec.format(own)}
                  {shown && <Text style={change > 0 ? styles.up : styles.down}>{change > 0 ? ' ▲' : ' ▼'}</Text>}
                </Text>
                <Text style={[styles.cellValue, styles.mutedCell]}>{parent == null ? '—' : spec.format(parent)}</Text>
              </View>
            );
          })}
        </View>

        <View style={styles.block}>
          <Text style={styles.blockLabel}>LOOK</Text>
          <Text style={styles.blockText}>{describeVisual(visual)}</Text>
          <Text style={styles.blockText}>{describeColour(visual)}</Text>
          {mutation && <Text style={styles.mutation}>Visual mutation: {mutation}</Text>}
        </View>

        <View style={styles.block}>
          <Text style={styles.blockLabel}>LINEAGE</Text>
          <Text style={styles.blockText}>
            {bug.parentName ? `Parent: ${bug.parentName}${parentAlive ? '' : ' (gone)'}` : 'Starter bug'}
            {` · Founder: ${bug.founderName}`}
          </Text>
          <Text style={styles.blockText}>Offspring: {bug.offspring} · Meals: {bug.totalEaten}</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { position: 'absolute', left: 10, right: 10, bottom: 10, maxHeight: '62%', backgroundColor: 'rgba(26, 22, 18, 0.97)', borderRadius: 18, borderWidth: 2, borderColor: COLORS.soilEdge, padding: 14 },
  content: { gap: 10 },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  portrait: { padding: 6, borderRadius: 10, backgroundColor: COLORS.soil },
  identityText: { flex: 1 },
  name: { color: COLORS.text, fontSize: 22, fontWeight: '900' },
  muted: { color: COLORS.muted, fontSize: 12, marginTop: 3 },
  close: { color: COLORS.muted, fontSize: 18, fontWeight: '900', paddingLeft: 12 },
  meter: { gap: 4 },
  meterHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  meterLabel: { color: COLORS.faint, fontSize: 10, fontWeight: '900', letterSpacing: 1.2, fontFamily: PIXEL_FONT },
  meterValue: { color: COLORS.text, fontSize: 11, fontWeight: '700', fontFamily: PIXEL_FONT },
  meterTrack: { height: 6, backgroundColor: COLORS.soil, overflow: 'hidden' },
  meterFill: { height: 6 },
  table: { gap: 5, paddingTop: 4 },
  tableRow: { flexDirection: 'row', alignItems: 'center' },
  headerCell: { color: COLORS.faint, fontSize: 10, fontWeight: '900', letterSpacing: 1.1, fontFamily: PIXEL_FONT },
  cellLabel: { flex: 1.3, color: COLORS.text, fontSize: 13 },
  cellValue: { flex: 1, color: COLORS.text, fontSize: 12, textAlign: 'right', fontFamily: PIXEL_FONT },
  mutedCell: { color: COLORS.muted },
  up: { color: COLORS.good },
  down: { color: COLORS.bad },
  block: { gap: 3 },
  blockLabel: { color: COLORS.faint, fontSize: 10, fontWeight: '900', letterSpacing: 1.2, fontFamily: PIXEL_FONT },
  blockText: { color: COLORS.text, fontSize: 13 },
  mutation: { color: COLORS.accent, fontSize: 12, fontWeight: '700' },
});
