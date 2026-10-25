import { Video, ResizeMode } from 'expo-av';
import { useEffect, useRef, useState } from 'react';
import { Image, SafeAreaView, StyleSheet, Text, TextInput, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import { parseSwipeMessage, SwipeCameraConnection, SwipeCameraMessage, SwipeMedia } from '../spatial/SwipeCamera';
import { interpolatePose, markStale, mediaTransform, SwipeViewport } from '../spatial/SwipeViewport';

const SCALE = 12;
const STALE_MS = 1200;

export default function SwipeScreen({ onExit }: { onExit: () => void }) {
  const { width, height } = useWindowDimensions();
  const [address, setAddress] = useState('');
  const [role, setRole] = useState<'A' | 'B'>('A');
  const [status, setStatus] = useState('Enter the MacBook camera address');
  const [media, setMedia] = useState<SwipeMedia | null>(null);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [pose, setPose] = useState<SwipeViewport | null>(null);
  const previous = useRef<SwipeViewport | null>(null);
  const target = useRef<SwipeViewport | null>(null);
  const connection = useRef<SwipeCameraConnection | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 16);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!target.current) return;
    const next = markStale(target.current, now, STALE_MS);
    if (next.stale) { setPose(next); return; }
    const from = previous.current ?? next;
    const elapsed = now - from.receivedAt;
    setPose(interpolatePose(from, next, Math.min(1, elapsed / 100), now));
  }, [now]);

  const receive = (message: SwipeCameraMessage) => {
    if (message.media) setMedia(message.media);
    if (message.type !== 'layout') return;
    const phone = message.phones.find(item => item.role === role);
    if (!phone) return;
    const next: SwipeViewport = { ...phone, receivedAt: Date.now(), stale: false };
    previous.current = target.current;
    target.current = next;
    setConnected(true);
  };

  const connect = () => {
    connection.current?.close();
    try {
      const client = new SwipeCameraConnection(receive, value => { setStatus(value); setConnected(value.startsWith('Tracking')); });
      client.connect(address.trim(), role);
      connection.current = client;
      setStatus('Connecting to MacBook camera…');
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };

  useEffect(() => () => connection.current?.close(), []);

  const mediaWidth = (media?.width ?? 1600) * SCALE;
  const mediaHeight = (media?.height ?? 1000) * SCALE;
  const transform = pose ? mediaTransform(pose, SCALE, { x: 0, y: 0 }) : null;
  const mediaStyle = transform ? {
    width: mediaWidth, height: mediaHeight, left: width / 2 - mediaWidth / 2,
    top: height / 2 - mediaHeight / 2,
    transform: [{ translateX: transform.translateX }, { translateY: transform.translateY }, { rotate: transform.rotate }],
  } : { width: mediaWidth, height: mediaHeight, left: width / 2 - mediaWidth / 2, top: height / 2 - mediaHeight / 2 };

  return <View style={styles.root}>
    <View style={styles.canvas}>
      {media?.kind === 'video'
        ? <Video source={{ uri: media.url }} style={[styles.media, mediaStyle]} resizeMode={ResizeMode.STRETCH} shouldPlay isLooping />
        : media ? <Image source={{ uri: media.url }} style={[styles.media, mediaStyle]} resizeMode="stretch" /> : <Text style={styles.empty}>Waiting for media from the MacBook</Text>}
      {!pose && <View style={styles.overlay}><Text style={styles.overlayTitle}>SWIPE</Text><Text style={styles.overlayText}>Connect the MacBook camera, then move this phone under the shared media.</Text></View>}
      {pose?.stale && <View style={styles.warning}><Text style={styles.warningText}>TRACKING LOST · HOLDING LAST VIEW</Text></View>}
    </View>
    <SafeAreaView style={styles.controls}>
      <TouchableOpacity onPress={onExit}><Text style={styles.back}>‹ Spatial Lab</Text></TouchableOpacity>
      <Text style={styles.title}>Swipe</Text>
      <Text style={styles.subtitle}>Two phones. One shared image or video.</Text>
      <View style={styles.panel}>
        <Text style={styles.label}>PHONE ROLE</Text>
        <View style={styles.roles}>
          {(['A', 'B'] as const).map(item => <TouchableOpacity key={item} onPress={() => setRole(item)} style={[styles.role, role === item && styles.roleSelected]}><Text style={styles.roleText}>PHONE {item}</Text></TouchableOpacity>)}
        </View>
        <TextInput value={address} onChangeText={setAddress} placeholder="ws://192.168.1.20:8765" placeholderTextColor="#8b96a5" autoCapitalize="none" autoCorrect={false} style={styles.input} />
        <TouchableOpacity style={styles.button} onPress={connect}><Text style={styles.buttonText}>{connected ? 'Reconnect camera' : 'Connect camera'}</Text></TouchableOpacity>
        <Text style={styles.status}>{status}</Text>
        <Text style={styles.mediaStatus}>{media ? `${media.kind.toUpperCase()} · ${media.width} × ${media.height}` : 'MEDIA NOT AVAILABLE'}</Text>
      </View>
    </SafeAreaView>
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#07090c' }, canvas: { ...StyleSheet.absoluteFill, overflow: 'hidden' }, media: { position: 'absolute' }, empty: { color: '#738092', alignSelf: 'center', marginTop: 180 }, overlay: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: 'rgba(7,9,12,.82)' }, overlayTitle: { color: '#f3f6fb', fontSize: 42, fontWeight: '900', letterSpacing: 6 }, overlayText: { color: '#a8b3c2', textAlign: 'center', marginTop: 12, maxWidth: 300, lineHeight: 20 }, warning: { position: 'absolute', top: 56, alignSelf: 'center', backgroundColor: '#8e3f32', paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20 }, warningText: { color: '#fff4ed', fontSize: 11, fontWeight: '800' }, controls: { padding: 20, pointerEvents: 'box-none' }, back: { color: '#8bb4ff', fontWeight: '800' }, title: { color: '#f3f6fb', fontSize: 34, fontWeight: '900', marginTop: 8 }, subtitle: { color: '#a8b3c2', marginTop: 4 }, panel: { marginTop: 18, backgroundColor: 'rgba(15,20,28,.92)', borderColor: '#2b3544', borderWidth: 1, borderRadius: 18, padding: 14, maxWidth: 390 }, label: { color: '#8290a3', fontSize: 10, fontWeight: '800', letterSpacing: 1.4 }, roles: { flexDirection: 'row', gap: 8, marginVertical: 10 }, role: { padding: 10, borderRadius: 8, backgroundColor: '#202a38' }, roleSelected: { backgroundColor: '#3a69ad' }, roleText: { color: '#eaf2ff', fontWeight: '800', fontSize: 11 }, input: { color: '#fff', borderColor: '#46566b', borderWidth: 1, borderRadius: 8, padding: 11 }, button: { backgroundColor: '#4778bd', padding: 12, borderRadius: 8, alignItems: 'center', marginTop: 10 }, buttonText: { color: '#fff', fontWeight: '800' }, status: { color: '#b9c6d8', fontSize: 12, marginTop: 10 }, mediaStatus: { color: '#7fe0a1', fontSize: 11, marginTop: 5, fontWeight: '800' },
});
