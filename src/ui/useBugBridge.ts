import { useCallback, useEffect, useRef, useState } from 'react';
import { Dimensions } from 'react-native';
import {
  CrossingLink,
  crossingLanding,
  CrossingMessage,
  crossingPoses,
  FIXED_JOIN_HEADING,
  GateSegment,
  HabitatLayout,
  openGates,
  parseCrossingMessage,
  serializeCrossingMessage,
} from '../game/crossing';
import { Bug } from '../game/types';
import ParallaxModule, { ConnectionState, Peer } from '../native/ParallaxModule';
import {
  classifySwipe,
  computeStitch,
  matchSwipes,
  parseStitchMessage,
  PhoneRole,
  serializeStitchMessage,
  Stitch,
  StitchMessage,
  SwipeReport,
  TouchSample,
} from '../spatial/Stitch';
import { DepartedEvent, Ecosystem } from './useEcosystem';

/** A bug the other phone hasn't confirmed by now comes back. */
const TRANSFER_TIMEOUT_MS = 4000;
/** Swipe halves older than this can no longer pair with a new one. */
const SWIPE_REPORT_LIFETIME_MS = 3000;

export type LinkStatus = 'off' | 'searching' | 'connecting' | 'connected' | 'joined';

export type BugBridge = {
  status: LinkStatus;
  role: PhoneRole | null;
  peers: Peer[];
  joinOpen: boolean;
  joinNote: string | null;
  joinStatus: string;
  /** Open stretches of this habitat's walls, for drawing. */
  gates: GateSegment[];
  enable: () => void;
  disable: () => void;
  connect: (peerId: string) => void;
  requestJoin: () => void;
  closeJoin: () => void;
  handleSwipe: (trail: TouchSample[], startedAt: number, endedAt: number) => void;
  setOwnLayout: (layout: HabitatLayout | null) => void;
};

type Pending = { bug: Bug; at: { x: number; y: number }; heading: number; sentAt: number };

const CONNECTION_STATES: ConnectionState[] = ['disconnected', 'connecting', 'connected', 'recovering'];

const readConnectionState = (value: unknown): ConnectionState | null => {
  const candidate = typeof value === 'string' ? value : value && typeof value === 'object' && 'state' in value ? (value as { state?: unknown }).state : null;
  return CONNECTION_STATES.includes(candidate as ConnectionState) ? candidate as ConnectionState : null;
};

const readRole = (value: unknown): PhoneRole | null => {
  const role = value && typeof value === 'object' && 'role' in value ? (value as { role?: unknown }).role : null;
  return role === 'A' || role === 'B' ? role : null;
};

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Links this phone's ecosystem to another phone's. The phones connect over Multipeer, are
 * joined by one swipe across both screens, and then bugs that walk off the touching edge are
 * handed over. A bug stays this phone's until the other phone confirms it took it; if it says
 * no, never answers, or the connection drops, the bug walks back in where it left.
 */
