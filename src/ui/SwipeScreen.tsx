import { VideoView, useVideoPlayer } from 'expo-video';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, ImageStyle, SafeAreaView, StyleSheet, Text, TextInput, TouchableOpacity, useWindowDimensions, View, ViewStyle, StyleProp } from 'react-native';
import ParallaxModule from '../native/ParallaxModule';
import { MarkerVisibility } from '../spatial/MarkerVisibility';
import { ScreenMarker, SwipeArea, SwipeCameraConnection, SwipeCameraMessage, SwipeMedia } from '../spatial/SwipeCamera';
import { TrackingSquare } from './TrackingSquare';
import { usePeerLink } from './usePeerLink';
import { glow, GridBackdrop, HUD, HUD_FONT, HudButton, HudFrame, PulseDot } from './hud';
import { loopDrift, loopPosition, SharedClock } from '../spatial/SharedClock';
import { interpolatePose, markStale, tabletopMediaPlacement, SwipeViewport } from '../spatial/SwipeViewport';

/** Connection-level statuses that mean no layout is coming, as opposed to a layout with a note. */
const CONNECTION_LOST = /^(Tracking lost|Mac restarted|Waiting for live camera layout)/;

// Seeking stalls playback, so it is a rare last resort: nudge the speed instead and never seek in a loop.
const SEEK_DRIFT_S = .5;
const NUDGE_DRIFT_S = .04;
const MAX_NUDGE = .05;
const SEEK_COOLDOWN_MS = 3000;

/** Follows the Mac's clock: nudges the speed, and seeks only when far off and not seeked recently. */
function SharedVideo({ url, style, targetSeconds }: { url: string; style: StyleProp<ViewStyle>; targetSeconds: (duration: number) => number | null }) {
  const player = useVideoPlayer(url, player => { player.loop = true; player.play(); });
  const lastSeek = useRef(0);
  useEffect(() => {
    const timer = setInterval(() => {
      const duration = player.duration;
      const target = duration > 0 ? targetSeconds(duration) : null;
      if (target === null) return;
      const drift = loopDrift(player.currentTime, target, duration);
      const at = Date.now();
      if (Math.abs(drift) > SEEK_DRIFT_S && at - lastSeek.current > SEEK_COOLDOWN_MS) {
        lastSeek.current = at;
        player.playbackRate = 1;
        player.currentTime = target;
        return;
      }
      player.playbackRate = Math.abs(drift) > NUDGE_DRIFT_S ? 1 - Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, drift * .5)) : 1;
    }, 500);
    return () => clearInterval(timer);
  }, [player, targetSeconds]);
  return <VideoView player={player} style={style} contentFit="fill" nativeControls={false} />;
}

