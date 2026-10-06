"""Explicit DirectML feasibility comparison, isolated from the shipped worker."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import time

import cv2
import numpy as np
from directml_proposals import DirectMLProposals, decode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work',type=Path,default=Path('artifacts/beauty-prototype'))
    parser.add_argument('--runtime',type=Path,required=True)
    args = parser.parse_args()
    sys.path.insert(0,str(args.runtime.resolve()))
    import onnxruntime as ort
    if ort.__version__ != '1.24.4' or 'DmlExecutionProvider' not in ort.get_available_providers():
        raise ValueError('Expected pinned DirectML diagnostic runtime')
    manifest = json.loads((Path(__file__).parent/'assets.json').read_text(encoding='utf-8'))['proposalModel']
    model = (args.work/manifest['file']).read_bytes()
    if hashlib.sha256(model).hexdigest() != manifest['sha256']:
        raise ValueError('Proposal model checksum mismatch')
    directory = Path(tempfile.mkdtemp(prefix='gpu-proposals-',dir=args.work))
    report = {'scope':__doc__,'qualityAccepted':False,'version':ort.__version__,'modelSha256':manifest['sha256'],'runs':[]}
    cv2.setNumThreads(1)
    frames = []
    for stamp in (4000,8000,10000,12000,14000):
        path = args.work/'face-segmentation-clc958q0'/f'{stamp}-source.png'
        bgr = cv2.imdecode(np.frombuffer(path.read_bytes(),dtype=np.uint8),cv2.IMREAD_COLOR)
        if bgr is None or bgr.shape[:2] != (360,640):
            raise ValueError('Expected existing reviewed 640x360 frame')
        canvas = np.zeros((640,640,3),dtype=np.uint8)
        canvas[:360] = bgr
        frames.append(cv2.dnn.blobFromImage(canvas))
    try:
        native = cv2.FaceDetectorYN.create('onnx',np.frombuffer(model,dtype=np.uint8),np.empty(0,dtype=np.uint8),(640,640),.7,.3,5000)
        native_boxes = [native.detect(frame[0].transpose(1,2,0).astype(np.uint8))[1] for frame in frames]
        def compare_boxes(rows, expected):
            if rows is None or expected is None:
                if rows is not None or expected is not None:
                    raise ValueError('GPU/CPU detection presence mismatch')
                return 0.0
            if rows.shape!=expected.shape:
                raise ValueError('GPU/CPU detection count mismatch')
            if not np.allclose(rows[:,:14],expected[:,:14],rtol=0,atol=.01) or not np.allclose(rows[:,14],expected[:,14],rtol=0,atol=1e-5):
                raise ValueError('GPU/CPU boxes, keypoints or scores differ')
            return float(np.max(np.abs(rows-expected)))
        reference = None
        for provider in ('CPUExecutionProvider','DmlExecutionProvider'):
            options = ort.SessionOptions()
            options.intra_op_num_threads=1
            options.inter_op_num_threads=1
            options.execution_mode=ort.ExecutionMode.ORT_SEQUENTIAL
            options.enable_mem_pattern=False
            options.enable_profiling=provider=='DmlExecutionProvider'
            options.profile_file_prefix=str(directory/'directml')
            if provider=='DmlExecutionProvider':
                options.add_session_config_entry('session.disable_cpu_ep_fallback','1')
            started = time.perf_counter()
            session = ort.InferenceSession(model,sess_options=options,providers=[provider])
            session.disable_fallback()
            inputs = session.get_inputs()
            if len(inputs)!=1 or inputs[0].shape != [1,3,640,640]:
                raise ValueError('Unexpected proposal model input')
            run = {'provider':provider,'registeredProviders':session.get_providers(),
                   'creationMs':(time.perf_counter()-started)*1000,'samples':[]}
            report['runs'].append(run)
            started = time.perf_counter()
            outputs = [session.run(None,{inputs[0].name:frame}) for frame in frames]
            run['firstFiveMs']=(time.perf_counter()-started)*1000
            run['decodedBoxCounts']=[0 if value is None else len(value) for value in native_boxes]
            run['maxDifferenceFromOpenCVBoxes']=max(compare_boxes(decode(value),expected) for value,expected in zip(outputs,native_boxes))
            if reference is None:
                reference = outputs
            else:
                run['maxAbsoluteDifferenceByOutput']={node.name:max(float(np.max(np.abs(output[index]-expected[index]))) for output,expected in zip(outputs,reference)) for index,node in enumerate(session.get_outputs())}
            for index in range(30):
                started = time.perf_counter()
                output = session.run(None,{inputs[0].name:frames[index%len(frames)]})
                elapsed=(time.perf_counter()-started)*1000
                if any(not np.isfinite(value).all() for value in output):
                    raise ValueError('Nonfinite GPU/CPU proposal output')
                run['samples'].append(elapsed)
            run['p50Ms']=float(np.percentile(run['samples'],50))
            run['p95Ms']=float(np.percentile(run['samples'],95))
            if options.enable_profiling:
                profile = Path(session.end_profiling())
                counts = {}
                for event in json.loads(profile.read_text(encoding='utf-8')):
                    execution = event.get('args',{}).get('provider')
                    if execution:
                        counts[execution]=counts.get(execution,0)+1
                run['profile']=str(profile)
                run['profileNodeProviders']=counts
                if counts.get('DmlExecutionProvider',0)==0 or counts.get('CPUExecutionProvider',0):
                    raise ValueError('GPU execution was not proven without CPU node fallback')
            del session
        with DirectMLProposals(model) as detector:
            rgb = [cv2.cvtColor(frame[0].transpose(1,2,0).astype(np.uint8),cv2.COLOR_BGR2RGB) for frame in frames]
            for image,expected in zip(rgb,native_boxes):
                compare_boxes(detector.locate(image),expected)
            timings=[]
            for index in range(30):
                started=time.perf_counter()
                rows=detector.locate(rgb[index%len(rgb)])
                timings.append((time.perf_counter()-started)*1000)
                compare_boxes(rows,native_boxes[index%len(rgb)])
            report['detector']={'comparedFrames':35,'p50Ms':float(np.percentile(timings,50)),
                'p95Ms':float(np.percentile(timings,95)),'boxCoordinateTolerancePixels':.01,'scoreTolerance':1e-5}
    except BaseException as error:
        report['error']=str(error)
        raise
    finally:
        (directory/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({'directory':str(directory),'runs':[{k:v for k,v in row.items() if k!='samples'} for row in report['runs']]}))


if __name__ == '__main__':
    main()
