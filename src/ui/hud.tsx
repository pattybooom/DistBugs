import { ReactNode, useEffect, useRef } from 'react';
import { Animated, Easing, Platform, StyleProp, StyleSheet, Text, TextStyle, TouchableOpacity, View, ViewStyle } from 'react-native';

/** The Spatial Lab and Swipe look: a dark holographic HUD with cyan for Phone A and magenta for Phone B. */
export const HUD = {
  background: '#02050b',
  panel: 'rgba(6, 18, 32, 0.82)',
  panelSolid: '#061220',
  line: 'rgba(63, 246, 255, 0.18)',
  lineStrong: 'rgba(63, 246, 255, 0.55)',
  cyan: '#3ff6ff',
  magenta: '#ff4fd8',
  text: '#e6fbff',
  muted: '#7fa3b8',
  faint: '#3a566a',
  good: '#4dffa6',
  warn: '#ffc24d',
  bad: '#ff5470',
};

export const HUD_FONT = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** A soft neon halo for text; iOS draws it, other platforms just skip it. */
export const glow = (color: string, radius = 10): TextStyle => ({ textShadowColor: color, textShadowRadius: radius, textShadowOffset: { width: 0, height: 0 } });

const CORNER = 12;

/** A panel with targeting-bracket corners and an optional `▸ TITLE ─── tag` header. */
export function HudFrame({ title, tag, tagColor = HUD.muted, accent = HUD.cyan, style, children }: {
  title?: string;
  tag?: string;
  tagColor?: string;
  accent?: string;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  return (
    <View style={[styles.frame, style]}>
      {(['tl', 'tr', 'bl', 'br'] as const).map((corner) => <View key={corner} pointerEvents="none" style={[styles.corner, styles[corner], { borderColor: accent }]} />)}
      {title && (
        <View style={styles.frameHeader}>
          <Text style={[styles.frameTitle, { color: accent }]}>▸ {title}</Text>
          <View style={styles.frameRule} />
          {tag && <Text style={[styles.frameTag, { color: tagColor }]} numberOfLines={1}>{tag}</Text>}
        </View>
      )}
      {children}
    </View>
  );
}

export function HudButton({ label, onPress, variant = 'primary', disabled = false, small = false, color = HUD.cyan, style }: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'ghost';
  disabled?: boolean;
  small?: boolean;
  color?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const tint = disabled ? HUD.faint : variant === 'primary' ? color : HUD.text;
  return (
    <TouchableOpacity
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={[
        styles.button,
        small && styles.buttonSmall,
        { borderColor: disabled ? HUD.faint : variant === 'primary' ? color : HUD.lineStrong },
        variant === 'primary' && !disabled && { backgroundColor: `${color}1f`, shadowColor: color, shadowOpacity: 0.55, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } },
        style,
      ]}
    >
      <Text style={[styles.buttonText, small && styles.buttonTextSmall, { color: tint }, variant === 'primary' && !disabled && glow(color, 6)]}>{label.toUpperCase()}</Text>
    </TouchableOpacity>
  );
}

/** A status light; while `active` a ring keeps pulsing out of it. */
export function PulseDot({ active, color = HUD.good, size = 10 }: { active: boolean; color?: string; size?: number }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) { pulse.setValue(0); return; }
    const loop = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1400, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [active, pulse]);
  const tint = active ? color : HUD.faint;
  return (
    <View style={{ width: size * 3, height: size * 3, alignItems: 'center', justifyContent: 'center' }}>
      {active && <Animated.View style={{
        position: 'absolute', width: size, height: size, borderRadius: size / 2, borderWidth: 1, borderColor: tint,
        opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0] }),
        transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 3] }) }],
      }} />}
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: tint, shadowColor: tint, shadowOpacity: active ? 1 : 0, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } }} />
    </View>
  );
}

/** A faint blueprint grid with a slow scan line sweeping down it. Purely decorative. */
export function GridBackdrop({ spacing = 32, scan = true }: { spacing?: number; scan?: boolean }) {
  const sweep = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!scan) return;
    const loop = Animated.loop(Animated.timing(sweep, { toValue: 1, duration: 6000, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [scan, sweep]);
  const lines = Array.from({ length: 48 }, (_, i) => i * spacing);
  return (
    <View pointerEvents="none" style={styles.backdrop}>
      {lines.map((at) => <View key={`v${at}`} style={[styles.gridLine, { left: at, top: 0, bottom: 0, width: StyleSheet.hairlineWidth }]} />)}
      {lines.map((at) => <View key={`h${at}`} style={[styles.gridLine, { top: at, left: 0, right: 0, height: StyleSheet.hairlineWidth }]} />)}
      {scan && <Animated.View style={[styles.scan, { transform: [{ translateY: sweep.interpolate({ inputRange: [0, 1], outputRange: [-80, 1000] }) }] }]} />}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { backgroundColor: HUD.panel, borderWidth: 1, borderColor: HUD.line, borderRadius: 3, padding: 14, gap: 9 },
  corner: { position: 'absolute', width: CORNER, height: CORNER },
  tl: { top: -1, left: -1, borderTopWidth: 2, borderLeftWidth: 2 },
  tr: { top: -1, right: -1, borderTopWidth: 2, borderRightWidth: 2 },
  bl: { bottom: -1, left: -1, borderBottomWidth: 2, borderLeftWidth: 2 },
  br: { bottom: -1, right: -1, borderBottomWidth: 2, borderRightWidth: 2 },
  frameHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  frameTitle: { fontFamily: HUD_FONT, fontSize: 10, fontWeight: '800', letterSpacing: 2 },
  frameRule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: HUD.lineStrong },
  frameTag: { fontFamily: HUD_FONT, fontSize: 9, fontWeight: '700', letterSpacing: 1, maxWidth: '55%' },
  button: { borderWidth: 1, borderRadius: 3, paddingVertical: 15, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  buttonSmall: { paddingVertical: 8, paddingHorizontal: 12 },
  buttonText: { fontFamily: HUD_FONT, fontSize: 12, fontWeight: '800', letterSpacing: 2 },
  buttonTextSmall: { fontSize: 10, letterSpacing: 1.5 },
  backdrop: { ...StyleSheet.absoluteFill, overflow: 'hidden' },
  gridLine: { position: 'absolute', backgroundColor: 'rgba(63, 246, 255, 0.07)' },
  scan: { position: 'absolute', left: 0, right: 0, height: 80, backgroundColor: 'rgba(63, 246, 255, 0.035)', borderBottomWidth: 1, borderBottomColor: 'rgba(63, 246, 255, 0.12)' },
});
