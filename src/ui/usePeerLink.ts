import { useEffect, useState } from 'react';
import ParallaxModule, { ConnectionState, Peer } from '../native/ParallaxModule';

export type PeerLinkStatus = 'off' | 'searching' | 'connecting' | 'connected';

export type PeerLink = {
  status: PeerLinkStatus;
  peers: Peer[];
  /** Phone A is whichever phone started the connection; null until connected. */
  role: 'A' | 'B' | null;
  error: string | null;
  start: () => void;
  stop: () => void;
  connect: (peerId: string) => void;
};

const CONNECTION_STATES: ConnectionState[] = ['disconnected', 'connecting', 'connected', 'recovering'];

const readConnectionState = (value: unknown): ConnectionState | null => {
  const candidate = typeof value === 'string' ? value : value && typeof value === 'object' && 'state' in value ? (value as { state?: unknown }).state : null;
  return CONNECTION_STATES.includes(candidate as ConnectionState) ? candidate as ConnectionState : null;
};

const readRole = (value: unknown): 'A' | 'B' | null => {
  const role = value && typeof value === 'object' && 'role' in value ? (value as { role?: unknown }).role : null;
  return role === 'A' || role === 'B' ? role : null;
};

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Links this phone to the other one over Multipeer, the same way the DistBugs Link does. Being
 * linked also starts the phone's motion sensor, which is what lets tracking squares hide while still.
 */
export function usePeerLink(): PeerLink {
  const [enabled, setEnabled] = useState(false);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [connection, setConnection] = useState<ConnectionState>('disconnected');
  const [role, setRole] = useState<'A' | 'B' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    setError(null);
    const subscriptions = [
      ParallaxModule.onPeerDiscovered(peer => {
        setPeers(current => current.some(item => item.id === peer.id) ? current : [...current, peer]);
      }),
      ParallaxModule.onConnectionChanged(event => {
        const state = readConnectionState(event);
        if (!state) return;
        setConnection(state);
        setRole(state === 'disconnected' ? null : readRole(event));
      }),
      ParallaxModule.onError(problem => setError(problem.message)),
    ];
    ParallaxModule.startDiscovery().catch(problem => setError(`Could not look for the other phone (${describeError(problem)})`));
    return () => {
      subscriptions.forEach(subscription => subscription.remove());
      void ParallaxModule.stopDiscovery();
      void ParallaxModule.disconnect().catch(() => undefined);
      setPeers([]);
      setConnection('disconnected');
      setRole(null);
    };
  }, [enabled]);

  const connected = connection === 'connected' || connection === 'recovering';
  return {
    status: !enabled ? 'off' : connected ? 'connected' : connection === 'connecting' ? 'connecting' : 'searching',
    peers,
    role: connected ? role : null,
    error,
    start: () => setEnabled(true),
    stop: () => setEnabled(false),
    connect: peerId => {
      ParallaxModule.connect(peerId).catch(problem => setError(`Could not connect (${describeError(problem)})`));
    },
  };
}
