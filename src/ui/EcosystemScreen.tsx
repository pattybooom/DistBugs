import { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Dimensions, GestureResponderEvent, HostInstance, PanResponder, Pressable, SafeAreaView, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import { GateSegment, HabitatLayout } from '../game/crossing';
import { MATURITY_FRACTION } from '../game/Simulation';
import { SPRITE_HEIGHT, SPRITE_WIDTH } from '../game/sprites';
import { Bug, Food, SimulationState } from '../game/types';
import { BugInspector } from './BugInspector';
import { BugSprite } from './BugSprite';
import { JoinOverlay } from './JoinOverlay';
import { LinkSheet } from './LinkSheet';
import { COLORS, formatClock, PIXEL_FONT } from './theme';
import { BIOME_GROUND, TileLayer } from './TileLayer';
import { TraitWorkshop } from './TraitWorkshop';
import { TrackingSquare } from './TrackingSquare';
import { BugBridge } from './useBugBridge';
import { Ecosystem } from './useEcosystem';

/** Screen points per sprite pixel; the habitat is scaled, bugs are not, so they stay crisp. */
const BUG_PIXEL = 3;
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
const GATE_WIDTH = 4;

const JOIN_THEME = { background: COLORS.background, accent: COLORS.travel, text: COLORS.text, muted: COLORS.muted, warn: COLORS.warn, border: COLORS.panelBorder };

type Size = { width: number; height: number };

function FoodSprite({ food, timeS, scale }: { food: Food; timeS: number; scale: number }) {
  const left = food.expiresAtS - timeS;
  const blinkOff = left < FOOD_WARNING_S && Math.floor(left * 4) % 2 === 0;
  const p = FOOD_PIXEL;
  return (
    <View style={[styles.food, { left: Math.round(food.x * scale - p * 1.5), top: Math.round(food.y * scale - p * 1.5), opacity: blinkOff ? 0.3 : 1 }]}>
      {/* A dark rim keeps food visible on any ground, green grass included. */}
      <View style={{ position: 'absolute', left: -p / 2, top: p / 2, width: p * 4, height: p * 2, backgroundColor: COLORS.foodRim }} />
      <View style={{ position: 'absolute', left: p / 2, top: -p / 2, width: p * 2, height: p * 4, backgroundColor: COLORS.foodRim }} />
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
      <View style={[styles.healthTrack, { left: x - 12, top: y - BUG_HEIGHT / 2 - 11 }]}><View style={[styles.healthFill, { width: Math.max(1, Math.round((bug.health / bug.maxHealth) * 24)), backgroundColor: bug.owner === 'local' ? COLORS.good : COLORS.bad }]} /></View>
    </>
  );
}

/** The open stretches of the walls, where bugs can cross to the other phone. */
function GateView({ gate, field, scale }: { gate: GateSegment; field: Size; scale: number }) {
  const along = { start: Math.round(gate.from * scale), length: Math.max(GATE_WIDTH, Math.round((gate.to - gate.from) * scale)) };
  const style = gate.edge === 'left' || gate.edge === 'right'
    ? { left: gate.edge === 'left' ? 0 : field.width - GATE_WIDTH, top: along.start, width: GATE_WIDTH, height: along.length }
    : { top: gate.edge === 'top' ? 0 : field.height - GATE_WIDTH, left: along.start, height: GATE_WIDTH, width: along.length };
  return <View style={[styles.gate, style]} />;
}

const MAX_ZOOM = 4;
/** Further than this, a one-finger touch is a drag rather than a tap. */
const DRAG_START_PT = 8;

/** Zoom and scroll, like a map: `x` and `y` shift the zoomed habitat from the screen centre, in screen points. */
type MapView = { zoom: number; x: number; y: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Keeps the habitat covering the screen: zoom from 1 to MAX_ZOOM, and no scrolling past an edge. */
function clampView(view: MapView, width: number, height: number): MapView {
  const zoom = clamp(view.zoom, 1, MAX_ZOOM);
  const limitX = ((zoom - 1) * width) / 2;
  const limitY = ((zoom - 1) * height) / 2;
  return { zoom, x: clamp(view.x, -limitX, limitX), y: clamp(view.y, -limitY, limitY) };
}

/** Centre of the first two touches and how far apart they are (0 for one finger). */
function touchesOf(event: GestureResponderEvent) {
  const touches = event.nativeEvent.touches.slice(0, 2);
  const x = touches.reduce((sum, touch) => sum + touch.pageX, 0) / touches.length;
  const y = touches.reduce((sum, touch) => sum + touch.pageY, 0) / touches.length;
  const spread = touches.length === 2 ? Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY) : 0;
  return { count: touches.length, x, y, spread };
}

function HabitatView({ state, selectedId, onSelect, gates, onFieldLayout }: {
  state: SimulationState;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  gates: GateSegment[];
  onFieldLayout: (layout: HabitatLayout) => void;
}) {
  const [frame, setFrame] = useState<Size | null>(null);
  const [view, setView] = useState<MapView>({ zoom: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  const frameInfo = useRef({ x: 0, y: 0, width: 0, height: 0 });
  const gesture = useRef<{ count: number; start: MapView; x: number; y: number; spread: number } | null>(null);
  const frameRef = useRef<HostInstance>(null);
  const { habitat } = state;
  const scale = frame ? Math.min(frame.width / habitat.width, frame.height / habitat.height) : 0;
  // The habitat has the screen's shape, so this fills the screen; any rounding sliver is centred.
  const field = { width: habitat.width * scale, height: habitat.height * scale };
  const offset = frame ? { x: (frame.width - field.width) / 2, y: (frame.height - field.height) / 2 } : { x: 0, y: 0 };

  // Tells the other phone where this habitat is drawn in window coordinates. Zoom and scroll move
  // it, so crossing follows what is on screen: a wall that is scrolled away from the screen's edge is no
  // longer where the phones touch, and a bug can't cross there.
  const reportField = (current: MapView) => {
    const { x, y, width, height } = frameInfo.current;
    if (!width || !height) return;
    const fit = Math.min(width / habitat.width, height / habitat.height);
    const fieldWidth = habitat.width * fit * current.zoom;
    const fieldHeight = habitat.height * fit * current.zoom;
    const window = Dimensions.get('window');
    onFieldLayout({
      screen: { widthPt: window.width, heightPt: window.height },
      field: { xPt: x + width / 2 + current.x - fieldWidth / 2, yPt: y + height / 2 + current.y - fieldHeight / 2, widthPt: fieldWidth, heightPt: fieldHeight },
      habitat,
    });
  };
  const reportRef = useRef(reportField);
  reportRef.current = reportField;

  const applyView = (next: MapView, report: boolean) => {
    const { width, height } = frameInfo.current;
    const clamped = clampView(next, width, height);
    viewRef.current = clamped;
    setView(clamped);
    if (report) reportRef.current(clamped);
  };
  const applyViewRef = useRef(applyView);
  applyViewRef.current = applyView;

  const handleLayout = () => {
    frameRef.current?.measureInWindow((xPt, yPt, width, height) => {
      frameInfo.current = { x: xPt, y: yPt, width, height };
      setFrame({ width, height });
      applyViewRef.current(viewRef.current, true);
    });
  };

  // One finger scrolls, two fingers pinch and scroll together. Taps never start a gesture, so they still pick bugs.
  const pan = useMemo(() => {
    const begin = (event: GestureResponderEvent) => {
      const touch = touchesOf(event);
      gesture.current = { count: touch.count, start: viewRef.current, x: touch.x, y: touch.y, spread: touch.spread };
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponderCapture: (event, state) => event.nativeEvent.touches.length >= 2 || Math.hypot(state.dx, state.dy) > DRAG_START_PT,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: begin,
      onPanResponderMove: (event) => {
        const touch = touchesOf(event);
        // A finger landing or lifting restarts from where the view is now, so it never jumps.
        if (!gesture.current || gesture.current.count !== touch.count) { begin(event); return; }
        const { start, x, y, spread } = gesture.current;
        const frameNow = frameInfo.current;
        if (touch.count === 2 && spread > 0) {
          const zoom = clamp(start.zoom * (touch.spread / spread), 1, MAX_ZOOM);
          // Keeps the spot that was between the fingers at the start between them now.
          const from = { x: x - frameNow.x - frameNow.width / 2, y: y - frameNow.y - frameNow.height / 2 };
          const to = { x: touch.x - frameNow.x - frameNow.width / 2, y: touch.y - frameNow.y - frameNow.height / 2 };
          const under = { x: (from.x - start.x) / start.zoom, y: (from.y - start.y) / start.zoom };
          applyViewRef.current({ zoom, x: to.x - zoom * under.x, y: to.y - zoom * under.y }, false);
        } else {
          applyViewRef.current({ zoom: start.zoom, x: start.x + touch.x - x, y: start.y + touch.y - y }, false);
        }
      },
      onPanResponderRelease: () => { gesture.current = null; reportRef.current(viewRef.current); },
      onPanResponderTerminate: () => { gesture.current = null; reportRef.current(viewRef.current); },
    });
  }, []);

  /** The +/- buttons zoom about the middle of the screen. */
  const zoomBy = (step: number) => {
    const current = viewRef.current;
    const zoom = clamp(Math.round((current.zoom + step) * 100) / 100, 1, MAX_ZOOM);
    applyView({ zoom, x: current.x * (zoom / current.zoom), y: current.y * (zoom / current.zoom) }, true);
  };

  const handlePress = (locationX: number, locationY: number) => {
    if (!scale) return;
    const centerX = habitat.width / 2;
    const centerY = habitat.height / 2;
    // The touch is measured on the frame; undo the scroll and zoom, then the fit, to reach habitat units.
    const x = centerX + (locationX - (frame?.width ?? 0) / 2 - view.x) / view.zoom / scale;
    const y = centerY + (locationY - (frame?.height ?? 0) / 2 - view.y) / view.zoom / scale;
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
    <View style={styles.habitatFrame} {...pan.panHandlers}>
    <Pressable ref={frameRef} style={StyleSheet.absoluteFill} onLayout={handleLayout} onPress={(event) => handlePress(event.nativeEvent.locationX, event.nativeEvent.locationY)}>
      {/* Children ignore touches so the tap position is always measured against the frame. */}
      <View pointerEvents="none" style={[styles.field, { left: offset.x, top: offset.y, ...field, backgroundColor: BIOME_GROUND[state.arena.biome], transform: [{ translateX: view.x }, { translateY: view.y }, { scale: view.zoom }] }]}>
        {scale > 0 && <TileLayer arena={state.arena} habitat={habitat} seed={state.seed} scale={scale} />}
        {gates.map((gate, index) => <GateView key={index} gate={gate} field={field} scale={scale} />)}
        {state.food.map((food) => <FoodSprite key={food.id} food={food} timeS={state.timeS} scale={scale} />)}
        {state.bugs.map((bug) => <BugView key={bug.id} bug={bug} scale={scale} selected={bug.id === selectedId} />)}
      </View>
      <View style={styles.zoomControls}>
        <TouchableOpacity style={styles.zoomButton} onPress={() => zoomBy(0.5)}><Text style={styles.zoomText}>+</Text></TouchableOpacity>
        <Text style={styles.zoomLabel}>{Math.round(view.zoom * 100)}%</Text>
        <TouchableOpacity style={styles.zoomButton} onPress={() => zoomBy(-0.5)}><Text style={styles.zoomText}>−</Text></TouchableOpacity>
      </View>
    </Pressable>
    </View>
  );
}

function EndedCard({ state, onRestart }: { state: SimulationState; onRestart: () => void }) {
  const survivor = state.bugs[0];
  return (
    <View style={styles.endedBackdrop}>
      <View style={styles.endedCard}>
        <Text style={styles.eyebrow}>{state.mode === 'battle' ? 'BATTLE COMPLETE' : `ECOSYSTEM #${state.ecosystem} HAS ENDED`}</Text>
        <Text style={styles.endedTitle}>{survivor ? `Only ${survivor.name} is left` : 'No bugs are left'}</Text>
        <Text style={styles.endedText}>
          {state.mode === 'battle' ? `The ${state.arena.biome} arena lasted ${formatClock(state.endedAtS ?? state.timeS)}.` : `A population needs at least two bugs. It lasted ${formatClock(state.endedAtS ?? state.timeS)}, reached generation ${state.stats.maxGeneration}.`}
        </Text>
        <TouchableOpacity style={styles.primary} onPress={onRestart}>
          <Text style={styles.primaryText}>Start a new ecosystem</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export function EcosystemScreen({ ecosystem, bridge, onOpenLab }: { ecosystem: Ecosystem; bridge: BugBridge; onOpenLab: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const window = useWindowDimensions();
  const { state } = ecosystem;
  const joinOverlay = bridge.joinOpen && (
    <JoinOverlay role={bridge.role} note={bridge.joinNote} status={bridge.joinStatus} onSwipe={bridge.handleSwipe} onClose={bridge.closeJoin} theme={JOIN_THEME} camera={bridge.camera} onScreenMarkers />
  );
  // The camera finds each phone by the square it draws, so it stays on top of everything while tracking.
  const trackingSquare = bridge.camera.enabled && bridge.camera.marker
    ? <TrackingSquare marker={bridge.camera.marker} width={window.width} height={window.height} /> : null;

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
          onRelease={(starters, power) => {
            setSelectedId(null);
            ecosystem.release(starters, power);
          }}
          onRoll={ecosystem.rollStarters}
          onOpenLab={onOpenLab}
        />
        {joinOverlay}
        {trackingSquare}
      </View>
    );
  }

  const selected = selectedId ? state.bugs.find((bug) => bug.id === selectedId) ?? null : null;
  const confirmRestart = () => Alert.alert(
    'Start a new ecosystem?',
    `Ecosystem #${state.ecosystem} and its ${state.bugs.length} bugs will be gone.`,
    [{ text: 'Cancel', style: 'cancel' }, { text: 'Start over', style: 'destructive', onPress: () => { setSelectedId(null); ecosystem.restart(); } }],
  );

  return (
    <View style={styles.root}>
      {/* The habitat fills the whole screen, edge to edge, so bugs cross at the phone's physical edge. */}
      <HabitatView
        state={state}
        selectedId={selectedId}
        onSelect={(id) => { setLinkOpen(false); setSelectedId(id); }}
        gates={bridge.gates}
        onFieldLayout={bridge.setOwnLayout}
      />
      <SafeAreaView style={styles.hud} pointerEvents="box-none">
        <View style={styles.content} pointerEvents="box-none">
          <View style={styles.header}>
            <View style={styles.headerLinks}>
              <TouchableOpacity onPress={() => { setSelectedId(null); setLinkOpen(true); }} hitSlop={8}>
                <Text style={[styles.linkButton, bridge.status === 'joined' && styles.linkButtonJoined]}>
                  {bridge.status === 'joined' ? 'Linked' : bridge.status === 'off' ? 'Link' : 'Linking…'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={onOpenLab} hitSlop={8}>
                <Text style={styles.labLink}>Spatial Lab</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={ecosystem.toggleSound} hitSlop={8}>
                <Text style={styles.labLink}>{state.soundEnabled ? 'Sound on' : 'Muted'}</Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.middle} pointerEvents="box-none">
            {state.status === 'running' && state.paused && (
              <View pointerEvents="none" style={styles.pausedTag}><Text style={styles.pausedText}>PAUSED</Text></View>
            )}
          </View>

          <View style={styles.panel} pointerEvents="box-none">
            {/* Taps on the log reach the bugs beneath it. */}
            <View style={styles.log} pointerEvents="none">
              {ecosystem.log.length === 0
                ? <Text style={styles.logHint}>Tap a bug to inspect it.</Text>
                : ecosystem.log.map((entry, index) => (
                  <Text key={entry.id} style={[styles.logLine, entry.tone === 'birth' && styles.logBirth, entry.tone === 'death' && styles.logDeath, entry.tone === 'travel' && styles.logTravel, { opacity: 1 - index * 0.22 }]} numberOfLines={1}>
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
          </View>

          {selectedId && (
            <BugInspector
              bug={selected}
              obituary={ecosystem.obituaries[selectedId] ?? null}
              parentAlive={Boolean(selected?.parentId && state.bugs.some((bug) => bug.id === selected.parentId))}
              onClose={() => setSelectedId(null)}
            />
          )}
          {linkOpen && <LinkSheet bridge={bridge} onClose={() => setLinkOpen(false)} />}
        </View>
      </SafeAreaView>
      {state.status === 'ended' && <EndedCard state={state} onRestart={() => { setSelectedId(null); ecosystem.restart(); }} />}
      {joinOverlay}
      {trackingSquare}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.soil },
  centered: { alignItems: 'center', justifyContent: 'center' },
  hud: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  content: { flex: 1, paddingHorizontal: 10, paddingTop: 4, paddingBottom: 8, gap: 8 },
  panel: { backgroundColor: 'rgba(15, 13, 11, 0.72)', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  middle: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center' },
  eyebrow: { color: COLORS.accent, fontSize: 10, fontWeight: '900', letterSpacing: 1.5, fontFamily: PIXEL_FONT },
  title: { color: COLORS.text, fontSize: 20, fontWeight: '900', letterSpacing: -0.4, marginTop: 2 },
  labLink: { color: COLORS.muted, fontSize: 12, fontWeight: '700', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, overflow: 'hidden', backgroundColor: 'rgba(15, 13, 11, 0.72)' },
  headerLinks: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  linkButton: { color: COLORS.accent, fontSize: 12, fontWeight: '800', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, overflow: 'hidden', backgroundColor: 'rgba(15, 13, 11, 0.72)' },
  linkButtonJoined: { color: COLORS.travel },
  gate: { position: 'absolute', backgroundColor: COLORS.travel, opacity: 0.85 },
  habitatFrame: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  field: { position: 'absolute', backgroundColor: COLORS.soil, overflow: 'hidden' },
  food: { position: 'absolute', width: FOOD_PIXEL * 3, height: FOOD_PIXEL * 3 },
  selection: { position: 'absolute', width: SELECT_SIZE, height: SELECT_SIZE, borderWidth: 2, borderColor: COLORS.select, borderStyle: 'dashed' },
  hungerTrack: { position: 'absolute', width: 16, height: 3, backgroundColor: 'rgba(0, 0, 0, 0.5)' },
  hungerFill: { height: 3, backgroundColor: COLORS.bad },
  healthTrack: { position: 'absolute', width: 24, height: 3, backgroundColor: 'rgba(0, 0, 0, 0.6)' },
  healthFill: { height: 3 },
  zoomControls: { position: 'absolute', right: 12, bottom: 110, alignItems: 'center', gap: 4 },
  zoomButton: { width: 38, height: 38, borderRadius: 12, backgroundColor: 'rgba(15, 13, 11, 0.78)', borderWidth: 1, borderColor: COLORS.panelBorder, alignItems: 'center', justifyContent: 'center' },
  zoomText: { color: COLORS.text, fontSize: 24, fontWeight: '800', lineHeight: 26 },
  zoomLabel: { color: COLORS.text, fontSize: 10, fontWeight: '900', backgroundColor: 'rgba(15, 13, 11, 0.7)', paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4 },
  pausedTag: { alignSelf: 'flex-start', backgroundColor: 'rgba(15, 13, 11, 0.85)', paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: COLORS.accent },
  pausedText: { color: COLORS.accent, fontSize: 11, fontWeight: '900', letterSpacing: 1.5, fontFamily: PIXEL_FONT },
  endedBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(15, 13, 11, 0.55)', justifyContent: 'center', padding: 24 },
  endedCard: { backgroundColor: COLORS.panel, borderRadius: 18, borderWidth: 2, borderColor: COLORS.accent, padding: 18, gap: 12 },
  endedTitle: { color: COLORS.text, fontSize: 22, fontWeight: '900' },
  endedText: { color: COLORS.muted, fontSize: 13, lineHeight: 19 },
  log: { height: 58, justifyContent: 'flex-start', gap: 2 },
  logHint: { color: COLORS.faint, fontSize: 12 },
  logLine: { color: COLORS.muted, fontSize: 12, fontFamily: PIXEL_FONT },
  logBirth: { color: COLORS.good },
  logDeath: { color: COLORS.bad },
  logTravel: { color: COLORS.travel },
  controls: { flexDirection: 'row', gap: 10 },
  primary: { flex: 1, backgroundColor: COLORS.accent, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  primaryText: { color: '#241b12', fontWeight: '900' },
  secondary: { paddingHorizontal: 16, paddingVertical: 14, borderRadius: 14, borderWidth: 1, borderColor: COLORS.panelBorder, alignItems: 'center' },
  secondaryText: { color: COLORS.text, fontWeight: '700' },
});
