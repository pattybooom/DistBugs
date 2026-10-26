"""Planar geometry and conservative stability gate; no camera or networking needed."""
import math
from collections import deque
import numpy as np


def wrap(angle):
    return math.atan2(math.sin(angle), math.cos(angle))


def project(points, homography):
    points = np.asarray(points, dtype=float).reshape(-1, 2)
    homogeneous = np.column_stack((points, np.ones(len(points)))) @ homography.T
    if not np.isfinite(homogeneous).all() or np.any(abs(homogeneous[:, 2]) < 1e-9):
        raise ValueError("Invalid calibration projection")
    return homogeneous[:, :2] / homogeneous[:, 2:3]


def rotate(points, angle):
    c, s = math.cos(angle), math.sin(angle)
    return np.asarray(points) @ np.array([[c, s], [-s, c]])


def rectangle(centre, heading, width, height):
    local = np.array([[-width/2, height/2], [width/2, height/2],
                      [width/2, -height/2], [-width/2, -height/2]])
    return rotate(local, heading - math.pi/2) + centre


def phone_pose(pixel_corners, homography, spec, marker_cm):
    pixels = np.asarray(pixel_corners, dtype=float).reshape(4, 2)
    if not np.isfinite(pixels).all():
        raise ValueError("Invalid marker corners")
    corners = project(pixels, homography)
    sides = np.linalg.norm(corners - np.roll(corners, -1, axis=0), axis=1)
    pixel_side = float(min(np.linalg.norm(pixels - np.roll(pixels, -1, axis=0), axis=1)))
    scale_error = float(max(abs(sides / marker_cm - 1)))
    # These are geometric quality scores, not statistical probabilities of accuracy.
    square_error = float(max(abs(np.sum((corners - np.roll(corners, -1, axis=0)) *
                                        (np.roll(corners, -1, axis=0) - np.roll(corners, -2, axis=0)), axis=1))) / marker_cm**2)
    confidence = max(0.0, min(1.0, pixel_side / 40, 1 - scale_error / .25, 1 - square_error / .4))
    top = (corners[0] + corners[1] - corners[2] - corners[3]) / 2
    heading = wrap(math.atan2(top[1], top[0]) - math.radians(spec.get("marker_rotation_deg", 0)))
    offset = rotate([spec.get("marker_offset_cm", [0, 0])], heading - math.pi/2)[0]
    centre = corners.mean(axis=0) - offset
    return {"role": spec["role"], "markerId": spec["marker_id"],
            "centreCm": {"x": float(centre[0]), "y": float(centre[1])},
            "headingRad": heading, "widthCm": spec["width_cm"], "heightCm": spec["height_cm"],
            "cornersCm": rectangle(centre, heading, spec["width_cm"], spec["height_cm"]).tolist(),
            "markerCornersPx": pixels.tolist(), "confidence": confidence}


def screen_phone_pose(pixel_corners, homography, spec, marker_cm):
    """Expand a centred screen marker into the screen outline in an approximate table frame.

    Marker-to-screen proportions come from the displayed square; estimated table scale
    must not reject a readable square just because it isn't exactly 3 cm in that frame.
    """
    pixels = np.asarray(pixel_corners, dtype=float).reshape(4, 2)
    if not np.isfinite(pixels).all():
        raise ValueError("Invalid screen marker corners")
    # The fixed homography already removes the table's perspective. Fit a
    # similarity (translation, rotation, uniform scale) to ALL four projected
    # corners. Fitting another projective transform to a tiny square magnified
    # subpixel errors when extrapolating to the far end of an offset screen.
    corners = project(pixels, homography)
    local = rectangle((0, 0), math.pi / 2, marker_cm, marker_cm)
    marker_centre = corners.mean(axis=0)
    centred = corners - marker_centre
    denominator = float(np.sum(local * local))
    a = float(np.sum(local * centred) / denominator)
    b = float(np.sum(local[:, 0] * centred[:, 1] - local[:, 1] * centred[:, 0]) / denominator)
    scale = math.hypot(a, b)
    if scale < 1e-6:
        raise ValueError('Degenerate screen marker')
    fitted = local @ np.array([[a, b], [-b, a]]) + marker_centre
    fit_error = float(np.sqrt(np.mean(np.sum((fitted - corners)**2, axis=1))) / (marker_cm * scale))
    if fit_error > .15:
        raise ValueError('Tracking square does not fit the table plane; keep phones flat or reset reference')
    ox, oy = spec.get('marker_offset_cm', (0, 0))
    heading = wrap(math.atan2(b, a) + math.pi / 2)
    centre = marker_centre - rotate([[ox * scale, oy * scale]], heading - math.pi / 2)[0]
    width, height = spec['width_cm'] * scale, spec['height_cm'] * scale
    outline = rectangle(centre, heading, width, height)
    pixel_side = min(np.linalg.norm(pixels - np.roll(pixels, -1, axis=0), axis=1))
    if not 0.1 < width < 100 or not 0.1 < height < 100 or not np.isfinite(outline).all():
        raise ValueError("Screen falls outside the estimated plane; adjust the area")
    return {"role": spec['role'], "markerId": spec['marker_id'], "centreCm": {"x": float(centre[0]), "y": float(centre[1])},
            "headingRad": heading, "widthCm": width, "heightCm": height,
            "cornersCm": outline.tolist(), "markerCornersPx": pixels.tolist(),
            "confidence": float(max(0, min(1, pixel_side/40, 1 - fit_error / .3)))}


