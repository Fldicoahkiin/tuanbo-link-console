"""Explicit GPU segmentation using the original MediaPipe pixel contract."""
import hashlib

import cv2
import numpy as np
from directml_execution import run
from semantic_frame import analysis_frames

MODEL_SHA256 = '35ec1ecd9ee7f85073c99c00020b7f6751b69506eeacf683bc8665f6117f85b0'
PROBABILITY_MODEL_SHA256 = '80bd994edb6437c8eed7a5d16b2dbdaa9635a166de190a9fd437b35e48461e5f'


def probabilities(logits):
    if logits.shape != (1, 256, 256, 6) or logits.dtype != np.float32 or not np.isfinite(logits).all():
        raise ValueError('Invalid semantic logits')
    values = np.exp(logits[0] - logits[0].max(axis=2, keepdims=True))
    return values / values.sum(axis=2, keepdims=True)


def input_tensor(rgb):
    # MediaPipe warps bytes before normalization. resize() has different pixel
    # centers and changes semantic edges. Original metadata specifies [-1, 1].
    height, width = rgb.shape[:2]
    resized = cv2.warpPerspective(rgb, np.diag([256/width, 256/height, 1]),
        (256, 256), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    return ((resized.astype(np.float32)-127.5)/127.5)[None]


class DirectMLFaceSegmentation:
    def __init__(self, model, *, probability_output=False):
        if type(probability_output) is not bool:
            raise ValueError('Semantic probability output must be boolean')
        self.probability_output=probability_output
        if hashlib.sha256(model).hexdigest() != (PROBABILITY_MODEL_SHA256 if probability_output else MODEL_SHA256):
            raise ValueError('DirectML semantic model checksum mismatch')
        import onnxruntime as ort
        if ort.__version__ != '1.24.4' or 'DmlExecutionProvider' not in ort.get_available_providers():
            raise RuntimeError('Pinned DirectML provider unavailable')
        options = ort.SessionOptions()
        options.enable_mem_pattern = False
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        options.add_session_config_entry('session.disable_cpu_ep_fallback', '1')
        self.session = ort.InferenceSession(model, sess_options=options, providers=['DmlExecutionProvider'])
        self.session.disable_fallback()
        if not self.session.get_providers() or self.session.get_providers()[0] != 'DmlExecutionProvider':
            raise RuntimeError('DirectML semantic session switched providers')
        inputs, outputs = self.session.get_inputs(), self.session.get_outputs()
        if len(inputs) != 1 or inputs[0].name != 'input_29' or inputs[0].shape != [1,256,256,3] or inputs[0].type != 'tensor(float)':
            raise ValueError('Unexpected DirectML semantic input')
        output_name='skin_probability' if probability_output else 'Identity'
        output_shape=[1,256,256] if probability_output else [1,256,256,6]
        if len(outputs) != 1 or outputs[0].name != output_name or outputs[0].shape != output_shape or outputs[0].type != 'tensor(float)':
            raise ValueError('Unexpected DirectML semantic output')
        self.output_name=output_name

    def analyze(self, rgb):
        frames = analysis_frames(rgb)
        output = np.zeros(rgb.shape[:2], dtype=np.float32)
        for frame in frames:
            result = run(self.session, [self.output_name], {'input_29': input_tensor(frame.pixels)})[0]
            if self.probability_output:
                if result.shape!=(1,256,256) or result.dtype!=np.float32 or not np.isfinite(result).all() or np.any(result<0) or np.any(result>1):
                    raise ValueError('Invalid DirectML skin probability')
                skin=result[0]
            else:
                skin=probabilities(result)[:,:,3]
            # Activation precedes interpolation; unpad only after restoring scale.
            edge = frame.pixels.shape[0]
            confidence = cv2.resize(skin, (edge, edge), interpolation=cv2.INTER_LINEAR)
            np.maximum(output, frame.restore(confidence), out=output)
        return output

    def close(self):
        self.session = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
