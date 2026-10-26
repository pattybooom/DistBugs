import asyncio
import contextlib
import copy
import json
import math
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

import cv2
import numpy as np
from websockets.asyncio.client import connect

import camera_join as app
from geometry import StabilityGate, phone_pose, polygon_gap, project, rectangle
from smoothing import PoseSmoother

CONFIG = app.load_config(app.ROOT / 'config.example.json')
# Deliberately oblique projective camera, world/table y points up.
WORLD_TO_PIXEL = np.array([[14., 2., 200.], [1., -13., 520.], [.002, .001, 1.]])
H = np.linalg.inv(WORLD_TO_PIXEL)


def pose(role='A', centre=(10, 10), heading=math.pi/2):
    spec = next(p for p in CONFIG['phones'] if p['role'] == role)
    marker = rectangle(centre, heading, 3, 3)
    return phone_pose(project(marker, WORLD_TO_PIXEL), H, spec, 3)


class GeometryTests(unittest.TestCase):
    def test_mirror_preview_keeps_world_coordinates_and_input_unchanged(self):
        image = np.arange(24, dtype=np.uint8).reshape(4, 6)
        corners = np.array([[1., 1.], [3, 1], [3, 2], [1, 2]])
        original = corners.copy()
        view, markers, matrix = app.preview_geometry(image, {0: corners}, np.eye(3))
        np.testing.assert_array_equal(view, image[:, ::-1])
        np.testing.assert_allclose(project(markers[0], matrix), original)
        np.testing.assert_array_equal(corners, original)

    def test_perspective_and_rotation(self):
        for angle in (0, math.pi/2, math.pi, -1.12):
            p = pose(heading=angle)
            self.assertAlmostEqual(p['centreCm']['x'], 10)
            self.assertAlmostEqual(p['centreCm']['y'], 10)
            self.assertAlmostEqual(math.cos(p['headingRad']), math.cos(angle))
            self.assertAlmostEqual(math.sin(p['headingRad']), math.sin(angle))
            self.assertGreater(p['confidence'], .6)

    def test_marker_offset_and_rotation(self):
        spec = {**CONFIG['phones'][0], 'marker_offset_cm': [2, 1], 'marker_rotation_deg': 90}
        # Phone heading up, marker heading left. Marker centre is 2 cm right, 1 cm above screen centre.
        marker = rectangle((12, 11), math.pi, 3, 3)
        p = phone_pose(project(marker, WORLD_TO_PIXEL), H, spec, 3)
        self.assertAlmostEqual(p['centreCm']['x'], 10)
        self.assertAlmostEqual(p['centreCm']['y'], 10)
        self.assertAlmostEqual(p['headingRad'], math.pi/2)

    def test_gap_and_overlap(self):
        a = rectangle((0, 0), math.pi/2, 6, 14)
        for gap in (0, .7, 5):
            self.assertAlmostEqual(polygon_gap(a, rectangle((6+gap, 0), math.pi/2, 6, 14)), gap)
        self.assertLess(polygon_gap(a, rectangle((5, 0), math.pi/2, 6, 14)), 0)
        self.assertAlmostEqual(polygon_gap(a, rectangle((10, 12), math.pi/2, 6, 6)), math.hypot(4, 2))

    def test_stability_occlusion_motion_and_reacquisition(self):
        gate = StabilityGate()
        phones = [pose('B', (18, 10)), pose()]
        for i in range(11):
            valid, ms, _ = gate.observe(phones, i/10)
        self.assertTrue(valid)
        self.assertEqual(ms, 1000)
        self.assertFalse(gate.observe([phones[0]], 1.1)[0])
        self.assertFalse(gate.observe(phones, 1.2)[0])
        for i in range(13, 24):
            valid, _, _ = gate.observe(phones, i/10)
        self.assertTrue(valid)
        moved = [pose('B', (-2, 10)), pose()]
        self.assertFalse(gate.observe(moved, 2.4)[0])
        for i in range(25, 36):
            valid, _, _ = gate.observe(moved, i/10)
        self.assertTrue(valid)  # automatic left/right changes, no new swipe

    def test_confidence_rotation_and_capture_stall_invalidate(self):
        gate = StabilityGate()
        phones = [pose(), pose('B', (20, 10))]
        for i in range(12):
            gate.observe(phones, i/10)
        self.assertFalse(gate.observe(phones, 2)[0])
        poor = copy.deepcopy(phones); poor[0]['confidence'] = .1
        self.assertFalse(gate.observe(poor, 2.1)[0])
        self.assertIsNone(gate.anchor)
        gate.observe(phones, 3)
        turned = [pose(heading=math.pi/2+.2), phones[1]]
        self.assertFalse(gate.observe(turned, 3.1)[0])
        self.assertEqual(gate.since, 3.1)

    def test_calibration_and_camera_movement(self):
        pixels = project(app.reference_world(CONFIG), WORLD_TO_PIXEL)
        matrix, residual = app.fit_calibration(pixels, CONFIG)
        np.testing.assert_allclose(project(pixels, matrix), app.reference_world(CONFIG), atol=1e-4)
        self.assertLess(residual, .001)
        calibration = {'frameSize': [1280, 720], 'config': CONFIG, 'pixels': pixels.tolist()}
        self.assertIsNone(app.calibration_valid(calibration, pixels, (1280, 720), CONFIG))
        self.assertIn('moved', app.calibration_valid(calibration, pixels+5, (1280, 720), CONFIG))
        self.assertIn('visible', app.calibration_valid(calibration, None, (1280, 720), CONFIG))
        self.assertIn('resolution', app.calibration_valid(calibration, pixels, (640, 480), CONFIG))

    def test_duplicate_markers_rejected(self):
        class Reader:
            def detectMarkers(self, frame):
                return [np.zeros((1, 4, 2))]*2, np.array([[0], [0]]), []
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            app.detect(None, Reader())

    def test_real_detector_finds_generated_markers(self):
        image = np.full((400, 400), 255, np.uint8)
        image[100:220, 100:220] = cv2.aruco.generateImageMarker(app.dictionary(), 0, 120)
        self.assertIn(0, app.detect(image, app.detector()))

    def test_detector_ignores_unconfigured_marker_ids_when_requested(self):
        image = np.full((400, 600), 255, np.uint8)
        for marker_id, x in ((0, 80), (2, 300)):
            image[100:220, x:x+120] = cv2.aruco.generateImageMarker(app.dictionary(), marker_id, 120)
        self.assertEqual(set(app.detect(image, app.detector(), allowed_ids={0})), {0})

    def test_readable_id_still_needs_contrast_and_an_intact_border(self):
        corners = np.float32([[40, 40], [159, 40], [159, 159], [40, 159]])
        image = np.full((200, 200), 180, np.uint8)
        marker = cv2.aruco.generateImageMarker(app.dictionary(), 0, 120)
        image[40:160, 40:160] = marker
        self.assertTrue(app.marker_image_valid(image, corners, 0))
        self.assertFalse(app.marker_image_valid(image, corners, 1))
        dim = (image.astype(float) * .05 + 100).astype(np.uint8)
        self.assertFalse(app.marker_image_valid(dim, corners, 0))
        image[40:60, 40:160] = 255
        self.assertFalse(app.marker_image_valid(image, corners, 0))

    def test_confirmation_rejects_single_frame_jump_and_never_replays_a_missing_marker(self):
        tracker = app.MarkerConfirmation()
        corners = np.float32([[0, 0], [50, 0], [50, 50], [0, 50]])
        self.assertFalse(tracker.observe({0: corners}, 0))
        self.assertFalse(tracker.observe({0: corners}, .03))
        self.assertIn(0, tracker.observe({0: corners}, .06))
        self.assertFalse(tracker.observe({0: corners + 200}, .09))
        self.assertFalse(tracker.observe({}, .12))
        self.assertFalse(tracker.observe({0: corners}, 1))