def polygon_gap(a, b):
    """Minimum outline distance, or negative penetration for overlapping convex rectangles."""
    a, b = np.asarray(a), np.asarray(b)
    separated = False
    penetration = float("inf")
    for polygon in (a, b):
        for start, end in zip(polygon, np.roll(polygon, -1, axis=0)):
            edge = end - start
            axis = np.array([-edge[1], edge[0]]) / np.linalg.norm(edge)
            pa, pb = a @ axis, b @ axis
            overlap = min(max(pa), max(pb)) - max(min(pa), min(pb))
            if overlap < 0:
                separated = True
            penetration = min(penetration, overlap)
    if not separated:
        return -float(max(0, penetration))
    distance = float("inf")
    for vertices, polygon in ((a, b), (b, a)):
        for point in vertices:
            for start, end in zip(polygon, np.roll(polygon, -1, axis=0)):
                segment = end - start
                t = np.clip(np.dot(point - start, segment) / np.dot(segment, segment), 0, 1)
                distance = min(distance, float(np.linalg.norm(point - (start + t * segment))))
    return distance


class StabilityGate:
    def __init__(self, seconds=1.0, movement_cm=.5, rotation_deg=3):
        self.seconds, self.movement_cm = seconds, movement_cm
        self.rotation_rad = math.radians(rotation_deg)
        self.reset()

    def reset(self):
        self.anchor = None
        self.since = None
        self.last = None
        self.samples = deque(maxlen=20)

    @property
    def jitter_cm(self):
        if len(self.samples) < 2:
            return 0.0
        # Largest per-phone radial standard deviation across the latest static samples.
        return float(max(np.sqrt(np.sum(np.var(np.asarray(self.samples), axis=0), axis=1))))

    def observe(self, phones, now, invalid_reason=None):
        if invalid_reason or len(phones) != 2 or {p["role"] for p in phones} != {"A", "B"}:
            self.reset()
            return False, 0, invalid_reason or "Detecting Phone A / Phone B"
        phones = sorted(phones, key=lambda p: p["role"])
        if any(not math.isfinite(p["confidence"]) or p["confidence"] < .6 for p in phones):
            self.reset()
            return False, 0, "Low marker confidence"
        gap = polygon_gap(phones[0]["cornersCm"], phones[1]["cornersCm"])
        if gap < -.2:
            self.reset()
            return False, 0, "Phone outlines overlap; check offsets and calibration"
        interrupted = self.last is not None and (now - self.last > .3 or now < self.last)
        self.last = now
        moved = self.anchor is not None and any(
            math.hypot(p["centreCm"]["x"] - a["centreCm"]["x"], p["centreCm"]["y"] - a["centreCm"]["y"]) > self.movement_cm
            or abs(wrap(p["headingRad"] - a["headingRad"])) > self.rotation_rad
            for p, a in zip(phones, self.anchor))
        if self.anchor is None or moved or interrupted:
            self.anchor, self.since = phones, now
            self.samples.clear()
        self.samples.append([[p["centreCm"]["x"], p["centreCm"]["y"]] for p in phones])
        duration = now - self.since
        return duration >= self.seconds, int(duration * 1000), "Phones moved; settling" if moved else "Hold both phones still"
