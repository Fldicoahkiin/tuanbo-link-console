"""Pixel-level face-skin confidence; explicit optional model, no identities."""
import hashlib

import mediapipe as mp
import numpy as np
from inference_options import ThreadedBaseOptions
from semantic_frame import analysis_frames

MODEL_SHA256 = 'c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0'
LABELS = ['background', 'hair', 'body-skin', 'face-skin', 'clothes', 'others']


def face_confidence(result, width, height):
    masks = result.confidence_masks
    if masks is None or len(masks) != len(LABELS):
        raise ValueError('Missing semantic probability channels')
    arrays = []
    for mask in masks:
        array = mask.numpy_view()
        if array.shape != (height, width) or array.dtype != np.float32 or \
                not np.isfinite(array).all() or np.any(array < 0) or np.any(array > 1):
            raise ValueError('Invalid semantic probabilities')
        arrays.append(array)
    if not np.allclose(np.sum(arrays, axis=0), 1, rtol=0, atol=.01):
        raise ValueError('Semantic classes do not sum to one')
    # Detach the selected plane from native output packet lifetime.
    return arrays[3].copy()


class FaceSegmentation:
    def __init__(self, model, threads=4):
        if hashlib.sha256(model).hexdigest() != MODEL_SHA256:
            raise ValueError('Semantic model checksum mismatch')
        options = mp.tasks.vision.ImageSegmenterOptions(base_options=ThreadedBaseOptions(model, threads),
            running_mode=mp.tasks.vision.RunningMode.IMAGE, output_category_mask=False, output_confidence_masks=True)
        self.segmenter = mp.tasks.vision.ImageSegmenter.create_from_options(options)
        try:
            if self.segmenter.labels != LABELS:
                raise ValueError('Unexpected semantic model categories')
        except BaseException:
            self.segmenter.close()
            raise

    def analyze(self, rgb):
        frames = analysis_frames(rgb)
        output = np.zeros(rgb.shape[:2], dtype=np.float32)
        for frame in frames:
            image = mp.Image(image_format=mp.ImageFormat.SRGB, data=frame.pixels)
            edge = frame.pixels.shape[0]
            np.maximum(output, frame.restore(face_confidence(self.segmenter.segment(image), edge, edge)), out=output)
        return output

    def close(self):
        self.segmenter.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
