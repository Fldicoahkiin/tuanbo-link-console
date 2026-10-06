"""Compare exact face geometry before/after omitting provably empty views."""
import hashlib
import json
from pathlib import Path
import tempfile
import time
from unittest.mock import patch

import cv2
import numpy as np
from analyzer import FaceAnalyzer, analysis_views, occupied_views


def main():
    work = Path('artifacts/beauty-prototype')
    directory = Path(tempfile.mkdtemp(prefix='empty-face-views-',dir=work))
    model = (work/'face_landmarker.task').read_bytes()
    manifest = json.loads(Path(__file__).with_name('assets.json').read_text())
    if hashlib.sha256(model).hexdigest() != manifest['model']['sha256']:
        raise ValueError('Face model checksum mismatch')
    report = {'passed':False,'qualityAccepted':False,'scope':__doc__,'samples':[]}
    capture = cv2.VideoCapture(str(work/'public-motion/cha-cha.webm'))
    try:
        with FaceAnalyzer(model) as detector:
            # The public file reports 47.948s but OpenCV's final random seek
            # at 47s yields no decoded frame. Use the proven 0..46s range.
            for stamp in range(0,47000,1000):
                capture.set(cv2.CAP_PROP_POS_MSEC,stamp)
                ok, bgr = capture.read()
                if not ok:
                    raise ValueError(f'Missing frame {stamp}')
                rgb = np.zeros((640,360,3),dtype=np.uint8)
                rgb[218:420] = cv2.cvtColor(cv2.resize(bgr,(360,202),interpolation=cv2.INTER_AREA),cv2.COLOR_BGR2RGB)
                started = time.perf_counter()
                with patch('analyzer.occupied_views',lambda value:list(enumerate(analysis_views(value.shape[1],value.shape[0])))):
                    expected = detector.analyze(rgb)
                original_ms = (time.perf_counter()-started)*1000
                started = time.perf_counter()
                actual = detector.analyze(rgb)
                elapsed = (time.perf_counter()-started)*1000
                report['samples'].append({'timestampMs':stamp,'faces':len(actual),'equal':actual==expected,
                    'originalMs':original_ms,'optimizedMs':elapsed,'originalViews':len(analysis_views(360,640)),
                    'optimizedViews':len(occupied_views(rgb))})
                if actual != expected:
                    raise ValueError(f'Face geometry changed at {stamp}')
            report['passed'] = True
    except BaseException as error:
        report['error'] = str(error)
        raise
    finally:
        capture.release()
        (directory/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
        print(json.dumps({'directory':str(directory),'passed':report['passed']}))


if __name__ == '__main__':
    main()
