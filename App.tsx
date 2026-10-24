import { useEffect, useState } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import ParallaxModule, { ConnectionState, DistanceEvent, Peer } from './src/native/ParallaxModule';
import { SmoothingBuffer } from './src/state/SmoothingBuffer';

const CONNECTION_STATES: ConnectionState[] = ['disconnected', 'connecting', 'connected', 'recovering'];
const MAX_DISTANCE_CM = 150;
const SCENE_CENTER_Y = 240;
const MAX_SEPARATION_PX = 150;
const PHONE_2_HALF_HEIGHT = 30;

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

const formatDistance = (value: number): string => `${Math.round(value)} cm`;

function PhoneGlyph({ small = false, accent = 'blue' }: { small?: boolean; accent?: 'blue' | 'red' }) {
  const red = accent === 'red';
  return (
    <View style={[styles.phone, small && styles.phoneSmall, red && styles.phoneRed]}>
      <View style={[styles.phoneSpeaker, small && styles.phoneSpeakerSmall, red && styles.phoneSpeakerRed]} />
      <View style={[styles.phoneScreen, small && styles.phoneScreenSmall]}>
        <View style={[styles.phoneGlow, small && styles.phoneGlowSmall, red && styles.phoneGlowRed]} />
      </View>
      <View style={[styles.phoneHome, small && styles.phoneHomeSmall, red && styles.phoneHomeRed]} />
    </View>
  );
}

function DistanceScene({ distanceCm }: { distanceCm: number | null }) {
  const sceneWidth = 320;
  const tooFar = distanceCm != null && distanceCm > MAX_DISTANCE_CM;
  const clampedDistance = distanceCm == null ? null : Math.max(0, Math.min(distanceCm, MAX_DISTANCE_CM));
  const separation = clampedDistance == null ? 90 : (clampedDistance / MAX_DISTANCE_CM) * MAX_SEPARATION_PX;
  const ringRadius = separation;
  const ringSize = ringRadius * 2;
  const ringLeft = (sceneWidth - ringSize) / 2;
  const ringTop = SCENE_CENTER_Y - ringRadius;
  const peerTop = Math.max(0, SCENE_CENTER_Y - separation - PHONE_2_HALF_HEIGHT);

  return (
    <View style={styles.scene}>
      {ringRadius > 4 && <View style={[styles.ring, { width: ringSize, height: ringSize, borderRadius: ringRadius, left: ringLeft, top: ringTop }]} />}
      <View style={[styles.ringInner, { width: ringSize * 0.68, height: ringSize * 0.68, borderRadius: ringSize * 0.34, left: (sceneWidth - ringSize * 0.68) / 2, top: SCENE_CENTER_Y - ringSize * 0.34 }]} />
      <View style={[styles.peerMarker, { top: peerTop }]}>
        <PhoneGlyph small accent="red" />
        <Text style={styles.peerMarkerText}>PHONE 2</Text>
      </View>
      <View style={[styles.sceneCenter, { top: SCENE_CENTER_Y - 38 }]}>
        <View style={styles.centerHalo} />
        <PhoneGlyph />
      </View>
      <View style={styles.radiusLabel}>
        <View style={styles.radiusDot} />
        <Text style={[styles.radiusText, tooFar && styles.tooFarText]}>{distanceCm == null ? 'Waiting for signal' : tooFar ? 'TOO FAR · 150+ cm' : `Phone separation · ${formatDistance(clampedDistance ?? 0)}`}</Text>
      </View>
    </View>
  );
}

