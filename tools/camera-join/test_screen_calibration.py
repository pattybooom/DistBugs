import asyncio
import contextlib
import copy
import json
import math
from pathlib import Path
import socket
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import cv2
import numpy as np
from websockets.asyncio.client import connect

import camera_join as app
from geometry import project, rectangle, screen_phone_pose
from manual_calibration import fit_manual_calibration
from screen_calibration import ScreenAnchor

CONFIG = app.load_config(app.ROOT / 'config.example.json')
CAMERA = np.array([[20., 1, 180], [1, -20., 550], [.001, .002, 1.]])


class ScreenCalibrationTests(unittest.TestCase):
    def markers(self):
        marker_cm = CONFIG.get('screen_marker_cm', 3)
        return {p['marker_id']: project(rectangle(centre, math.pi/2, marker_cm, marker_cm), CAMERA)
                for p, centre in zip(CONFIG['phones'], ((10, 9), (18, 9)))}

    def test_auto_reference_needs_both_screens_and_restarts_after_motion(self):
        anchor = ScreenAnchor()
        markers = self.markers()
        self.assertIsNone(anchor.observe({0: markers[0]}, 0, CONFIG, (1280, 720), 0)[0])
        for at in (0, .1, .2):
            self.assertIsNone(anchor.observe(markers, at, CONFIG, (1280, 720), 0)[0])
        moved = {key: corners + [8, 0] for key, corners in markers.items()}
        self.assertIsNone(anchor.observe(moved, .3, CONFIG, (1280, 720), 0)[0])
        for at in (.4, .5, .6, .7, .8):
            self.assertIsNone(anchor.observe(moved, at, CONFIG, (1280, 720), 0)[0])
        calibration, _ = anchor.observe(moved, .91, CONFIG, (1280, 720), 0)
        self.assertEqual(calibration['mode'], 'screen')

    def test_fixed_reference_tracks_both_phones_after_they_move(self):
        anchor, markers = ScreenAnchor(), self.markers()
        for at in (0, .1, .2, .3, .4, .5, .61):
            calibration, _ = anchor.observe(markers, at, CONFIG, (1280, 720), 0)
        h = np.array(calibration['matrix'])
        for centre, angle in (((-2, 9), 0), ((20, 12), math.pi), ((10, -3), -1.12)):
            marker_cm = CONFIG.get('screen_marker_cm', 3)
            p = screen_phone_pose(project(rectangle(centre, angle, marker_cm, marker_cm), CAMERA), h, CONFIG['phones'][0], marker_cm)
            # Initial pair centre was (14,9), placed at area centre (16,9).
            self.assertAlmostEqual(p['centreCm']['x'], centre[0] + 2, places=3)
            self.assertAlmostEqual(p['centreCm']['y'], centre[1], places=3)
            self.assertAlmostEqual(math.cos(p['headingRad']), math.cos(angle), places=3)
            self.assertAlmostEqual(p['widthCm'], CONFIG['phones'][0]['width_cm'], places=3)
            self.assertGreater(p['confidence'], .6)
        self.assertIsNone(app.calibration_valid(calibration, None, (1280, 720), CONFIG))
        self.assertIn('resolution', app.calibration_valid(calibration, None, (640, 480), CONFIG))

    def test_manual_area_and_estimated_scale_do_not_require_printed_references(self):
        world = [[0, 18], [32, 18], [32, 0], [0, 0]]
        corners = project(world, CAMERA)
        h = fit_manual_calibration(corners, 48, 27, (1280, 720))
        p = screen_phone_pose(self.markers()[0], h, CONFIG['phones'][0], CONFIG.get('screen_marker_cm', 3))
        self.assertGreater(p['confidence'], .6)
        self.assertAlmostEqual(p['centreCm']['x'], 15, places=3)
        self.assertAlmostEqual(p['widthCm'], 1.5*CONFIG['phones'][0]['width_cm'], places=3)
        for bad in (corners[[0, 2, 1, 3]], np.zeros((4, 2)), corners + [2000, 0]):
            with self.assertRaises(ValueError):
                fit_manual_calibration(bad, 32, 18, (1280, 720))

    def test_phone_cell_patterns_are_real_aruco_markers(self):
        for spec in app.screen_markers(CONFIG):
            image = np.full((200, 200), 255, np.uint8)
            cells = np.array(spec['cells'], dtype=np.uint8) * 255
            image[40:160, 40:160] = np.repeat(np.repeat(cells, 20, axis=0), 20, axis=1)
            self.assertIn(spec['markerId'], app.detect(image, app.detector()))

    def test_live_gate_rejects_poor_tracking_and_carries_setup_before_detection(self):
        calibration = {'mode': 'screen'}
        base = {'type': 'layout_invalid', 'reason': 'waiting'}
        args = SimpleNamespace(media_url=None)
        waiting = app.swipe_layout(base, [], None, {'A', 'B'}, calibration, CONFIG, args)
        self.assertEqual(len(waiting['screenMarkers']), 2)
        self.assertEqual(waiting['calibrationMode'], 'screen')
        marker_cm = CONFIG.get('screen_marker_cm', 3)
        phones = [screen_phone_pose(c, np.linalg.inv(CAMERA), p, marker_cm) for c, p in zip(self.markers().values(), CONFIG['phones'])]
        self.assertEqual(app.swipe_layout(base, phones, None, {'A', 'B'}, calibration, CONFIG, args)['type'], 'layout')
        poor = copy.deepcopy(phones); poor[0]['confidence'] = .2
        self.assertEqual(app.swipe_layout(base, poor, None, {'A', 'B'}, calibration, CONFIG, args)['type'], 'layout_invalid')
        self.assertEqual(app.swipe_layout(base, phones, 'Camera moved', {'A', 'B'}, calibration, CONFIG, args)['reason'], 'Camera moved')