export default function SwipeScreen({ onExit }: { onExit: () => void }) {
  const screen = useWindowDimensions();
  const [address, setAddress] = useState('');
  const [manualRole, setManualRole] = useState<'A' | 'B'>('A');
  // Linked like DistBugs, the link decides the role and runs the motion sensor; unlinked, pick by hand.
  const link = usePeerLink();
  const role = link.role ?? manualRole;
  const [status, setStatus] = useState('Enter the MacBook camera address');
  const [media, setMedia] = useState<SwipeMedia | null>(null);
  const [mediaError, setMediaError] = useState(false);
  const [area, setArea] = useState<SwipeArea>({ widthCm: 32, heightCm: 18 });
  const [marker, setMarker] = useState<ScreenMarker | null>(null);
  const [markerVisible, setMarkerVisible] = useState(true);
  const [motionOn, setMotionOn] = useState(false);
  const [approximate, setApproximate] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(true);
  const [pose, setPose] = useState<SwipeViewport | null>(null);
  const previous = useRef<SwipeViewport | null>(null);
  const target = useRef<SwipeViewport | null>(null);
  const rendered = useRef<SwipeViewport | null>(null);
  const tracking = useRef(false);
  const transitionStarted = useRef(0);
  const blendMs = useRef(100);
  const clock = useRef(new SharedClock());
  const mediaRef = useRef<SwipeMedia | null>(null);
  const connection = useRef<SwipeCameraConnection | null>(null);
  const editedAddress = useRef(false);
  const visibility = useRef(new MarkerVisibility());
  const lastPacket = useRef(0);
  const streamLost = useRef(false);
  const publishRef = useRef<() => void>(() => undefined);
  const motionWatch = useRef<(() => void) | null>(null);

  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem('distbugs.camera.address').then(value => {
      if (active && value && !editedAddress.current) setAddress(value);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const next = target.current;
      if (next) {
        const at = Date.now();
        if (!tracking.current || markStale(next, at).stale) {
          if (rendered.current && !rendered.current.stale) {
            rendered.current = { ...rendered.current, stale: true };
            setPose(rendered.current);
          }
        } else {
          const view = interpolatePose(previous.current ?? next, next, (at - transitionStarted.current) / blendMs.current, next.receivedAt);
          rendered.current = view;
          setPose(view);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); connection.current?.close(); motionWatch.current?.(); };
  }, []);

  const stopMotionWatch = () => {
    motionWatch.current?.();
    motionWatch.current = null;
    publishRef.current = () => undefined;
  };

  /**
   * The same behaviour as the DistBugs link: the square hides once this phone has rested and the
   * camera has its position, and comes back as soon as the phone moves. Without movement data it stays up.
   */
  const startMotionWatch = (client: SwipeCameraConnection) => {
    stopMotionWatch();
    visibility.current = new MarkerVisibility();
    setMarkerVisible(true);
    const publish = () => {
      const state = visibility.current.snapshot(Date.now());
      setMarkerVisible(state.markerVisible);
      setMotionOn(state.motionAvailable);
      client.updateMarkerTracking(state);
    };
    publishRef.current = publish;
    void ParallaxModule.startMotion().catch(() => undefined);
    const motion = ParallaxModule.onMotionUpdated(event => { if (visibility.current.observeMotion(event, Date.now())) publish(); });
    const watchdog = setInterval(() => {
      if (!streamLost.current && Date.now() - lastPacket.current > 1500) {
        streamLost.current = true;
        visibility.current.reacquire();
      }
      publish();
    }, 100);
    motionWatch.current = () => { clearInterval(watchdog); motion.remove(); void ParallaxModule.stopMotion().catch(() => undefined); };
  };

  const receive = (message: SwipeCameraMessage, connectedRole: 'A' | 'B') => {
    lastPacket.current = Date.now();
    streamLost.current = false;
    if (message.timestampMs !== undefined) clock.current.observe(message.timestampMs, Date.now());
    if (message.media) {
      const next = message.media;
      mediaRef.current = next;
      setMedia(current => current && current.url === next.url && current.kind === next.kind && current.version === next.version
        && current.width === next.width && current.height === next.height && current.position === next.position
        && current.startedAtMs === next.startedAtMs ? current : next);
    }
    if (message.area) setArea(message.area);
    setApproximate(message.calibrationMode === 'manual' || message.calibrationMode === 'screen');
    const square = message.screenMarkers?.find(item => item.role === connectedRole);
    if (square) setMarker(current => current?.markerId === square.markerId && current.widthCm === square.widthCm
      && current.sizeCm === square.sizeCm ? current : square);
    if (message.type !== 'layout') {
      if (message.needsPositionUpdate && !visibility.current.snapshot(Date.now()).markerVisible) {
        visibility.current.reacquire();
        publishRef.current();
      }
      tracking.current = false;
      return;
    }
    // A layout that does not answer this phone's latest movement is from before it moved: ignore it.
    const acknowledged = message.markerRevisions?.[connectedRole];
    if (acknowledged !== undefined && acknowledged !== visibility.current.snapshot(Date.now()).revision) return;
    const phone = message.phones.find(item => item.role === connectedRole);
    if (!phone) { tracking.current = false; return; }
    visibility.current.observeLayout(acknowledged, Date.now());
    const next: SwipeViewport = { ...phone, receivedAt: Date.now(), stale: false };
    if (target.current) blendMs.current = Math.max(33, Math.min(120, next.receivedAt - target.current.receivedAt));
    previous.current = rendered.current ?? next;
    target.current = next;
    transitionStarted.current = next.receivedAt;
    tracking.current = true;
  };

  const connect = () => {
    connection.current?.close();
    stopMotionWatch();
    tracking.current = false;
    clock.current.reset();
    setMarker(null); setPose(null);
    previous.current = target.current = rendered.current = null;
    try {
      const client = new SwipeCameraConnection(message => receive(message, role), value => {
        setStatus(value);
        if (CONNECTION_LOST.test(value)) tracking.current = false;
      });
      client.connect(address.trim(), role, screen.width / screen.height, true);
      connection.current = client;
      lastPacket.current = Date.now();
      streamLost.current = false;
      startMotionWatch(client);
      setStatus('Connecting to MacBook camera…');
      setControlsOpen(false);
      void AsyncStorage.setItem('distbugs.camera.address', address.trim()).catch(() => undefined);
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };

  /** A new role means a new camera identity, so the camera connection starts over. */
  const resetCamera = (reason: string) => {
    connection.current?.close();
    stopMotionWatch();
    setMarkerVisible(true);
    tracking.current = false;
    previous.current = target.current = rendered.current = null;
    setPose(null); setMarker(null);
    setStatus(reason);
  };

  const chooseRole = (next: 'A' | 'B') => {
    if (next === role) return;
    setManualRole(next);
    resetCamera('Role changed · connect camera again');
  };

  const linkedRole = useRef(link.role);
  useEffect(() => {
    if (linkedRole.current === link.role) return;
    linkedRole.current = link.role;
    resetCamera(link.role ? `Linked as Phone ${link.role} · connect camera` : 'Unlinked · connect camera again');
  }, [link.role]);

  useEffect(() => { setMediaError(false); }, [media?.url, media?.version]);

  const videoTarget = useCallback((duration: number) => {
    const remote = clock.current.remoteNow(Date.now());
    const current = mediaRef.current;
    if (remote === null || !current || current.startedAtMs === undefined) return null;
    return loopPosition(remote, current.startedAtMs, current.position ?? 0, duration);
  }, []);

  const placement = pose && media ? tabletopMediaPlacement(pose, screen, media, area) : null;
  const mediaStyle: ImageStyle & ViewStyle = placement ? {
    position: 'absolute', width: placement.width, height: placement.height,
    left: (screen.width - placement.width) / 2, top: (screen.height - placement.height) / 2,
    transform: [{ matrix: placement.matrix }],
  } : styles.hidden;

  const live = Boolean(pose && !pose.stale);
  const roleColor = role === 'A' ? HUD.cyan : HUD.magenta;

  return <View style={styles.root}>
    <StatusBar hidden />
    <View style={styles.canvas}>
      {!live && <GridBackdrop />}
      {media?.kind === 'video'
        ? <SharedVideo key={`${media.url}:${media.version}`} url={media.url} style={mediaStyle} targetSeconds={videoTarget} />
        : media ? <Image source={{ uri: media.url }} onError={() => setMediaError(true)} style={mediaStyle} resizeMode="stretch" /> : null}
      {!pose && <View style={styles.waiting}>
        <Reticle color={roleColor} />
        <Text style={styles.waitingTitle}>YOUR SCREEN{'\n'}IS A WINDOW.</Text>
        <Text style={styles.waitingHint}>{marker ? 'Keep both on-screen squares visible to the MacBook camera.' : 'Connect both phones to show their tracking squares.'}</Text>
      </View>}
    </View>
    <SafeAreaView style={styles.controls} pointerEvents="box-none">
      <View style={styles.toolbar}>
        <HudButton small variant="ghost" label="‹ Spatial Lab" onPress={onExit} />
        <HudButton small color={roleColor} label={controlsOpen ? 'Hide setup' : 'Setup'} onPress={() => { tracking.current = false; setControlsOpen(open => !open); }} />
      </View>
      {controlsOpen && <HudFrame style={styles.panel} title="SWIPE // SETUP" tag={`PHONE ${role}`} tagColor={roleColor} accent={roleColor}>
        <Text style={[styles.title, glow(roleColor, 16)]}>SWIPE</Text>
        <Text style={styles.subtitle}>Move two screens across one image.</Text>
        <Text style={styles.label}>LINK THE PHONES</Text>
        {link.status === 'off' && <HudButton color={roleColor} label="Link phones" onPress={link.start} />}
        {(link.status === 'searching' || link.status === 'connecting') && <View style={styles.peers}>
          {link.peers.length === 0
            ? <Text style={styles.hint}>Looking for the other phone · open Swipe and tap Link phones on it too.</Text>
            : link.peers.map(peer => <HudButton key={peer.id} small color={roleColor} label={`Connect to ${peer.name}`} onPress={() => link.connect(peer.id)} />)}
          {link.status === 'connecting' && <Text style={styles.hint}>Connecting…</Text>}
        </View>}
        {link.status === 'connected' && <Text style={[styles.hint, { color: roleColor }]}>Linked · this is PHONE {role}. The phone that connected is Phone A.</Text>}
        {link.status !== 'off' && <HudButton small variant="ghost" label="Unlink" onPress={link.stop} />}
        {link.error && <Text style={styles.hint}>{link.error}</Text>}
        {link.status !== 'connected' && <>
        <Text style={styles.label}>OR CHOOSE A DIFFERENT ROLE ON EACH PHONE (SQUARE STAYS ON)</Text>
        <View style={styles.roles}>
          {(['A', 'B'] as const).map(item => {
            const color = item === 'A' ? HUD.cyan : HUD.magenta;
            const selected = role === item;
            return <TouchableOpacity key={item} onPress={() => chooseRole(item)}
              style={[styles.role, selected && { borderColor: color, backgroundColor: `${color}1f`, shadowColor: color, shadowOpacity: 0.6, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } }]}>
              <Text style={[styles.roleText, { color: selected ? color : HUD.muted }, selected && glow(color, 6)]}>PHONE {item}</Text>
            </TouchableOpacity>;
          })}
        </View>
        </>}
        <Text style={styles.label}>MACBOOK CAMERA ADDRESS</Text>
        <TextInput value={address} onChangeText={value => { editedAddress.current = true; setAddress(value); }} placeholder="ws://192.168.1.20:8765"
          accessibilityLabel="MacBook camera address" placeholderTextColor={HUD.faint} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={styles.input} />
        <HudButton color={roleColor} label="Connect camera" onPress={connect} />
        <View style={styles.statusRow}>
          <PulseDot active={live} size={8} />
          <Text style={styles.status}>{`> ${status}`}</Text>
        </View>
        <Text style={styles.hint}>No printing. Hide setup to show the tracking square in the centre of this screen.</Text>
        {approximate && <Text style={styles.hint}>Hold both phones still briefly to set the reference, then move freely on the table. Press R on the Mac after moving the camera.</Text>}
      </HudFrame>}
    </SafeAreaView>
    {(!media || mediaError || pose?.stale) && <View pointerEvents="none" style={styles.warning}>
      <Text style={styles.warningText}>⚠ {pose?.stale ? 'TRACKING LOST · HOLDING LAST VIEW' : 'MEDIA UNAVAILABLE · SELECT A FILE ON THE MAC'}</Text>
    </View>}
    {!controlsOpen && <View pointerEvents="none" style={styles.liveStatus}>
      <PulseDot active={live} color={roleColor} size={7} />
      <Text style={[styles.liveText, { color: roleColor }]} numberOfLines={1}>PHONE {role} · {status} · movement sensor {motionOn ? 'on' : 'off'}</Text>
    </View>}
    {marker && markerVisible && !controlsOpen && <TrackingSquare marker={marker} width={screen.width} height={screen.height} />}
  </View>;
}

