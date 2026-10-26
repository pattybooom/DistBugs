"""Low-latency smoothing for live Swipe poses (One Euro filter)."""
import math
from geometry import rectangle


def wrap(angle):
    return math.atan2(math.sin(angle), math.cos(angle))


def _alpha(cutoff, dt):
    return 1 / (1 + 1 / (2 * math.pi * cutoff) / dt)


class OneEuro:
    """Heavy smoothing while slow, little lag while fast: cutoff rises with speed."""

    def __init__(self, min_cutoff, beta, angular=False, d_cutoff=1.0):
        self.min_cutoff, self.beta, self.angular, self.d_cutoff = min_cutoff, beta, angular, d_cutoff
        self.reset()

    def reset(self):
        self.x = self.dx = self.t = None

    def __call__(self, value, now):
        if self.t is None or now <= self.t:
            if self.t is None:
                self.x, self.dx, self.t = value, 0.0, now
            return wrap(self.x) if self.angular else self.x
        dt = now - self.t
        if self.angular:
            value = self.x + wrap(value - self.x)
        self.dx += _alpha(self.d_cutoff, dt) * ((value - self.x) / dt - self.dx)
        self.x += _alpha(self.min_cutoff + self.beta * abs(self.dx), dt) * (value - self.x)
        self.t = now
        return wrap(self.x) if self.angular else self.x


class PoseSmoother:
    """Smooth live poses while rejecting one-frame corner/decoder spikes.

    A single ArUco frame can decode correctly while its four corners move by a
    few pixels. After perspective projection that can look like a centimetre
    jump. A three-sample median removes that isolated spike, then One Euro
    keeps the result responsive when a phone really moves.
    """

    def __init__(self, min_cutoff=.8, position_beta=.15, heading_beta=.5, forget_s=.5, jump_cm=15, median_size=3):
        self.settings = (min_cutoff, position_beta, heading_beta)
        self.forget_s, self.jump_cm = forget_s, jump_cm
        self.median_size = median_size
        self.filters, self.seen = {}, {}
        self.history = {}

    def reset(self, role=None):
        if role is None:
            self.filters.clear()
            self.seen.clear()
            self.history.clear()
        else:
            self.filters.pop(role, None)
            self.seen.pop(role, None)
            self.history.pop(role, None)

    def _filters(self, role):
        cutoff, position_beta, heading_beta = self.settings
        return self.filters.setdefault(role, (OneEuro(cutoff, position_beta), OneEuro(cutoff, position_beta),
                                              OneEuro(cutoff, heading_beta, angular=True), OneEuro(cutoff, .05)))

    def apply(self, phones, now):
        present = {p['role'] for p in phones}
        for role in list(self.filters):
            if now - self.seen.get(role, now) > self.forget_s:
                self.filters.pop(role)
                self.seen.pop(role, None)
                self.history.pop(role, None)
        smoothed = []
        for phone in phones:
            role = phone['role']
            fx, fy, fh, fw = self._filters(role)
            history = self.history.setdefault(role, [])
            history.append(phone)
            if len(history) > self.median_size:
                del history[:-self.median_size]
            # Three samples suppress a bad frame without making a real move sticky.
            median_x = sorted(item['centreCm']['x'] for item in history)[len(history) // 2]
            median_y = sorted(item['centreCm']['y'] for item in history)[len(history) // 2]
            origin = history[0]['headingRad']
            median_heading = origin + sorted(wrap(item['headingRad'] - origin) for item in history)[len(history) // 2]
            # Only reset for a sustained jump. A one-frame decoder/corner
            # spike must reach the median first, otherwise it would become the
            # new filter origin and visibly teleport the screen.
            if fx.x is not None and math.hypot(median_x - fx.x, median_y - fy.x) > self.jump_cm:
                for f in (fx, fy, fh, fw):
                    f.reset()
            self.seen[role] = now
            result = {**phone, 'centreCm': {'x': float(fx(median_x, now)), 'y': float(fy(median_y, now))},
                      'headingRad': float(fh(median_heading, now))}
            if 'widthCm' in phone and 'heightCm' in phone:
                width = sorted(item['widthCm'] for item in history)[len(history) // 2]
                result['widthCm'] = float(fw(width, now))
                result['heightCm'] = result['widthCm'] * phone['heightCm'] / phone['widthCm']
                result['cornersCm'] = rectangle((result['centreCm']['x'], result['centreCm']['y']),
                                                result['headingRad'], result['widthCm'], result['heightCm']).tolist()
            smoothed.append(result)
        return smoothed
