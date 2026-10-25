import { SwipePose, SwipeRole } from './SwipeViewport';

export type SwipeMedia = { kind: 'image' | 'video'; url: string; width: number; height: number; version: number; position?: number };
export type SwipeCameraMessage = {
  protocol: 'distbugs.camera'; version: 1; sessionId: string; sequence: number;
  type: 'layout' | 'layout_invalid'; reason: string;
  coordinateSystem: 'table_cm_x_right_y_up'; phones: SwipePose[];
  media?: SwipeMedia;
};

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function parseSwipeMessage(text: string): SwipeCameraMessage | null {
  if (text.length > 32000) return null;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (value.protocol !== 'distbugs.camera' || value.version !== 1 || typeof value.sessionId !== 'string'
      || !Number.isSafeInteger(value.sequence) || !['layout', 'layout_invalid'].includes(value.type as string)
      || value.coordinateSystem !== 'table_cm_x_right_y_up' || typeof value.reason !== 'string') return null;
    if (value.type === 'layout_invalid') return value as unknown as SwipeCameraMessage;
    if (!Array.isArray(value.phones) || value.phones.length !== 2) return null;
    for (const phone of value.phones as Record<string, unknown>[]) {
      const centre = phone.centreCm as Record<string, unknown>;
      if (!['A', 'B'].includes(phone.role as string) || !centre || !finite(centre.x) || !finite(centre.y)
        || !finite(phone.headingRad) || !finite(phone.widthCm) || !finite(phone.heightCm) || !finite(phone.confidence)
        || phone.confidence < 0 || phone.confidence > 1) return null;
    }
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

  connect(url: string, role: SwipeRole) {
    this.close();
    if (!/^wss?:\/\/[^\s/]+(?::\d+)?\/?$/.test(url)) throw new Error('Use ws://Mac-Wi-Fi-IP:8765');
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      socket.send(JSON.stringify({ protocol: 'distbugs.camera', version: 1, type: 'hello', role, mode: 'swipe' }));
      this.onStatus('Camera connected · tracking phones');
    };
    socket.onmessage = event => {
      if (this.socket !== socket || typeof event.data !== 'string') return;
      const message = parseSwipeMessage(event.data);
      if (!message || (this.session !== null && message.sessionId !== this.session) || message.sequence <= this.sequence) return;
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
