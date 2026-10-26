import { useRef } from 'react';
import { GestureResponderEvent, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { PhoneRole, TouchSample } from '../spatial/Stitch';
import { CameraJoinControls as CameraControls } from './useCameraJoin';
import { CameraJoinControls } from './CameraJoinControls';
import { glow, GridBackdrop, HUD, HUD_FONT } from './hud';

export type JoinOverlayTheme = {
  background: string; accent: string; text: string; muted: string; warn: string; border: string;
  /** The Spatial Lab's HUD styling: monospace type, neon glow and a grid backdrop. */
  hud?: boolean;
};

const LAB_THEME: JoinOverlayTheme = { background: HUD.background, accent: HUD.cyan, text: HUD.text, muted: HUD.muted, warn: HUD.warn, border: HUD.lineStrong, hud: true };
const HUD_CAMERA_THEME = { text: HUD.text, muted: HUD.muted, accent: HUD.faint, border: HUD.lineStrong, button: 'rgba(63, 246, 255, 0.12)', buttonText: HUD.cyan, buttonBorder: HUD.cyan, fontFamily: HUD_FONT };

/**
 * Full-screen catcher for the join swipe. Both phones show it at once; the finger's trail on
 * each screen is read for where it left or arrived, and Phone A pairs the two halves.
 */
export function JoinOverlay({
  role,
  note,
  status,
  onSwipe,
  onClose,
  theme = LAB_THEME,
  camera,
  onScreenMarkers = false,
}: {
  role: PhoneRole | null;
  note: string | null;
  status: string;
  onSwipe: (trail: TouchSample[], startedAt: number, endedAt: number) => void;
  onClose: () => void;
  theme?: JoinOverlayTheme;
  camera?: CameraControls;
  /** The phones draw their own tracking squares; no printed markers or reference board. */
  onScreenMarkers?: boolean;
}) {
  const trail = useRef<TouchSample[]>([]);
  const startedAt = useRef(0);
  const sample = (event: GestureResponderEvent): TouchSample => ({
    xPt: event.nativeEvent.pageX,
    yPt: event.nativeEvent.pageY,
    tMs: event.nativeEvent.timestamp,
  });
  const finish = () => {
    const samples = trail.current;
    trail.current = [];
    if (samples.length > 1) onSwipe(samples, startedAt.current, Date.now());
  };

  return (
    <View
      style={[styles.overlay, { backgroundColor: theme.background }]}
      onStartShouldSetResponder={() => !camera?.enabled}
      onMoveShouldSetResponder={() => !camera?.enabled}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(event) => {
        startedAt.current = Date.now();
        trail.current = [sample(event)];
      }}
      onResponderMove={(event) => { trail.current.push(sample(event)); }}
      onResponderRelease={(event) => {
        trail.current.push(sample(event));
        finish();
      }}
      onResponderTerminate={finish}
    >
      {theme.hud && <GridBackdrop />}
      <ScrollView scrollEnabled={!!camera?.enabled} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.copy}>
        <Text style={[styles.eyebrow, { color: theme.accent }, theme.hud && styles.hudMono]}>{role ? `${theme.hud ? '◉ ' : ''}PHONE ${role}` : 'NOT CONNECTED'}</Text>
        <Text style={[styles.title, { color: theme.text }, theme.hud && [styles.hudTitle, glow(theme.accent, 14)]]}>
          {camera?.enabled ? 'Position both phones\nunder the camera' : 'Swipe across\nboth screens'}
        </Text>
        {camera && <CameraJoinControls camera={camera} role={role} onScreenMarkers={onScreenMarkers} theme={theme.hud ? HUD_CAMERA_THEME : undefined} />}
        <Text style={[styles.hint, { color: theme.muted }]}>
          {camera?.enabled ? (onScreenMarkers ? 'Lay both phones flat under the camera and keep each tracking square visible. Bugs cross on the side that faces the other phone.' : 'Keep both phone markers and all four reference markers visible. Hold still for one second to join automatically.') : 'Swipe fallback: lay both phones flat with their edges touching. Drag one finger from this screen straight onto the other, without stopping.'}
        </Text>
        <Text style={[styles.status, { color: theme.text }, theme.hud && styles.hudMono]}>{theme.hud ? `> ${status}` : status}</Text>
        {note && <Text style={[styles.note, { color: theme.warn }, theme.hud && styles.hudMono]}>{note}</Text>}
      </ScrollView>
      <TouchableOpacity style={[styles.close, { borderColor: theme.border }, theme.hud && styles.hudClose]} onPress={onClose}>
        <Text style={[styles.closeText, { color: theme.text }, theme.hud && styles.hudMono]}>{theme.hud ? 'NOT NOW' : 'Not now'}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', paddingHorizontal: 32, paddingTop: 64, paddingBottom: 120 },
  copy: { gap: 14, flexGrow: 1, justifyContent: 'center' },
  eyebrow: { fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
  title: { fontSize: 38, fontWeight: '800', letterSpacing: -1 },
  chevrons: { fontSize: 34, fontWeight: '800' },
  hint: { fontSize: 14, lineHeight: 20 },
  status: { fontSize: 13, fontWeight: '700' },
  note: { fontSize: 13, fontWeight: '700' },
  close: { position: 'absolute', bottom: 60, alignSelf: 'center', paddingHorizontal: 22, paddingVertical: 12, borderRadius: 14, borderWidth: 1 },
  closeText: { fontWeight: '700' },
  hudMono: { fontFamily: HUD_FONT, letterSpacing: 1.5 },
  hudTitle: { fontFamily: HUD_FONT, fontSize: 30, letterSpacing: 0, textTransform: 'uppercase' },
  hudClose: { borderRadius: 3 },
});
