"""Independent face proposals with five-point agreement; no persistent identity."""
from concurrent.futures import ThreadPoolExecutor
import math
import hashlib

import cv2
import mediapipe as mp
import numpy as np
from analyzer import merge_faces
from detect import face_region
from face_landmark_region import FaceLandmarkRegion

ALIGNMENT_LIMIT = .18
WORKERS = 3
PROPOSAL_SHA256 = '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'


def proposal_error(face, box, width, height):
    """Five-point agreement in detector-box units, before optional mirror remap."""
    x, y, w, h = box[:4]
    cx, cy = face['cx']*width, face['cy']*height
    if w <= 0 or h <= 0 or not (x-.15*w <= cx <= x+1.15*w and y-.15*h <= cy <= y+1.15*h):
        return None
    actual = np.array([[face['lx']*width, face['ly']*height], [face['ex']*width, face['ey']*height],
                       [face['p1x']*width, face['p1y']*height], [face['p61x']*width, face['p61y']*height],
                       [face['p291x']*width, face['p291y']*height]])
    expected = np.asarray(box[4:14]).reshape(5, 2)
    squared = np.sum((actual-expected)**2, axis=1)
    # Only symmetric feature pairs may exchange detector naming conventions.
    for first, second in [(0, 1), (3, 4)]:
        direct = squared[first]+squared[second]
        swapped = np.sum((actual[[first, second]]-expected[[second, first]])**2)
        squared[first], squared[second] = min(direct, swapped)/2, min(direct, swapped)/2
    error = float(np.sqrt(np.mean(squared))/max(w, h))
    return error if math.isfinite(error) else None


def proposal_crop(box, width, height):
    x, y, w, h = box[:4]
    edge = max(w, h)*1.8
    cx, cy = x+w/2, y+h/2
    crop = (max(0, int(cx-edge/2)), max(0, int(cy-edge/2)),
            min(width, int(cx+edge/2)), min(height, int(cy+edge/2)))
    return crop if crop[2] > crop[0] and crop[3] > crop[1] else None


class FaceProposals:
    def __init__(self, landmark_model, proposal_model, locator=None, *, batched=False):
        if hashlib.sha256(proposal_model).hexdigest() != PROPOSAL_SHA256:
            raise ValueError('Face proposal model checksum mismatch')
        # Explicitly bound OpenCV's independent native pool; the caller still
        # receives every native failure, without retries or fallback detection.
        cv2.setNumThreads(1)
        self.locator = locator
        if batched and locator is None:
            raise ValueError('Batched proposals require an explicit locator')
        self.batched=batched
        self.proposals = None if locator is not None else cv2.FaceDetectorYN.create('onnx', np.frombuffer(proposal_model, dtype=np.uint8),
            np.empty(0, dtype=np.uint8), (640, 360), .7, .3, 5000)
        self.detectors = []
        try:
            for _ in range(WORKERS):
                self.detectors.append(FaceLandmarkRegion(landmark_model))
        except BaseException:
            for detector in self.detectors:
                detector.close()
            raise
        self.executor = ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix='face-proposals')

    def _analyze(self, detector, rgb, proposals):
        height, width = rgb.shape[:2]
        results = []
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
        for order, box, _ in proposals:
            points = detector.detect(image, box)
            if points is None:
                continue
            face = face_region(points)
            if not all(math.isfinite(value) and 0 <= value <= 1 for value in face.values()):
                continue
            if face['rx'] < .005 or face['ry'] < .005:
                continue
            error = proposal_error(face, box, width, height)
            if error is not None and error <= ALIGNMENT_LIMIT:
                results.append((order, face))
        return results

    def locate(self, rgb):
        if rgb.ndim != 3 or rgb.shape[2] != 3 or rgb.dtype != np.uint8:
            raise ValueError('Face proposal input must be uint8 RGB')
        height, width = rgb.shape[:2]
        if not 0 < width <= 640 or not 0 < height <= 640:
            raise ValueError('Face proposal dimensions exceed limits')
        if self.locator is not None:
            from proposal_views import tiled_proposals
            return tiled_proposals(self.locator, rgb, 640,batched=self.batched)
        self.proposals.setInputSize((width, height))
        _, boxes = self.proposals.detect(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
        return boxes

    def refine(self, rgb, existing, boxes):
        if rgb.ndim != 3 or rgb.shape[2] != 3 or rgb.dtype != np.uint8:
            raise ValueError('Face proposal input must be uint8 RGB')
        height, width = rgb.shape[:2]
        if not 0 < width <= 640 or not 0 < height <= 640 or len(existing) > 6:
            raise ValueError('Face proposal dimensions or face count exceed limits')
        if len(existing) == 6:
            return list(existing)
        if boxes is None:
            return list(existing)
        if boxes.ndim != 2 or boxes.shape[1] != 15 or not np.isfinite(boxes).all():
            raise ValueError('Malformed face proposals')
        selected = []
        for box in sorted(boxes, key=lambda row: -row[14]):
            if box[14] < .7 or box[2] <= 0 or box[3] <= 0:
                continue
            if any((error := proposal_error(face, box, width, height)) is not None and error <= ALIGNMENT_LIMIT for face in existing):
                continue
            crop = proposal_crop(box, width, height)
            if crop is not None:
                selected.append((len(existing)+len(selected), box, crop))
            if len(selected) == 6-len(existing):
                break
        jobs = [self.executor.submit(self._analyze, detector, rgb, selected[index::WORKERS])
                for index, detector in enumerate(self.detectors)]
        return merge_faces(list(enumerate(existing)) + [candidate for job in jobs for candidate in job.result()])

    def analyze(self, rgb, existing):
        return self.refine(rgb, existing, None if len(existing) == 6 else self.locate(rgb))

    def close(self):
        self.executor.shutdown(wait=True)
        for detector in self.detectors:
            detector.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
