import { useEffect, useRef, useState } from 'react';
import { Dimensions } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ScreenMarker, SwipeCameraConnection, SwipeCameraMessage } from '../spatial/SwipeCamera';
import { ScreenPose } from '../spatial/Stitch';
import { CameraJoinControls } from './useCameraJoin';

/**
 * When the camera stops seeing the phones, their last known positions are kept and the wall facing
 * the other phone stays open this long before crossing closes.
 */
export const TRACKING_LOST_MS = 2000;

export type SwipeTrackingControls = CameraJoinControls & {
  /** The square this phone must draw on its screen for the camera to see it, once the Mac has said. */
  marker: ScreenMarker | null;
};

type Phone = SwipeCameraMessage['phones'][number];

/** The Mac reports the table in cm with +y up and the heading of each screen's top edge. */
const poseOf = (phone: Phone): ScreenPose => ({
  centreMm: { x: phone.centreCm.x * 10, y: phone.centreCm.y * 10 },
  headingRad: phone.headingRad,
  screenSizeCm: { width: phone.widthCm, height: phone.heightCm },
});

/**
 * Follows both phones live through the MacBook camera: each draws a square on its own screen and
 * the Mac streams where the two screens are. `onPoses` fires for every good layout; `onLost` fires
 * once when layouts stop being good for `TRACKING_LOST_MS`, so a dropout doesn't flicker the walls.
 */
export function useSwipeTracking(
  active: boolean,
  role: 'A' | 'B' | null,
  onPoses: (own: ScreenPose, other: ScreenPose) => void,
  onLost: (reason: string) => void,
): SwipeTrackingControls {
  const [address, setAddress] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState('Position both phones under the camera');
  const [marker, setMarker] = useState<ScreenMarker | null>(null);
  const callbacks = useRef({ onPoses, onLost });
  callbacks.current = { onPoses, onLost };
  const edited = useRef(false);
  const addressRef = useRef(address);
  addressRef.current = address;

  useEffect(() => {
    let mounted = true;
    void AsyncStorage.getItem('distbugs.camera.address').then(value => {
      if (mounted && value && !edited.current) setAddress(value);
    }).catch(() => undefined);
    return () => { mounted = false; };
  }, []);

  // Changing the address does not reconnect until the user taps Connect.
  useEffect(() => {
    if (!active || !enabled || !role) return;
    let lastGood = 0;
    let tracking = false;
    const lose = (reason: string) => {
      if (!tracking) return;
      tracking = false;
      callbacks.current.onLost(reason);
    };
    const client = new SwipeCameraConnection(message => {
      const square = message.screenMarkers?.find(item => item.role === role);
      if (square) setMarker(current => current && current.markerId === square.markerId && current.sizeCm === square.sizeCm
        && current.widthCm === square.widthCm && current.offsetCm?.[0] === square.offsetCm?.[0] && current.offsetCm?.[1] === square.offsetCm?.[1] ? current : square);
      if (message.type !== 'layout') return;
      const own = message.phones.find(item => item.role === role);
      const other = message.phones.find(item => item.role !== role);
      if (!own || !other) return;
      lastGood = Date.now();
      tracking = true;
      callbacks.current.onPoses(poseOf(own), poseOf(other));
    }, setStatus);
    const watchdog = setInterval(() => {
      if (tracking && Date.now() - lastGood > TRACKING_LOST_MS) lose('Camera tracking lost · crossings closed');
    }, 100);
    try {
      const { width, height } = Dimensions.get('window');
      client.connect(addressRef.current.trim(), role, width / height);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
    return () => {
      clearInterval(watchdog);
      client.close();
      setMarker(null);
      lose('Camera disconnected · crossings closed');
    };
  }, [active, enabled, attempt, role]);

  return {
    enabled, address, status, marker,
    setAddress: value => { edited.current = true; setAddress(value); },
    connect: () => {
      setEnabled(true); setAttempt(n => n + 1);
      void AsyncStorage.setItem('distbugs.camera.address', address.trim()).catch(() => undefined);
    },
    disconnect: () => {
      setEnabled(false); setStatus('Position both phones under the camera');
    },
  };
}
