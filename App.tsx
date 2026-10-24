import { useEffect, useMemo, useRef, useState } from 'react';
import { SafeAreaView, ScrollView, Share, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
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
} from './src/native/ParallaxModule';
import {
  calculateRelativeRotation,
  hasCommonFrame,
  isFresh,
  PositionEstimate,
  selectPositionMeasurement,
  STALE_AFTER_MS,
  tablePlaneHeading,
  transformDirectionToReferenceFrame,
  wrapAngle,
} from './src/spatial/SpatialMath';
import { layoutPhonePair, PHONE_SIZE_CM, rotatePosition, ScenePoint, viewRotation } from './src/spatial/SceneLayout';
import { selectSpinPosition, SpinFit, spinFrameOffset, SpinRecording, SpinSample } from './src/spatial/SpinBearing';
import { SmoothingBuffer } from './src/state/SmoothingBuffer';

type PhoneRole = 'A' | 'B';

const CONNECTION_STATES: ConnectionState[] = ['disconnected', 'connecting', 'connected', 'recovering'];
const PHONE_ROLES: PhoneRole[] = ['A', 'B'];
const SCENE_WIDTH = 340;
const SCENE_HEIGHT = 410;
const ORIGIN_X = SCENE_WIDTH / 2;
const ORIGIN_Y = 205;
/** Largest drawing scale, used when the phones are close; a phone is then about 41 × 85 px. */
const MAX_PIXELS_PER_CM = 5.5;
/** Both phone outlines are kept within this many pixels of the origin by shrinking the scale. */
const SCENE_REACH_PX = 150;
const PHONE_HALF_DIAGONAL_CM = Math.hypot(PHONE_SIZE_CM.widthCm, PHONE_SIZE_CM.lengthCm) / 2;
/** Local distance and motion events for one UWB sample are sent together; allow for delivery jitter. */
const SPIN_PAIRING_WINDOW_MS = 100;
const SPIN_TIMEOUT_MS = 60_000;
const SPIN_PLOT_WIDTH = 300;
const SPIN_PLOT_HEIGHT = 90;
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
}: {
  position: PositionEstimate;
  headingA: number | null;
  headingB: number | null;
}) {
  const estimated = position.source === 'estimated';
  const layout = position.source === 'measured' || estimated ? layoutPhonePair(position, headingA, headingB) : null;
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
  const notes = [estimated && 'SPIN ESTIMATE', layout && headingB == null && 'B ROTATION UNKNOWN'].filter(Boolean).join(' · ');

  return (
    <View style={styles.scene}>
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
            : 'Waiting for measured direction or a spin test'}
        </Text>
        <Text style={styles.sceneScaleText}>{`PHONES TO SCALE · 10 cm = ${Math.round(pixelsPerCm * 10)} px · +Y = PHONE A AT START`}</Text>
      </View>
    </View>
  );
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
      <DiagnosticRow label={`${role} READING AGE`} value={formatAge(measurement?.receivedAt, now)} />
    </>
  );
}

function SpinDiagnostics({
  role,
  fit,
  recording,
  active,
}: {
  role: PhoneRole;
  fit: SpinFit | undefined;
  recording: SpinRecording;
  active: boolean;
}) {
  if (active) {
    return <DiagnosticRow label={`${role} SPIN`} value={`RECORDING · ${formatDegrees(recording.turnedRad)} TURNED · ${recording.sampleCount} READINGS`} />;
  }
  if (!fit) return <DiagnosticRow label={`${role} SPIN`} value="NOT RUN" />;
  return (
    <>
      <DiagnosticRow label={`${role} SPIN`} value={`${fit.accepted ? 'ACCEPTED' : 'REJECTED'} · ${fit.reason.toUpperCase()}`} tone={fit.accepted ? 'good' : 'warn'} />
      <DiagnosticRow label={`${role} SPIN COVERAGE`} value={`${formatDegrees(fit.turnedRad)} TURNED · ${fit.sampleCount} READINGS`} />
      <DiagnosticRow
        label={`${role} SPIN WAVE`}
        value={fit.amplitudeCm == null
          ? '—'
          : `${fit.amplitudeCm.toFixed(1)} cm · NOISE ${fit.residualCm?.toFixed(1)} cm · QUALITY ${Math.round((fit.quality ?? 0) * 100)}%`}
      />
      <DiagnosticRow
        label={`${role} SPIN BEARING`}
        value={fit.bearingRad == null
          ? '—'
          : `${formatDegrees(fit.bearingRad)} ± ${formatDegrees(fit.bearingUncertaintyRad)} (CLOSEST AT ${formatDegrees(fit.closestHeadingRad)})`}
      />
      <SpinPlot samples={recording.samples} fit={fit} />
    </>
  );
}

