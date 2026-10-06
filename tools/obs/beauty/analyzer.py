"""Bounded multiscale face views, without member identities."""
import math
from concurrent.futures import ThreadPoolExecutor
import mediapipe as mp
import numpy as np
from detect import face_region
from landmarks import POINT_KEYS

ANALYSIS_WORKERS = 3


def analysis_views(width, height):
    views = [(0, 0, width, height)]
    if width >= height:
        views += [(0, 0, int(width*.625), height), (int(width*.375), 0, width, height)]
    else:
        views += [(0, 0, width, int(height*.625)), (0, int(height*.375), width, height)]
    edge = max(96, math.ceil(max(width, height)/4))
    def starts(length):
        end = max(0, length-edge)
        steps = max(1, math.ceil(end/(edge*.75)))
        return sorted(set(round(end*index/steps) for index in range(steps+1)))
    views += [(x, y, min(width, x+edge), min(height, y+edge)) for y in starts(height) for x in starts(width)]
    return list(dict.fromkeys(views))


def merge_faces(candidates):
    faces = []
    for _, face in sorted(candidates, key=lambda item: item[0]):
        if any(((f['cx']-face['cx'])/max(f['rx'],face['rx']))**2 +
               ((f['cy']-face['cy'])/max(f['ry'],face['ry']))**2 < .25 for f in faces):
            continue
        faces.append(face)
        if len(faces) == 6:
            break
    return faces


def occupied_views(rgb):
    """Keep original view order; omit only crops with no nonzero RGB byte."""
    height, width = rgb.shape[:2]
    return [(order, bounds) for order, bounds in enumerate(analysis_views(width, height))
            if np.any(rgb[bounds[1]:bounds[3], bounds[0]:bounds[2]])]


class FaceAnalyzer:
    def __init__(self, model):
        options = mp.tasks.vision.FaceLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_buffer=model),
            running_mode=mp.tasks.vision.RunningMode.IMAGE, num_faces=6)
        self.detectors = []
        try:
            for _ in range(ANALYSIS_WORKERS):
                self.detectors.append(mp.tasks.vision.FaceLandmarker.create_from_options(options))
        except BaseException:
            for detector in self.detectors:
                detector.close()
            raise
        self.executor = ThreadPoolExecutor(max_workers=ANALYSIS_WORKERS, thread_name_prefix='face-analysis')

    def _analyze_views(self, detector, rgb, views):
        height, width = rgb.shape[:2]
        candidates = []
        for order, (x0, y0, x1, y1) in views:
            image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb[y0:y1, x0:x1]))
            result = detector.detect(image)
            for landmarks in result.face_landmarks:
                face = face_region(landmarks)
                if order >= 3 and not (0 <= face['cx']-face['rx'] and face['cx']+face['rx'] <= 1 and
                                      0 <= face['cy']-face['ry'] and face['cy']+face['ry'] <= 1):
                    continue
                for key in ("cx", "lx", "ex") + tuple(key for key in POINT_KEYS if key.endswith("x")):
                    face[key] = (face[key] * (x1 - x0) + x0) / width
                for key in ("cy", "ly", "ey") + tuple(key for key in POINT_KEYS if key.endswith("y")):
                    face[key] = (face[key] * (y1 - y0) + y0) / height
                face["rx"] *= (x1 - x0) / width
                face["ry"] *= (y1 - y0) / height
                if not all(math.isfinite(value) and 0 <= value <= 1 for value in face.values()):
                    continue
                if face["rx"] < 0.005 or face["ry"] < 0.005:
                    continue
                candidates.append((order, face))
        return candidates

    def analyze(self, rgb):
        if rgb.ndim != 3 or rgb.shape[2] != 3 or rgb.dtype != np.uint8:
            raise ValueError('Face input must be uint8 RGB')
        height, width = rgb.shape[:2]
        if not 0 < width <= 640 or not 0 < height <= 640:
            raise ValueError('Face analysis dimensions must be within 640 pixels')
        views = occupied_views(rgb)
        jobs = [self.executor.submit(self._analyze_views, detector, rgb, views[index::ANALYSIS_WORKERS])
                for index, detector in enumerate(self.detectors)]
        return merge_faces([candidate for job in jobs for candidate in job.result()])

    def close(self):
        self.executor.shutdown(wait=True)
        for detector in self.detectors:
            detector.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