class SmoothingTests(unittest.TestCase):
    @staticmethod
    def phone(x, y=0, heading=0):
        return {'role': 'A', 'centreCm': {'x': x, 'y': y}, 'headingRad': heading, 'confidence': .9}

    def test_single_frame_pose_spike_is_rejected(self):
        smoother = PoseSmoother()
        smoother.apply([self.phone(0)], 0.0)
        smoother.apply([self.phone(0)], 0.1)
        stable = smoother.apply([self.phone(20)], 0.2)[0]
        self.assertLess(stable['centreCm']['x'], 5)
        settled = smoother.apply([self.phone(0)], 0.3)[0]
        self.assertLess(settled['centreCm']['x'], 2)

    def test_real_motion_survives_the_short_median(self):
        smoother = PoseSmoother()
        values = [smoother.apply([self.phone(x)], i / 10)[0]['centreCm']['x'] for i, x in enumerate((0, 2, 4, 6, 8))]
        self.assertGreater(values[-1], values[1])

    def test_heading_spikes_are_removed_across_angle_wrap(self):
        smoother = PoseSmoother()
        for i, angle in enumerate((math.pi - .01, -math.pi + .01, 1.0)):
            result = smoother.apply([self.phone(0, heading=angle)], i / 30)[0]
        self.assertLess(abs(math.atan2(math.sin(result['headingRad'] - math.pi), math.cos(result['headingRad'] - math.pi))), .03)

    def test_smoothed_screen_outline_matches_smoothed_pose(self):
        smoother = PoseSmoother()
        for i in range(5):
            result = smoother.apply([{**self.phone(i), 'widthCm': 6, 'heightCm': 14}], i / 30)[0]
        outline = np.array(result['cornersCm'])
        np.testing.assert_allclose(outline.mean(axis=0), [result['centreCm']['x'], result['centreCm']['y']])


