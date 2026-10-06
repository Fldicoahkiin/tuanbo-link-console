"""Experimental DirectML person instances; no Torch/MMCV runtime dependency."""
import hashlib
import time

import cv2
import numpy as np
import onnxruntime as ort

from directml_execution import run
from rtmdet_postprocess import decode_people, prepare_image


def suppress_duplicate_masks(masks):
    """Keep confidence order; suppress only near-identical nested instances."""
    kept = []
    binary = [mask >= .6 for mask in masks]
    areas = [np.count_nonzero(mask) for mask in binary]
    for index, mask in enumerate(binary):
        duplicate = False
        for previous in kept:
            intersection = np.count_nonzero(mask & binary[previous])
            union = areas[index] + areas[previous] - intersection
            if union and intersection / union >= .75 and intersection / max(min(areas[index],areas[previous]),1) >= .95:
                duplicate = True
                break
        if not duplicate:
            kept.append(index)
    return [masks[index] for index in kept]


class RTMDetInstances:
    def __init__(self, directory):
        model = directory / 'raw-heads.onnx'
        if hashlib.sha256(model.read_bytes()).hexdigest() != 'e6a5e0f5e8c6403ac3935228d66ea2b1b4d8cb67f2eb6f45eb8ef90a72653779':
            raise ValueError('RTMDet model checksum mismatch')
        if ort.__version__ != '1.24.4':
            raise ValueError('Expected ONNX Runtime DirectML 1.24.4')
        settings = ort.SessionOptions()
        settings.enable_mem_pattern = False
        settings.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        settings.intra_op_num_threads = settings.inter_op_num_threads = 1
        settings.add_session_config_entry('session.disable_cpu_ep_fallback', '1')
        self.session = ort.InferenceSession(str(model), sess_options=settings, providers=['DmlExecutionProvider'])
        self.session.disable_fallback()
        if self.session.get_providers()[0] != 'DmlExecutionProvider':
            raise ValueError('RTMDet requires DirectML')
        self.timing = {}

    def analyze(self, rgb):
        self.timing = {}
        start = time.perf_counter()
        if rgb.ndim != 3 or rgb.shape[2] != 3 or rgb.dtype != np.uint8 or not all(0 < size <= 640 for size in rgb.shape[:2]):
            raise ValueError('Invalid instance RGB frame')
        # Use the same active-image convention as the existing instance adapter.
        occupied = np.bitwise_or(rgb[:,:,0],rgb[:,:,1])
        np.bitwise_or(occupied,rgb[:,:,2],out=occupied)
        rows = np.flatnonzero(np.any(occupied, axis=1))
        if not rows.size:
            self.timing = {'preprocessMs':(time.perf_counter()-start)*1000, 'inferenceMs':0, 'postprocessMs':0}
            return []
        columns = np.flatnonzero(np.any(occupied, axis=0))
        left, right, top, bottom = int(columns[0]), int(columns[-1])+1, int(rows[0]), int(rows[-1])+1
        image, metadata = prepare_image(cv2.cvtColor(rgb[top:bottom, left:right], cv2.COLOR_RGB2BGR))
        prepared = time.perf_counter()
        raw = run(self.session, None, {'image':image})
        inferred = time.perf_counter()
        _, _, masks = decode_people(raw, metadata)
        if len(masks) > 10:
            raise ValueError('RTMDet detected more than the supported ten people')
        result = []
        for mask in masks:
            restored = np.zeros(rgb.shape[:2], dtype=np.float32)
            restored[top:bottom, left:right] = mask
            result.append(restored)
        self.timing = {'preprocessMs':(prepared-start)*1000, 'inferenceMs':(inferred-prepared)*1000,
                       'postprocessMs':(time.perf_counter()-inferred)*1000}
        return result

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.session = None
