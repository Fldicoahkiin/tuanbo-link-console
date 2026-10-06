"""Short-lived geometric smoothing, without names, identities or retained missing faces."""
import math
from landmarks import POINT_KEYS

GEOMETRY = ("cx", "cy", "rx", "ry", "lx", "ly", "ex", "ey") + POINT_KEYS


def distance(a, b):
    return math.hypot((a["cx"] - b["cx"]) / max(a["rx"], b["rx"]),
                      (a["cy"] - b["cy"]) / max(a["ry"], b["ry"]))


class GeometryStabilizer:
    def __init__(self):
        self.previous = []
        self.timestamp = None
        self.context = None

    def update(self, faces, timestamp_ms, context):
        current = [dict(face) for face in faces]
        dt = 0 if self.timestamp is None else (timestamp_ms - self.timestamp) / 1000
        previous = self.previous if context == self.context and 0 < dt <= .25 else []
        self.timestamp, self.context = timestamp_ms, context
        # Only reciprocal, unambiguous spatial matches are smoothed. During
        # overlaps or abrupt cuts use current detections, never guessed identities.
        def nearest(face, candidates):
            ranked = sorted((distance(face, item), index) for index, item in enumerate(candidates))
            if not ranked or ranked[0][0] > .65:
                return None
            if len(ranked) > 1 and ranked[1][0] - ranked[0][0] < .2:
                return None
            return ranked[0][1]

        for index, face in enumerate(current):
            match = nearest(face, previous)
            if match is None or nearest(previous[match], faces) != index:
                continue
            old = previous[match]
            if not all(.75 <= face[key] / old[key] <= 1.33 for key in ("rx", "ry")):
                continue
            speed = distance(face, old) / dt
            alpha = 1 - math.exp(-2 * math.pi * (2 + 4 * speed) * dt)
            for key in GEOMETRY:
                axis = "rx" if key.endswith("x") else "ry"
                # Bound geometric lag to 3% of the current face radius.
                limit = face[axis] * .03
                delta = (old[key] - face[key]) * (1 - alpha)
                face[key] += max(-limit, min(limit, delta))
        self.previous = [dict(face) for face in current]
        return current
