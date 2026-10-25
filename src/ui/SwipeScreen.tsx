import { VideoView, useVideoPlayer } from 'expo-video';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, ImageStyle, SafeAreaView, StyleSheet, Text, TextInput, TouchableOpacity, useWindowDimensions, View, ViewStyle, StyleProp } from 'react-native';
import { ScreenMarker, SwipeArea, SwipeCameraConnection, SwipeCameraMessage, SwipeMedia } from '../spatial/SwipeCamera';
import { TrackingSquare } from './TrackingSquare';
import { loopDrift, loopPosition, SharedClock } from '../spatial/SharedClock';
import { interpolatePose, markStale, tabletopMediaPlacement, SwipeViewport } from '../spatial/SwipeViewport';

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
  const [role, setRole] = useState<'A' | 'B'>('A');
  const [status, setStatus] = useState('Enter the MacBook camera address');
  const [media, setMedia] = useState<SwipeMedia | null>(null);
  const [mediaError, setMediaError] = useState(false);
  const [area, setArea] = useState<SwipeArea>({ widthCm: 32, heightCm: 18 });
  const [marker, setMarker] = useState<ScreenMarker | null>(null);
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
    return () => { cancelAnimationFrame(frame); connection.current?.close(); };
  }, []);

  const receive = (message: SwipeCameraMessage, connectedRole: 'A' | 'B') => {
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
    if (message.type !== 'layout') { tracking.current = false; return; }
    const phone = message.phones.find(item => item.role === connectedRole);
    if (!phone) { tracking.current = false; return; }
    const next: SwipeViewport = { ...phone, receivedAt: Date.now(), stale: false };
    if (target.current) blendMs.current = Math.max(33, Math.min(120, next.receivedAt - target.current.receivedAt));
    previous.current = rendered.current ?? next;
    target.current = next;
    transitionStarted.current = next.receivedAt;
    tracking.current = true;
  };

  const connect = () => {
    connection.current?.close();
    tracking.current = false;
    clock.current.reset();
    setMarker(null); setPose(null);
    previous.current = target.current = rendered.current = null;
    try {
      const client = new SwipeCameraConnection(message => receive(message, role), value => {
        setStatus(value);
        if (value !== 'Tracking phones') tracking.current = false;
      });
      client.connect(address.trim(), role, screen.width / screen.height);
      connection.current = client;
      setStatus('Connecting to MacBook camera…');
      setControlsOpen(false);
      void AsyncStorage.setItem('distbugs.camera.address', address.trim()).catch(() => undefined);
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };

  const chooseRole = (next: 'A' | 'B') => {
    if (next === role) return;
    connection.current?.close();
    tracking.current = false;
    previous.current = target.current = rendered.current = null;
    setPose(null); setMarker(null); setRole(next);
    setStatus('Role changed · connect camera again');
  };

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

  return <View style={styles.root}>
    <StatusBar hidden />
    <View style={styles.canvas}>
      {media?.kind === 'video'
        ? <SharedVideo key={`${media.url}:${media.version}`} url={media.url} style={mediaStyle} targetSeconds={videoTarget} />
        : media ? <Image source={{ uri: media.url }} onError={() => setMediaError(true)} style={mediaStyle} resizeMode="stretch" /> : null}
      {!pose && <View style={styles.waiting}>
        <Text style={styles.waitingTitle}>Your screen is a window.</Text>
        <Text style={styles.hint}>{marker ? 'Keep both on-screen squares visible to the MacBook camera.' : 'Connect both phones to show their tracking squares.'}</Text>
      </View>}
    </View>
    <SafeAreaView style={styles.controls} pointerEvents="box-none">
      <View style={styles.toolbar}>
        <TouchableOpacity onPress={onExit}><Text style={styles.back}>‹ Spatial Lab</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => { tracking.current = false; setControlsOpen(open => !open); }}><Text style={styles.back}>{controlsOpen ? 'Hide setup' : 'Setup'}</Text></TouchableOpacity>
      </View>
      {controlsOpen && <View style={styles.panel}>
        <Text style={styles.title}>Swipe</Text>
        <Text style={styles.subtitle}>Move two screens across one image.</Text>
        <Text style={styles.label}>CHOOSE A DIFFERENT ROLE ON EACH PHONE</Text>
        <View style={styles.roles}>
          {(['A', 'B'] as const).map(item => <TouchableOpacity key={item} onPress={() => chooseRole(item)} style={[styles.role, role === item && styles.roleSelected]}><Text style={styles.roleText}>PHONE {item}</Text></TouchableOpacity>)}
        </View>
        <TextInput value={address} onChangeText={value => { editedAddress.current = true; setAddress(value); }} placeholder="ws://192.168.1.20:8765"
          accessibilityLabel="MacBook camera address" placeholderTextColor="#8b96a5" autoCapitalize="none" autoCorrect={false} keyboardType="url" style={styles.input} />
        <TouchableOpacity style={styles.button} onPress={connect}><Text style={styles.buttonText}>Connect camera</Text></TouchableOpacity>
        <Text style={styles.status}>{status}</Text>
        <Text style={styles.hint}>No printing. Hide setup to show the tracking square in the centre of this screen.</Text>
        {approximate && <Text style={styles.hint}>Hold both phones still briefly to set the reference, then move freely on the table. Press R on the Mac after moving the camera.</Text>}
      </View>}
    </SafeAreaView>
    {(!media || mediaError || pose?.stale) && <View pointerEvents="none" style={styles.warning}>
      <Text style={styles.warningText}>{pose?.stale ? 'TRACKING LOST · HOLDING LAST VIEW' : 'MEDIA UNAVAILABLE · SELECT A FILE ON THE MAC'}</Text>
    </View>}
    {!controlsOpen && <View pointerEvents="none" style={styles.liveStatus}><Text style={styles.hint}>PHONE {role} · {status}</Text></View>}
    {marker && !controlsOpen && <TrackingSquare marker={marker} width={screen.width} height={screen.height} />}
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#07090c' },
  canvas: { ...StyleSheet.absoluteFill, overflow: 'hidden' },
  hidden: { width: 0, height: 0 },
  waiting: { position: 'absolute', left: 24, right: 24, bottom: 140, alignItems: 'center' },
  waitingTitle: { color: '#f3f6fb', fontSize: 20, fontWeight: '700', marginBottom: 8 },
  controls: { padding: 20 },
  toolbar: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10 },
  back: { color: '#9bbfff', fontWeight: '700', padding: 6 },
  panel: { marginTop: 10, backgroundColor: 'rgba(15,20,28,.96)', borderColor: '#2b3544', borderWidth: 1, borderRadius: 18, padding: 14, maxWidth: 390 },
  title: { color: '#f3f6fb', fontSize: 30, fontWeight: '800' },
  subtitle: { color: '#a8b3c2', marginTop: 4, marginBottom: 16 },
  label: { color: '#a2b0c4', fontSize: 10, fontWeight: '700', letterSpacing: .8 },
  roles: { flexDirection: 'row', gap: 8, marginVertical: 10 },
  role: { padding: 10, borderRadius: 8, backgroundColor: '#202a38' },
  roleSelected: { backgroundColor: '#3a69ad' },
  roleText: { color: '#eaf2ff', fontWeight: '800', fontSize: 11 },
  input: { color: '#fff', borderColor: '#46566b', borderWidth: 1, borderRadius: 8, padding: 11 },
  button: { backgroundColor: '#4778bd', padding: 12, borderRadius: 8, alignItems: 'center', marginTop: 10 },
  buttonText: { color: '#fff', fontWeight: '800' },
  status: { color: '#b9c6d8', fontSize: 12, marginTop: 10 },
  hint: { color: '#9eacc0', fontSize: 12, lineHeight: 18, marginTop: 6 },
  warning: { position: 'absolute', bottom: 44, alignSelf: 'center', backgroundColor: '#633c29', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12 },
  warningText: { color: '#fff4ed', fontSize: 10, fontWeight: '700' },
  liveStatus: { position: 'absolute', top: 95, left: 20, right: 20 },
});
