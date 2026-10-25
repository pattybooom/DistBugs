import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { ScreenMarker } from '../spatial/SwipeCamera';

/**
 * The black-and-white square the MacBook camera tracks, drawn at the size and place the Mac asked
 * for. A white quiet margin keeps the content behind it from merging into the marker border.
 */
export const TrackingSquare = memo(function TrackingSquare({ marker, width, height }: { marker: ScreenMarker; width: number; height: number }) {
  const scale = width / marker.widthCm;
  const side = marker.sizeCm * scale;
  const margin = side / 6;
  const [offsetX, offsetY] = marker.offsetCm ?? [0, 0];
  return <View pointerEvents="none" accessibilityLabel={`Phone ${marker.role} tracking square ${marker.markerId}`}
    style={[styles.margin, { left: width / 2 + offsetX * scale - side / 2 - margin, top: height / 2 - offsetY * scale - side / 2 - margin, padding: margin }]}>
    {marker.cells.map((row, y) => <View key={y} style={styles.row}>
      {row.map((cell, x) => <View key={x} style={{ width: side / 6, height: side / 6, backgroundColor: cell ? '#fff' : '#000' }} />)}
    </View>)}
  </View>;
});

const styles = StyleSheet.create({
  margin: { position: 'absolute', backgroundColor: '#fff' },
  row: { flexDirection: 'row' },
});