/** Distance against heading for the last spin, with the fitted drift removed and the fitted wave overlaid. */
function SpinPlot({ samples, fit }: { samples: readonly SpinSample[]; fit: SpinFit }) {
  const { meanCm, amplitudeCm, closestHeadingRad } = fit;
  if (samples.length === 0 || meanCm == null || amplitudeCm == null || closestHeadingRad == null) return null;
  const startT = samples[0].t;
  const drift = fit.driftCmPerSecond ?? 0;
  const points = samples.map(({ t, heading, distanceCm }) => ({ heading: wrapAngle(heading), distanceCm: distanceCm - (drift * (t - startT)) / 1000 }));
  const curve = Array.from({ length: 72 }, (_, index) => {
    const heading = -Math.PI + (2 * Math.PI * index) / 71;
    return { heading, distanceCm: meanCm - amplitudeCm * Math.cos(heading - closestHeadingRad) };
  });
  const distances = [...points, ...curve].map(({ distanceCm }) => distanceCm);
  const low = Math.min(...distances);
  const span = Math.max(1, Math.max(...distances) - low);
  const left = (heading: number) => ((heading + Math.PI) / (2 * Math.PI)) * (SPIN_PLOT_WIDTH - 4);
  const top = (distanceCm: number) => (1 - (distanceCm - low) / span) * (SPIN_PLOT_HEIGHT - 4);

  return (
    <View>
      <View style={styles.spinPlot}>
        {curve.map((point, index) => <View key={`curve-${index}`} style={[styles.spinCurveDot, { left: left(point.heading), top: top(point.distanceCm) }]} />)}
        {points.map((point, index) => <View key={`sample-${index}`} style={[styles.spinSampleDot, { left: left(point.heading), top: top(point.distanceCm) }]} />)}
      </View>
      <Text style={styles.spinPlotLabel}>{`HEADING −180° → 180° · ${Math.round(span)} cm TOP TO BOTTOM`}</Text>
    </View>
  );
}