class MotionPoseCacheTests(unittest.TestCase):
    def state(self, role='A'):
        return {'role': role, 'seen': 0, 'markerVisibility': 'motion',
                'markerTracking': {'motionAvailable': True, 'moving': False, 'markerVisible': True, 'revision': 0}}

    def test_hidden_pose_requires_live_rest_same_client_and_same_revision(self):
        cache, state = app.MotionPoseCache(), self.state()
        phone = {'role': 'A', 'confidence': 1, 'centreCm': {'x': 4, 'y': 5}}
        cache.resolve([phone], [state], 0)
        self.assertEqual(cache.resolve([], [state], .1)[0], [])  # occlusion while showing the code
        state['markerTracking']['markerVisible'] = False
        held, revisions, roles = cache.resolve([], [state], .2)
        self.assertEqual((held, revisions, roles), ([phone], {'A': 0}, ['A']))
        state['markerTracking']['moving'] = True
        self.assertEqual(cache.resolve([], [state], .3)[0], [])
        state['markerTracking']['moving'] = False
        state['markerTracking']['revision'] = 1
        self.assertEqual(cache.resolve([], [state], .4)[0], [])
        cache.resolve([phone], [state], .5)
        self.assertEqual(cache.resolve([], [self.state()], .6)[0], [])  # reconnect
        cache.resolve([phone], [state], .7)
        self.assertEqual(cache.resolve([], [state], 1.3)[0], [])  # heartbeat expired

    def test_unavailable_motion_and_legacy_clients_cannot_hold_positions(self):
        cache, state = app.MotionPoseCache(), self.state()
        phone = {'role': 'A', 'confidence': 1}
        cache.resolve([phone], [state], 0)
        state['markerTracking'].update(markerVisible=False, motionAvailable=False)
        self.assertEqual(cache.resolve([], [state], .1)[0], [])
        state.pop('markerVisibility')
        self.assertEqual(cache.resolve([], [state], .2)[0], [])

    def test_malformed_sensor_state_is_rejected_at_the_network_boundary(self):
        for value in (None, {}, {'motionAvailable': True, 'moving': False, 'markerVisible': False, 'revision': True},
                      {'motionAvailable': True, 'moving': False, 'markerVisible': False, 'revision': -1}):
            with self.assertRaises(ValueError):
                app.marker_tracking_state(value)


