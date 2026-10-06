"""Bounded frame-local body smoothing; never retains absent people or masks."""
import math
import numpy as np
from body import BodyGeometry, CONFIDENCE


TORSO = [11, 12, 23, 24]


class BodyStabilizer:
    def __init__(self):
        self.previous = []
        self.timestamp = None
        self.context = None

    def update(self, bodies, timestamp_ms, context):
        _, width, height = context
        size = np.array([width, height], dtype=np.float32)
        current = [BodyGeometry(body.joints.copy(), body.mask) for body in bodies]
        dt = 0 if self.timestamp is None else (timestamp_ms-self.timestamp)/1000
        previous = self.previous if context == self.context and 0 < dt <= .25 else []
        self.timestamp, self.context = timestamp_ms, context

        def location(joints):
            torso = joints[TORSO, :2]*size
            return np.mean(torso, axis=0), np.linalg.norm((torso[0]+torso[1]-torso[2]-torso[3])*.5)

        locations = [location(body.joints) for body in bodies]
        prior_locations = [location(joints) for joints in previous]

        def nearest(value, candidates):
            center, scale = value
            ranked = sorted((np.linalg.norm(center-other)/max(scale, other_scale, 1), index)
                            for index, (other, other_scale) in enumerate(candidates))
            if not ranked or ranked[0][0] > .4:
                return None
            if len(ranked) > 1 and ranked[1][0]-ranked[0][0] < .2:
                return None
            return ranked[0][1]

        for index, body in enumerate(current):
            match = nearest(locations[index], prior_locations)
            if match is None or nearest(prior_locations[match], locations) != index:
                continue
            old = previous[match]
            scale, prior_scale = locations[index][1], prior_locations[match][1]
            if prior_scale <= 0 or not .75 <= scale/prior_scale <= 1.33:
                continue
            visible = (body.joints[:, 2] >= CONFIDENCE) & (old[:, 2] >= CONFIDENCE)
            delta = (old[:, :2]-body.joints[:, :2])*size
            speed = np.linalg.norm(delta, axis=1)/max(scale, 1)/dt
            alpha = 1-np.exp(-2*math.pi*(2+4*speed)*dt)
            lag = delta*(1-alpha[:, None])
            # At most two analysis pixels and 2% of torso length. Masks and
            # confidence are always current; occluded joints never borrow history.
            limit = min(2., float(scale)*.02)
            lag *= np.minimum(1, limit/np.maximum(np.linalg.norm(lag, axis=1), 1e-6))[:, None]
            body.joints[visible, :2] += lag[visible]/size
        self.previous = [body.joints.copy() for body in current]
        return current
