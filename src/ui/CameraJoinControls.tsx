import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { CameraJoinControls as Controls } from './useCameraJoin';

export function CameraJoinControls({ camera, role, onScreenMarkers = false }: { camera: Controls; role: 'A' | 'B' | null; onScreenMarkers?: boolean }) {
  return <View style={styles.panel}>
    <Text style={styles.title}>MacBook camera</Text>
    <Text style={styles.text}>{role ? (onScreenMarkers ? `PHONE ${role} · shows a tracking square on its screen` : `PHONE ${role} · use its printed marker`) : 'Connect the phones first; the initiator is Phone A.'}</Text>
    <TextInput style={styles.input} value={camera.address} onChangeText={camera.setAddress}
      placeholder="ws://192.168.1.20:8765" placeholderTextColor="#8e9ca8" autoCapitalize="none"
      autoCorrect={false} keyboardType="url" accessibilityLabel="MacBook camera server address" />
    <Text style={styles.text}>{camera.status}</Text>
    <TouchableOpacity disabled={!role} style={styles.button} onPress={camera.connect}>
      <Text style={styles.buttonText}>{camera.enabled ? 'Reconnect camera' : 'Connect camera'}</Text>
    </TouchableOpacity>
    {camera.enabled && <TouchableOpacity style={styles.button} onPress={camera.disconnect}>
      <Text style={styles.buttonText}>Use swipe instead</Text>
    </TouchableOpacity>}
  </View>;
}

const styles = StyleSheet.create({
  panel: { gap: 8, marginVertical: 8 }, title: { color: '#f4f6f8', fontSize: 16, fontWeight: '700' },
  text: { color: '#b9c4cf', fontSize: 12, lineHeight: 17 },
  input: { color: '#f4f6f8', borderColor: '#657888', borderWidth: 1, borderRadius: 8, padding: 10 },
  button: { backgroundColor: '#293c4c', borderRadius: 8, padding: 12, alignItems: 'center' },
  buttonText: { color: '#e5f1ff', fontWeight: '700' },
});
