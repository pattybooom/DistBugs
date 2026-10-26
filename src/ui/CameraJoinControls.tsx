import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { CameraJoinControls as Controls } from './useCameraJoin';

export type CameraJoinTheme = { text: string; muted: string; accent: string; border: string; button: string; buttonText: string; buttonBorder?: string; fontFamily?: string };

const DEFAULT_THEME: CameraJoinTheme = { text: '#f4f6f8', muted: '#b9c4cf', accent: '#8e9ca8', border: '#657888', button: '#293c4c', buttonText: '#e5f1ff' };

export function CameraJoinControls({ camera, role, onScreenMarkers = false, theme = DEFAULT_THEME }: {
  camera: Controls;
  role: 'A' | 'B' | null;
  onScreenMarkers?: boolean;
  theme?: CameraJoinTheme;
}) {
  const font = theme.fontFamily ? { fontFamily: theme.fontFamily } : null;
  const button = [styles.button, { backgroundColor: theme.button }, theme.buttonBorder ? { borderWidth: 1, borderColor: theme.buttonBorder } : null];
  return <View style={styles.panel}>
    <Text style={[styles.title, font, { color: theme.text }]}>MacBook camera</Text>
    <Text style={[styles.text, { color: theme.muted }]}>{role ? (onScreenMarkers ? `PHONE ${role} · shows a tracking square on its screen` : `PHONE ${role} · use its printed marker`) : 'Connect the phones first; the initiator is Phone A.'}</Text>
    <TextInput style={[styles.input, font, { color: theme.text, borderColor: theme.border }]} value={camera.address} onChangeText={camera.setAddress}
      placeholder="ws://192.168.1.20:8765" placeholderTextColor={theme.accent} autoCapitalize="none"
      autoCorrect={false} keyboardType="url" accessibilityLabel="MacBook camera server address" />
    <Text style={[styles.text, font, { color: theme.muted }]}>{camera.status}</Text>
    <TouchableOpacity disabled={!role} style={button} onPress={camera.connect}>
      <Text style={[styles.buttonText, font, { color: theme.buttonText }]}>{camera.enabled ? 'Reconnect camera' : 'Connect camera'}</Text>
    </TouchableOpacity>
    {camera.enabled && <TouchableOpacity style={button} onPress={camera.disconnect}>
      <Text style={[styles.buttonText, font, { color: theme.buttonText }]}>Use swipe instead</Text>
    </TouchableOpacity>}
  </View>;
}

const styles = StyleSheet.create({
  panel: { gap: 8, marginVertical: 8 }, title: { fontSize: 16, fontWeight: '700' },
  text: { fontSize: 12, lineHeight: 17 },
  input: { borderWidth: 1, borderRadius: 8, padding: 10 },
  button: { borderRadius: 8, padding: 12, alignItems: 'center' },
  buttonText: { fontWeight: '700' },
});
