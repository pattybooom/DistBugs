import { useEffect, useRef, useState } from 'react';
import { useCameraJoin } from '../ui/useCameraJoin';
import { CameraJoinControls } from '../ui/CameraJoinControls';
import {
  Animated,
  Dimensions,
  Easing,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import ParallaxModule, {
  ConnectionState,
  DistanceEvent,
  DeviceRole,
  MotionEvent,
  NativeCapabilities,
  Peer,
  Quaternion,
  ReferenceFrame,
  SpatialSessionState,
  Vector3,
} from '../native/ParallaxModule';
import {
  isFresh,
  PositionEstimate,
  tablePlaneHeading,
  transformDirectionToReferenceFrame,
  wrapAngle,
} from '../spatial/SpatialMath';
import { layoutPhonePair, PHONE_SIZE_CM, rotatePosition, ScenePoint, viewRotation } from '../spatial/SceneLayout';
import {
  classifySwipe,
  computeStitch,
  matchSwipes,
  MOVED_THRESHOLD_CM,
  MovedApartCheck,
  parseStitchMessage,
  PhoneRole,
  predictedAntennaDistanceCm,
  screenPoses,
  serializeStitchMessage,
  Stitch,
  StitchMessage,
  StitchState,
  stitchedLayout,
  SwipeReport,
  tableToScreen,
  TouchSample,
} from '../spatial/Stitch';
import { DistanceFilter, FilteredDistance } from '../state/DistanceFilter';
import { JoinOverlay } from '../ui/JoinOverlay';
import { glow, GridBackdrop, HUD, HUD_FONT, HudButton, HudFrame, PulseDot } from '../ui/hud';

const CONNECTION_STATES: ConnectionState[] = ['disconnected', 'connecting', 'connected', 'recovering'];
/** Swipe halves older than this can no longer pair with a new one. */
const SWIPE_REPORT_LIFETIME_MS = 3000;
/** Gives the other phone a moment to finish connecting before both send their Nearby Interaction tokens. */
const AUTO_RANGING_DELAY_MS = 500;
/** Join animation: the spark's crossing, then the landing ring and fade. */
const LINK_TRAVEL_MS = 1100;
const LINK_SETTLE_MS = 700;
const LINK_HEAD_SIZE = 26;
const LINK_RING_SIZE = 64;
const LINK_COLORS: Record<PhoneRole, string> = { A: HUD.cyan, B: HUD.magenta };
const SCENE_WIDTH = 340;
const SCENE_HEIGHT = 410;
const ORIGIN_X = SCENE_WIDTH / 2;
const ORIGIN_Y = 205;
/** Largest drawing scale, used when the phones are close; a phone is then about 41 × 85 px. */
const MAX_PIXELS_PER_CM = 5.5;
/** Both phone outlines are kept within this many pixels of the origin by shrinking the scale. */
const SCENE_REACH_PX = 150;
const PHONE_HALF_DIAGONAL_CM = Math.hypot(PHONE_SIZE_CM.widthCm, PHONE_SIZE_CM.lengthCm) / 2;
const RAD_TO_DEG = 180 / Math.PI;

const readConnectionState = (value: unknown): ConnectionState | null => {
  const candidate = typeof value === 'string'
    ? value
    : value && typeof value === 'object' && 'state' in value
      ? (value as { state?: unknown }).state
      : null;
  return typeof candidate === 'string' && CONNECTION_STATES.includes(candidate as ConnectionState)
    ? candidate as ConnectionState
    : null;
};

const formatDistance = (value: number | null | undefined): string =>
  value == null || !Number.isFinite(value) ? '—' : `${Math.round(value)} cm`;

const readSessionState = (value: unknown): SpatialSessionState | null =>
  value && typeof value === 'object' && 'sessionState' in value && typeof (value as { sessionState?: unknown }).sessionState === 'string'
    ? (value as { sessionState: SpatialSessionState }).sessionState
    : null;

const readRole = (value: unknown): PhoneRole | null => {
  const role = value && typeof value === 'object' && 'role' in value ? (value as { role?: unknown }).role : null;
  return role === 'A' || role === 'B' ? role : null;
};

const headingOf = (motion: MotionEvent | null | undefined): number | null => tablePlaneHeading(motion?.attitudeQuaternion);

const EMPTY_DISTANCE: FilteredDistance = { rawCm: null, smoothedCm: null, role: null, fresh: false };

const formatVector = (vector?: Vector3 | null): string =>
  vector ? `[${vector.x.toFixed(2)}, ${vector.y.toFixed(2)}, ${vector.z.toFixed(2)}]` : '—';

const formatQuaternion = (quaternion?: Quaternion): string =>
  quaternion ? `[${quaternion.x.toFixed(2)}, ${quaternion.y.toFixed(2)}, ${quaternion.z.toFixed(2)}, ${quaternion.w.toFixed(2)}]` : '—';

const formatDegrees = (radians: number | null | undefined): string =>
  radians == null || !Number.isFinite(radians) ? '—' : `${Math.round(radians * RAD_TO_DEG)}°`;

const formatEuler = (motion: MotionEvent | null): string =>
  motion ? `${formatDegrees(motion.yaw)} / ${formatDegrees(motion.pitch)} / ${formatDegrees(motion.roll)}` : '—';

const formatAge = (timestamp: number | undefined, now: number): string =>
  timestamp == null || !Number.isFinite(timestamp) ? '—' : `${Math.max(0, Math.round(now - timestamp))} ms`;

const formatFrame = (frame?: ReferenceFrame): string => {
  if (!frame || frame === 'unavailable') return 'UNAVAILABLE';
  return frame.replace('x', '').replace('ZVertical', '').replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase();
};

/** The glyph is drawn top-up (reference +Y); React Native rotates clockwise, headings run anticlockwise from +X. */
const glyphRotation = (heading: number | null): number => heading == null ? 0 : 90 - heading * RAD_TO_DEG;

function PhoneGlyph({
  accent = 'blue',
  rotation = 0,
  estimated = false,
  width = 52,
  height = 82,
  label,
}: {
  accent?: 'blue' | 'red';
  rotation?: number;
  estimated?: boolean;
  width?: number;
  height?: number;
  label?: string;
}) {
  const red = accent === 'red';
  // Speaker, home bar and inner padding only fit once the phone is drawn reasonably large.
  const detailed = width >= 30;
  return (
    <View
      style={[
        styles.phone,
        { width, height, borderRadius: Math.max(2, width * 0.21), padding: detailed ? width * 0.1 : 0 },
        red && styles.phoneRed,
        estimated && styles.phoneEstimated,
        { transform: [{ rotate: `${rotation}deg` }] },
      ]}
    >
      {detailed && <View style={[styles.phoneSpeaker, red && styles.phoneSpeakerRed]} />}
      <View style={[styles.phoneScreen, !detailed && styles.phoneScreenCompact]}>
        {label
          ? width >= 14 && <Text style={[styles.phoneLetter, red && styles.phoneLetterRed, { fontSize: Math.min(20, width * 0.45) }]}>{label}</Text>
          : <View style={[styles.phoneGlow, red && styles.phoneGlowRed]} />}
      </View>
      {detailed && <View style={[styles.phoneHome, red && styles.phoneHomeRed]} />}
    </View>
  );
}

function PositionScene({
  position,
  headingA,
  headingB,
  note,
  stale = false,
}: {
  position: PositionEstimate;
  headingA: number | null;
  headingB: number | null;
  note?: string | null;
  /** Phone B was placed by a join that no longer holds; it is drawn dashed. */
  stale?: boolean;
}) {
  const estimated = position.source === 'estimated' || stale;
  const layout = position.source === 'measured' || position.source === 'stitched' || estimated ? layoutPhonePair(position, headingA, headingB) : null;
  // Phones are drawn to scale; the scale shrinks until both outlines fit.
  const extentCm = (layout ? Math.max(Math.abs(layout.centreB.xCm), Math.abs(layout.centreB.yCm)) : 0) + PHONE_HALF_DIAGONAL_CM;
  const pixelsPerCm = Math.min(MAX_PIXELS_PER_CM, SCENE_REACH_PX / extentCm);
  const phoneWidth = PHONE_SIZE_CM.widthCm * pixelsPerCm;
  const phoneHeight = PHONE_SIZE_CM.lengthCm * pixelsPerCm;
  const toScreen = ({ xCm, yCm }: ScenePoint) => ({ x: ORIGIN_X + xCm * pixelsPerCm, y: ORIGIN_Y - yCm * pixelsPerCm });
  const centreB = layout && toScreen(layout.centreB);
  const gapStart = layout && toScreen(layout.gapStart);
  const gapEnd = layout && toScreen(layout.gapEnd);
  const gapPx = layout ? layout.gapCm * pixelsPerCm : 0;
  const notes = [layout && note, layout && headingB == null && 'B ROTATION UNKNOWN'].filter(Boolean).join(' · ');

  return (
    <View style={styles.scene}>
      {[50, 100, 150, 200].map((radius) => (
        <View key={radius} style={[styles.rangeRing, { left: ORIGIN_X - radius, top: ORIGIN_Y - radius, width: radius * 2, height: radius * 2, borderRadius: radius }]} />
      ))}
      <RadarSweep />
      <View style={styles.axisHorizontal} />
      <View style={styles.axisVertical} />
      <View style={[styles.axisLabel, styles.axisLabelX]}><Text style={styles.axisText}>X</Text></View>
      <View style={[styles.axisLabel, styles.axisLabelY]}><Text style={styles.axisText}>Y</Text></View>
      {gapStart && gapEnd && gapPx > 2 && (
        <View style={[
          styles.measurementVector,
          estimated && styles.measurementVectorEstimated,
          {
            left: gapStart.x,
            top: gapStart.y,
            width: gapPx,
            transform: [{ rotate: `${Math.atan2(gapEnd.y - gapStart.y, gapEnd.x - gapStart.x) * RAD_TO_DEG}deg` }],
          },
        ]} />
      )}
      <View style={[styles.phoneAnchor, { left: ORIGIN_X - phoneWidth / 2, top: ORIGIN_Y - phoneHeight / 2 }]}>
        <PhoneGlyph width={phoneWidth} height={phoneHeight} label="A" rotation={glyphRotation(headingA)} />
      </View>
      {centreB ? (
        <View style={[styles.phoneAnchor, { left: centreB.x - phoneWidth / 2, top: centreB.y - phoneHeight / 2 }]}>
          <PhoneGlyph accent="red" width={phoneWidth} height={phoneHeight} label="B" rotation={glyphRotation(headingB)} estimated={estimated} />
        </View>
      ) : (
        <View style={styles.unknownPosition}>
          <Text style={styles.unknownGlyph}>?</Text>
          <Text style={styles.unknownTitle}>POSITION UNKNOWN</Text>
          <Text style={styles.unknownReason}>{position.reason}</Text>
        </View>
      )}
      <View style={styles.sceneFooter}>
        <Text style={styles.sceneFooterText}>
          {layout
            ? `${formatDistance(layout.distanceCm)} CENTRE TO CENTRE · ${layout.touching ? 'TOUCHING' : `GAP ${formatDistance(layout.gapCm)}`}${notes ? ` · ${notes}` : ''}`
            : 'Waiting for a camera layout or swipe join'}
        </Text>
        <Text style={styles.sceneScaleText}>{`PHONES TO SCALE · 10 cm = ${Math.round(pixelsPerCm * 10)} px · +Y = PHONE A AT START`}</Text>
      </View>
    </View>
  );
}

/** A slow radar arm turning around Phone A; decoration only. */
function RadarSweep() {
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(turn, { toValue: 1, duration: 4000, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [turn]);
  return <Animated.View pointerEvents="none" style={[styles.sweep, { transform: [{ rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] }]} />;
}

function DiagnosticRow({ label, value, tone = 'normal' }: { label: string; value: string; tone?: 'normal' | 'good' | 'warn' }) {
  return (
    <View style={styles.diagnosticRow}>
      <Text style={styles.diagnosticLabel}>{label}</Text>
      <Text style={[styles.diagnosticValue, tone === 'good' && styles.goodText, tone === 'warn' && styles.warnText]}>{value}</Text>
    </View>
  );
}

function RoleDiagnostics({
  role,
  measurement,
  motion,
  now,
}: {
  role: PhoneRole;
  measurement: DistanceEvent | null;
  motion: MotionEvent | null;
  now: number;
}) {
  const worldGravity = motion?.gravity ? transformDirectionToReferenceFrame(motion.gravity, motion.attitudeQuaternion) : null;
  return (
    <>
      <DiagnosticRow label={`${role} DISTANCE`} value={formatDistance(measurement?.distanceCm)} />
      <DiagnosticRow label={`${role} DIRECTION`} value={formatVector(measurement?.direction)} />
      <DiagnosticRow label={`${role} HORIZONTAL ANGLE`} value={formatDegrees(measurement?.horizontalAngleRad)} />
      <DiagnosticRow label={`${role} QUATERNION`} value={formatQuaternion(motion?.attitudeQuaternion)} />
      <DiagnosticRow label={`${role} YAW / PITCH / ROLL`} value={formatEuler(motion)} />
      <DiagnosticRow label={`${role} TABLE HEADING`} value={formatDegrees(tablePlaneHeading(motion?.attitudeQuaternion))} />
      <DiagnosticRow label={`${role} GRAVITY`} value={formatVector(motion?.gravity)} />
      <DiagnosticRow label={`${role} WORLD GRAVITY`} value={formatVector(worldGravity)} tone={worldGravity ? (worldGravity.z < -0.95 ? 'good' : 'warn') : 'normal'} />
      <DiagnosticRow label={`${role} ANGULAR VELOCITY`} value={formatVector(motion?.angularVelocity)} />
      <DiagnosticRow label={`${role} FRAME`} value={formatFrame(motion?.referenceFrame)} />
      <DiagnosticRow
        label={`${role} SLIDE`}
        value={motion?.displacementCm
          ? `${motion.stationary ? 'STILL' : 'MOVING'} · ${formatVector(motion.displacementCm)} cm · ${(motion.movingSeconds ?? 0).toFixed(1)} s MOVING`
          : '—'}
      />
      <DiagnosticRow label={`${role} USER ACCEL`} value={formatVector(motion?.userAcceleration)} />
      <DiagnosticRow label={`${role} READING AGE`} value={formatAge(measurement?.receivedAt, now)} />
    </>
  );
}

type ScreenPoint = { xPt: number; yPt: number };
type LinkPath = { id: string; from: PhoneRole; start: ScreenPoint; end: ScreenPoint };

/**
 * Plays when the phones join: a ring pulses on the phone the swipe started on, a spark runs to
 * the other phone's centre with a beam behind it, and a ring pulses where it lands. Both phones
 * draw the same path on the table in their own screen points, so the part beyond each screen
 * falls off its edge and the spark crosses the gap from one phone onto the other.
 */
function LinkAnimation({ path, onDone }: { path: LinkPath; onDone: () => void }) {
  const travel = useRef(new Animated.Value(0)).current;
  const settle = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    // The same easing on both phones keeps the spark at the same place on the table on each.
    const animation = Animated.sequence([
      Animated.timing(travel, { toValue: 1, duration: LINK_TRAVEL_MS, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }),
      Animated.timing(settle, { toValue: 1, duration: LINK_SETTLE_MS, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]);
    animation.start(({ finished }) => { if (finished) onDone(); });
    return () => animation.stop();
  }, [travel, settle]);

  const { start, end } = path;
  const color = LINK_COLORS[path.from];
  const lengthPt = Math.hypot(end.xPt - start.xPt, end.yPt - start.yPt);
  const angleRad = Math.atan2(end.yPt - start.yPt, end.xPt - start.xPt);
  const fadeOut = settle.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  const fadeIn = travel.interpolate({ inputRange: [0, 0.08], outputRange: [0, 1], extrapolate: 'clamp' });
  const ring = (at: ScreenPoint) => ({ left: at.xPt - LINK_RING_SIZE / 2, top: at.yPt - LINK_RING_SIZE / 2, borderColor: color });

  return (
    <View pointerEvents="none" style={styles.linkLayer}>
      <Animated.View
        style={[styles.linkRing, ring(start), {
          opacity: travel.interpolate({ inputRange: [0, 0.5], outputRange: [0.9, 0], extrapolate: 'clamp' }),
          transform: [{ scale: travel.interpolate({ inputRange: [0, 0.5], outputRange: [0.3, 2.6], extrapolate: 'clamp' }) }],
        }]}
      />
      <Animated.View
        style={[styles.linkBeam, {
          left: start.xPt,
          top: start.yPt - 2,
          width: lengthPt,
          backgroundColor: color,
          shadowColor: color,
          opacity: Animated.multiply(fadeIn, fadeOut),
          transform: [{ rotate: `${angleRad}rad` }, { scaleX: travel.interpolate({ inputRange: [0, 1], outputRange: [0.001, 1] }) }],
        }]}
      />
      <Animated.View
        style={[styles.linkHead, {
          shadowColor: color,
          opacity: Animated.multiply(fadeIn, fadeOut),
          transform: [
            { translateX: travel.interpolate({ inputRange: [0, 1], outputRange: [start.xPt - LINK_HEAD_SIZE / 2, end.xPt - LINK_HEAD_SIZE / 2] }) },
            { translateY: travel.interpolate({ inputRange: [0, 1], outputRange: [start.yPt - LINK_HEAD_SIZE / 2, end.yPt - LINK_HEAD_SIZE / 2] }) },
          ],
        }]}
      />
      <Animated.View
        style={[styles.linkRing, ring(end), {
          opacity: settle.interpolate({ inputRange: [0, 0.1, 1], outputRange: [0, 1, 0] }),
          transform: [{ scale: settle.interpolate({ inputRange: [0, 1], outputRange: [0.3, 3.2] }) }],
        }]}
      />
    </View>
  );
}

/** The two-phone Nearby Interaction prototype, kept as a separate experiment beside the ecosystem. */
export default function SpatialLab({ onExit, onOpenSwipe }: { onExit: () => void; onOpenSwipe?: () => void }) {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [connection, setConnection] = useState<ConnectionState>('disconnected');
  const [localRole, setLocalRole] = useState<PhoneRole | null>(null);
  const [measurements, setMeasurements] = useState<Partial<Record<DeviceRole, DistanceEvent>>>({});
  const [motions, setMotions] = useState<Partial<Record<DeviceRole, MotionEvent>>>({});
  const [capabilities, setCapabilities] = useState<NativeCapabilities | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [logs, setLogs] = useState<string[]>(['Parallax M2 ready — Phone A is the connection initiator.']);
  const [sessionState, setSessionState] = useState<SpatialSessionState | null>(null);
  const [stitchState, setStitchState] = useState<StitchState | null>(null);
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinNote, setJoinNote] = useState<string | null>(null);
  const [uwbResidualCm, setUwbResidualCm] = useState<number | null>(null);
  const [linkPath, setLinkPath] = useState<LinkPath | null>(null);
  /** Phone A's heading when its first motion reading arrived; the map draws it pointing up. */
  const [upHeading, setUpHeading] = useState<number | null>(null);
  // Native callbacks are subscribed once, so they read the latest values through refs.
  const distanceFilter = useRef(new DistanceFilter());
  const movedCheck = useRef(new MovedApartCheck());
  const localRoleRef = useRef<PhoneRole | null>(null);
  const motionsRef = useRef<Partial<Record<PhoneRole, MotionEvent>>>({});
  const stitchRef = useRef<StitchState | null>(null);
  const swipeReports = useRef<SwipeReport[]>([]);
  const rangingRequested = useRef(false);
  const screen = useWindowDimensions();
  const cameraMode = useRef(false);
  const camera = useCameraJoin(connection === 'connected' && localRole !== null, localRole, stitch => {
    applyStitchState({ stitch, status: 'joined' });
    setJoinNote(null);
  }, reason => {
    applyStitchState(null);
    setJoinOpen(true);
    setJoinNote(reason);
  });
  cameraMode.current = camera.enabled;

  const addLog = (message: string) => setLogs((current) => [message, ...current].slice(0, 32));
  const reportActionError = (error: unknown) => addLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
  const sendStitchMessage = (message: StitchMessage) => {
    void ParallaxModule.sendPeerMessage(serializeStitchMessage(message)).catch(reportActionError);
  };

  /** Lays the join animation's path, centre to centre, out in this phone's screen points. */
  const playLink = (stitch: Stitch) => {
    const role = localRoleRef.current;
    const placed = stitchedLayout(stitch, headingOf(motionsRef.current.A), headingOf(motionsRef.current.B));
    if (!role || placed.headingA == null || placed.headingB == null) return;
    const poses = screenPoses(stitch, placed.headingA, placed.headingB);
    const { width, height } = Dimensions.get('window');
    const screen = { widthPt: width, heightPt: height };
    const to = stitch.from === 'A' ? 'B' : 'A';
    setLinkPath({
      id: stitch.id,
      from: stitch.from,
      start: tableToScreen(poses[stitch.from].centreMm, poses[role], screen),
      end: tableToScreen(poses[to].centreMm, poses[role], screen),
    });
  };

  const applyStitchState = (state: StitchState | null) => {
    if (state?.stitch.id !== stitchRef.current?.stitch.id) {
      movedCheck.current.reset();
      setUwbResidualCm(null);
      if (state?.status === 'joined') playLink(state.stitch);
    }
    stitchRef.current = state;
    setStitchState(state);
    if (state) setJoinOpen(state.status !== 'joined');
  };

  // Phone A owns the join: it pairs swipe halves, decides when the join is lost, and tells Phone B.
  const publishStitchState = (state: StitchState) => {
    applyStitchState(state);
    sendStitchMessage({ type: 'state', state });
  };

  const markMoved = (reason: string) => {
    const current = stitchRef.current;
    if (current?.stitch.source === 'camera') return;
    if (!current || current.status !== 'joined' || localRoleRef.current !== 'A') return;
    publishStitchState({ ...current, status: 'moved', reason });
    addLog(`Join lost: ${reason}`);
  };

  const addSwipeReport = (report: SwipeReport) => {
    const at = Date.now();
    swipeReports.current = [...swipeReports.current.filter((item) => at - item.atMs < SWIPE_REPORT_LIFETIME_MS), report];
    const match = matchSwipes(swipeReports.current);
    if (!match) return;
    swipeReports.current = [];
    const result = computeStitch(match.exit, match.entry, at);
    if (!result.stitch) {
      setJoinNote(`Join failed: ${result.reason}`);
      addLog(`Join failed: ${result.reason}`);
      return;
    }
    publishStitchState({ stitch: result.stitch, status: 'joined' });
    setJoinNote(null);
    const { stitch } = result;
    addLog(`Joined by a swipe from Phone ${stitch.from} · B turned ${formatDegrees(stitch.relativeYawRad)}${stitch.snapped ? ' (square)' : ''}`);
  };

  /** UWB is only a tripwire: it compares its change since the join with the change rotation explains. */
  const checkMoved = (filtered: FilteredDistance, at: number) => {
    const state = stitchRef.current;
    if (state?.stitch.source === 'camera') return;
    if (!state || state.status !== 'joined' || filtered.smoothedCm == null) return;
    const placed = stitchedLayout(state.stitch, headingOf(motionsRef.current.A), headingOf(motionsRef.current.B));
    if (placed.headingA == null || placed.headingB == null) return;
    const predictedCm = predictedAntennaDistanceCm(state.stitch, placed.headingA, placed.headingB);
    const { residualCm, moved } = movedCheck.current.observe(filtered.smoothedCm, predictedCm, at);
    setUwbResidualCm(residualCm);
    if (moved && residualCm != null) markMoved(`UWB distance changed by ${Math.round(residualCm)} cm`);
  };

  useEffect(() => {
    const subscriptions = [
      ParallaxModule.onPeerDiscovered((peer) => {
        setPeers((current) => current.some((item) => item.id === peer.id) ? current : [...current, peer]);
        addLog(`Discovered ${peer.name}`);
      }),
      ParallaxModule.onConnectionChanged((event) => {
        const state = readConnectionState(event);
        if (!state) {
          addLog('Error: invalid connection status from native code');
          return;
        }
        setConnection(state);
        setSessionState(readSessionState(event));
        const role = readRole(event);
        localRoleRef.current = role;
        setLocalRole(role);
        if (state === 'connected' && !rangingRequested.current) {
          rangingRequested.current = true;
          if (stitchRef.current?.status !== 'joined') setJoinOpen(true);
          // Each phone sends its own token and needs the other's, so both start ranging.
          setTimeout(() => { void ParallaxModule.startRanging().catch(reportActionError); }, AUTO_RANGING_DELAY_MS);
        }
        if (state === 'disconnected') {
          rangingRequested.current = false;
          distanceFilter.current.reset();
          swipeReports.current = [];
          applyStitchState(null);
          setJoinOpen(false);
          setUpHeading(null);
        }
        addLog(`Connection: ${state}`);
      }),
      ParallaxModule.onDistanceUpdated((event) => {
        const role = event.role;
        if (event.directionAvailable && !event.directionValid) addLog('Direction reported but rejected as invalid');
        if (role !== 'A' && role !== 'B') return;
        const receivedAt = Date.now();
        setMeasurements((current) => ({ ...current, [role]: { ...event, receivedAt } }));
        if (!event.distanceAvailable || event.distanceCm == null) return;
        // Every reading advances the filter, even a repeat of the last value.
        if (!distanceFilter.current.push({ role, distanceCm: event.distanceCm, receivedAt }, localRoleRef.current)) return;
        const filtered = distanceFilter.current.current(receivedAt);
        checkMoved(filtered, receivedAt);
      }),
      ParallaxModule.onMotionUpdated((event) => {
        const role = event.role;
        if (role !== 'A' && role !== 'B') return;
        const received = { ...event, receivedAt: Date.now() };
        motionsRef.current = { ...motionsRef.current, [role]: received };
        setMotions((current) => ({ ...current, [role]: received }));
        // A restarted motion frame has a new yaw zero, so the join's heading offset no longer applies.
        const joinedFrame = stitchRef.current?.stitch.frameIds[role];
        if (joinedFrame != null && event.frameId != null && event.frameId !== joinedFrame) markMoved(`motion restarted on Phone ${role}`);
      }),
      ParallaxModule.onPeerMessage((event) => {
        if (cameraMode.current) return;
        const message = parseStitchMessage(event.message);
        if (!message) return;
        if (message.type === 'swipe') {
          // The other phone says how long ago the finger crossed; Multipeer latency is ignored.
          if (localRoleRef.current === 'A') addSwipeReport({ ...message.report, atMs: Date.now() - message.ageMs });
        } else if (message.type === 'state') {
          if (localRoleRef.current === 'A') return;
          applyStitchState(message.state);
          addLog(message.state?.status === 'joined' ? 'Joined (from Phone A)' : `Join lost: ${message.state?.reason ?? 'cleared'}`);
        } else {
          setJoinOpen(true);
        }
      }),
      ParallaxModule.onError((error) => addLog(`Error ${error.code}: ${error.message}`)),
      ParallaxModule.onDiagnostic((event) => addLog(`[${event.stage}] ${event.message}`)),
    ];

    ParallaxModule.getCapabilities()
      .then((value) => setCapabilities(value))
      .catch((error) => addLog(`Capabilities unavailable: ${error instanceof Error ? error.message : String(error)}`));
    ParallaxModule.startDiscovery().catch((error) => addLog(`Discovery failed: ${error instanceof Error ? error.message : String(error)}`));

    const clock = setInterval(() => setNow(Date.now()), 250);
    return () => {
      clearInterval(clock);
      subscriptions.forEach((subscription) => subscription.remove());
      void ParallaxModule.stopDiscovery();
      // Leaving the lab ends the session so the other phone is not left waiting.
      void ParallaxModule.disconnect().catch(() => {});
    };
  }, []);

  const handleSwipe = (trail: TouchSample[], startedAt: number, endedAt: number) => {
    if (cameraMode.current) return;
    const role = localRoleRef.current;
    if (!role) {
      setJoinNote('Connect the phones first');
      return;
    }
    const { exit, entry } = classifySwipe(trail, { widthPt: screen.width, heightPt: screen.height });
    const own = motionsRef.current[role];
    const base = { role, headingRad: headingOf(own), frameId: own?.frameId ?? null };
    const reports: SwipeReport[] = [
      ...(exit ? [{ ...exit, ...base, kind: 'exit' as const, atMs: endedAt }] : []),
      ...(entry ? [{ ...entry, ...base, kind: 'entry' as const, atMs: startedAt }] : []),
    ];
    setJoinNote(reports.length === 0
      ? 'Not counted: start or finish on an edge, and keep the finger moving'
      : reports.map((report) => report.kind === 'exit' ? `Left across the ${report.edge} edge` : `Arrived across the ${report.edge} edge`).join(' · '));
    if (role === 'A') reports.forEach(addSwipeReport);
    else reports.forEach(({ atMs, ...report }) => sendStitchMessage({ type: 'swipe', report, ageMs: Date.now() - atMs }));
  };

  const requestJoin = () => {
    setJoinNote(null);
    setJoinOpen(true);
    sendStitchMessage({ type: 'join' });
  };

  const measurementA = measurements.A ?? null;
  const measurementB = measurements.B ?? null;
  const motionA = motions.A ?? null;
  const motionB = motions.B ?? null;
  const distance = distanceFilter.current.current(now);
  const ownMeasurement = localRole ? measurements[localRole] ?? null : null;
  const fresh = isFresh(ownMeasurement?.receivedAt, now);
  const headingA = stitchState?.stitch.source === 'camera' ? Math.PI / 2 : headingOf(motionA);
  const placed = stitchState ? stitchedLayout(stitchState.stitch, headingA, headingOf(motionB)) : null;
  const headingB = placed?.headingB ?? null;
  const connected = connection === 'connected';
  const position: PositionEstimate = placed?.position ?? {
    source: 'unknown',
    xCm: null,
    yCm: null,
    bearingRad: null,
    distanceCm: null,
    reason: connected ? camera.enabled ? camera.status : 'swipe across both screens to join' : 'connect the phones first',
  };
  const joined = stitchState?.status === 'joined';

  useEffect(() => {
    if (upHeading == null && headingA != null) setUpHeading(headingA);
  }, [headingA, upHeading]);

  const bearingToB = position.source === 'unknown' ? null : position.bearingRad;
  const relativeRotationLabel = headingA != null && headingB != null ? `${formatDegrees(wrapAngle(headingB - headingA))} · ${stitchState?.stitch.source === 'camera' ? 'CAMERA' : 'GYRO'}` : 'UNKNOWN';
  const frames = [motionA?.referenceFrame, motionB?.referenceFrame];
  const frameStatus = frames.some((frame) => frame === 'xMagneticNorthZVertical')
    ? 'MAGNETIC · REBUILD FOR GYRO-ONLY YAW'
    : frames.every((frame) => frame === 'xArbitraryZVertical')
      ? 'GYRO ONLY'
      : 'WAITING FOR BOTH PHONES';
  const geometryLabel = !stitchState
    ? 'NOT JOINED'
    : joined
      ? stitchState.stitch.source === 'camera' ? 'JOINED · MACBOOK CAMERA' : `JOINED · SWIPE ${stitchState.stitch.from} → ${stitchState.stitch.from === 'A' ? 'B' : 'A'}${stitchState.stitch.snapped ? ' · SQUARE' : ''}`
      : `MOVED · ${(stitchState.reason ?? 'swipe again').toUpperCase()}`;
  const uwbCheckLabel = stitchState?.stitch.source === 'camera' ? 'CAMERA GEOMETRY' : !joined
    ? '—'
    : uwbResidualCm == null
      ? 'SETTLING'
      : `${uwbResidualCm >= 0 ? '+' : ''}${uwbResidualCm.toFixed(1)} cm · LIMIT ±${MOVED_THRESHOLD_CM} cm`;
  const joinStatus = camera.enabled ? camera.status : !localRole
    ? 'Waiting for the connection'
    : joined
      ? 'Joined'
      : stitchState
        ? `Join lost: ${stitchState.reason ?? 'swipe again'}`
        : localRole === 'A' ? 'Waiting for a swipe' : 'Waiting for a swipe · Phone A pairs them';
  // The map turns as a whole so Phone A's starting direction points up (+Y); the geometry is unchanged.
  const sceneRotation = viewRotation(stitchState?.stitch.source === 'camera' ? Math.PI / 2 : upHeading);
  const turnForScene = (heading: number | null) => heading == null ? null : wrapAngle(heading + sceneRotation);
  // Multipeer stays connected while Nearby Interaction recovers, so ranging can be restarted then too.
  const canRange = connected || connection === 'recovering';

  return (
    <View style={styles.root}>
      <GridBackdrop />
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.container}>
          <View style={styles.topBar}>
            <HudButton small variant="ghost" label="‹ Ecosystem" onPress={onExit} />
            {onOpenSwipe && <HudButton small color={HUD.magenta} label="Swipe demo ↗" onPress={onOpenSwipe} />}
          </View>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.eyebrow}>SPATIAL LAB // PARALLAX M2 // RELATIVE SPACE</Text>
              <Text style={styles.title}>TWO PHONES.{'\n'}ONE FRAME.</Text>
              <Text style={styles.subtitle}>Phone A is the connection initiator and fixed origin.</Text>
            </View>
            <View style={styles.linkBadge}>
              <PulseDot active={connected} />
              <Text style={[styles.linkBadgeText, connected && styles.goodText]}>{connected ? 'LINKED' : 'NO LINK'}</Text>
            </View>
          </View>

          <HudFrame title="RELATIVE SPACE" tag={joined ? 'LOCKED' : stitchState ? 'DRIFT' : 'SEARCHING'} tagColor={joined ? HUD.good : HUD.warn}>
            <PositionScene
              position={rotatePosition(position, sceneRotation)}
              headingA={turnForScene(headingA)}
              headingB={turnForScene(headingB)}
              note={stitchState && !joined ? 'MOVED · SWIPE AGAIN' : null}
              stale={Boolean(stitchState && !joined)}
            />
            <View style={styles.measurementRow}>
              <View>
                <Text style={styles.measurementLabel}>SMOOTHED DISTANCE</Text>
                <Text style={styles.measurement}>{formatDistance(distance.fresh ? distance.smoothedCm : null)}</Text>
              </View>
              <View style={styles.rightMeasurement}>
                <Text style={styles.measurementLabel}>{distance.role ? `RAW · ${distance.role}` : 'RAW'}</Text>
                <Text style={styles.rawValue}>{formatDistance(distance.fresh ? distance.rawCm : null)}</Text>
              </View>
            </View>
            <HudButton small variant="ghost" disabled={headingA == null} label="Point +Y where Phone A points now" onPress={() => setUpHeading(headingA)} />
          </HudFrame>

          <HudFrame title="TELEMETRY">
            <DiagnosticRow label="GEOMETRY" value={geometryLabel} tone={joined ? 'good' : 'warn'} />
            <DiagnosticRow label="RELATIVE ROTATION" value={relativeRotationLabel} />
            <DiagnosticRow
              label="UWB CHECK"
              value={uwbCheckLabel}
              tone={uwbResidualCm == null ? 'normal' : Math.abs(uwbResidualCm) <= MOVED_THRESHOLD_CM ? 'good' : 'warn'}
            />
            <DiagnosticRow label="FRAME" value={frameStatus} tone={frameStatus === 'GYRO ONLY' ? 'good' : 'warn'} />
          </HudFrame>

          <HudFrame title="UPLINK" tag={`${peers.length} ${peers.length === 1 ? 'PEER' : 'PEERS'} IN RANGE`}>
            <Text style={[styles.connectionValue, connected && styles.goodText]}>{connection.toUpperCase()}{localRole ? ` · PHONE ${localRole}` : ''}</Text>
            {peers.map((peer) => (
              <TouchableOpacity key={peer.id} style={styles.peerRow} onPress={() => { void ParallaxModule.connect(peer.id).catch(reportActionError); }}>
                <View style={styles.peerIcon}><PhoneGlyph accent="red" /></View>
                <View style={styles.peerInfo}>
                  <Text style={styles.peerName}>{peer.name}</Text>
                  <Text style={styles.peerId}>{peer.id}</Text>
                </View>
                <Text style={styles.connectAction}>CONNECT ›</Text>
              </TouchableOpacity>
            ))}
            <View style={styles.actions}>
              <HudButton style={styles.primary} disabled={!canRange} label={canRange ? 'Restart ranging' : 'Awaiting link'} onPress={() => { void ParallaxModule.startRanging().catch(reportActionError); }} />
              <HudButton variant="ghost" label="Disconnect" onPress={() => { void ParallaxModule.disconnect().catch(reportActionError); }} />
            </View>
          </HudFrame>

          <HudFrame title="CAMERA JOIN" accent={HUD.magenta}>
            <CameraJoinControls camera={camera} role={localRole} theme={CAMERA_THEME} />
            <Text style={styles.joinPanelHint}>
              Position both phones under the calibrated MacBook camera. Attach the matching printed marker to each phone.
              Camera tracking rejoins automatically after a move. Disable the camera to use the swipe fallback.
            </Text>
            <HudButton variant="ghost" disabled={!canRange || camera.enabled} label="Swipe fallback" onPress={requestJoin} />
          </HudFrame>

          <HudFrame title="SENSOR DIAGNOSTICS">
            <RoleDiagnostics role="A" measurement={measurementA} motion={motionA} now={now} />
            <View style={styles.divider} />
            <RoleDiagnostics role="B" measurement={measurementB} motion={motionB} now={now} />
            <View style={styles.divider} />
            <DiagnosticRow label="SESSION" value={(ownMeasurement && fresh ? ownMeasurement.sessionState : sessionState ?? 'idle').toUpperCase()} />
            <DiagnosticRow
              label="BEARINGS"
              value={bearingToB == null ? '—' : `A → B ${formatDegrees(bearingToB)} · B → A ${formatDegrees(wrapAngle(bearingToB + Math.PI))} (A'S FRAME)`}
            />
            <DiagnosticRow
              label="JOIN"
              value={stitchState
                ? `B AT ${formatDistance(Math.hypot(stitchState.stitch.centreB.xCm, stitchState.stitch.centreB.yCm))} · TURNED ${formatDegrees(stitchState.stitch.relativeYawRad)} · OFFSET ${formatDegrees(stitchState.stitch.yawOffsetRad)}`
                : '—'}
            />
            <DiagnosticRow label="CAMERA" value={camera.enabled ? camera.status : 'MACBOOK CAMERA OFF'} />
            <DiagnosticRow
              label="CAPABILITIES"
              value={capabilities
                ? `${capabilities.uwbSupported ? 'UWB' : 'NO UWB'} · ${capabilities.directionMayBeAvailable ? 'DIRECTION' : 'NO DIRECTION'} · ${capabilities.deviceMotionAvailable ? 'MOTION' : 'NO MOTION'} · ${capabilities.magneticNorthAvailable ? 'MAGNETIC' : 'NO MAGNETIC'}`
                : 'LOADING'}
            />
          </HudFrame>

          <HudFrame title="EVENT LOG" tag={`${logs.length} LINES`}>
            {logs.map((log, index) => <Text style={[styles.log, index === 0 && styles.logLatest]} key={`${log}-${index}`}>{`> ${log}`}</Text>)}
          </HudFrame>
        </ScrollView>
      </SafeAreaView>
      {joinOpen && <JoinOverlay role={localRole} note={joinNote} status={joinStatus} onSwipe={handleSwipe} onClose={() => setJoinOpen(false)} camera={camera} />}
      {linkPath && <LinkAnimation key={linkPath.id} path={linkPath} onDone={() => setLinkPath(null)} />}
    </View>
  );
}

