import { CameraConnection, CameraMessage, CameraSocket, cameraStitch, parseCameraMessage } from '../src/spatial/CameraJoin';
import { crossingLanding, crossingPoses, openGates, screenToTable } from '../src/game/crossing';
import { stitchedLayout, tableToScreen } from '../src/spatial/Stitch';

const frame = (): CameraMessage => ({
  protocol: 'distbugs.camera', version: 1, sessionId: 'test-session', sequence: 1,
  type: 'layout', reason: 'Phones aligned', stableMs: 1000,
  coordinateSystem: 'table_cm_x_right_y_up', edgeGapCm: .7,
  phones: [
    { role: 'A', markerId: 0, centreCm: { x: 10, y: 20 }, headingRad: Math.PI / 2, widthCm: 6, heightCm: 14, confidence: .9 },
    { role: 'B', markerId: 1, centreCm: { x: 16.7, y: 20 }, headingRad: Math.PI / 2, widthCm: 6, heightCm: 14, confidence: .9 },
  ],
});

describe('camera geometry and network validation', () => {
  test('orders identities and normalizes a translated, rotated camera frame', () => {
    const m = frame();
    m.phones[0].headingRad = 0;
    m.phones[1].headingRad = -Math.PI / 2;
    m.phones[1].centreCm = { x: 10, y: 10 };
    m.phones.reverse();
    const s = cameraStitch(m, 123);
    expect(s.centreB.xCm).toBeCloseTo(10);
    expect(s.centreB.yCm).toBeCloseTo(0);
    expect(s.relativeYawRad).toBeCloseTo(-Math.PI / 2);
    expect(stitchedLayout(s, -1, -2).headingA).toBeCloseTo(Math.PI / 2);
    expect(stitchedLayout(s, null, null).headingB).toBeCloseTo(0);
  });

  test.each([0, Math.PI / 2, Math.PI, -1.13])('preserves relative rotation %s', angle => {
    const m = frame();
    m.phones[0].headingRad = 0;
    m.phones[1].headingRad = angle;
    expect(cameraStitch(m).relativeYawRad).toBeCloseTo(angle);
  });

  test('camera screen dimensions drive crossing and inverse coordinates', () => {
    const s = cameraStitch(frame());
    const poses = crossingPoses(s, 'A');
    const layout = { screen: { widthPt: 400, heightPt: 800 }, field: { xPt: 0, yPt: 0, widthPt: 400, heightPt: 800 }, habitat: { width: 360, height: 720 } };
    const link = { ...poses, ownLayout: layout, otherLayout: layout };
    expect(openGates(link).some(g => g.edge === 'right')).toBe(true);
    expect(crossingLanding(link, { x: 360, y: 360 }, 'right', 0)).not.toBeNull();
    const point = { xPt: 373, yPt: 650 };
    const table = screenToTable(point, poses.other, layout.screen);
    const recovered = tableToScreen(table, poses.other, layout.screen);
    expect(recovered.xPt).toBeCloseTo(point.xPt);
    expect(recovered.yPt).toBeCloseTo(point.yPt);
    s.centreB.xCm = -6.7;
    const left = { ...link, ...crossingPoses(s, 'A') };
    expect(openGates(left).some(g => g.edge === 'left')).toBe(true);
    expect(openGates(left).some(g => g.edge === 'right')).toBe(false);
    s.centreB.xCm = 12;
    expect(openGates({ ...link, ...crossingPoses(s, 'A') })).toHaveLength(0);
  });

  test('rejects malformed, unstable, duplicate and low-quality layouts', () => {
    expect(parseCameraMessage(JSON.stringify(frame()))).not.toBeNull();
    const badFrames: unknown[] = [null, {}, { ...frame(), stableMs: 999 }, { ...frame(), version: 2 },
      { ...frame(), sequence: 1.2 }, { ...frame(), edgeGapCm: -1 }, { ...frame(), phones: [] }];
    for (const mutate of [(m: CameraMessage) => { m.phones[0].confidence = .2; },
      (m: CameraMessage) => { m.phones[0].centreCm.x = NaN; },
      (m: CameraMessage) => { m.phones[0].widthCm = -1; },
      (m: CameraMessage) => { m.phones[1].role = 'A'; },
      (m: CameraMessage) => { m.phones[1].markerId = 0; }]) {
      const m = frame(); mutate(m); badFrames.push(m);
    }
    for (const m of badFrames) expect(parseCameraMessage(JSON.stringify(m))).toBeNull();
    expect(parseCameraMessage('{bad')).toBeNull();
    expect(parseCameraMessage('x'.repeat(33000))).toBeNull();
  });
});

