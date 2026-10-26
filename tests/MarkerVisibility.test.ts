import { MarkerVisibility } from '../src/spatial/MarkerVisibility';

const motion = (stationary = true, yaw = 0) => ({ source: 'local', valid: true, stationary, yaw });

function settle(controller: MarkerVisibility, from = 0) {
  const revision = controller.snapshot(from).revision;
  for (let at = from; at <= from + 1000; at += 100) {
    controller.observeMotion(motion(), at);
    controller.observeLayout(revision, at);
    controller.snapshot(at);
  }
}

test('shows setup code, hides only after a confirmed stationary layout, then wakes on movement', () => {
  const controller = new MarkerVisibility();
  expect(controller.snapshot(0).markerVisible).toBe(true);
  settle(controller);
  expect(controller.snapshot(1000)).toMatchObject({ markerVisible: false, moving: false, revision: 0 });
  controller.observeMotion(motion(false), 1050);
  expect(controller.snapshot(1050).markerVisible).toBe(false);
  controller.observeMotion(motion(false), 1350);
  expect(controller.snapshot(1350)).toMatchObject({ markerVisible: true, moving: true, revision: 1 });
  expect(controller.observeLayout(0, 1400)).toBe(false);
  settle(controller, 1400);
  expect(controller.snapshot(2400).markerVisible).toBe(false);
});

test('legacy packets and unavailable or stale motion never hide the code', () => {
  const controller = new MarkerVisibility();
  for (let at = 0; at <= 1000; at += 100) {
    controller.observeMotion(motion(), at);
    controller.observeLayout(undefined, at);
  }
  expect(controller.snapshot(1000).markerVisible).toBe(true);
  settle(controller, 1100);
  expect(controller.snapshot(2100).markerVisible).toBe(false);
  expect(controller.snapshot(2800)).toMatchObject({ markerVisible: true, motionAvailable: false });
});

test('ignores malformed and remote native events and detects gradual rotation while hidden', () => {
  const controller = new MarkerVisibility();
  for (const bad of [null, {}, { ...motion(), source: 'remote' }, { ...motion(), stationary: undefined }, { ...motion(), valid: false }]) {
    expect(controller.observeMotion(bad, 0)).toBe(false);
  }
  settle(controller);
  controller.observeMotion(motion(true, .05), 1050);
  expect(controller.snapshot(1050).markerVisible).toBe(false);
  controller.observeMotion(motion(true, .12), 1100);
  expect(controller.snapshot(1100)).toMatchObject({ markerVisible: true, revision: 1 });
});

test('brief knocks and small jiggles keep a hidden code hidden, a firm shove wakes it', () => {
  const controller = new MarkerVisibility();
  settle(controller);
  const jiggle = { ...motion(false), userAcceleration: { x: .05, y: 0, z: 0 }, angularVelocity: { x: .3, y: 0, z: 0 } };
  for (const at of [1050, 1100, 1150]) controller.observeMotion(jiggle, at);
  controller.observeMotion(motion(), 1200);
  controller.observeMotion(jiggle, 1250);
  expect(controller.snapshot(1250)).toMatchObject({ markerVisible: false, revision: 0 });
  controller.observeMotion({ ...motion(false), userAcceleration: { x: .2, y: 0, z: 0 } }, 1300);
  expect(controller.snapshot(1300)).toMatchObject({ markerVisible: true, revision: 1 });
});

test('camera updates must remain fresh before a code can disappear', () => {
  const controller = new MarkerVisibility();
  for (let at = 0; at <= 1000; at += 100) controller.observeMotion(motion(), at);
  controller.observeLayout(0, 0);
  expect(controller.snapshot(1000).markerVisible).toBe(true);
});

test('a camera reset can wake a hidden stationary code without waiting for physical movement', () => {
  const controller = new MarkerVisibility();
  settle(controller);
  controller.reacquire();
  expect(controller.snapshot(1050)).toMatchObject({ markerVisible: true, revision: 1 });
  expect(controller.observeLayout(0, 1050)).toBe(false);
  controller.observeMotion(motion(), 1100);
  expect(controller.snapshot(1100).markerVisible).toBe(true);
});
