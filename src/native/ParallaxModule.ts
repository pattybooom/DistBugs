import { EventSubscription, requireOptionalNativeModule } from 'expo-modules-core';

export type Vector3 = { x: number; y: number; z: number };
export type Quaternion = { x: number; y: number; z: number; w: number };
export type DeviceRole = 'A' | 'B' | 'unknown';
export type MeasurementSource = 'measured' | 'estimated' | 'manual' | 'unknown';
export type ReferenceFrame =
  | 'xMagneticNorthZVertical'
  | 'xTrueNorthZVertical'
  | 'xArbitraryCorrectedZVertical'
  | 'xArbitraryZVertical'
  | 'unavailable';
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'recovering';
export type SpatialSessionState = 'idle' | 'connected' | 'ranging' | 'recovering' | 'invalidated';

export type Peer = { id: string; name: string };

export type ConnectionChangedEvent = {
  state: ConnectionState;
  peerId?: string;
  role?: DeviceRole;
  sessionState?: SpatialSessionState;
};

export type DistanceEvent = {
  peerId?: string;
  role?: DeviceRole;
  source: MeasurementSource;
  distanceCm?: number;
  distanceAvailable: boolean;
  direction?: Vector3;
  directionAvailable: boolean;
  directionValid: boolean;
  horizontalAngleRad?: number;
  horizontalAngleAvailable: boolean;
  timestamp: number;
  measurementTimestamp: number;
  sessionState: SpatialSessionState;
  /** Set in JavaScript on arrival, using this phone's clock; native code never sends it. */
  receivedAt?: number;
};

export type MotionEvent = {
  peerId?: string;
  role: DeviceRole;
  source: 'local' | 'remote';
  attitudeQuaternion?: Quaternion;
  yaw?: number;
  pitch?: number;
  roll?: number;
  gravity?: Vector3;
  angularVelocity?: Vector3;
  referenceFrame: ReferenceFrame;
  commonFrameAvailable: boolean;
  valid: boolean;
  timestamp: number;
  motionTimestamp?: number;
  /** Set in JavaScript on arrival, using this phone's clock; native code never sends it. */
  receivedAt?: number;
};

export type NativeCapabilities = {
  uwbSupported: boolean;
  directionMayBeAvailable: boolean;
  deviceMotionAvailable: boolean;
  magneticNorthAvailable: boolean;
  selectedReferenceFrame: ReferenceFrame;
  cameraAssistanceSupported: boolean;
  cameraAssistance: 'not_used';
};

export type ParallaxError = { code: string; message: string; recoverable: boolean };
export type DiagnosticEvent = { stage: string; message: string; timestamp: number };

type NativeApi = {
  startDiscovery(): Promise<void>;
  stopDiscovery(): Promise<void>;
  connect(peerId: string): Promise<void>;
  disconnect(): Promise<void>;
  startRanging(): Promise<void>;
  stopRanging(): Promise<void>;
  getCapabilities(): Promise<NativeCapabilities>;
  addListener(event: string, listener: (payload: unknown) => void): EventSubscription;
};

const native = requireOptionalNativeModule<NativeApi>('ParallaxModule');
const unavailable = () => Promise.reject(new Error('Parallax native module is not installed'));
const subscribe = <T>(event: string, callback: (value: T) => void): EventSubscription =>
  native?.addListener(event, callback as (payload: unknown) => void) ?? ({ remove: () => undefined } as EventSubscription);

export default {
  startDiscovery: () => native?.startDiscovery() ?? unavailable(),
  stopDiscovery: () => native?.stopDiscovery() ?? Promise.resolve(),
  connect: (peerId: string) => native?.connect(peerId) ?? unavailable(),
  disconnect: () => native?.disconnect() ?? Promise.resolve(),
  startRanging: () => native?.startRanging() ?? unavailable(),
  stopRanging: () => native?.stopRanging() ?? Promise.resolve(),
  getCapabilities: () => native?.getCapabilities() ?? Promise.resolve({
    uwbSupported: false,
    directionMayBeAvailable: false,
    deviceMotionAvailable: false,
    magneticNorthAvailable: false,
    selectedReferenceFrame: 'unavailable' as ReferenceFrame,
    cameraAssistanceSupported: false,
    cameraAssistance: 'not_used' as const,
  }),
  onPeerDiscovered: (cb: (peer: Peer) => void) => subscribe('peerDiscovered', cb),
  onConnectionChanged: (cb: (event: ConnectionChangedEvent | ConnectionState) => void) => subscribe('connectionChanged', cb),
  onDistanceUpdated: (cb: (event: DistanceEvent) => void) => subscribe('distanceUpdated', cb),
  onMotionUpdated: (cb: (event: MotionEvent) => void) => subscribe('motionUpdated', cb),
  onError: (cb: (error: ParallaxError) => void) => subscribe('error', cb),
  onDiagnostic: (cb: (event: DiagnosticEvent) => void) => subscribe('diagnostic', cb),
};
