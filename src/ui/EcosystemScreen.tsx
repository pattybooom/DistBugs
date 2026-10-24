import { useMemo, useState } from 'react';
import { ActivityIndicator, Alert, LayoutChangeEvent, Pressable, SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Random } from '../game/Random';
import { MATURITY_FRACTION } from '../game/Simulation';
import { SPRITE_HEIGHT, SPRITE_WIDTH } from '../game/sprites';
import { Bug, Food, Habitat, SimulationState } from '../game/types';
import { BugInspector } from './BugInspector';
import { BugSprite } from './BugSprite';
import { COLORS, formatClock, PIXEL_FONT } from './theme';
import { TraitWorkshop } from './TraitWorkshop';
import { Ecosystem } from './useEcosystem';

/** Screen points per sprite pixel; the habitat is scaled, bugs are not, so they stay crisp. */
const BUG_PIXEL = 2;
const BUG_WIDTH = SPRITE_WIDTH * BUG_PIXEL;
const BUG_HEIGHT = SPRITE_HEIGHT * BUG_PIXEL;
const SELECT_SIZE = 36;
const FOOD_PIXEL = 2;
const TAP_RADIUS_PT = 28;
/** Newborns are drawn at this size and grow to full size as they mature. */
const JUVENILE_SCALE = 0.6;
/** Past this share of their lifespan, bugs fade. */
const ELDER_SHARE = 0.85;
const HUNGRY_SATIETY = 30;
/** Food blinks for this long before it expires. */
const FOOD_WARNING_S = 4;
const PEBBLE_COUNT = 40;

type Size = { width: number; height: number };
type Pebble = { x: number; y: number; size: number };

/** Background specks, fixed for each ecosystem so the ground doesn't shuffle on every redraw. */
function makePebbles(seed: number, habitat: Habitat): Pebble[] {
  const rng = new Random(seed ^ 0x9e3779b9);
  return Array.from({ length: PEBBLE_COUNT }, () => ({
    x: rng.range(0, habitat.width),
    y: rng.range(0, habitat.height),
    size: rng.pick([2, 2, 4]),
  }));
}

function FoodSprite({ food, timeS, scale }: { food: Food; timeS: number; scale: number }) {
  const left = food.expiresAtS - timeS;
  const blinkOff = left < FOOD_WARNING_S && Math.floor(left * 4) % 2 === 0;
  const p = FOOD_PIXEL;
  return (
    <View style={[styles.food, { left: Math.round(food.x * scale - p * 1.5), top: Math.round(food.y * scale - p * 1.5), opacity: blinkOff ? 0.3 : 1 }]}>
      <View style={{ position: 'absolute', left: 0, top: p, width: p * 3, height: p, backgroundColor: COLORS.food }} />
      <View style={{ position: 'absolute', left: p, top: 0, width: p, height: p * 3, backgroundColor: COLORS.food }} />
      <View style={{ position: 'absolute', left: p, top: p, width: p, height: p, backgroundColor: COLORS.foodCore }} />
    </View>
  );
}

function BugView({ bug, scale, selected }: { bug: Bug; scale: number; selected: boolean }) {
  const { lifespanS } = bug.traits.behaviour;
  const maturity = Math.min(1, bug.ageS / (lifespanS * MATURITY_FRACTION));
  // Sprites face up; snapping to eight directions keeps the pixel-art look.
  const rotation = (Math.round((bug.heading + Math.PI / 2) / (Math.PI / 4)) * 45) % 360;
  const x = Math.round(bug.x * scale);
  const y = Math.round(bug.y * scale);
  return (
    <>
      {selected && <View style={[styles.selection, { left: x - SELECT_SIZE / 2, top: y - SELECT_SIZE / 2 }]} />}
      <View
        style={{
          position: 'absolute',
          left: x - BUG_WIDTH / 2,
          top: y - BUG_HEIGHT / 2,
          opacity: bug.ageS > lifespanS * ELDER_SHARE ? 0.55 : 1,
          transform: [{ rotate: `${rotation}deg` }, { scale: JUVENILE_SCALE + (1 - JUVENILE_SCALE) * maturity }],
        }}
      >
        <BugSprite visual={bug.traits.visual} pixel={BUG_PIXEL} />
      </View>
      {bug.satiety < HUNGRY_SATIETY && (
        <View style={[styles.hungerTrack, { left: x - 8, top: y - BUG_HEIGHT / 2 - 6 }]}>
          <View style={[styles.hungerFill, { width: Math.max(2, Math.round((bug.satiety / HUNGRY_SATIETY) * 16)) }]} />
        </View>
      )}
    </>
  );
}

