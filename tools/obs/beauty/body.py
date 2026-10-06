"""Frame-local body geometry and segmentation. No member identities or face binding."""
from dataclasses import dataclass
from concurrent.futures import ThreadPoolExecutor
import math

import mediapipe as mp
import numpy as np
from inference_options import ThreadedBaseOptions


BODY_LIMIT = 6
ANALYSIS_WORKERS = 4
JOINT_COUNT = 33
CONFIDENCE = 0.6


@dataclass
class BodyGeometry:
    # Each joint is x, y, visibility*presence; unavailable joints have confidence zero.
    joints: np.ndarray
    mask: np.ndarray

    def usable(self, indices):
        return all(self.joints[index, 2] >= CONFIDENCE for index in indices)


def geometry(points, mask, width, height):
    if len(points) != JOINT_COUNT:
        raise ValueError("Unexpected body landmark count")
    if mask.shape != (height, width) or not np.isfinite(mask).all():
        raise ValueError("Invalid body segmentation")
    if np.any(mask < 0) or np.any(mask > 1):
        raise ValueError("Body segmentation outside probability range")
    joints = np.zeros((JOINT_COUNT, 3), dtype=np.float32)
    for index, point in enumerate(points):
        values = (point.x, point.y, point.visibility, point.presence)
        if not all(value is not None and math.isfinite(value) for value in values):
            continue
        if not all(0 <= value <= 1 for value in values):
            continue
        joints[index] = (point.x, point.y, point.visibility * point.presence)
    result = BodyGeometry(joints, np.array(mask, dtype=np.float32, copy=True))
    # A torso must be located; individual occluded legs remain unavailable.
    if not result.usable((11, 12, 23, 24)):
        return None
    shoulders = joints[11, :2] - joints[12, :2]
    torso = (joints[11, :2] + joints[12, :2] - joints[23, :2] - joints[24, :2]) * .5
    if np.linalg.norm(shoulders * (width, height)) < 8 or np.linalg.norm(torso * (width, height)) < 12:
        return None
    return result


def exclusive_masks(bodies):
    """Preserve ambiguous overlaps instead of assigning them to an arbitrary person."""
    if not bodies:
        return []
    # Only a mask above .6 can produce output. If it is the sole strong mask,
    # the second largest probability is its strongest competitor. If two masks
    # are strong, the second largest suppresses both. Thus one shared second
    # maximum gives exactly the per-person exclusion, without an N-plane stack.
    largest = np.zeros_like(bodies[0].mask)
    second = np.zeros_like(largest)
    lower = np.empty_like(largest)
    for body in bodies:
        np.minimum(largest, body.mask, out=lower)
        np.maximum(second, lower, out=second)
        np.maximum(largest, body.mask, out=largest)
    np.subtract(.4, second, out=second)
    np.divide(second, .2, out=second)
    np.clip(second, 0, 1, out=second)
    masks = []
    for body in bodies:
        weight = np.subtract(body.mask, .6)
        np.divide(weight, .3, out=weight)
        np.clip(weight, 0, 1, out=weight)
        np.multiply(weight, second, out=weight)
        masks.append(weight)
    return masks


class BodyAnalyzer:
    def __init__(self, model, *, threads=2, workers=ANALYSIS_WORKERS):
        if type(workers) is not int or not 1 <= workers <= 7:
            raise ValueError('Body analysis worker count must be 1..7')
        self.workers = workers
        options = mp.tasks.vision.PoseLandmarkerOptions(
            base_options=ThreadedBaseOptions(model, threads),
            running_mode=mp.tasks.vision.RunningMode.IMAGE,
            num_poses=BODY_LIMIT, output_segmentation_masks=True,
            min_pose_detection_confidence=.6, min_pose_presence_confidence=.6)
        self.detectors = []
        try:
            for _ in range(self.workers):
                self.detectors.append(mp.tasks.vision.PoseLandmarker.create_from_options(options))
        except BaseException:
            for detector in self.detectors:
                detector.close()
            raise
        self.executor = ThreadPoolExecutor(max_workers=self.workers, thread_name_prefix='body-analysis')

    def _analyze_views(self, detector, rgb, views):
        height,width=rgb.shape[:2]
        candidates=[]
        for order,(x0,y0,x1,y1) in views:
            crop=np.ascontiguousarray(rgb[y0:y1,x0:x1])
            result=detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB,data=crop))
            masks=result.segmentation_masks or []
            if len(masks)!=len(result.pose_landmarks) or len(masks)>BODY_LIMIT:
                raise ValueError('Body landmark and segmentation counts differ')
            for points,mask in zip(result.pose_landmarks,masks):
                body=geometry(points,mask.numpy_view(),x1-x0,y1-y0)
                if body is None:
                    continue
                body.joints[:,0]=(body.joints[:,0]*(x1-x0)+x0)/width
                body.joints[:,1]=(body.joints[:,1]*(y1-y0)+y0)/height
                fullmask=np.zeros((height,width),dtype=np.float32)
                fullmask[y0:y1,x0:x1]=body.mask
                body.mask=fullmask
                candidates.append((order,body))
        return candidates

    def analyze(self, rgb):
        if rgb.ndim != 3 or rgb.shape[2] != 3 or rgb.dtype != np.uint8:
            raise ValueError("Body input must be uint8 RGB")
        height, width = rgb.shape[:2]
        bodies = []
        # Full image plus overlapping tiles: group subjects are much smaller than
        # the single-person framing on which this detector is strongest.
        views = [(0,0,width,height)]
        for x0,x1 in [(0,.6),(.2,.8),(.4,1)]:
            for y0,y1 in [(0,.6),(.4,1)]:
                views.append((int(x0*width),int(y0*height),int(x1*width),int(y1*height)))
        indexed=list(enumerate(views))
        jobs=[self.executor.submit(self._analyze_views,detector,rgb,indexed[index::self.workers])
              for index,detector in enumerate(self.detectors)]
        candidates=[candidate for job in jobs for candidate in job.result()]
        # Recombine in fixed spatial order; scheduling must not change which body wins.
        for _,body in sorted(candidates,key=lambda candidate:candidate[0]):
            center=np.mean(body.joints[[11,12,23,24],:2],axis=0)
            scale=np.linalg.norm(body.joints[11,:2]-body.joints[23,:2])
            if any(np.linalg.norm(np.mean(other.joints[[11,12,23,24],:2],axis=0)-center)<scale*.4 for other in bodies):
                continue
            bodies.append(body)
            if len(bodies)==BODY_LIMIT:
                return bodies
        return bodies

    def close(self):
        self.executor.shutdown(wait=True)
        for detector in self.detectors:
            detector.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
