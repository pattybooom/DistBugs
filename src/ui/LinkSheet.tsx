import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { COLORS, PIXEL_FONT } from './theme';
import { BugBridge } from './useBugBridge';
import { CameraJoinControls } from './CameraJoinControls';

const STATUS_TEXT: Record<BugBridge['status'], string> = {
  off: 'Off',
  searching: 'Looking for the other phone…',
  connecting: 'Connecting…',
  connected: 'Connected · not joined yet',
  joined: 'Joined · bugs can cross',
};

/** Connects to the other phone, joins the two habitats, and turns the link off again. */
export function LinkSheet({ bridge, onClose }: { bridge: BugBridge; onClose: () => void }) {
  const connected = bridge.status === 'connected' || bridge.status === 'joined';
  return (
    <View style={styles.sheet}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>Link two phones</Text>
        <TouchableOpacity onPress={onClose} hitSlop={10}><Text style={styles.close}>✕</Text></TouchableOpacity>
      </View>
      <Text style={styles.hint}>
        Open Link on both phones and connect from one. Position both phones under the calibrated MacBook camera.
        Bugs that walk off the touching edge cross to the other phone.
      </Text>
      <Text style={[styles.status, bridge.status === 'joined' && styles.statusJoined]}>
        {STATUS_TEXT[bridge.status]}{bridge.role ? ` · PHONE ${bridge.role}` : ''}
      </Text>

      {bridge.status === 'off' && (
        <TouchableOpacity style={styles.primary} onPress={bridge.enable}>
          <Text style={styles.primaryText}>Start linking</Text>
        </TouchableOpacity>
      )}

      {bridge.status !== 'off' && !connected && (
        <View style={styles.peers}>
          {bridge.peers.length === 0
            ? <Text style={styles.muted}>No phones found yet. Open Link on the other phone too.</Text>
            : bridge.peers.map((peer) => (
              <TouchableOpacity key={peer.id} style={styles.peer} onPress={() => bridge.connect(peer.id)}>
                <Text style={styles.peerName}>{peer.name}</Text>
                <Text style={styles.peerAction}>CONNECT</Text>
              </TouchableOpacity>
            ))}
        </View>
      )}

      {connected && (
        <CameraJoinControls camera={bridge.camera} role={bridge.role} />
      )}

      {connected && !bridge.camera.enabled && (
        <TouchableOpacity style={styles.primary} onPress={bridge.requestJoin}>
          <Text style={styles.primaryText}>{bridge.status === 'joined' ? 'Join again with swipe' : 'Swipe fallback'}</Text>
        </TouchableOpacity>
      )}

      {bridge.status !== 'off' && (
        <TouchableOpacity style={styles.secondary} onPress={bridge.disable}>
          <Text style={styles.secondaryText}>Stop linking</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { position: 'absolute', left: 10, right: 10, bottom: 10, backgroundColor: 'rgba(26, 22, 18, 0.98)', borderRadius: 18, borderWidth: 2, borderColor: COLORS.travel, padding: 16, gap: 12 },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { color: COLORS.text, fontSize: 20, fontWeight: '900' },
  close: { color: COLORS.muted, fontSize: 18, fontWeight: '900' },
  hint: { color: COLORS.muted, fontSize: 13, lineHeight: 18 },
  status: { color: COLORS.accent, fontSize: 12, fontWeight: '800', fontFamily: PIXEL_FONT },
  statusJoined: { color: COLORS.travel },
  muted: { color: COLORS.faint, fontSize: 12 },
  peers: { gap: 8 },
  peer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: COLORS.soil, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12 },
  peerName: { color: COLORS.text, fontSize: 15, fontWeight: '700' },
  peerAction: { color: COLORS.travel, fontSize: 10, fontWeight: '900', letterSpacing: 1, fontFamily: PIXEL_FONT },
  primary: { backgroundColor: COLORS.travel, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  primaryText: { color: '#10202c', fontWeight: '900' },
  secondary: { borderRadius: 14, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: COLORS.panelBorder },
  secondaryText: { color: COLORS.text, fontWeight: '700' },
});
