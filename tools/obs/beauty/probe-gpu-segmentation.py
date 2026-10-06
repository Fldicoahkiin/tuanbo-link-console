"""Compare converted-model DirectML probabilities with pinned MediaPipe outputs."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import time

import cv2
import mediapipe as mp
import numpy as np
from face_segmentation import ThreadedBaseOptions, LABELS, MODEL_SHA256

ONNX_SHA256='35ec1ecd9ee7f85073c99c00020b7f6751b69506eeacf683bc8665f6117f85b0'


def probabilities(logits):
    if logits.shape!=(1,256,256,6) or logits.dtype!=np.float32 or not np.isfinite(logits).all():
        raise ValueError('Invalid semantic logits')
    values=np.exp(logits[0]-logits[0].max(axis=2,keepdims=True))
    return values/values.sum(axis=2,keepdims=True)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime',type=Path,required=True)
    parser.add_argument('--work',type=Path,default=Path('artifacts/beauty-prototype'))
    args=parser.parse_args()
    sys.path.insert(0,str(args.runtime.resolve()))
    import onnxruntime as ort
    if ort.__version__!='1.24.4' or 'DmlExecutionProvider' not in ort.get_available_providers():
        raise ValueError('Pinned DirectML runtime unavailable')
    onnx=(args.work/'selfie_multiclass_256x256.onnx').read_bytes()
    tflite=(args.work/'selfie_multiclass_256x256.tflite').read_bytes()
    if hashlib.sha256(onnx).hexdigest()!=ONNX_SHA256 or hashlib.sha256(tflite).hexdigest()!=MODEL_SHA256:
        raise ValueError('Semantic model checksum mismatch')
    directory=Path(tempfile.mkdtemp(prefix='gpu-segmentation-',dir=args.work))
    report={'scope':__doc__,'qualityAccepted':False,'onnxSha256':ONNX_SHA256,'tfliteSha256':MODEL_SHA256,
        'normalization':{'mean':127.5,'std':127.5,'source':'Verified original TFLite embedded metadata'},'samples':[]}
    options=ort.SessionOptions()
    options.enable_mem_pattern=False
    options.execution_mode=ort.ExecutionMode.ORT_SEQUENTIAL
    options.intra_op_num_threads=1
    options.inter_op_num_threads=1
    options.enable_profiling=True
    options.profile_file_prefix=str(directory/'directml')
    options.add_session_config_entry('session.disable_cpu_ep_fallback','1')
    gpu=ort.InferenceSession(onnx,sess_options=options,providers=['DmlExecutionProvider'])
    gpu.disable_fallback()
    if gpu.get_providers()[0]!='DmlExecutionProvider':
        raise RuntimeError('DirectML session switched providers')
    settings=mp.tasks.vision.ImageSegmenterOptions(base_options=ThreadedBaseOptions(tflite,4),
        running_mode=mp.tasks.vision.RunningMode.IMAGE,output_confidence_masks=True,output_category_mask=False)
    cv2.setNumThreads(1)
    try:
        with mp.tasks.vision.ImageSegmenter.create_from_options(settings) as baseline:
            if baseline.labels!=LABELS:
                raise ValueError('Semantic labels changed')
            for stamp in (4000,8000,10000,12000,14000):
                bgr=cv2.imdecode(np.frombuffer((args.work/'face-segmentation-clc958q0'/f'{stamp}-source.png').read_bytes(),dtype=np.uint8),cv2.IMREAD_COLOR)
                for size in ((256,256),(640,360)):
                    rgb=cv2.cvtColor(cv2.resize(bgr,size,interpolation=cv2.INTER_LINEAR),cv2.COLOR_BGR2RGB)
                    image=mp.Image(image_format=mp.ImageFormat.SRGB,data=rgb)
                    started=time.perf_counter()
                    original=baseline.segment(image)
                    cpu_ms=(time.perf_counter()-started)*1000
                    expected=np.stack([mask.numpy_view() for mask in original.confidence_masks],axis=2)
                    row={'timestampMs':stamp,'size':size,'cpuMs':cpu_ms,'variants':[]}
                    for mode in ('byte-resize','float-resize','byte-warp'):
                        source=(rgb.astype(np.float32)-127.5)/127.5 if mode=='float-resize' else rgb
                        if mode=='byte-warp':
                            resized=cv2.warpPerspective(source,np.diag([256/rgb.shape[1],256/rgb.shape[0],1]),(256,256),flags=cv2.INTER_LINEAR,borderMode=cv2.BORDER_REPLICATE)
                        else:
                            resized=cv2.resize(source,(256,256),interpolation=cv2.INTER_LINEAR)
                        tensor=resized if mode=='float-resize' else (resized.astype(np.float32)-127.5)/127.5
                        started=time.perf_counter()
                        logits=gpu.run(['Identity'],{'input_29':tensor[None]})[0]
                        gpu_ms=(time.perf_counter()-started)*1000
                        for before_resize in (True,False):
                            if before_resize:
                                actual=cv2.resize(probabilities(logits),size,interpolation=cv2.INTER_LINEAR)
                            else:
                                expanded=cv2.resize(logits[0],size,interpolation=cv2.INTER_LINEAR)
                                e=np.exp(expanded-expanded.max(axis=2,keepdims=True))
                                actual=e/e.sum(axis=2,keepdims=True)
                            diff=np.abs(actual-expected)
                            row['variants'].append({'preprocessing':mode,'softmaxBeforeResize':before_resize,
                                'gpuMs':gpu_ms,'maxDifference':float(diff.max()),'meanDifference':float(diff.mean()),
                                'categoryAgreement':float(np.mean(actual.argmax(axis=2)==expected.argmax(axis=2)))})
                    report['samples'].append(row)
        profile=Path(gpu.end_profiling())
        counts={}
        for event in json.loads(profile.read_text(encoding='utf-8')):
            provider=event.get('args',{}).get('provider')
            if provider: counts[provider]=counts.get(provider,0)+1
        report['profileNodeProviders']=counts
        if counts.get('DmlExecutionProvider',0)==0 or counts.get('CPUExecutionProvider',0):
            raise ValueError('GPU execution was not proven without CPU nodes')
    except BaseException as error:
        report['error']=str(error)
        raise
    finally:
        (directory/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({'directory':str(directory),'profileNodeProviders':counts}))


if __name__=='__main__':
    main()