const CAMERA_THEME = { text: HUD.text, muted: HUD.muted, accent: HUD.faint, border: HUD.lineStrong, button: 'rgba(255, 79, 216, 0.12)', buttonText: HUD.magenta, buttonBorder: HUD.magenta, fontFamily: HUD_FONT };

const mono = { fontFamily: HUD_FONT } as const;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: HUD.background },
  safe: { flex: 1 },
  container: { padding: 20, gap: 18, paddingBottom: 40 },
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingTop: 6 },
  headerText: { flex: 1 },
  eyebrow: { ...mono, color: HUD.cyan, fontSize: 9, fontWeight: '800', letterSpacing: 1.5 },
  title: { ...mono, color: HUD.text, fontSize: 30, fontWeight: '800', lineHeight: 36, marginTop: 10, ...glow(HUD.cyan, 14) },
  subtitle: { color: HUD.muted, fontSize: 13, marginTop: 8, maxWidth: 280 },
  linkBadge: { alignItems: 'center', gap: 2 },
  linkBadgeText: { ...mono, color: HUD.faint, fontSize: 8, fontWeight: '800', letterSpacing: 1.5 },
  scene: { width: SCENE_WIDTH, height: SCENE_HEIGHT, alignSelf: 'center', position: 'relative', overflow: 'hidden' },
  rangeRing: { position: 'absolute', borderWidth: 1, borderColor: 'rgba(63, 246, 255, 0.10)' },
  sweep: { position: 'absolute', left: ORIGIN_X, top: ORIGIN_Y, width: SCENE_REACH_PX + 20, height: 1, backgroundColor: 'rgba(63, 246, 255, 0.35)', transformOrigin: 'left center', shadowColor: HUD.cyan, shadowOpacity: 1, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } },
  axisHorizontal: { position: 'absolute', left: 14, right: 14, top: ORIGIN_Y, height: 1, backgroundColor: 'rgba(63, 246, 255, 0.22)' },
  axisVertical: { position: 'absolute', top: 16, bottom: 30, left: ORIGIN_X, width: 1, backgroundColor: 'rgba(63, 246, 255, 0.22)' },
  axisLabel: { position: 'absolute', borderWidth: 1, borderColor: HUD.lineStrong, backgroundColor: HUD.panelSolid, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 2 },
  axisLabelX: { right: 14, top: ORIGIN_Y + 6 },
  axisLabelY: { left: ORIGIN_X + 6, top: 16 },
  axisText: { ...mono, color: HUD.cyan, fontSize: 9, fontWeight: '800' },
  measurementVector: { position: 'absolute', height: 1, backgroundColor: HUD.magenta, transformOrigin: 'left center', shadowColor: HUD.magenta, shadowOpacity: 1, shadowRadius: 4, shadowOffset: { width: 0, height: 0 } },
  measurementVectorEstimated: { backgroundColor: HUD.warn, shadowColor: HUD.warn },
  phoneAnchor: { position: 'absolute' },
  phone: { width: 52, height: 82, borderRadius: 11, borderWidth: 1.5, borderColor: HUD.cyan, backgroundColor: 'rgba(63, 246, 255, 0.10)', padding: 5, alignItems: 'center', shadowColor: HUD.cyan, shadowOpacity: 0.8, shadowRadius: 12, shadowOffset: { width: 0, height: 0 } },
  phoneRed: { borderColor: HUD.magenta, backgroundColor: 'rgba(255, 79, 216, 0.10)', shadowColor: HUD.magenta },
  phoneEstimated: { opacity: 0.6, borderStyle: 'dashed' },
  phoneSpeaker: { width: 15, height: 2, borderRadius: 2, backgroundColor: HUD.cyan, marginBottom: 4 },
  phoneSpeakerRed: { backgroundColor: HUD.magenta },
  phoneScreen: { flex: 1, width: '100%', borderRadius: 5, backgroundColor: 'rgba(2, 5, 11, 0.85)', overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  phoneScreenCompact: { borderRadius: 1 },
  phoneLetter: { ...mono, color: HUD.cyan, fontWeight: '800', ...glow(HUD.cyan, 8) },
  phoneLetterRed: { color: HUD.magenta, ...glow(HUD.magenta, 8) },
  phoneGlow: { width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(63, 246, 255, 0.35)' },
  phoneGlowRed: { backgroundColor: 'rgba(255, 79, 216, 0.4)' },
  phoneHome: { width: 10, height: 2, borderRadius: 2, backgroundColor: HUD.cyan, marginTop: 4 },
  phoneHomeRed: { backgroundColor: HUD.magenta },
  unknownPosition: { position: 'absolute', left: 80, right: 80, top: 24, alignItems: 'center', padding: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(255, 194, 77, 0.6)', borderRadius: 3, backgroundColor: 'rgba(255, 194, 77, 0.07)' },
  unknownGlyph: { ...mono, color: HUD.warn, fontSize: 26, fontWeight: '800', ...glow(HUD.warn, 10) },
  unknownTitle: { ...mono, color: HUD.warn, fontSize: 10, fontWeight: '800', letterSpacing: 1.5, marginTop: 4 },
  unknownReason: { ...mono, color: 'rgba(255, 194, 77, 0.7)', fontSize: 9, marginTop: 4, textAlign: 'center' },
  sceneFooter: { position: 'absolute', bottom: 6, left: 0, right: 0, alignItems: 'center' },
  sceneFooterText: { ...mono, color: HUD.muted, fontSize: 10, fontWeight: '700' },
  sceneScaleText: { ...mono, color: HUD.faint, fontSize: 8, fontWeight: '700', marginTop: 3 },
  measurementRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', paddingHorizontal: 4, paddingBottom: 4 },
  measurementLabel: { ...mono, color: HUD.muted, fontSize: 9, fontWeight: '800', letterSpacing: 1.5 },
  measurement: { ...mono, color: HUD.cyan, fontSize: 40, fontWeight: '800', marginTop: 4, ...glow(HUD.cyan, 16) },
  rightMeasurement: { alignItems: 'flex-end', paddingBottom: 5 },
  rawValue: { ...mono, color: HUD.text, fontSize: 16, fontWeight: '700', marginTop: 5 },
  diagnosticRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  diagnosticLabel: { ...mono, color: HUD.muted, fontSize: 9, fontWeight: '700', letterSpacing: 1 },
  diagnosticValue: { ...mono, color: HUD.text, fontSize: 10, fontWeight: '700', textAlign: 'right', flexShrink: 1 },
  goodText: { color: HUD.good, ...glow(HUD.good, 6) },
  warnText: { color: HUD.warn },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: HUD.line, marginVertical: 2 },
  connectionValue: { ...mono, color: HUD.text, fontSize: 15, fontWeight: '800', letterSpacing: 1 },
  peerRow: { flexDirection: 'row', alignItems: 'center', borderRadius: 3, borderWidth: 1, borderColor: 'rgba(255, 79, 216, 0.35)', backgroundColor: 'rgba(255, 79, 216, 0.05)', padding: 10 },
  peerIcon: { width: 52, height: 82, alignItems: 'center', justifyContent: 'center', transform: [{ scale: 0.6 }] },
  peerInfo: { flex: 1, marginLeft: 4 },
  peerName: { ...mono, color: HUD.text, fontSize: 14, fontWeight: '700' },
  peerId: { ...mono, color: HUD.faint, fontSize: 9, marginTop: 3 },
  connectAction: { ...mono, color: HUD.magenta, fontSize: 10, fontWeight: '800', letterSpacing: 1.5, ...glow(HUD.magenta, 6) },
  actions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  primary: { flex: 1 },
  joinPanelHint: { color: HUD.muted, fontSize: 12, lineHeight: 17 },
  linkLayer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  linkRing: { position: 'absolute', width: LINK_RING_SIZE, height: LINK_RING_SIZE, borderRadius: LINK_RING_SIZE / 2, borderWidth: 2 },
  linkBeam: { position: 'absolute', height: 4, borderRadius: 2, transformOrigin: 'left center', shadowOpacity: 0.9, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } },
  linkHead: { position: 'absolute', left: 0, top: 0, width: LINK_HEAD_SIZE, height: LINK_HEAD_SIZE, borderRadius: LINK_HEAD_SIZE / 2, backgroundColor: '#f4feff', shadowOpacity: 1, shadowRadius: 16, shadowOffset: { width: 0, height: 0 } },
  log: { ...mono, color: HUD.muted, fontSize: 10, lineHeight: 15 },
  logLatest: { color: HUD.good },
});
