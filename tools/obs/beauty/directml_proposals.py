"""Explicit experimental YuNet DirectML inference; no CPU fallback.

Tensor decoding contract checked against OpenCV 4.11 FaceDetectorYN:
https://github.com/opencv/opencv/blob/4.11.0/modules/objdetect/src/face_detect.cpp
"""
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np
from directml_execution import run

STRIDES = (8,16,32)
OUTPUT_NAMES = tuple(f'{kind}_{stride}' for kind in ('cls','obj','bbox','kps') for stride in STRIDES)


def decode(outputs):
    if len(outputs) != 12:
        raise ValueError('Missing YuNet output tensors')
    for index, value in enumerate(outputs):
        channels = (1,1,4,10)[index//3]
        if value.shape != (1,(640//STRIDES[index%3])**2,channels) or value.dtype != np.float32 or not np.isfinite(value).all():
            raise ValueError('Invalid YuNet output shape, dtype or values')
    candidates = []
    for level,stride in enumerate(STRIDES):
        score = np.sqrt(np.clip(outputs[level][0,:,0],0,1)*np.clip(outputs[level+3][0,:,0],0,1))
        indices = np.flatnonzero(score >= .7)
        if not indices.size:
            continue
        grid = np.column_stack((indices%(640//stride),indices//(640//stride))).astype(np.float32)
        regression = outputs[level+6][0,indices]
        center = (grid+regression[:,:2])*stride
        with np.errstate(over='raise',invalid='raise'):
            try:
                size = np.exp(regression[:,2:])*stride
            except FloatingPointError as error:
                raise ValueError('Invalid YuNet box extent') from error
        points = (outputs[level+9][0,indices].reshape(-1,5,2)+grid[:,None,:])*stride
        rows = np.concatenate((center-size*.5,size,points.reshape(-1,10),score[indices,None]),axis=1)
        if not np.isfinite(rows).all() or np.any(np.abs(rows[:,:14]) >= 2**30):
            raise ValueError('Unbounded YuNet coordinates')
        candidates.append(rows)
    if not candidates:
        return None
    rows = np.concatenate(candidates).astype(np.float32)
    if len(rows)==1:
        return rows
    # OpenCV 4.11 uses integer rectangles for NMS, truncating toward zero.
    keep = cv2.dnn.NMSBoxes(rows[:,:4].astype(np.int32).tolist(),rows[:,14].tolist(),.7,.3,top_k=5000)
    return rows[np.asarray(keep,dtype=np.int32).reshape(-1)]


class DirectMLProposals:
    def __init__(self, model, *, batch_size=1):
        if batch_size not in (1,3):
            raise ValueError('Proposal batch size must be one or three')
        self.batch_size=batch_size
        expected = json.loads(Path(__file__).with_name('assets.json').read_text(encoding='utf-8'))['proposalModel']['sha256'] if batch_size==1 else 'c53d6a33b45f3145730834de1a7c4bb1edd5ad977d6a7a13d2aa266387a1c1b2'
        if hashlib.sha256(model).hexdigest()!=expected:
            raise ValueError('DirectML proposal model checksum mismatch')
        import onnxruntime as ort
        if ort.__version__!='1.24.4' or 'DmlExecutionProvider' not in ort.get_available_providers():
            raise RuntimeError('Pinned DirectML provider unavailable')
        options = ort.SessionOptions()
        options.enable_mem_pattern=False
        options.execution_mode=ort.ExecutionMode.ORT_SEQUENTIAL
        options.intra_op_num_threads=1
        options.inter_op_num_threads=1
        options.add_session_config_entry('session.disable_cpu_ep_fallback','1')
        self.session = ort.InferenceSession(model,sess_options=options,providers=['DmlExecutionProvider'])
        self.session.disable_fallback()
        if not self.session.get_providers() or self.session.get_providers()[0]!='DmlExecutionProvider':
            raise RuntimeError('DirectML session did not retain its requested provider')
        inputs = self.session.get_inputs()
        if len(inputs)!=1 or inputs[0].shape != [batch_size,3,640,640] or inputs[0].type!='tensor(float)':
            raise ValueError('Unexpected DirectML proposal input')
        if tuple(value.name for value in self.session.get_outputs())!=OUTPUT_NAMES:
            raise ValueError('Unexpected DirectML proposal outputs')
        self.input_name = inputs[0].name

    def locate(self, rgb):
        if self.batch_size!=1:
            raise ValueError('Three-view model requires locate_many')
        if rgb.ndim!=3 or rgb.shape[2]!=3 or rgb.dtype!=np.uint8 or not all(0<value<=640 for value in rgb.shape[:2]):
            raise ValueError('Expected bounded uint8 RGB proposal image')
        height,width = rgb.shape[:2]
        canvas = np.zeros((640,640,3),dtype=np.uint8)
        canvas[:height,:width] = cv2.cvtColor(rgb,cv2.COLOR_RGB2BGR)
        return decode(run(self.session,list(OUTPUT_NAMES),{self.input_name:cv2.dnn.blobFromImage(canvas)}))

    def locate_many(self, images):
        if self.batch_size!=3 or not 1<=len(images)<=3:
            raise ValueError('Expected one to three views with the batched model')
        tensor=np.zeros((3,3,640,640),dtype=np.float32)
        for index,rgb in enumerate(images):
            if rgb.ndim!=3 or rgb.shape[2]!=3 or rgb.dtype!=np.uint8 or not all(0<size<=640 for size in rgb.shape[:2]):
                raise ValueError('Invalid batched proposal view')
            tensor[index,:,:rgb.shape[0],:rgb.shape[1]]=cv2.cvtColor(rgb,cv2.COLOR_RGB2BGR).transpose(2,0,1)
        outputs=run(self.session,list(OUTPUT_NAMES),{self.input_name:tensor})
        if any(value.shape[0]!=3 for value in outputs):
            raise ValueError('Unexpected proposal output batch')
        return [decode([value[index:index+1] for value in outputs]) for index in range(len(images))]

    def close(self):
        self.session=None

    def __enter__(self):
        return self

    def __exit__(self,*_):
        self.close()