function HabitatView({ state, selectedId, onSelect }: { state: SimulationState; selectedId: string | null; onSelect: (id: string | null) => void }) {
  const [frame, setFrame] = useState<Size | null>(null);
  const { habitat } = state;
  const pebbles = useMemo(() => makePebbles(state.seed + state.ecosystem, habitat), [state.seed, state.ecosystem, habitat]);
  const scale = frame ? Math.min(frame.width / habitat.width, frame.height / habitat.height) : 0;
  const field = { width: Math.floor(habitat.width * scale), height: Math.floor(habitat.height * scale) };
  const offset = frame ? { x: (frame.width - field.width) / 2, y: (frame.height - field.height) / 2 } : { x: 0, y: 0 };

  const handleLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setFrame({ width, height });
  };

  const handlePress = (locationX: number, locationY: number) => {
    if (!scale) return;
    const x = (locationX - offset.x) / scale;
    const y = (locationY - offset.y) / scale;
    let nearest: Bug | null = null;
    let nearestDistance = TAP_RADIUS_PT / scale;
    for (const bug of state.bugs) {
      const distance = Math.hypot(bug.x - x, bug.y - y);
      if (distance < nearestDistance) {
        nearest = bug;
        nearestDistance = distance;
      }
    }
    onSelect(nearest?.id ?? null);
  };

  return (
    <Pressable style={styles.habitatFrame} onLayout={handleLayout} onPress={(event) => handlePress(event.nativeEvent.locationX, event.nativeEvent.locationY)}>
      {/* Children ignore touches so the tap position is always measured against the frame. */}
      <View pointerEvents="none" style={[styles.field, { left: offset.x, top: offset.y, ...field }]}>
        {pebbles.map((pebble, index) => (
          <View
            key={index}
            style={[styles.pebble, { left: Math.round(pebble.x * scale), top: Math.round(pebble.y * scale), width: pebble.size, height: pebble.size }]}
          />
        ))}
        {state.food.map((food) => <FoodSprite key={food.id} food={food} timeS={state.timeS} scale={scale} />)}
        {state.bugs.map((bug) => <BugView key={bug.id} bug={bug} scale={scale} selected={bug.id === selectedId} />)}
      </View>
    </Pressable>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function EndedCard({ state, onRestart }: { state: SimulationState; onRestart: () => void }) {
  const survivor = state.bugs[0];
  return (
    <View style={styles.endedBackdrop}>
      <View style={styles.endedCard}>
        <Text style={styles.eyebrow}>ECOSYSTEM #{state.ecosystem} HAS ENDED</Text>
        <Text style={styles.endedTitle}>{survivor ? `Only ${survivor.name} is left` : 'No bugs are left'}</Text>
        <Text style={styles.endedText}>
          A population needs at least two bugs. It lasted {formatClock(state.endedAtS ?? state.timeS)}, reached generation {state.stats.maxGeneration},
          {' '}hatched {state.stats.births} and peaked at {state.stats.peakPopulation} bugs.
        </Text>
        <TouchableOpacity style={styles.primary} onPress={onRestart}>
          <Text style={styles.primaryText}>Start a new ecosystem</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export function EcosystemScreen({ ecosystem, onOpenLab }: { ecosystem: Ecosystem; onOpenLab: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { state } = ecosystem;

  if (!ecosystem.loaded || !state) {
    return (
      <View style={[styles.root, styles.centered]}>
        <ActivityIndicator color={COLORS.accent} />
      </View>
    );
  }

  if (state.status === 'workshop') {
    return (
      <View style={styles.root}>
        <TraitWorkshop
          ecosystemNumber={state.ecosystem}
          onRelease={(starters) => {
            setSelectedId(null);
            ecosystem.release(starters);
          }}
          onRoll={ecosystem.rollStarters}
          onOpenLab={onOpenLab}
        />
      </View>
    );
  }

  const selected = selectedId ? state.bugs.find((bug) => bug.id === selectedId) ?? null : null;
  const deaths = state.stats.starvations + state.stats.oldAgeDeaths;
  const confirmRestart = () => Alert.alert(
    'Start a new ecosystem?',
    `Ecosystem #${state.ecosystem} and its ${state.bugs.length} bugs will be gone.`,
    [{ text: 'Cancel', style: 'cancel' }, { text: 'Start over', style: 'destructive', onPress: () => { setSelectedId(null); ecosystem.restart(); } }],
  );

  return (
    <View style={styles.root}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.content}>
          <View style={styles.header}>
            <View>
              <Text style={styles.eyebrow}>ECOSYSTEM #{state.ecosystem}</Text>
              <Text style={styles.title}>DistBugs</Text>
            </View>
            <TouchableOpacity onPress={onOpenLab} hitSlop={8}>
              <Text style={styles.labLink}>Spatial Lab</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.stats}>
            <Stat label="BUGS" value={state.bugs.length} />
            <Stat label="FOOD" value={state.food.length} />
            <Stat label="GEN" value={state.stats.maxGeneration} />
            <Stat label="BORN" value={state.stats.births} />
            <Stat label="DIED" value={deaths} />
            <Stat label="TIME" value={formatClock(state.timeS)} />
          </View>

          <View style={styles.habitatWrap}>
            <HabitatView state={state} selectedId={selectedId} onSelect={setSelectedId} />
            {state.status === 'running' && state.paused && (
              <View pointerEvents="none" style={styles.pausedTag}><Text style={styles.pausedText}>PAUSED</Text></View>
            )}
            {state.status === 'ended' && <EndedCard state={state} onRestart={() => { setSelectedId(null); ecosystem.restart(); }} />}
          </View>

          <View style={styles.log}>
            {ecosystem.log.length === 0
              ? <Text style={styles.logHint}>Tap a bug to inspect it.</Text>
              : ecosystem.log.map((entry, index) => (
                <Text key={entry.id} style={[styles.logLine, entry.tone === 'birth' && styles.logBirth, entry.tone === 'death' && styles.logDeath, { opacity: 1 - index * 0.22 }]} numberOfLines={1}>
                  {entry.text}
                </Text>
              ))}
          </View>

          {state.status === 'running' && (
            <View style={styles.controls}>
              <TouchableOpacity style={styles.primary} onPress={() => ecosystem.setPaused(!state.paused)}>
                <Text style={styles.primaryText}>{state.paused ? 'Resume' : 'Pause'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.secondary} onPress={confirmRestart}>
                <Text style={styles.secondaryText}>New ecosystem</Text>
              </TouchableOpacity>
            </View>
          )}

          {selectedId && (
            <BugInspector
              bug={selected}
              obituary={ecosystem.obituaries[selectedId] ?? null}
              parentAlive={Boolean(selected?.parentId && state.bugs.some((bug) => bug.id === selected.parentId))}
              onClose={() => setSelectedId(null)}
            />
          )}
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.background },
  centered: { alignItems: 'center', justifyContent: 'center' },
  safe: { flex: 1 },
  content: { flex: 1, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12, gap: 10 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  eyebrow: { color: COLORS.accent, fontSize: 10, fontWeight: '900', letterSpacing: 1.5, fontFamily: PIXEL_FONT },
  title: { color: COLORS.text, fontSize: 26, fontWeight: '900', letterSpacing: -0.6, marginTop: 2 },
  labLink: { color: COLORS.muted, fontSize: 12, fontWeight: '700', paddingBottom: 4 },
  stats: { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: COLORS.panel, borderRadius: 12, borderWidth: 1, borderColor: COLORS.panelBorder, paddingVertical: 8, paddingHorizontal: 6 },
  stat: { alignItems: 'center', flex: 1 },
  statValue: { color: COLORS.text, fontSize: 15, fontWeight: '800', fontFamily: PIXEL_FONT },
  statLabel: { color: COLORS.faint, fontSize: 9, fontWeight: '900', letterSpacing: 1, marginTop: 2, fontFamily: PIXEL_FONT },
  habitatWrap: { flex: 1 },
  habitatFrame: { flex: 1 },
  field: { position: 'absolute', backgroundColor: COLORS.soil, borderWidth: 2, borderColor: COLORS.soilEdge, overflow: 'hidden' },
  pebble: { position: 'absolute', backgroundColor: COLORS.pebble },
  food: { position: 'absolute', width: FOOD_PIXEL * 3, height: FOOD_PIXEL * 3 },
  selection: { position: 'absolute', width: SELECT_SIZE, height: SELECT_SIZE, borderWidth: 2, borderColor: COLORS.select, borderStyle: 'dashed' },
  hungerTrack: { position: 'absolute', width: 16, height: 3, backgroundColor: 'rgba(0, 0, 0, 0.5)' },
  hungerFill: { height: 3, backgroundColor: COLORS.bad },
  pausedTag: { position: 'absolute', top: 10, left: 10, backgroundColor: 'rgba(15, 13, 11, 0.85)', paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: COLORS.accent },
  pausedText: { color: COLORS.accent, fontSize: 11, fontWeight: '900', letterSpacing: 1.5, fontFamily: PIXEL_FONT },
  endedBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(15, 13, 11, 0.55)', justifyContent: 'center', padding: 18 },
  endedCard: { backgroundColor: COLORS.panel, borderRadius: 18, borderWidth: 2, borderColor: COLORS.accent, padding: 18, gap: 12 },
  endedTitle: { color: COLORS.text, fontSize: 22, fontWeight: '900' },
  endedText: { color: COLORS.muted, fontSize: 13, lineHeight: 19 },
  log: { height: 64, justifyContent: 'flex-start', gap: 2 },
  logHint: { color: COLORS.faint, fontSize: 12 },
  logLine: { color: COLORS.muted, fontSize: 12, fontFamily: PIXEL_FONT },
  logBirth: { color: COLORS.good },
  logDeath: { color: COLORS.bad },
  controls: { flexDirection: 'row', gap: 10 },
  primary: { flex: 1, backgroundColor: COLORS.accent, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  primaryText: { color: '#241b12', fontWeight: '900' },
  secondary: { paddingHorizontal: 16, paddingVertical: 14, borderRadius: 14, borderWidth: 1, borderColor: COLORS.panelBorder, alignItems: 'center' },
  secondaryText: { color: COLORS.text, fontWeight: '700' },
});