export default function App() {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [connection, setConnection] = useState<ConnectionState>('disconnected');
  const [distance, setDistance] = useState<DistanceEvent | null>(null);
  const [smoothed, setSmoothed] = useState<number | null>(null);
  const [logs, setLogs] = useState<string[]>(['Parallax ready — start discovery on both phones.']);
  const [smoother] = useState(() => new SmoothingBuffer(5));

  useEffect(() => {
    const addLog = (message: string) => setLogs((current) => [message, ...current].slice(0, 30));
    const subscriptions = [
      ParallaxModule.onPeerDiscovered((peer) => {
        setPeers((current) => current.some((item) => item.id === peer.id) ? current : [...current, peer]);
        addLog(`Discovered ${peer.name}`);
      }),
      ParallaxModule.onConnectionChanged((event) => {
        const state = readConnectionState(event);
        if (state) {
          setConnection(state);
          addLog(`Connection: ${state}`);
        } else {
          addLog('Error: invalid connection status from native code');
        }
      }),
      ParallaxModule.onDistanceUpdated((event) => {
        if (Number.isFinite(event.distanceCm) && event.distanceCm >= 0) setDistance(event);
        else addLog('Error: invalid distance reading');
      }),
      ParallaxModule.onError((error) => addLog(`Error ${error.code}: ${error.message}`)),
      ParallaxModule.onDiagnostic((event) => addLog(`[${event.stage}] ${event.message}`)),
    ];

    ParallaxModule.startDiscovery().catch((error) => {
      addLog(`Discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    });

    return () => {
      subscriptions.forEach((subscription) => subscription.remove());
      void ParallaxModule.stopDiscovery();
    };
  }, []);

  useEffect(() => {
    if (distance) setSmoothed(smoother.push(distance.distanceCm));
    else {
      smoother.reset();
      setSmoothed(null);
    }
  }, [distance, smoother]);

  const reportActionError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setLogs((current) => [`Error: ${message}`, ...current].slice(0, 30));
  };

  const connected = connection === 'connected';
  const rawDistance = distance?.distanceCm ?? null;
  const tooFar = smoothed != null && smoothed > MAX_DISTANCE_CM;

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Nearby, precisely.</Text>
            <Text style={styles.subtitle}>Apple Nearby Interaction</Text>
          </View>
          <View style={[styles.statusDot, connection === 'connected' && styles.statusDotConnected]} />
        </View>

        <View style={styles.visualPanel}>
          <DistanceScene distanceCm={smoothed} />
          <View style={styles.measurementRow}>
            <View>
              <Text style={styles.measurementLabel}>DISTANCE TO PHONE 2</Text>
              <Text style={[styles.measurement, tooFar && styles.measurementTooFar]}>{smoothed == null ? '—' : tooFar ? 'TOO FAR' : formatDistance(Math.max(0, smoothed))}</Text>
            </View>
            <View style={styles.rawReading}>
              <Text style={styles.rawLabel}>RAW</Text>
              <Text style={styles.rawValue}>{rawDistance == null ? '—' : rawDistance > MAX_DISTANCE_CM ? 'TOO FAR' : formatDistance(Math.max(0, rawDistance))}</Text>
            </View>
          </View>
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
              <TouchableOpacity
                key={peer.id}
                style={styles.peerRow}
                onPress={() => { void ParallaxModule.connect(peer.id).catch(reportActionError); }}
              >
                <View style={styles.peerIcon}><PhoneGlyph small accent="red" /></View>
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
          <TouchableOpacity
            disabled={!connected}
            style={[styles.primary, !connected && styles.primaryDisabled]}
            onPress={() => { void ParallaxModule.startRanging().catch(reportActionError); }}
          >
            <Text style={styles.primaryText}>{connected ? 'Start ranging' : 'Waiting for connection'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.secondary}
            onPress={() => { void ParallaxModule.disconnect().catch(reportActionError); }}
          >
            <Text style={styles.secondaryText}>Disconnect</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.label}>DIAGNOSTICS</Text>
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
  title: { color: '#f4f6f8', fontSize: 31, fontWeight: '800', letterSpacing: -0.8 },
  subtitle: { color: '#8993a1', fontSize: 14, marginTop: 5 },
  statusDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#69717c', marginTop: 10 },
  statusDotConnected: { backgroundColor: '#7fe0a1' },
  visualPanel: { backgroundColor: '#14181e', borderRadius: 24, padding: 12, borderWidth: 1, borderColor: '#242b34' },
  scene: { width: 320, height: 400, alignSelf: 'center', position: 'relative' },
  ring: { position: 'absolute', borderWidth: 1, borderColor: '#638fcf', backgroundColor: 'rgba(89, 137, 207, 0.06)' },
  ringInner: { position: 'absolute', borderWidth: 1, borderColor: 'rgba(99, 143, 207, 0.28)' },
  sceneCenter: { position: 'absolute', left: 132, width: 56, height: 78, alignItems: 'center', justifyContent: 'center' },
  centerHalo: { position: 'absolute', width: 110, height: 110, borderRadius: 55, backgroundColor: 'rgba(111, 163, 239, 0.08)' },
  phone: { width: 48, height: 76, borderRadius: 10, borderWidth: 2, borderColor: '#b6d1f5', backgroundColor: '#1d385d', padding: 5, alignItems: 'center', shadowColor: '#76a9ef', shadowOpacity: 0.35, shadowRadius: 12, shadowOffset: { width: 0, height: 0 } },
  phoneRed: { borderColor: '#f2a0a0', backgroundColor: '#642d36', shadowColor: '#ef6d78' },
  phoneSmall: { width: 38, height: 61, borderRadius: 8, borderWidth: 1.7, padding: 4 },
  phoneSpeaker: { width: 14, height: 2, borderRadius: 2, backgroundColor: '#9fc4f3', marginBottom: 4 },
  phoneSpeakerRed: { backgroundColor: '#ffc0c0' },
  phoneSpeakerSmall: { width: 11, height: 1.5, marginBottom: 3 },
  phoneScreen: { flex: 1, width: '100%', borderRadius: 5, backgroundColor: '#0c1728', overflow: 'hidden' },
  phoneScreenSmall: { borderRadius: 4 },
  phoneGlow: { width: 22, height: 22, borderRadius: 11, backgroundColor: 'rgba(117, 175, 251, 0.38)', alignSelf: 'center', marginTop: 20 },
  phoneGlowSmall: { width: 17, height: 17, borderRadius: 8.5, marginTop: 15 },
  phoneGlowRed: { backgroundColor: 'rgba(255, 133, 145, 0.48)' },
  phoneHome: { width: 9, height: 2, borderRadius: 2, backgroundColor: '#9fc4f3', marginTop: 4 },
  phoneHomeRed: { backgroundColor: '#ffc0c0' },
  phoneHomeSmall: { width: 7, height: 1.5, marginTop: 3 },
  peerMarker: { position: 'absolute', left: 0, right: 0, alignItems: 'center', gap: 4 },
  peerMarkerText: { color: '#9fbbe2', fontSize: 9, fontWeight: '800', letterSpacing: 1.2 },
  radiusLabel: { position: 'absolute', left: 0, right: 0, bottom: 6, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 6 },
  radiusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#80aaff' },
  radiusText: { color: '#9da8b6', fontSize: 12, fontWeight: '600' },
  tooFarText: { color: '#f0b36f' },
  measurementRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', paddingHorizontal: 12, paddingBottom: 10 },
  measurementLabel: { color: '#778391', fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },
  measurement: { color: '#f5f7fa', fontSize: 45, fontWeight: '800', letterSpacing: -1.5, marginTop: 4 },
  measurementTooFar: { color: '#f0b36f', fontSize: 34, letterSpacing: -0.8 },
  rawReading: { alignItems: 'flex-end', paddingBottom: 5 },
  rawLabel: { color: '#778391', fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },
  rawValue: { color: '#a9b6c7', fontSize: 16, fontWeight: '700', marginTop: 5 },
  connectionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 3 },
  label: { color: '#778391', fontSize: 10, fontWeight: '800', letterSpacing: 1.4 },
  connectionValue: { color: '#e7edf5', fontSize: 16, fontWeight: '800', marginTop: 5 },
  peerCount: { color: '#778391', fontSize: 12 },
  peerList: { gap: 10 },
  peerRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#14181e', borderRadius: 16, borderWidth: 1, borderColor: '#242b34', padding: 12 },
  peerIcon: { width: 38, height: 52, alignItems: 'center', justifyContent: 'center' },
  peerInfo: { flex: 1, marginLeft: 10 },
  peerName: { color: '#e7edf5', fontSize: 15, fontWeight: '700' },
  peerId: { color: '#778391', fontSize: 11, marginTop: 3 },
  connectAction: { color: '#80aaff', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  actions: { flexDirection: 'row', gap: 10 },
  primary: { flex: 1, backgroundColor: '#80aaff', paddingVertical: 16, borderRadius: 14, alignItems: 'center' },
  primaryDisabled: { backgroundColor: '#2b3542' },
  primaryText: { color: '#0b0d10', fontWeight: '800' },
  secondary: { paddingHorizontal: 16, paddingVertical: 16, borderRadius: 14, borderWidth: 1, borderColor: '#35404d', alignItems: 'center' },
  secondaryText: { color: '#e7edf5', fontWeight: '700' },
  diagnostics: { backgroundColor: '#101318', borderRadius: 14, borderWidth: 1, borderColor: '#202731', padding: 12, gap: 6 },
  log: { color: '#9eabb9', fontSize: 11, fontFamily: 'monospace', lineHeight: 16 },
});