/** Targeting rings with a crosshair, spinning slowly while this phone waits for the camera. */
function Reticle({ color }: { color: string }) {
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 8000, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [spin]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return <View style={styles.reticle}>
    <Animated.View style={[styles.reticleOuter, { borderColor: color, transform: [{ rotate }] }]} />
    <View style={[styles.reticleInner, { borderColor: `${color}66` }]} />
    <View style={[styles.reticleCrossH, { backgroundColor: `${color}88` }]} />
    <View style={[styles.reticleCrossV, { backgroundColor: `${color}88` }]} />
    <View style={[styles.reticleCore, { backgroundColor: color, shadowColor: color }]} />
  </View>;
}

const mono = { fontFamily: HUD_FONT } as const;
const RETICLE = 120;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: HUD.background },
  canvas: { ...StyleSheet.absoluteFill, overflow: 'hidden' },
  hidden: { width: 0, height: 0 },
  waiting: { position: 'absolute', left: 24, right: 24, bottom: 120, alignItems: 'center', gap: 14 },
  waitingTitle: { ...mono, color: HUD.text, fontSize: 22, fontWeight: '800', textAlign: 'center', lineHeight: 28, ...glow(HUD.cyan, 12) },
  waitingHint: { ...mono, color: HUD.muted, fontSize: 11, lineHeight: 17, textAlign: 'center' },
  reticle: { width: RETICLE, height: RETICLE, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  reticleOuter: { position: 'absolute', width: RETICLE, height: RETICLE, borderRadius: RETICLE / 2, borderWidth: 1.5, borderStyle: 'dashed' },
  reticleInner: { position: 'absolute', width: RETICLE * 0.55, height: RETICLE * 0.55, borderRadius: RETICLE * 0.275, borderWidth: 1 },
  reticleCrossH: { position: 'absolute', width: RETICLE * 1.3, height: StyleSheet.hairlineWidth },
  reticleCrossV: { position: 'absolute', height: RETICLE * 1.3, width: StyleSheet.hairlineWidth },
  reticleCore: { width: 8, height: 8, borderRadius: 4, shadowOpacity: 1, shadowRadius: 8, shadowOffset: { width: 0, height: 0 } },
  controls: { padding: 20 },
  toolbar: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, paddingHorizontal: 4 },
  panel: { marginTop: 10, marginHorizontal: 4, maxWidth: 390, backgroundColor: 'rgba(4, 12, 22, 0.94)' },
  title: { ...mono, color: HUD.text, fontSize: 32, fontWeight: '800', letterSpacing: 6 },
  subtitle: { color: HUD.muted, marginBottom: 6 },
  label: { ...mono, color: HUD.muted, fontSize: 9, fontWeight: '700', letterSpacing: 1.2 },
  roles: { flexDirection: 'row', gap: 8, marginBottom: 4 },
  peers: { gap: 6 },
  role: { flex: 1, paddingVertical: 11, borderRadius: 3, borderWidth: 1, borderColor: HUD.line, alignItems: 'center' },
  roleText: { ...mono, fontWeight: '800', fontSize: 11, letterSpacing: 2 },
  input: { ...mono, color: HUD.text, borderColor: HUD.lineStrong, borderWidth: 1, borderRadius: 3, padding: 11, backgroundColor: 'rgba(63, 246, 255, 0.04)' },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginLeft: -8 },
  status: { ...mono, color: HUD.text, fontSize: 11, flex: 1 },
  hint: { color: HUD.muted, fontSize: 12, lineHeight: 18 },
  warning: { position: 'absolute', bottom: 44, alignSelf: 'center', backgroundColor: 'rgba(255, 194, 77, 0.12)', borderWidth: 1, borderColor: HUD.warn, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 3, shadowColor: HUD.warn, shadowOpacity: 0.5, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } },
  warningText: { ...mono, color: HUD.warn, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  liveStatus: { position: 'absolute', top: 95, left: 20, right: 20, flexDirection: 'row', alignItems: 'center' },
  liveText: { ...mono, fontSize: 10, fontWeight: '700', letterSpacing: 1, flex: 1 },
});