export function useBugBridge(ecosystem: Ecosystem, visible: boolean): BugBridge {
  const [enabled, setEnabled] = useState(false);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [connection, setConnection] = useState<ConnectionState>('disconnected');
  const [role, setRole] = useState<PhoneRole | null>(null);
  const [stitch, setStitch] = useState<Stitch | null>(null);
  const [ownLayout, setOwnLayoutState] = useState<HabitatLayout | null>(null);
  const [otherLayout, setOtherLayout] = useState<HabitatLayout | null>(null);
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinNote, setJoinNote] = useState<string | null>(null);
  const [gates, setGates] = useState<GateSegment[]>([]);

  // Native callbacks are subscribed once per session, so they read the latest values through refs.
  const ecosystemRef = useRef(ecosystem);
  ecosystemRef.current = ecosystem;
  const roleRef = useRef<PhoneRole | null>(null);
  const linkRef = useRef<CrossingLink | null>(null);
  const ownLayoutRef = useRef<HabitatLayout | null>(null);
  const pending = useRef(new Map<string, Pending>());
  const swipeReports = useRef<SwipeReport[]>([]);
  const nextTransfer = useRef(1);

  const active = enabled && visible;

  const send = (message: StitchMessage | CrossingMessage, serialized: string) =>
    ParallaxModule.sendPeerMessage(serialized).catch((error) => {
      ecosystemRef.current.note(`Link: could not send ${message.type} (${describeError(error)})`);
      throw error;
    });
  const sendStitch = (message: StitchMessage) => send(message, serializeStitchMessage(message)).catch(() => undefined);
  const sendCrossing = (message: CrossingMessage) => send(message, serializeCrossingMessage(message));

  /** Walks a bug whose crossing failed back in. */
  const bounce = (transferId: string) => {
    const item = pending.current.get(transferId);
    if (!item) return;
    pending.current.delete(transferId);
    ecosystemRef.current.returnBug(item.bug, item.at, item.heading);
  };

  const bounceAll = () => [...pending.current.keys()].forEach(bounce);

  const applyStitch = (next: Stitch | null) => {
    setStitch(next);
    if (next) {
      setJoinOpen(false);
      setJoinNote(null);
      ecosystemRef.current.note('Phones joined: bugs can cross where the habitats meet', 'travel');
    }
  };

  const addSwipeReport = (report: SwipeReport) => {
    const at = Date.now();
    swipeReports.current = [...swipeReports.current.filter((item) => at - item.atMs < SWIPE_REPORT_LIFETIME_MS), report];
    const match = matchSwipes(swipeReports.current);
    if (!match) return;
    swipeReports.current = [];
    const result = computeStitch(match.exit, match.entry, at);
    if (!result.stitch) {
      setJoinNote(`Join failed: ${result.reason}`);
      return;
    }
    applyStitch(result.stitch);
    void sendStitch({ type: 'state', state: { stitch: result.stitch, status: 'joined' } });
  };

  const handleMessage = (text: string) => {
    const stitchMessage = parseStitchMessage(text);
    if (stitchMessage) {
      if (stitchMessage.type === 'swipe') {
        // Phone A pairs the halves; the other phone says how long ago its finger crossed.
        if (roleRef.current === 'A') addSwipeReport({ ...stitchMessage.report, atMs: Date.now() - stitchMessage.ageMs });
      } else if (stitchMessage.type === 'state') {
        if (roleRef.current === 'B') applyStitch(stitchMessage.state?.status === 'joined' ? stitchMessage.state.stitch : null);
      } else {
        setJoinNote(null);
        setJoinOpen(true);
      }
      return;
    }
    const message = parseCrossingMessage(text);
    if (!message) return;
    if (message.type === 'layout') {
      setOtherLayout(message.layout);
    } else if (message.type === 'bug') {
      const accepted = ecosystemRef.current.admit(message.bug, message.landing);
      sendCrossing({ type: 'bug-ack', transferId: message.transferId, accepted }).catch(() => undefined);
    } else {
      const item = pending.current.get(message.transferId);
      if (!item) return;
      if (message.accepted) {
        pending.current.delete(message.transferId);
        ecosystemRef.current.note(`${item.bug.name} crossed to the other phone`, 'travel');
      } else {
        bounce(message.transferId);
      }
    }
  };

  // Reads everything through refs, so the walls never need reopening for it.
  const sendBug = useCallback((event: DepartedEvent) => {
    const at = { x: event.x, y: event.y };
    const link = linkRef.current;
    const landing = link ? crossingLanding(link, at, event.edge, event.bug.heading) : null;
    if (!landing) {
      ecosystemRef.current.returnBug(event.bug, at, event.bug.heading);
      return;
    }
    const transferId = `${Date.now()}-${nextTransfer.current++}`;
    pending.current.set(transferId, { bug: event.bug, at, heading: event.bug.heading, sentAt: Date.now() });
    sendCrossing({ type: 'bug', transferId, bug: event.bug, landing }).catch(() => bounce(transferId));
  }, []);

  useEffect(() => {
    if (!active) return;
    const subscriptions = [
      ParallaxModule.onPeerDiscovered((peer) => {
        setPeers((current) => current.some((item) => item.id === peer.id) ? current : [...current, peer]);
      }),
      ParallaxModule.onConnectionChanged((event) => {
        const state = readConnectionState(event);
        if (!state) return;
        const nextRole = readRole(event);
        setConnection(state);
        roleRef.current = nextRole;
        setRole(nextRole);
        if (state === 'connected') {
          sendCrossing({ type: 'layout', layout: ownLayoutRef.current }).catch(() => undefined);
          setJoinOpen(true);
        }
        if (state === 'disconnected') {
          bounceAll();
          swipeReports.current = [];
          setStitch(null);
          setOtherLayout(null);
          setJoinOpen(false);
        }
      }),
      ParallaxModule.onPeerMessage((event) => handleMessage(event.message)),
      ParallaxModule.onError((error) => ecosystemRef.current.note(`Link error: ${error.message}`)),
    ];
    ParallaxModule.startDiscovery().catch((error) => ecosystemRef.current.note(`Link: discovery failed (${describeError(error)})`));
    const timeouts = setInterval(() => {
      const now = Date.now();
      pending.current.forEach((item, transferId) => {
        if (now - item.sentAt > TRANSFER_TIMEOUT_MS) bounce(transferId);
      });
    }, 1000);

    return () => {
      clearInterval(timeouts);
      subscriptions.forEach((subscription) => subscription.remove());
      bounceAll();
      void ParallaxModule.stopDiscovery();
      void ParallaxModule.disconnect().catch(() => undefined);
      roleRef.current = null;
      swipeReports.current = [];
      setPeers([]);
      setConnection('disconnected');
      setRole(null);
      setStitch(null);
      setOtherLayout(null);
      setJoinOpen(false);
    };
    // One native session per activation; the handlers read everything else through refs.
  }, [active]);

  // Opens the walls whenever both phones' layouts and the join are known.
  useEffect(() => {
    const link = stitch && role && ownLayout && otherLayout ? { ...crossingPoses(stitch, role), ownLayout, otherLayout } : null;
    linkRef.current = link;
    if (!link) {
      ecosystem.setCrossing(null, null);
      setGates([]);
      return;
    }
    ecosystem.setCrossing((point, edge) => crossingLanding(link, point, edge, 0) != null, sendBug);
    setGates(openGates(link));
  }, [stitch, role, ownLayout, otherLayout, ecosystem.setCrossing, sendBug]);

  // Tells the other phone whenever this habitat moves on screen.
  useEffect(() => {
    if (connection === 'connected') sendCrossing({ type: 'layout', layout: ownLayout }).catch(() => undefined);
  }, [ownLayout, connection]);

  const setOwnLayout = useCallback((layout: HabitatLayout | null) => {
    if (JSON.stringify(layout) === JSON.stringify(ownLayoutRef.current)) return;
    ownLayoutRef.current = layout;
    setOwnLayoutState(layout);
  }, []);

  const handleSwipe = (trail: TouchSample[], startedAt: number, endedAt: number) => {
    const current = roleRef.current;
    if (!current) {
      setJoinNote('Connect the phones first');
      return;
    }
    const { width, height } = Dimensions.get('window');
    const { exit, entry } = classifySwipe(trail, { widthPt: width, heightPt: height });
    // Motion isn't used here: both phones claim the same heading, so the join is in Phone A's screen frame.
    const base = { role: current, headingRad: FIXED_JOIN_HEADING, frameId: null };
    const reports: SwipeReport[] = [
      ...(exit ? [{ ...exit, ...base, kind: 'exit' as const, atMs: endedAt }] : []),
      ...(entry ? [{ ...entry, ...base, kind: 'entry' as const, atMs: startedAt }] : []),
    ];
    setJoinNote(reports.length === 0
      ? 'Not counted: start or finish on an edge, and keep the finger moving'
      : reports.map((report) => report.kind === 'exit' ? `Left across the ${report.edge} edge` : `Arrived across the ${report.edge} edge`).join(' · '));
    if (current === 'A') reports.forEach(addSwipeReport);
    else reports.forEach(({ atMs, ...report }) => void sendStitch({ type: 'swipe', report, ageMs: Date.now() - atMs }));
  };

  const connected = connection === 'connected' || connection === 'recovering';
  const status: LinkStatus = !enabled ? 'off' : connected ? (stitch ? 'joined' : 'connected') : connection === 'connecting' ? 'connecting' : 'searching';
  const joinStatus = !role
    ? 'Waiting for the connection'
    : stitch
      ? 'Joined'
      : role === 'A' ? 'Waiting for a swipe' : 'Waiting for a swipe · Phone A pairs them';

  return {
    status,
    role,
    peers,
    joinOpen,
    joinNote,
    joinStatus,
    gates,
    enable: () => setEnabled(true),
    disable: () => setEnabled(false),
    connect: (peerId) => {
      ParallaxModule.connect(peerId).catch((error) => ecosystem.note(`Link: could not connect (${describeError(error)})`));
    },
    requestJoin: () => {
      setJoinNote(null);
      setJoinOpen(true);
      void sendStitch({ type: 'join' });
    },
    closeJoin: () => setJoinOpen(false),
    handleSwipe,
    setOwnLayout,
  };
}
