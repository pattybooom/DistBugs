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

CONFIG = app.load_config(app.ROOT / 'config.example.json')
# Deliberately oblique projective camera, world/table y points up.
WORLD_TO_PIXEL = np.array([[14., 2., 200.], [1., -13., 520.], [.002, .001, 1.]])
H = np.linalg.inv(WORLD_TO_PIXEL)


def pose(role='A', centre=(10, 10), heading=math.pi/2):
    spec = next(p for p in CONFIG['phones'] if p['role'] == role)
    marker = rectangle(centre, heading, 3, 3)
    return phone_pose(project(marker, WORLD_TO_PIXEL), H, spec, 3)


class GeometryTests(unittest.TestCase):
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
