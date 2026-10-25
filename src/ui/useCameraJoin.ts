import { useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CameraConnection } from '../spatial/CameraJoin';
import { Stitch } from '../spatial/Stitch';

export type CameraJoinControls = {
  enabled: boolean; address: string; status: string;
  setAddress: (value: string) => void; connect: () => void; disconnect: () => void;
};

export function useCameraJoin(active: boolean, role: 'A' | 'B' | null, onLayout: (stitch: Stitch) => void, onInvalid: (reason: string) => void): CameraJoinControls {
  const [address, setAddress] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState('Position both phones under the camera');
  const callbacks = useRef({ onLayout, onInvalid });
  callbacks.current = { onLayout, onInvalid };
  const edited = useRef(false);
  useEffect(() => {
    let mounted = true;
    void AsyncStorage.getItem('distbugs.camera.address').then(value => {
      if (mounted && value && !edited.current) setAddress(value);
    }).catch(() => undefined);
    return () => { mounted = false; };
  }, []);
  // Changing the address does not reconnect until the user taps Connect.
  const addressRef = useRef(address);
  addressRef.current = address;
  useEffect(() => {
    if (!active || !enabled || !role) return;
    const client = new CameraConnection(url => new WebSocket(url),
      next => callbacks.current.onLayout(next), reason => callbacks.current.onInvalid(reason), setStatus);
    try { client.connect(addressRef.current.trim(), role); }
    catch (error) { const reason = error instanceof Error ? error.message : String(error); setStatus(reason); callbacks.current.onInvalid(reason); }
    return () => client.close();
  }, [active, enabled, attempt, role]);
  return {
    enabled, address, status,
    setAddress: value => { edited.current = true; setAddress(value); },
    connect: () => {
      callbacks.current.onInvalid('Waiting for a stable camera layout');
      setEnabled(true); setAttempt(n => n + 1);
      void AsyncStorage.setItem('distbugs.camera.address', address.trim()).catch(() => undefined);
    },
    disconnect: () => {
      callbacks.current.onInvalid('Camera disabled · swipe across both screens to join');
      setEnabled(false); setStatus('Position both phones under the camera');
    },
  };
}
