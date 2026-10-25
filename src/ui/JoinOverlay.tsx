import { useRef } from 'react';
import { GestureResponderEvent, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { PhoneRole, TouchSample } from '../spatial/Stitch';

export type JoinOverlayTheme = { background: string; accent: string; text: string; muted: string; warn: string; border: string };

const LAB_THEME: JoinOverlayTheme = { background: '#0b0d10', accent: '#80aaff', text: '#f4f6f8', muted: '#8993a1', warn: '#f0b36f', border: '#35404d' };

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
}: {
  role: PhoneRole | null;
  note: string | null;
  status: string;
  onSwipe: (trail: TouchSample[], startedAt: number, endedAt: number) => void;
  onClose: () => void;
  theme?: JoinOverlayTheme;
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
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
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
      <View pointerEvents="none" style={styles.copy}>
        <Text style={[styles.eyebrow, { color: theme.accent }]}>{role ? `PHONE ${role}` : 'NOT CONNECTED'}</Text>
        <Text style={[styles.title, { color: theme.text }]}>Swipe across{'\n'}both screens</Text>
        <Text style={[styles.chevrons, { color: theme.accent }]}>›  ›  ›</Text>
        <Text style={[styles.hint, { color: theme.muted }]}>
          Lay both phones flat with their edges touching. Drag one finger from this screen straight onto the other, without stopping.
        </Text>
        <Text style={[styles.status, { color: theme.text }]}>{status}</Text>
        {note && <Text style={[styles.note, { color: theme.warn }]}>{note}</Text>}
      </View>
      <TouchableOpacity style={[styles.close, { borderColor: theme.border }]} onPress={onClose}>
        <Text style={[styles.closeText, { color: theme.text }]}>Not now</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', paddingHorizontal: 32 },
  copy: { gap: 14 },
  eyebrow: { fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
  title: { fontSize: 38, fontWeight: '800', letterSpacing: -1 },
  chevrons: { fontSize: 34, fontWeight: '800' },
  hint: { fontSize: 14, lineHeight: 20 },
  status: { fontSize: 13, fontWeight: '700' },
  note: { fontSize: 13, fontWeight: '700' },
  close: { position: 'absolute', bottom: 60, alignSelf: 'center', paddingHorizontal: 22, paddingVertical: 12, borderRadius: 14, borderWidth: 1 },
  closeText: { fontWeight: '700' },
});