describe('camera connection lifecycle', () => {
  let socket: CameraSocket;
  let valid: jest.Mock, invalid: jest.Mock, status: jest.Mock, close: jest.Mock;
  let client: CameraConnection;
  let now: number;
  const deliver = (m: unknown) => socket.onmessage?.call(socket as WebSocket, { data: JSON.stringify(m) } as MessageEvent);
  beforeEach(() => {
    jest.useFakeTimers(); now = 10000;
    valid = jest.fn(); invalid = jest.fn(); status = jest.fn(); close = jest.fn();
    socket = { onopen: null, onclose: null, onerror: null, onmessage: null, close, send: jest.fn() };
    client = new CameraConnection(() => socket, valid, invalid, status, () => now);
    client.connect('ws://192.168.1.5:8765');
  });
  afterEach(() => { client.close(); jest.useRealTimers(); });

  test('valid layouts join, invalidation closes geometry, fresh stable frames rejoin', () => {
    deliver(frame());
    expect(valid).toHaveBeenCalledTimes(1);
    deliver({ ...frame(), type: 'layout_invalid', sequence: 2, reason: 'Marker hidden' });
    expect(invalid).toHaveBeenLastCalledWith('Marker hidden');
    deliver({ ...frame(), sequence: 3 });
    expect(valid).toHaveBeenCalledTimes(2);
  });
  test('identifies its role and sends heartbeats while receiving fresh layouts', () => {
    socket.onopen?.call(socket as WebSocket, {} as Event);
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ protocol: 'distbugs.camera', version: 1, type: 'hello', role: 'A' }));
    now += 500; deliver(frame()); jest.advanceTimersByTime(200);
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ protocol: 'distbugs.camera', version: 1, type: 'heartbeat', role: 'A' }));
  });
  test('duplicate or reordered packets cannot keep a dead camera alive', () => {
    deliver(frame()); now += 1000; deliver(frame());
    expect(valid).toHaveBeenCalledTimes(1);
    now += 300; jest.advanceTimersByTime(200);
    expect(invalid).toHaveBeenCalledWith('Camera tracking lost · no recent layout');
    expect(close).toHaveBeenCalled();
  });
  test('malformed packets invalidate immediately and never join', () => {
    deliver({ ...frame(), phones: [] });
    expect(invalid).toHaveBeenCalledWith('Invalid camera layout'); expect(valid).not.toHaveBeenCalled();
  });
  test('connection that never opens times out and releases its socket', () => {
    now += 1300; jest.advanceTimersByTime(200);
    expect(invalid).toHaveBeenCalled(); expect(close).toHaveBeenCalled();
  });
  test('socket failure immediately clears camera geometry', () => {
    deliver(frame());
    socket.onerror?.call(socket as WebSocket, {} as Event);
    expect(invalid).toHaveBeenLastCalledWith('Camera tracking lost · reconnect to the Mac');
    expect(close).toHaveBeenCalled();
    expect(socket.onmessage).toBeNull();
  });
  test('disconnect and camera restart invalidate rather than accepting a different session', () => {
    deliver(frame()); deliver({ ...frame(), sessionId: 'replacement', sequence: 2 });
    expect(invalid).toHaveBeenLastCalledWith('Camera session changed; reconnect');
    expect(socket.onmessage).toBeNull(); expect(close).toHaveBeenCalled();
  });
  test('intentional cleanup detaches callbacks and stops timers', () => {
    client.close(); now += 10000; jest.advanceTimersByTime(10000);
    expect(invalid).not.toHaveBeenCalled(); expect(socket.onmessage).toBeNull();
  });
});
