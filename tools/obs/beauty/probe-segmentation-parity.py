"""Gate full GPU face-mask parity against MediaPipe, including canvas restoration."""
import argparse
import json
from pathlib import Path
import sys
import tempfile
import time

import cv2
import numpy as np
from directml_segmentation import DirectMLFaceSegmentation
from face_segmentation import FaceSegmentation


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work', type=Path, default=Path('artifacts/beauty-prototype'))
    args = parser.parse_args()
    sys.path.insert(0, str((args.work/'gpu-probe-deps').resolve()))
    directory = Path(tempfile.mkdtemp(prefix='segmentation-parity-',dir=args.work))
    report = {'passed':False,'qualityAccepted':False,'scope':__doc__,'samples':[]}
    cv2.setNumThreads(1)
    try:
        with FaceSegmentation((args.work/'selfie_multiclass_256x256.tflite').read_bytes()) as cpu, \
                DirectMLFaceSegmentation((args.work/'selfie_multiclass_256x256.onnx').read_bytes()) as gpu:
            for stamp in (4000,8000,10000,12000,14000):
                bgr = cv2.imdecode(np.frombuffer((args.work/'face-segmentation-clc958q0'/f'{stamp}-source.png').read_bytes(),dtype=np.uint8),cv2.IMREAD_COLOR)
                rgb = cv2.cvtColor(bgr,cv2.COLOR_BGR2RGB)
                portrait = np.zeros((640,360,3),dtype=np.uint8)
                portrait[217:420] = cv2.resize(rgb,(360,203))
                asymmetric = np.zeros((639,479,3),dtype=np.uint8)
                asymmetric[11:612,73:374] = cv2.resize(rgb,(301,601))
                cases = {'landscape':rgb,'portrait':portrait,'asymmetric':asymmetric,
                    'square':cv2.resize(rgb,(256,256)), 'narrow':cv2.resize(rgb,(17,613))}
                for name, pixels in cases.items():
                    started = time.perf_counter()
                    expected = cpu.analyze(pixels)
                    cpu_ms = (time.perf_counter()-started)*1000
                    started = time.perf_counter()
                    actual = gpu.analyze(pixels)
                    gpu_ms = (time.perf_counter()-started)*1000
                    diff = np.abs(actual-expected)
                    row = {'timestampMs':stamp,'case':name,'cpuMs':cpu_ms,'gpuMs':gpu_ms,
                        'maxDifference':float(diff.max()),'meanDifference':float(diff.mean())}
                    report['samples'].append(row)
                    if row['maxDifference'] > .0001 or row['meanDifference'] > .00001:
                        raise ValueError(f'Semantic parity failed: {row}')
            report['passed'] = True
    except BaseException as error:
        report['error'] = str(error)
        raise
    finally:
        (directory/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
        print(json.dumps({'directory':str(directory),'passed':report['passed']}))


if __name__ == '__main__':
    main()
