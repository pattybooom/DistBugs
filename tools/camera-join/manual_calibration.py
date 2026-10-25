"""Approximate four-corner setup for Swipe; no printed reference board."""
import json
import math
from pathlib import Path

import cv2
import numpy as np

from geometry import project


def fit_manual_calibration(points, width_cm, height_cm, frame_size):
    points = np.asarray(points, dtype=float)
    if points.shape != (4, 2) or not np.isfinite(points).all():
        raise ValueError("Select four finite corners: top-left, top-right, bottom-right, bottom-left")
    if not all(math.isfinite(v) and 1 <= v <= 1000 for v in (width_cm, height_cm)):
        raise ValueError("Estimated area dimensions must be between 1 and 1000 cm")
    w, h = frame_size
    if np.any(points < 0) or np.any(points[:, 0] >= w) or np.any(points[:, 1] >= h):
        raise ValueError("Keep all four corners inside the camera image")
    # Positive image-space winding also rejects crossing handles and collapsed edges.
    edges = np.roll(points, -1, axis=0) - points
    turns = edges[:, 0] * np.roll(edges, -1, axis=0)[:, 1] - edges[:, 1] * np.roll(edges, -1, axis=0)[:, 0]
    if np.any(turns <= 1) or cv2.contourArea(points.astype(np.float32)) < w * h * .005:
        raise ValueError("Make a larger, non-crossing rectangle on the tabletop")
    world = np.array([[0, height_cm], [width_cm, height_cm], [width_cm, 0], [0, 0]], dtype=float)
    matrix = cv2.getPerspectiveTransform(points.astype(np.float32), world.astype(np.float32))
    if not np.isfinite(matrix).all() or np.linalg.cond(matrix) > 1e8:
        raise ValueError("Area is too narrow; move the corners farther apart")
    if not np.allclose(project(points, matrix), world, atol=1e-3):
        raise ValueError("Could not map this area; adjust the corners")
    return matrix


class ManualArea:
    """Mouse coordinates are camera-image pixels (WINDOW_AUTOSIZE)."""
    def __init__(self, width, height):
        self.width, self.height = width, height
        self.reset()

    def reset(self):
        self.points = np.array([[.18, .25], [.82, .25], [.82, .82], [.18, .82]]) * [self.width, self.height]
        self.dragging = None

    def mouse(self, event, x, y, flags, userdata):
        if event == cv2.EVENT_LBUTTONDOWN:
            self.dragging = int(np.argmin(np.linalg.norm(self.points - [x, y], axis=1)))
        if self.dragging is not None and event in (cv2.EVENT_LBUTTONDOWN, cv2.EVENT_MOUSEMOVE):
            self.points[self.dragging] = [np.clip(x, 0, self.width - 1), np.clip(y, 90, self.height - 1)]
        if event == cv2.EVENT_LBUTTONUP:
            self.dragging = None


def calibrate_manual(cap, args, config):
    name = "Swipe - drag corners, then SPACE to start"
    area, note = None, ""
    cv2.namedWindow(name, cv2.WINDOW_AUTOSIZE)
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                raise RuntimeError("Camera stopped delivering frames")
            size = (frame.shape[1], frame.shape[0])
            if area is None or (area.width, area.height) != size:
                area = ManualArea(*size)
                cv2.setMouseCallback(name, area.mouse)
            matrix = None
            try:
                matrix = fit_manual_calibration(area.points, args.area_width_cm, args.area_height_cm, size)
                note = "Drag each corner onto a rectangular table area. SPACE saves + starts. R resets. Q cancels."
            except ValueError as error:
                note = str(error)
            cv2.polylines(frame, [area.points.astype(np.int32)], True, (80, 230, 200), 3)
            for index, point in enumerate(area.points.astype(int)):
                cv2.circle(frame, tuple(point), 14, (80, 230, 200), -1)
                cv2.putText(frame, ("TL", "TR", "BR", "BL")[index], tuple(point + [18, -12]), cv2.FONT_HERSHEY_SIMPLEX, .7, (255, 255, 255), 2)
            cv2.rectangle(frame, (0, 0), (size[0], 85), (20, 20, 20), -1)
            cv2.putText(frame, note, (12, 28), cv2.FONT_HERSHEY_SIMPLEX, .6, (255, 255, 255), 1)
            cv2.putText(frame, f"Approximate {args.area_width_cm:g} x {args.area_height_cm:g} cm. No printing. Keep the Mac fixed after saving.",
                        (12, 61), cv2.FONT_HERSHEY_SIMPLEX, .6, (130, 220, 250), 1)
            cv2.imshow(name, frame)
            key = cv2.waitKey(1) & 0xff
            if key in (ord('q'), 27) or cv2.getWindowProperty(name, cv2.WND_PROP_VISIBLE) < 1:
                return False
            if key == ord('r'):
                area.reset()
            if key == 32 and matrix is not None:
                data = {"mode": "manual", "matrix": matrix.tolist(), "pixels": area.points.tolist(),
                        "areaWidthCm": args.area_width_cm, "areaHeightCm": args.area_height_cm,
                        "frameSize": list(size), "config": config, "camera": args.camera,
                        "residualCm": None}
                Path(args.calibration).write_text(json.dumps(data, indent=2))
                print(f"Saved approximate Swipe area to {args.calibration}. Starting tracking.", flush=True)
                return True
    finally:
        cv2.destroyWindow(name)