class ScreenNetworkTests(unittest.IsolatedAsyncioTestCase):
    async def test_hidden_game_markers_hold_positions_until_movement_and_expire_on_disconnect(self):
        class Capture:
            visible = {'A': True, 'B': True}
            second_x = 540

            def read(self):
                image = np.full((720, 1280, 3), 180, np.uint8)
                for marker_id, (role, x) in enumerate((('A', 380), ('B', self.second_x))):
                    if self.visible[role]:
                        image[328:412, x-12:x+72] = 255
                        image[340:400, x:x+60] = cv2.cvtColor(cv2.aruco.generateImageMarker(app.dictionary(), marker_id, 60), cv2.COLOR_GRAY2BGR)
                return True, image

            def release(self):
                pass

        cap = Capture()
        probe = socket.socket(); probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]; probe.close()
        args = SimpleNamespace(command='swipe', manual_area=False, camera=0,
                               host='127.0.0.1', port=port, headless=True, media_url=None)
        states = {role: {'motionAvailable': True, 'moving': False, 'markerVisible': True, 'revision': 0}
                  for role in ('A', 'B')}
        with patch.object(app, 'open_camera', return_value=cap):
            task = asyncio.create_task(app.run(args, CONFIG))
            keepers = []
            try:
                for _ in range(40):
                    try:
                        first = await connect(f'ws://127.0.0.1:{port}', max_queue=None)
                        break
                    except OSError:
                        await asyncio.sleep(.05)
                else:
                    self.fail('Swipe server did not start')
                async with first, connect(f'ws://127.0.0.1:{port}', max_queue=None) as second:
                    async def heartbeat(ws, role):
                        await ws.send(json.dumps({'protocol': 'distbugs.camera', 'version': 1, 'type': 'hello',
                            'role': role, 'mode': 'swipe', 'markerOnScreen': True, 'screenAspect': .46,
                            'markerVisibility': 'motion', 'markerTracking': states[role]}))
                        while True:
                            await asyncio.sleep(.1)
                            await ws.send(json.dumps({'protocol': 'distbugs.camera', 'version': 1,
                                'type': 'heartbeat', 'role': role, 'markerTracking': states[role]}))

                    async def until(predicate):
                        async with asyncio.timeout(5):
                            while True:
                                message = json.loads(await first.recv())
                                if predicate(message):
                                    return message

                    keepers = [asyncio.create_task(heartbeat(first, 'A')), asyncio.create_task(heartbeat(second, 'B'))]
                    initial = await until(lambda m: m['type'] == 'layout')
                    self.assertEqual(initial['markerRevisions'], {'A': 0, 'B': 0})
                    for role in states:
                        states[role]['markerVisible'] = False
                    await asyncio.sleep(.15)  # the visibility heartbeat must precede hiding the image
                    cap.visible = {'A': False, 'B': False}
                    saved = await until(lambda m: m['type'] == 'layout' and 'Positions saved' in m['reason'])
                    self.assertEqual(saved['markerRevisions'], {'A': 0, 'B': 0})
                    states['B'].update(moving=True, markerVisible=True, revision=1)
                    await until(lambda m: m['type'] == 'layout_invalid' and m.get('needsPositionUpdate'))
                    cap.second_x = 160
                    cap.visible['B'] = True
                    moved = await until(lambda m: m['type'] == 'layout' and m['markerRevisions'].get('B') == 1)
                    a, b = moved['phones']
                    self.assertLess(b['centreCm']['x'], a['centreCm']['x'])
                    self.assertEqual(initial['sessionId'], moved['sessionId'])
                    states['B'].update(moving=False, markerVisible=False)
                    await asyncio.sleep(.15)
                    cap.visible['B'] = False
                    await until(lambda m: m['type'] == 'layout' and m['markerRevisions'].get('B') == 1)
                    keepers[1].cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await keepers[1]
                    expired = await until(lambda m: m['type'] == 'layout_invalid')
                    self.assertTrue(expired['needsPositionUpdate'])
            finally:
                for keeper in keepers:
                    keeper.cancel()
                    with contextlib.suppress(asyncio.CancelledError, app.ConnectionClosed):
                        await keeper
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

    async def test_screen_only_bootstrap_movement_and_occlusion(self):
        class Capture:
            moved = hidden = False
            second_x = 540

            def read(self):
                image = np.full((720, 1280, 3), 180, np.uint8)
                positions = ((220 if self.moved else 380, 340), (self.second_x, 340))
                for marker_id, (x, y) in enumerate(positions):
                    if marker_id == 1 and self.hidden:
                        continue
                    image[y-12:y+72, x-12:x+72] = 255
                    image[y:y+60, x:x+60] = cv2.cvtColor(cv2.aruco.generateImageMarker(app.dictionary(), marker_id, 60), cv2.COLOR_GRAY2BGR)
                return True, image

            def release(self):
                pass

        cap = Capture()
        probe = socket.socket(); probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]; probe.close()
        with tempfile.TemporaryDirectory() as folder:
            # No saved calibration and no printed reference markers at all.
            args = SimpleNamespace(command='swipe', manual_area=False, calibration=Path(folder)/'missing.json', camera=0,
                                   host='127.0.0.1', port=port, headless=True, media_url=None)
            with patch.object(app, 'open_camera', return_value=cap):
                task = asyncio.create_task(app.run(args, CONFIG))
                keepers = []
                try:
                    for _ in range(40):
                        try:
                            first = await connect(f'ws://127.0.0.1:{port}', max_queue=None)
                            break
                        except OSError:
                            await asyncio.sleep(.05)
                    else:
                        self.fail('Swipe server did not start')
                    async with first, connect(f'ws://127.0.0.1:{port}', max_queue=None) as second:
                        async def keepalive(ws, role):
                            await ws.send(json.dumps({'protocol': 'distbugs.camera', 'version': 1, 'type': 'hello',
                                                      'role': role, 'mode': 'swipe', 'markerOnScreen': True, 'screenAspect': .46}))
                            while True:
                                await asyncio.sleep(.25)
                                await ws.send(json.dumps({'protocol': 'distbugs.camera', 'version': 1, 'type': 'heartbeat', 'role': role}))
                        keepers = [asyncio.create_task(keepalive(first, 'A')), asyncio.create_task(keepalive(second, 'B'))]

                        async def until(predicate):
                            async with asyncio.timeout(5):
                                while True:
                                    message = json.loads(await first.recv())
                                    if predicate(message):
                                        return message

                        setup = await until(lambda m: 'screenMarkers' in m)
                        self.assertEqual(len(setup['screenMarkers']), 2)
                        initial = await until(lambda m: m['type'] == 'layout')
                        self.assertLess(initial['stableMs'], 1000)
                        a, b = sorted(initial['phones'], key=lambda p: p['role'])
                        cap.moved = True
                        moved = await until(lambda m: m['type'] == 'layout' and m['phones'][0]['centreCm']['x'] < a['centreCm']['x'] - 5)
                        self.assertAlmostEqual(moved['phones'][1]['centreCm']['x'], b['centreCm']['x'], places=2)
                        self.assertEqual(moved['sessionId'], initial['sessionId'])
                        cap.hidden = True
                        lost = await until(lambda m: m['type'] == 'layout_invalid')
                        self.assertIn('visible', lost['reason'])
                        cap.hidden = False
                        await until(lambda m: m['type'] == 'layout')
                        # Repeated side changes must work in the same session,
                        # without capturing a new reference or reconnecting.
                        cap.moved = False
                        cap.second_x = 160
                        left = await until(lambda m: m['type'] == 'layout' and
                                           m['phones'][1]['centreCm']['x'] < m['phones'][0]['centreCm']['x'] - 5)
                        cap.second_x = 620
                        right = await until(lambda m: m['type'] == 'layout' and
                                            m['phones'][1]['centreCm']['x'] > m['phones'][0]['centreCm']['x'] + 5)
                        self.assertEqual(left['sessionId'], right['sessionId'])
                finally:
                    for keeper in keepers:
                        keeper.cancel()
                        with contextlib.suppress(asyncio.CancelledError, app.ConnectionClosed):
                            await keeper
                    task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await task
