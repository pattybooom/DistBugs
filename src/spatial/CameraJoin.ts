import { Stitch } from './Stitch';

export const CAMERA_TIMEOUT_MS = 1200;
export type CameraPhone = {
  role: 'A' | 'B'; markerId: number;
  centreCm: { x: number; y: number }; headingRad: number;
  widthCm: number; heightCm: number; confidence: number;
};
export type CameraMessage = {
  protocol: 'distbugs.camera'; version: 1; sessionId: string; sequence: number;
  type: 'layout' | 'layout_invalid'; reason: string;
  stableMs: number; phones: CameraPhone[];
  coordinateSystem: 'table_cm_x_right_y_up'; edgeGapCm: number | null;
};
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** Validate at the network boundary before geometry reaches React or the simulation. */
export function parseCameraMessage(text: string): CameraMessage | null {
  if (text.length > 32000) return null;
  try {
    const m = JSON.parse(text);
    if (!object(m) || m.protocol !== 'distbugs.camera' || m.version !== 1
      || typeof m.sessionId !== 'string' || !m.sessionId || m.sessionId.length > 100
      || !Number.isSafeInteger(m.sequence) || (m.sequence as number) < 0
      || !['layout', 'layout_invalid'].includes(m.type as string)
      || m.coordinateSystem !== 'table_cm_x_right_y_up'
      || typeof m.reason !== 'string' || m.reason.length > 250) return null;
    if (m.type === 'layout_invalid') return m as CameraMessage;
    if (!finite(m.stableMs) || m.stableMs < 1000 || !finite(m.edgeGapCm) || m.edgeGapCm < -.2
      || !Array.isArray(m.phones) || m.phones.length !== 2) return null;
    const phones = m.phones;
    for (const p of phones) {
      if (!object(p) || !['A', 'B'].includes(p.role as string)
        || !Number.isSafeInteger(p.markerId) || (p.markerId as number) < 0
        || !object(p.centreCm) || !finite(p.centreCm.x) || !finite(p.centreCm.y)
        || Math.abs(p.centreCm.x) > 1000 || Math.abs(p.centreCm.y) > 1000
        || !finite(p.headingRad) || Math.abs(p.headingRad) > Math.PI + .001
        || !finite(p.widthCm) || p.widthCm < 3 || p.widthCm > 30
        || !finite(p.heightCm) || p.heightCm < 3 || p.heightCm > 40
        || !finite(p.confidence) || p.confidence < .6 || p.confidence > 1) return null;
    }
    if (phones[0].role === phones[1].role || phones[0].markerId === phones[1].markerId) return null;
    return m as CameraMessage;
  } catch { return null; }
}

/** Canonical frame: A at the origin with its screen top pointing up; +x right, +y up. */
export function cameraStitch(message: CameraMessage, now = Date.now()): Stitch {
  const a = message.phones.find(p => p.role === 'A')!;
  const b = message.phones.find(p => p.role === 'B')!;
  const turn = Math.PI / 2 - a.headingRad;
  const dx = b.centreCm.x - a.centreCm.x, dy = b.centreCm.y - a.centreCm.y;
  const yaw = Math.atan2(Math.sin(b.headingRad - a.headingRad), Math.cos(b.headingRad - a.headingRad));
  return {
    id: `camera-${message.sessionId}`, createdAt: now, source: 'camera',
    centreB: { xCm: dx * Math.cos(turn) - dy * Math.sin(turn), yCm: dx * Math.sin(turn) + dy * Math.cos(turn) },
    yawOffsetRad: yaw, relativeYawRad: yaw, snapped: false, from: 'A', frameIds: { A: null, B: null },
    screenSizesCm: { A: { width: a.widthCm, height: a.heightCm }, B: { width: b.widthCm, height: b.heightCm } },
  };
}

export type CameraSocket = Pick<WebSocket, 'onopen' | 'onclose' | 'onerror' | 'onmessage' | 'close' | 'send'>;

/** Heartbeats use the receiving phone's clock, so Mac/iPhone clock skew is harmless. */
export class CameraConnection {
  private socket: CameraSocket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastMessage = 0;
  private session: string | null = null;
  private sequence = -1;
  private started = 0;
  private opened = false;
  private lastSent = 0;
  constructor(private createSocket: (url: string) => CameraSocket,
    private onLayout: (stitch: Stitch) => void, private onInvalid: (reason: string) => void,
    private onStatus: (status: string) => void, private clock = Date.now) {}

  connect(url: string, role: 'A' | 'B' = 'A') {
    this.close();
    if (!/^wss?:\/\/[^\s/]+(?::\d+)?\/?$/.test(url)) throw new Error('Use ws://Mac-Wi-Fi-IP:8765');
    this.started = this.clock();
    this.lastMessage = 0; this.session = null; this.sequence = -1;
    this.onStatus('Connecting to camera…');
    const socket = this.createSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.opened = true; this.lastSent = this.clock();
      try { socket.send(JSON.stringify({ protocol: 'distbugs.camera', version: 1, type: 'hello', role })); }
      catch { lost(); return; }
      this.onStatus('Camera connected · position both phones under the camera');
    };
    socket.onmessage = event => {
      if (this.socket !== socket) return;
      const message = typeof event.data === 'string' ? parseCameraMessage(event.data) : null;
      if (!message) { this.onInvalid('Invalid camera layout'); return; }
      if (this.session !== null && message.sessionId !== this.session) {
        this.onInvalid('Camera session changed; reconnect'); this.close(); return;
      }
      if (message.sequence <= this.sequence) return;
      this.session = message.sessionId; this.sequence = message.sequence; this.lastMessage = this.clock();
      if (message.type === 'layout') {
        this.onStatus('Phones aligned');
        this.onLayout(cameraStitch(message, this.clock()));
      } else {
        this.onInvalid(message.reason); this.onStatus(message.reason);
      }
    };
    const lost = () => {
      if (this.socket !== socket) return;
      this.onInvalid('Camera tracking lost · reconnect to the Mac');
      this.onStatus('Camera tracking lost · reconnect to the Mac');
      this.close();
    };
    socket.onclose = lost; socket.onerror = lost;
    this.timer = setInterval(() => {
      if (this.clock() - (this.lastMessage || this.started) > CAMERA_TIMEOUT_MS) {
        this.onInvalid('Camera tracking lost · no recent layout');
        this.onStatus('Camera tracking lost · reconnect to the Mac');
        this.close();
      }
      if (this.socket === socket && this.opened && this.clock() - this.lastSent >= 400) {
        try {
          socket.send(JSON.stringify({ protocol: 'distbugs.camera', version: 1, type: 'heartbeat', role }));
          this.lastSent = this.clock();
        } catch { lost(); }
      }
    }, 200);
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    this.opened = false;
    if (socket) { socket.onopen = null; socket.onclose = null; socket.onerror = null; socket.onmessage = null; socket.close(); }
  }
}
