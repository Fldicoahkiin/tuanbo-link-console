"""Verified CPU instance segmentation for explicit experimental body protection."""
import hashlib
import json
import time
from pathlib import Path
import cv2
import numpy as np


class PersonInstances:
    def __init__(self, directory, *, threads=4, cpu_pinning=False):
        if type(threads) is not int or threads not in (1,2,4,8):
            raise ValueError('Instance CPU threads must be 1, 2, 4 or 8')
        if type(cpu_pinning) is not bool:
            raise ValueError('Instance CPU pinning must be boolean')
        assets = json.loads(Path(__file__).with_name('instance-assets.json').read_text(encoding='utf-8'))
        for asset in assets['files']:
            data = (directory/asset['file']).read_bytes()
            if hashlib.sha256(data).hexdigest() != asset['sha256'] or hashlib.sha384(data).hexdigest() != asset['sha384']:
                raise ValueError('Instance model checksum mismatch')
        import openvino as ov
        if ov.__version__.split('-')[0] != '2024.6.0':
            raise ValueError('Expected OpenVINO 2024.6.0')
        self.compiled = ov.Core().compile_model(str(directory/'model.xml'),'CPU',{'INFERENCE_NUM_THREADS':threads,'NUM_STREAMS':1,'ENABLE_CPU_PINNING':cpu_pinning})

    def analyze(self, rgb):
        self.timing = {}
        started = time.perf_counter()
        if rgb.ndim != 3 or rgb.shape[2] != 3 or rgb.dtype != np.uint8 or not all(0 < n <= 640 for n in rgb.shape[:2]):
            raise ValueError('Invalid instance RGB frame')
        height,width = rgb.shape[:2]
        occupied = np.any(rgb != 0,axis=2)
        rows = np.flatnonzero(np.any(occupied,axis=1))
        if not rows.size:
            self.timing = {'preprocessMs':(time.perf_counter()-started)*1000,'inferenceMs':0,'postprocessMs':0}
            return []
        columns = np.flatnonzero(np.any(occupied,axis=0))
        left,right,top,bottom = int(columns[0]),int(columns[-1])+1,int(rows[0]),int(rows[-1])+1
        active_width,active_height = right-left,bottom-top
        data = cv2.resize(cv2.cvtColor(rgb[top:bottom,left:right],cv2.COLOR_RGB2BGR),(544,320)).transpose(2,0,1)[None].astype(np.float32)
        prepared = time.perf_counter()
        output = self.compiled([data])
        inferred = time.perf_counter()
        boxes = output[self.compiled.output('boxes')]
        labels = output[self.compiled.output('labels')]
        masks = output[self.compiled.output('masks')]
        if boxes.ndim != 2 or boxes.shape[1] != 5 or len(boxes)>10 or masks.shape != (len(boxes),224,224) or labels.shape != (len(boxes),):
            raise ValueError('Invalid instance output shape')
        if not np.isfinite(boxes).all() or not np.isfinite(masks).all() or np.any(masks<0) or np.any(masks>1) or np.any(labels != 0):
            raise ValueError('Invalid instance output values')
        result = []
        for box,mask in zip(boxes,masks):
            if not 0 <= box[4] <= 1 or box[2]<=box[0] or box[3]<=box[1]:
                raise ValueError('Invalid instance box')
            if box[4] < .5:
                continue
            x0,y0,x1,y1 = box[:4]*np.array([active_width/544,active_height/320,active_width/544,active_height/320])+np.array([left,top,left,top])
            transform = np.array([[(x1-x0)/224,0,x0],[0,(y1-y0)/224,y0]],dtype=np.float32)
            restored = cv2.warpAffine(mask,transform,(width,height),flags=cv2.INTER_LINEAR,borderMode=cv2.BORDER_CONSTANT,borderValue=0)
            restored[:top]=0; restored[bottom:]=0; restored[:,:left]=0; restored[:,right:]=0
            result.append(restored)
        self.timing = {'preprocessMs':(prepared-started)*1000,'inferenceMs':(inferred-prepared)*1000,
            'postprocessMs':(time.perf_counter()-inferred)*1000}
        return result

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.compiled = None
