import { parseSwipeMessage, SwipeCameraConnection } from '../src/spatial/SwipeCamera';

const frame = () => ({ protocol: 'distbugs.camera', version: 1, sessionId: 'test', sequence: 1,
  type: 'layout', reason: 'Tracking phones', coordinateSystem: 'table_cm_x_right_y_up',
  phones: ['A', 'B'].map(role => ({ role, centreCm: { x: 10, y: 9 }, headingRad: Math.PI / 2, widthCm: 7, heightCm: 15, confidence: 1 })),
  screenMarkers: ['A', 'B'].map((role, markerId) => ({ role, markerId, widthCm: 7, heightCm: 15, sizeCm: 3, cells: Array.from({ length: 6 }, () => [0, 0, 0, 0, 0, 0]) })),
  calibrationMode: 'screen', area: { widthCm: 32, heightCm: 18 },
});

test('screen-square setup is delivered before there is a valid layout', () => {
  const packet = { ...frame(), type: 'layout_invalid', phones: [] };
  expect(parseSwipeMessage(JSON.stringify(packet))?.screenMarkers?.length).toBe(2);
});

test('rejects malformed pose and marker packets at the camera boundary', () => {
  expect(parseSwipeMessage('null')).toBeNull();
  for (const bad of [
    { ...frame(), sequence: -1 },
    { ...frame(), phones: [{ ...frame().phones[0], widthCm: 0 }, frame().phones[1]] },
    { ...frame(), phones: [frame().phones[0], frame().phones[0]] },
    { ...frame(), screenMarkers: [{ ...frame().screenMarkers[0], cells: [[1]] }, frame().screenMarkers[1]] },
    { ...frame(), media: { kind: 'image', url: 'file:///secret', width: 1, height: 1, version: 1 } },
  ]) expect(parseSwipeMessage(JSON.stringify(bad))).toBeNull();
});

test('reconnect resets sequence state and old packets cannot advance the viewport', () => {
  jest.useFakeTimers();
  const instances: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    send = jest.fn();
    close = jest.fn();
    constructor(url: string) { instances.push(this); }
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  const receive = jest.fn();
  const client = new SwipeCameraConnection(receive, jest.fn(), () => 1000);
  try {
    client.connect('ws://localhost:8765', 'A', .46);
    const first = instances[0];
    first.onopen?.();
    expect(JSON.parse(first.send.mock.calls[0][0])).toMatchObject({ mode: 'swipe', markerOnScreen: true, screenAspect: .46 });
    first.onmessage?.({ data: JSON.stringify({ ...frame(), sequence: 20 }) });
    first.onmessage?.({ data: JSON.stringify({ ...frame(), sequence: 19 }) });
    expect(receive).toHaveBeenCalledTimes(1);
    client.connect('ws://localhost:8765', 'A', .46);
    instances[1].onmessage?.({ data: JSON.stringify({ ...frame(), sessionId: 'new', sequence: 1 }) });
    expect(receive).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalled();
  } finally { client.close(); globalThis.WebSocket = original; jest.useRealTimers(); }
});
