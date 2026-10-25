"""Low-latency smoothing for live Swipe poses (One Euro filter)."""
import math


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
    """Smooths each phone's centre and heading. Forgets a phone that vanished or jumped."""

    def __init__(self, min_cutoff=2.0, position_beta=.4, heading_beta=1.5, forget_s=.5, jump_cm=15):
        self.settings = (min_cutoff, position_beta, heading_beta)
        self.forget_s, self.jump_cm = forget_s, jump_cm
        self.filters, self.seen = {}, {}

    def reset(self):
        self.filters.clear()
        self.seen.clear()

    def _filters(self, role):
        cutoff, position_beta, heading_beta = self.settings
        return self.filters.setdefault(role, (OneEuro(cutoff, position_beta), OneEuro(cutoff, position_beta),
                                              OneEuro(cutoff, heading_beta, angular=True)))

    def apply(self, phones, now):
        present = {p['role'] for p in phones}
        for role in list(self.filters):
            if role not in present and now - self.seen.get(role, now) > self.forget_s:
                self.filters.pop(role)
                self.seen.pop(role, None)
        smoothed = []
        for phone in phones:
            role = phone['role']
            fx, fy, fh = self._filters(role)
            centre = phone['centreCm']
            if fx.x is not None and math.hypot(centre['x'] - fx.x, centre['y'] - fy.x) > self.jump_cm:
                for f in (fx, fy, fh):
                    f.reset()
            self.seen[role] = now
            smoothed.append({**phone, 'centreCm': {'x': float(fx(centre['x'], now)), 'y': float(fy(centre['y'], now))},
                             'headingRad': float(fh(phone['headingRad'], now))})
        return smoothed