export default function App() {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [connection, setConnection] = useState<ConnectionState>('disconnected');
  const [measurements, setMeasurements] = useState<Partial<Record<DeviceRole, DistanceEvent>>>({});
  const [motions, setMotions] = useState<Partial<Record<DeviceRole, MotionEvent>>>({});
  const [capabilities, setCapabilities] = useState<NativeCapabilities | null>(null);
  const [smoothedDistance, setSmoothedDistance] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [logs, setLogs] = useState<string[]>(['Parallax M2 ready — Phone A is the connection initiator.']);
  const [smoother] = useState(() => new SmoothingBuffer(5));
  const [sessionState, setSessionState] = useState<SpatialSessionState | null>(null);
  const [spinStartedAt, setSpinStartedAt] = useState<number | null>(null);
  const [spinFits, setSpinFits] = useState<Partial<Record<PhoneRole, SpinFit>>>({});
  /** Phone A's heading when its first motion reading arrived; the map draws it pointing up. */
  const [upHeading, setUpHeading] = useState<number | null>(null);
  const measurementsRef = useRef<Partial<Record<PhoneRole, DistanceEvent>>>({});
  const spinRecordings = useRef<Record<PhoneRole, SpinRecording>>({ A: new SpinRecording(), B: new SpinRecording() });
  const spinPairedAt = useRef<Partial<Record<PhoneRole, number>>>({});
  const spinActiveRef = useRef(false);

  const addLog = (message: string) => setLogs((current) => [message, ...current].slice(0, 32));

  useEffect(() => {
    // Native code sends each UWB sample's distance just before its motion, both timed by the measuring phone.
    const recordSpinSample = (role: PhoneRole, motion: MotionEvent) => {
      const measurement = measurementsRef.current[role];
      const heading = tablePlaneHeading(motion.attitudeQuaternion);
      if (!measurement?.distanceAvailable || measurement.distanceCm == null || heading == null) return;
      if (Math.abs(measurement.measurementTimestamp - motion.timestamp) > SPIN_PAIRING_WINDOW_MS) return;
      if (spinPairedAt.current[role] === measurement.measurementTimestamp) return;
      spinPairedAt.current[role] = measurement.measurementTimestamp;
      spinRecordings.current[role].add(motion.timestamp, heading, measurement.distanceCm);
    };

    const subscriptions = [
      ParallaxModule.onPeerDiscovered((peer) => {
        setPeers((current) => current.some((item) => item.id === peer.id) ? current : [...current, peer]);
        addLog(`Discovered ${peer.name}`);
      }),
      ParallaxModule.onConnectionChanged((event) => {
        const state = readConnectionState(event);
        if (state) {
          setConnection(state);
          setSessionState(readSessionState(event));
          // A new connection restarts the motion frames, so earlier spin bearings no longer apply.
          if (state === 'disconnected') {
            setSpinFits({});
            setUpHeading(null);
          }
          addLog(`Connection: ${state}`);
        } else addLog('Error: invalid connection status from native code');
      }),
      ParallaxModule.onDistanceUpdated((event) => {
        const role = event.role;
        if (role === 'A' || role === 'B') {
          const received = { ...event, receivedAt: Date.now() };
          measurementsRef.current = { ...measurementsRef.current, [role]: received };
          setMeasurements((current) => ({ ...current, [role]: received }));
        }
        if (event.directionAvailable && !event.directionValid) addLog('Direction reported but rejected as invalid');
      }),
      ParallaxModule.onMotionUpdated((event) => {
        const role = event.role;
        if (role !== 'A' && role !== 'B') return;
        setMotions((current) => ({ ...current, [role]: { ...event, receivedAt: Date.now() } }));
        if (spinActiveRef.current) recordSpinSample(role, event);
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
    };
  }, []);

  const measurementA = measurements.A ?? null;
  const measurementB = measurements.B ?? null;
  const motionA = motions.A ?? null;
  const motionB = motions.B ?? null;
  const distanceCm = measurementA?.distanceCm ?? measurementB?.distanceCm ?? null;

  useEffect(() => {
    if (distanceCm != null && Number.isFinite(distanceCm) && distanceCm >= 0) setSmoothedDistance(smoother.push(distanceCm));
    else {
      smoother.reset();
      setSmoothedDistance(null);
    }
  }, [distanceCm, smoother]);

  const startSpin = () => {
    PHONE_ROLES.forEach((role) => spinRecordings.current[role].reset());
    spinPairedAt.current = {};
    spinActiveRef.current = true;
    setSpinStartedAt(Date.now());
    addLog('Spin test started');
  };

  const finishSpin = () => {
    spinActiveRef.current = false;
    setSpinStartedAt(null);
    const fits = { A: spinRecordings.current.A.fit(), B: spinRecordings.current.B.fit() };
    setSpinFits(fits);
    addLog(`Spin test finished · A ${fits.A.accepted ? 'accepted' : fits.A.reason} · B ${fits.B.accepted ? 'accepted' : fits.B.reason}`);
  };

  // Compact rows of [ms since start, heading in degrees, distance in cm] for offline analysis.
  const shareSpinData = () => {
    const data = Object.fromEntries(PHONE_ROLES.map((role) => {
      const samples = spinRecordings.current[role].samples;
      const startT = samples[0]?.t ?? 0;
      return [role, {
        fit: spinFits[role] ?? null,
        samples: samples.map(({ t, heading, distanceCm }) => [Math.round(t - startT), Math.round(heading * RAD_TO_DEG * 10) / 10, Math.round(distanceCm * 10) / 10]),
      }];
    }));
    void Share.share({ message: JSON.stringify(data) }).catch(reportActionError);
  };

  useEffect(() => {
    if (spinStartedAt != null && now - spinStartedAt > SPIN_TIMEOUT_MS) finishSpin();
  }, [now, spinStartedAt]);

  const measuredPosition = useMemo(
    () => selectPositionMeasurement(measurementA, measurementB, motionA, motionB, 'A', now),
    [measurementA, measurementB, motionA, motionB, now],
  );
  const commonFrame = hasCommonFrame(motionA?.referenceFrame, motionB?.referenceFrame);
  const currentMeasurement = measurementA ?? measurementB;
  const fresh = isFresh(currentMeasurement?.receivedAt, now, STALE_AFTER_MS);
  const spinPosition = selectSpinPosition(spinFits.A, spinFits.B, fresh ? smoothedDistance : null, commonFrame);
  const position: PositionEstimate = measuredPosition.source === 'measured'
    ? measuredPosition
    : spinPosition.source === 'estimated'
      ? spinPosition
      : { ...measuredPosition, reason: `${measuredPosition.reason} · ${spinPosition.reason}` };
  const relativeRotation = commonFrame
    ? calculateRelativeRotation(motionA?.attitudeQuaternion, motionB?.attitudeQuaternion)
    : calculateRelativeRotation(undefined, undefined);
  const headingA = tablePlaneHeading(motionA?.attitudeQuaternion);
  const ownHeadingB = tablePlaneHeading(motionB?.attitudeQuaternion);

  useEffect(() => {
    if (upHeading == null && headingA != null) setUpHeading(headingA);
  }, [headingA, upHeading]);
  const frameOffset = spinFrameOffset(spinFits.A, spinFits.B);
  // B is drawn in A's frame: directly when both share magnetic north, otherwise through the two spin bearings.
  const headingB = ownHeadingB == null
    ? null
    : commonFrame
      ? ownHeadingB
      : frameOffset == null ? null : wrapAngle(ownHeadingB + frameOffset);
  const relativeRotationLabel = commonFrame && relativeRotation.yaw != null
    ? `${formatDegrees(relativeRotation.yaw)} yaw`
    : headingA != null && headingB != null
      ? `${formatDegrees(wrapAngle(headingB - headingA))} yaw · SPIN`
      : 'UNKNOWN';
  const frameStatus = commonFrame
    ? 'MAGNETIC NORTH'
    : motionA && motionB && motionA.referenceFrame !== 'unavailable' && motionB.referenceFrame !== 'unavailable'
      ? 'LOCAL CORRECTED · NO COMMON FRAME'
      : 'COMMON FRAME UNAVAILABLE';
  const directionStatus = !currentMeasurement
    ? 'WAITING'
    : !fresh
      ? 'STALE'
      : currentMeasurement.directionValid
        ? 'MEASURED'
        : currentMeasurement.directionAvailable
          ? 'INVALID'
          : 'UNAVAILABLE';
  // The map turns as a whole so Phone A's starting direction points up (+Y); the geometry is unchanged.
  const sceneRotation = viewRotation(upHeading);
  const turnForScene = (heading: number | null) => heading == null ? null : wrapAngle(heading + sceneRotation);
  const connected = connection === 'connected';
  // Multipeer stays connected while Nearby Interaction recovers, so ranging can be restarted then too.
  const canRange = connected || connection === 'recovering';
  const spinning = spinStartedAt != null;
  const reportActionError = (error: unknown) => addLog(`Error: ${error instanceof Error ? error.message : String(error)}`);

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>PARALLAX M2 · RELATIVE SPACE</Text>
            <Text style={styles.title}>Two phones. One frame.</Text>
            <Text style={styles.subtitle}>Phone A is the connection initiator and fixed origin.</Text>
          </View>
          <View style={[styles.statusDot, connected && styles.statusDotConnected]} />
        </View>

        <View style={styles.visualPanel}>
          <PositionScene
            position={rotatePosition(position, sceneRotation)}
            headingA={turnForScene(headingA)}
            headingB={turnForScene(headingB)}
          />
          <View style={styles.measurementRow}>
            <View>
              <Text style={styles.measurementLabel}>SMOOTHED DISTANCE</Text>
              <Text style={styles.measurement}>{formatDistance(smoothedDistance)}</Text>
            </View>
            <View style={styles.rightMeasurement}>
              <Text style={styles.measurementLabel}>RAW</Text>
              <Text style={styles.rawValue}>{formatDistance(distanceCm)}</Text>
            </View>
          </View>
          <TouchableOpacity disabled={headingA == null} style={styles.viewButton} onPress={() => setUpHeading(headingA)}>
            <Text style={[styles.viewButtonText, headingA == null && styles.viewButtonTextDisabled]}>Point +Y where Phone A points now</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.statusPanel}>
          <DiagnosticRow
            label="GEOMETRY"
            value={position.source === 'estimated' ? `ESTIMATED · ${position.reason.toUpperCase()}` : position.source.toUpperCase()}
            tone={position.source === 'measured' ? 'good' : position.source === 'estimated' ? 'normal' : 'warn'}
          />
          <DiagnosticRow label="DIRECTION" value={directionStatus} tone={directionStatus === 'MEASURED' ? 'good' : 'warn'} />
          <DiagnosticRow label="FRAME" value={frameStatus} tone={commonFrame ? 'good' : 'warn'} />
          <DiagnosticRow label="RELATIVE ROTATION" value={relativeRotationLabel} />
        </View>

        <View style={styles.connectionRow}>
          <View>
            <Text style={styles.label}>CONNECTION</Text>
            <Text style={styles.connectionValue}>{connection.toUpperCase()}</Text>
          </View>
          <Text style={styles.peerCount}>{peers.length} {peers.length === 1 ? 'peer' : 'peers'} nearby</Text>
        </View>

        {peers.length > 0 && (
          <View style={styles.peerList}>
            <Text style={styles.label}>AVAILABLE PHONES</Text>
            {peers.map((peer) => (
              <TouchableOpacity key={peer.id} style={styles.peerRow} onPress={() => { void ParallaxModule.connect(peer.id).catch(reportActionError); }}>
                <View style={styles.peerIcon}><PhoneGlyph accent="red" /></View>
                <View style={styles.peerInfo}>
                  <Text style={styles.peerName}>{peer.name}</Text>
                  <Text style={styles.peerId}>{peer.id}</Text>
                </View>
                <Text style={styles.connectAction}>CONNECT</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <View style={styles.actions}>
          <TouchableOpacity disabled={!canRange} style={[styles.primary, !canRange && styles.primaryDisabled]} onPress={() => { void ParallaxModule.startRanging().catch(reportActionError); }}>
            <Text style={styles.primaryText}>{canRange ? 'Start ranging' : 'Waiting for connection'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondary} onPress={() => { void ParallaxModule.disconnect().catch(reportActionError); }}>
            <Text style={styles.secondaryText}>Disconnect</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.spinPanel}>
          <Text style={styles.label}>SPIN TEST</Text>
          <Text style={styles.spinHint}>
            While ranging, lay one phone flat, hold a fingertip on the middle of its bottom edge, and swing it around that point:
            two slow full turns, then back. The antenna is near the top, so this makes the distance wave about a phone-length wide.
            Spin Phone A to place Phone B; spin both to line up their rotations without a compass.
            Results appear on the phone where you pressed Start.
          </Text>
          <TouchableOpacity
            disabled={!canRange && !spinning}
            style={[styles.spinButton, spinning && styles.spinButtonActive, !canRange && !spinning && styles.spinButtonDisabled]}
            onPress={spinning ? finishSpin : startSpin}
          >
            <Text style={[styles.spinButtonText, spinning && styles.spinButtonTextActive]}>
              {spinning ? `Finish spin test · ${Math.max(0, Math.round((now - spinStartedAt) / 1000))} s` : 'Start spin test'}
            </Text>
          </TouchableOpacity>
          {!spinning && (spinFits.A || spinFits.B) && (
            <TouchableOpacity style={styles.secondary} onPress={shareSpinData}>
              <Text style={styles.secondaryText}>Share spin data</Text>
            </TouchableOpacity>
          )}
        </View>

        <Text style={styles.label}>SENSOR DIAGNOSTICS</Text>
        <View style={styles.diagnostics}>
          <RoleDiagnostics role="A" measurement={measurementA} motion={motionA} now={now} />
          <RoleDiagnostics role="B" measurement={measurementB} motion={motionB} now={now} />
          <DiagnosticRow label="SESSION" value={(currentMeasurement && fresh ? currentMeasurement.sessionState : sessionState ?? 'idle').toUpperCase()} />
          <DiagnosticRow label="CAMERA" value={capabilities ? `NOT USED · ${capabilities.cameraAssistanceSupported ? 'AVAILABLE' : 'UNAVAILABLE'}` : 'LOADING'} />
          <DiagnosticRow
            label="CAPABILITIES"
            value={capabilities
              ? `${capabilities.uwbSupported ? 'UWB' : 'NO UWB'} · ${capabilities.directionMayBeAvailable ? 'DIRECTION' : 'NO DIRECTION'} · ${capabilities.deviceMotionAvailable ? 'MOTION' : 'NO MOTION'} · ${capabilities.magneticNorthAvailable ? 'MAGNETIC' : 'NO MAGNETIC'}`
              : 'LOADING'}
          />
          {PHONE_ROLES.map((role) => (
            <SpinDiagnostics key={role} role={role} fit={spinFits[role]} recording={spinRecordings.current[role]} active={spinning} />
          ))}
        </View>

        <Text style={styles.label}>EVENT LOG</Text>
        <View style={styles.diagnostics}>
          {logs.map((log, index) => <Text style={styles.log} key={`${log}-${index}`}>{log}</Text>)}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0b0d10' },
  container: { padding: 22, gap: 16 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingTop: 10 },
  eyebrow: { color: '#80aaff', fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
  title: { color: '#f4f6f8', fontSize: 30, fontWeight: '800', letterSpacing: -0.8, marginTop: 6 },
  subtitle: { color: '#8993a1', fontSize: 13, marginTop: 5, maxWidth: 280 },
  statusDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#69717c', marginTop: 10 },
  statusDotConnected: { backgroundColor: '#7fe0a1' },
  visualPanel: { backgroundColor: '#14181e', borderRadius: 24, padding: 12, borderWidth: 1, borderColor: '#242b34' },
  scene: { width: SCENE_WIDTH, height: SCENE_HEIGHT, alignSelf: 'center', position: 'relative', overflow: 'hidden' },
  axisHorizontal: { position: 'absolute', left: 14, right: 14, top: ORIGIN_Y, height: 1, backgroundColor: 'rgba(126, 155, 194, 0.20)' },
  axisVertical: { position: 'absolute', top: 16, bottom: 30, left: ORIGIN_X, width: 1, backgroundColor: 'rgba(126, 155, 194, 0.20)' },
  axisLabel: { position: 'absolute', backgroundColor: '#1a222c', paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4 },
  axisLabelX: { right: 14, top: ORIGIN_Y + 6 },
  axisLabelY: { left: ORIGIN_X + 6, top: 16 },
  axisText: { color: '#6f849d', fontSize: 9, fontWeight: '800' },
  measurementVector: { position: 'absolute', height: 1, backgroundColor: 'rgba(240, 113, 125, 0.75)', transformOrigin: 'left center' },
  measurementVectorEstimated: { backgroundColor: 'rgba(240, 179, 111, 0.75)' },
  phoneAnchor: { position: 'absolute' },
  phone: { width: 52, height: 82, borderRadius: 11, borderWidth: 2, borderColor: '#b6d1f5', backgroundColor: '#1d385d', padding: 5, alignItems: 'center', shadowColor: '#76a9ef', shadowOpacity: 0.35, shadowRadius: 12, shadowOffset: { width: 0, height: 0 } },
  phoneRed: { borderColor: '#f2a0a0', backgroundColor: '#642d36', shadowColor: '#ef6d78' },
  phoneEstimated: { opacity: 0.65, borderStyle: 'dashed' },
  phoneSpeaker: { width: 15, height: 2, borderRadius: 2, backgroundColor: '#9fc4f3', marginBottom: 4 },
  phoneSpeakerRed: { backgroundColor: '#ffc0c0' },
  phoneScreen: { flex: 1, width: '100%', borderRadius: 5, backgroundColor: '#0c1728', overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  phoneScreenCompact: { borderRadius: 1 },
  phoneLetter: { color: '#d6e6ff', fontWeight: '800' },
  phoneLetterRed: { color: '#ffd6d6' },
  phoneGlow: { width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(117, 175, 251, 0.38)' },
  phoneGlowRed: { backgroundColor: 'rgba(255, 133, 145, 0.48)' },
  phoneHome: { width: 10, height: 2, borderRadius: 2, backgroundColor: '#9fc4f3', marginTop: 4 },
  phoneHomeRed: { backgroundColor: '#ffc0c0' },
  unknownPosition: { position: 'absolute', left: 90, right: 90, top: 24, alignItems: 'center', padding: 16, borderWidth: 1, borderStyle: 'dashed', borderColor: '#7b5a42', borderRadius: 16, backgroundColor: 'rgba(88, 58, 40, 0.22)' },
  unknownGlyph: { color: '#f0b36f', fontSize: 28, fontWeight: '800' },
  unknownTitle: { color: '#f0b36f', fontSize: 10, fontWeight: '800', letterSpacing: 1, marginTop: 4 },
  unknownReason: { color: '#a88d76', fontSize: 10, marginTop: 4, textAlign: 'center' },
  sceneFooter: { position: 'absolute', bottom: 6, left: 0, right: 0, alignItems: 'center' },
  sceneFooterText: { color: '#7e8c9d', fontSize: 11, fontWeight: '700' },
  sceneScaleText: { color: '#56657a', fontSize: 9, fontWeight: '700', marginTop: 3 },
  viewButton: { alignSelf: 'center', paddingVertical: 8, paddingHorizontal: 12, marginBottom: 4 },
  viewButtonText: { color: '#80aaff', fontSize: 12, fontWeight: '700' },
  viewButtonTextDisabled: { color: '#35404d' },
  measurementRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', paddingHorizontal: 12, paddingBottom: 10 },
  measurementLabel: { color: '#778391', fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },
  measurement: { color: '#f5f7fa', fontSize: 42, fontWeight: '800', letterSpacing: -1.5, marginTop: 4 },
  rightMeasurement: { alignItems: 'flex-end', paddingBottom: 5 },
  rawValue: { color: '#a9b6c7', fontSize: 16, fontWeight: '700', marginTop: 5 },
  statusPanel: { backgroundColor: '#14181e', borderRadius: 16, borderWidth: 1, borderColor: '#242b34', padding: 13, gap: 8 },
  diagnosticRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  diagnosticLabel: { color: '#778391', fontSize: 10, fontWeight: '800', letterSpacing: 1.1 },
  diagnosticValue: { color: '#d8e0ea', fontSize: 11, fontWeight: '700', textAlign: 'right', flexShrink: 1 },
  goodText: { color: '#7fe0a1' },
  warnText: { color: '#f0b36f' },
  connectionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 3 },
  label: { color: '#778391', fontSize: 10, fontWeight: '800', letterSpacing: 1.4 },
  connectionValue: { color: '#e7edf5', fontSize: 16, fontWeight: '800', marginTop: 5 },
  peerCount: { color: '#778391', fontSize: 12 },
  peerList: { gap: 10 },
  peerRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#14181e', borderRadius: 16, borderWidth: 1, borderColor: '#242b34', padding: 12 },
  peerIcon: { width: 52, height: 82, alignItems: 'center', justifyContent: 'center', transform: [{ scale: 0.66 }] },
  peerInfo: { flex: 1, marginLeft: 4 },
  peerName: { color: '#e7edf5', fontSize: 15, fontWeight: '700' },
  peerId: { color: '#778391', fontSize: 11, marginTop: 3 },
  connectAction: { color: '#80aaff', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  actions: { flexDirection: 'row', gap: 10 },
  primary: { flex: 1, backgroundColor: '#80aaff', paddingVertical: 16, borderRadius: 14, alignItems: 'center' },
  primaryDisabled: { backgroundColor: '#2b3542' },
  primaryText: { color: '#0b0d10', fontWeight: '800' },
  secondary: { paddingHorizontal: 16, paddingVertical: 16, borderRadius: 14, borderWidth: 1, borderColor: '#35404d', alignItems: 'center' },
  secondaryText: { color: '#e7edf5', fontWeight: '700' },
  spinPanel: { backgroundColor: '#14181e', borderRadius: 16, borderWidth: 1, borderColor: '#242b34', padding: 13, gap: 10 },
  spinHint: { color: '#8993a1', fontSize: 12, lineHeight: 17 },
  spinButton: { borderRadius: 14, borderWidth: 1, borderColor: '#80aaff', paddingVertical: 14, alignItems: 'center' },
  spinButtonActive: { backgroundColor: '#80aaff' },
  spinButtonDisabled: { borderColor: '#35404d' },
  spinButtonText: { color: '#80aaff', fontWeight: '800' },
  spinButtonTextActive: { color: '#0b0d10' },
  spinPlot: { width: SPIN_PLOT_WIDTH, height: SPIN_PLOT_HEIGHT, alignSelf: 'center', marginTop: 4, borderRadius: 8, backgroundColor: '#0b0e12', overflow: 'hidden' },
  spinSampleDot: { position: 'absolute', width: 3, height: 3, borderRadius: 1.5, backgroundColor: '#9eabb9' },
  spinCurveDot: { position: 'absolute', width: 4, height: 4, borderRadius: 2, backgroundColor: '#f0b36f' },
  spinPlotLabel: { color: '#6f849d', fontSize: 9, fontWeight: '700', textAlign: 'center', marginTop: 4 },
  diagnostics: { backgroundColor: '#101318', borderRadius: 14, borderWidth: 1, borderColor: '#202731', padding: 12, gap: 7 },
  log: { color: '#9eabb9', fontSize: 11, fontFamily: 'monospace', lineHeight: 16 },
});
