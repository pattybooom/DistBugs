import { SwipePose, SwipeRole } from './SwipeViewport';

export type SwipeMedia = { kind: 'image' | 'video'; url: string; width: number; height: number; version: number; position?: number; startedAtMs?: number };
export type ScreenMarker = { role: SwipeRole; markerId: number; widthCm: number; heightCm: number; sizeCm: number; cells: number[][]; offsetCm?: [number, number] };
export type SwipeArea = { widthCm: number; heightCm: number };
export type SwipeCameraMessage = {
  protocol: 'distbugs.camera'; version: 1; sessionId: string; sequence: number;
  type: 'layout' | 'layout_invalid'; reason: string;
  coordinateSystem: 'table_cm_x_right_y_up'; phones: SwipePose[];
  media?: SwipeMedia;
  screenMarkers?: ScreenMarker[];
  area?: SwipeArea;
  calibrationMode?: 'manual' | 'board' | 'screen';
  timestampMs?: number;
};

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): value is number => finite(value) && value > 0 && value <= 10000;

export function parseSwipeMessage(text: string): SwipeCameraMessage | null {
  if (text.length > 32000) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!record(value) || value.protocol !== 'distbugs.camera' || value.version !== 1 || typeof value.sessionId !== 'string'
      || value.sessionId.length < 1 || value.sessionId.length > 100 || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0 || !['layout', 'layout_invalid'].includes(value.type as string)
      || value.coordinateSystem !== 'table_cm_x_right_y_up' || typeof value.reason !== 'string') return null;
    if (value.timestampMs !== undefined && !finite(value.timestampMs)) return null;
    if (value.media !== undefined) {
      const m = value.media;
      if (!record(m) || !['image', 'video'].includes(m.kind as string) || typeof m.url !== 'string'
        || !/^https?:\/\/[^\s]+$/.test(m.url) || !positive(m.width) || !positive(m.height)
        || !Number.isSafeInteger(m.version) || (m.position !== undefined && (!finite(m.position) || m.position < 0))
        || (m.startedAtMs !== undefined && !finite(m.startedAtMs))) return null;
    }
    if (value.area !== undefined && (!record(value.area) || !positive(value.area.widthCm) || !positive(value.area.heightCm))) return null;
    if (value.screenMarkers !== undefined) {
      if (!Array.isArray(value.screenMarkers) || value.screenMarkers.length !== 2) return null;
      for (const marker of value.screenMarkers) {
        if (!record(marker) || !['A', 'B'].includes(marker.role as string) || !Number.isSafeInteger(marker.markerId)
          || !positive(marker.widthCm) || !positive(marker.heightCm) || !positive(marker.sizeCm)
          || marker.sizeCm > marker.widthCm * .75 || marker.sizeCm > marker.heightCm * .75
          || (marker.offsetCm !== undefined && (!Array.isArray(marker.offsetCm) || marker.offsetCm.length !== 2 || !marker.offsetCm.every(finite)
            || Math.abs(marker.offsetCm[0]) > marker.widthCm / 2 || Math.abs(marker.offsetCm[1]) > marker.heightCm / 2))
          || !Array.isArray(marker.cells) || marker.cells.length !== 6
          || !marker.cells.every((row: unknown) => Array.isArray(row) && row.length === 6 && row.every(cell => cell === 0 || cell === 1))) return null;
      }
      if (value.screenMarkers[0].role === value.screenMarkers[1].role || value.screenMarkers[0].markerId === value.screenMarkers[1].markerId) return null;
    }
    if (value.type === 'layout_invalid') return value as unknown as SwipeCameraMessage;
    if (!Array.isArray(value.phones) || value.phones.length !== 2) return null;
    for (const phone of value.phones) {
      if (!record(phone) || !['A', 'B'].includes(phone.role as string) || !record(phone.centreCm)
        || !finite(phone.centreCm.x) || !finite(phone.centreCm.y) || Math.abs(phone.centreCm.x) > 1000 || Math.abs(phone.centreCm.y) > 1000
        || !finite(phone.headingRad) || Math.abs(phone.headingRad) > Math.PI + .001 || !positive(phone.widthCm) || !positive(phone.heightCm) || !finite(phone.confidence)
        || phone.confidence < .1 || phone.confidence > 1) return null;
    }
    if (value.phones[0].role === value.phones[1].role) return null;
    return value as unknown as SwipeCameraMessage;
  } catch { return null; }
}

export class SwipeCameraConnection {
  private socket: WebSocket | null = null;
  private sequence = -1;
  private session: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastMessage = 0;

  constructor(private onMessage: (message: SwipeCameraMessage) => void, private onStatus: (status: string) => void, private now = Date.now) {}

  connect(url: string, role: SwipeRole, screenAspect = 1) {
    this.close();
    if (!/^wss?:\/\/[^\s/]+(?::\d+)?\/?$/.test(url)) throw new Error('Use ws://Mac-Wi-Fi-IP:8765');
    this.sequence = -1; this.session = null; this.lastMessage = this.now();
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      socket.send(JSON.stringify({ protocol: 'distbugs.camera', version: 1, type: 'hello', role, mode: 'swipe', markerOnScreen: true, screenAspect }));
      this.onStatus('Camera connected · tracking phones');
    };
    socket.onmessage = event => {
      if (this.socket !== socket || typeof event.data !== 'string') return;
      const message = parseSwipeMessage(event.data);
      if (!message) return;
      if (this.session !== null && message.sessionId !== this.session) { this.onStatus('Mac restarted · reconnect camera'); this.close(); return; }
      if (message.sequence <= this.sequence) return;
      this.session = message.sessionId; this.sequence = message.sequence; this.lastMessage = this.now();
      this.onMessage(message);
      this.onStatus(message.type === 'layout' ? 'Tracking phones' : message.reason);
    };
    const lost = () => { if (this.socket === socket) { this.onStatus('Tracking lost · reconnect to the Mac'); this.close(); } };
    socket.onerror = lost; socket.onclose = lost;
    this.timer = setInterval(() => {
      if (this.now() - this.lastMessage > 1500) this.onStatus('Waiting for live camera layout');
      if (this.socket === socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ protocol: 'distbugs.camera', version: 1, type: 'heartbeat', role }));
    }, 400);
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const socket = this.socket; this.socket = null;
    if (socket) { socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null; socket.close(); }
  }
}