class NetworkTests(unittest.IsolatedAsyncioTestCase):
    async def test_two_clients_stable_join_and_marker_loss(self):
        # Real detector, homography, stability gate and WebSocket server; only camera capture is synthetic.
        config = copy.deepcopy(CONFIG)
        pixel_matrix = np.array([[20., 0, 180], [0, -20., 550], [0, 0, 1.]])
        markers = {}
        world = app.reference_world(config).reshape(4, 4, 2)
        for i, corners in zip(app.REFERENCE_IDS, world):
            markers[i] = project(corners, pixel_matrix)
        for spec, centre in zip(config['phones'], ((10, 9), (18, 9))):
            markers[spec['marker_id']] = project(rectangle(centre, math.pi/2, 3, 3), pixel_matrix)
        image = np.full((720, 1280, 3), 255, np.uint8)
        for i, corners in markers.items():
            x, y = corners[0].astype(int)
            size = int(corners[1, 0] - corners[0, 0])
            marker = cv2.aruco.generateImageMarker(app.dictionary(), i, size)
            image[y:y+size, x:x+size] = cv2.cvtColor(marker, cv2.COLOR_GRAY2BGR)
        detected = app.detect(image, app.detector())
        pixels = app.reference_pixels(detected)
        matrix, residual = app.fit_calibration(pixels, config)
        class Capture:
            hidden = False
            shifted = False
            def read(self):
                img = image.copy()
                if self.hidden:
                    corners = markers[1].astype(int)
                    x, y = corners[0]; size = int(corners[1, 0]-x)
                    img[y-2:y+size+2, x-2:x+size+2] = 255
                if self.shifted:
                    img = cv2.warpAffine(img, np.float32([[1, 0, 8], [0, 1, 0]]), (1280, 720), borderValue=(255, 255, 255))
                return True, img
            def release(self):
                pass
        cap = Capture()
        with tempfile.TemporaryDirectory() as folder:
            calibration = Path(folder)/'calibration.json'
            calibration.write_text(json.dumps({'matrix': matrix.tolist(), 'pixels': pixels.tolist(), 'config': config,
                'frameSize': [1280, 720], 'residualCm': residual, 'camera': 0}))
            probe = socket.socket(); probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]; probe.close()
            args = SimpleNamespace(calibration=calibration, camera=0, host='127.0.0.1', port=port, headless=True)
            with patch.object(app, 'open_camera', return_value=cap):
                task = asyncio.create_task(app.run(args, config))
                heartbeat_tasks = []
                try:
                    for _ in range(40):
                        try:
                            first = await connect(f'ws://127.0.0.1:{port}')
                            break
                        except OSError:
                            await asyncio.sleep(.05)
                    else:
                        self.fail('Server did not start')
                    async with first, connect(f'ws://127.0.0.1:{port}', max_queue=None) as second:
                        async def keepalive(ws, role, greeting=True):
                            if greeting:
                                await ws.send(json.dumps({'protocol': 'distbugs.camera', 'version': 1, 'type': 'hello', 'role': role}))
                            try:
                                while True:
                                    await asyncio.sleep(.3)
                                    await ws.send(json.dumps({'protocol': 'distbugs.camera', 'version': 1, 'type': 'heartbeat', 'role': role}))
                            except app.ConnectionClosed:
                                pass
                        heartbeat_tasks = [asyncio.create_task(keepalive(first, 'A')), asyncio.create_task(keepalive(second, 'B'))]
                        async def valid(ws):
                            async with asyncio.timeout(5):
                                while True:
                                    m = json.loads(await ws.recv())
                                    if m['type'] == 'layout':
                                        return m
                        a, b = await asyncio.gather(valid(first), valid(second))
                        self.assertEqual(a['sessionId'], b['sessionId'])
                        self.assertGreaterEqual(a['stableMs'], 1000)
                        self.assertEqual(len(a['phones']), 2)
                        heartbeat_tasks[1].cancel()
                        with contextlib.suppress(asyncio.CancelledError):
                            await heartbeat_tasks[1]
                        async with asyncio.timeout(3):
                            while True:
                                m = json.loads(await first.recv())
                                if m['type'] == 'layout_invalid':
                                    break
                        self.assertIn('both phones', m['reason'])
                        heartbeat_tasks[1] = asyncio.create_task(keepalive(second, 'B', False))
                        await valid(first)
                        cap.hidden = True
                        async with asyncio.timeout(2):
                            while True:
                                m = json.loads(await first.recv())
                                if m['type'] == 'layout_invalid':
                                    break
                        self.assertIn('Detecting', m['reason'])
                        cap.hidden = False
                        await valid(first)
                        cap.shifted = True
                        async with asyncio.timeout(2):
                            while True:
                                m = json.loads(await first.recv())
                                if 'calibration invalid' in m['reason']:
                                    break
                        self.assertEqual(m['type'], 'layout_invalid')
                        cap.shifted = False
                        # Moving back to the calibrated location does not silently re-enable tracking.
                        for _ in range(14):
                            m = json.loads(await first.recv())
                            self.assertEqual(m['type'], 'layout_invalid')
                        self.assertIn('recalibrate', m['reason'])
                        await second.close()
                finally:
                    for heartbeat in heartbeat_tasks:
                        heartbeat.cancel()
                        with contextlib.suppress(asyncio.CancelledError):
                            await heartbeat
                    task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await task


if __name__ == '__main__':
    unittest.main()
