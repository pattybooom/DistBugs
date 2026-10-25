"""Capture one fixed tabletop frame from known-size on-screen squares."""
import cv2
import numpy as np

from geometry import project, rectangle


# Reference capture wants squares at least this many pixels on a side; tracking itself is gated by --min-confidence.
MIN_SIDE_PX = 14


class ScreenAnchor:
    def __init__(self, seconds=.6, movement_px=4):
        self.seconds, self.movement_px = seconds, movement_px
        self.reset()

    def reset(self):
        self.since = self.last = self.first = None
        self.samples = []

    def observe(self, markers, now, config, frame_size, camera):
        specs = sorted(config['phones'], key=lambda p: p['role'])
        if not all(p['marker_id'] in markers for p in specs):
            self.reset()
            return None, 'Keep both phone squares visible to capture the reference'
        corners = np.array([markers[p['marker_id']] for p in specs], dtype=float)
        if corners.shape != (2, 4, 2) or not np.isfinite(corners).all():
            self.reset()
            return None, 'Phone square is unreadable'
        sides = np.linalg.norm(corners - np.roll(corners, -1, axis=1), axis=2)
        if np.min(sides) < MIN_SIDE_PX:
            self.reset()
            return None, 'Phone squares are too small; move them closer to the camera'
        interrupted = self.last is not None and (now - self.last > .3 or now < self.last)
        moved = self.first is not None and np.max(np.linalg.norm(corners-self.first, axis=2)) > self.movement_px
        if self.first is None or moved or interrupted:
            self.first, self.since, self.samples = corners, now, []
        self.last = now
        self.samples.append(corners)
        if now - self.since < self.seconds:
            return None, 'Hold both phones flat and still briefly to capture the reference'
        median = np.median(self.samples[-12:], axis=0)
        local = rectangle((0, 0), np.pi/2, config.get('screen_marker_cm', config['phone_marker_cm']), config.get('screen_marker_cm', config['phone_marker_cm']))
        matrix = cv2.getPerspectiveTransform(median[0].astype(np.float32), local.astype(np.float32))
        if not np.isfinite(matrix).all() or np.linalg.cond(matrix) > 1e8:
            self.reset()
            return None, 'Phone A square is too oblique; reposition it'
        # Centre the media over the pair at setup. Freeze this mapping afterwards:
        # updating it from moving A would make the hidden image move with the phone.
        centres = project(median.reshape(-1, 2), matrix).reshape(2, 4, 2).mean(axis=1)
        width, height = config['reference_width_cm'], config['reference_height_cm']
        shift = np.array([width/2, height/2]) - centres.mean(axis=0)
        matrix = np.array([[1, 0, shift[0]], [0, 1, shift[1]], [0, 0, 1]]) @ matrix
        return {'mode': 'screen', 'matrix': matrix.tolist(), 'config': config, 'frameSize': list(frame_size),
                'camera': camera, 'areaWidthCm': width, 'areaHeightCm': height, 'residualCm': None}, 'Reference captured'
