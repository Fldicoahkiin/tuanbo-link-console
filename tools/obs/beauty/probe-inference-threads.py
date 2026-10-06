"""Offline CPU contention comparison on identical frames, not OBS acceptance."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
import hashlib
import json
from pathlib import Path
import tempfile
import time
from unittest.mock import patch

import cv2
import mediapipe as mp
import numpy as np
from analyzer import FaceAnalyzer
from body import BodyAnalyzer, exclusive_masks
from face_proposals import FaceProposals
from face_segmentation import FaceSegmentation


def body_sample(detector, rgb):
    started = time.perf_counter()
    bodies = detector.analyze(rgb)
    masks = exclusive_masks(bodies)
    elapsed = (time.perf_counter()-started)*1000
    fingerprint = hashlib.sha256()
    for body, mask in zip(bodies, masks):
        fingerprint.update(body.joints.tobytes())
        fingerprint.update(mask.tobytes())
    return {'milliseconds': elapsed, 'bodies': len(bodies), 'sha256': fingerprint.hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('video', type=Path)
    parser.add_argument('--work', type=Path, default=Path('artifacts/beauty-prototype'))
    args = parser.parse_args()
    manifest = json.loads((Path(__file__).parent/'assets.json').read_text(encoding='utf-8'))
    models = {}
    for key in ('model', 'bodyLiteModel', 'proposalModel'):
        asset = manifest[key]
        value = (args.work/asset['file']).read_bytes()
        if hashlib.sha256(value).hexdigest() != asset['sha256']:
            raise ValueError('Diagnostic model checksum mismatch')
        models[key] = value
    directory = Path(tempfile.mkdtemp(prefix='inference-threads-', dir=args.work))
    report = {'scope': __doc__, 'videoSha256': hashlib.sha256(args.video.read_bytes()).hexdigest(), 'runs': []}
    frames = []
    capture = cv2.VideoCapture(str(args.video))
    try:
        if not capture.isOpened():
            raise ValueError('Cannot decode diagnostic video')
        for stamp in range(10000, 14000, 100):
            capture.set(cv2.CAP_PROP_POS_MSEC, stamp)
            ok, bgr = capture.read()
            if not ok:
                raise ValueError('Missing diagnostic frame')
            height = round(bgr.shape[0]*360/bgr.shape[1])
            frame = np.zeros((640,360,3), dtype=np.uint8)
            top = (640-height)//2
            frame[top:top+height] = cv2.cvtColor(cv2.resize(bgr,(360,height),interpolation=cv2.INTER_AREA),cv2.COLOR_BGR2RGB)
            frames.append((stamp, frame))
    finally:
        capture.release()
    try:
        with ExitStack() as stack:
            face = stack.enter_context(FaceAnalyzer(models['model']))
            proposals = stack.enter_context(FaceProposals(models['model'], models['proposalModel']))
            semantic = stack.enter_context(FaceSegmentation((args.work/'selfie_multiclass_256x256.tflite').read_bytes()))
            pool = stack.enter_context(ThreadPoolExecutor(max_workers=4))
            # Patch only while constructing this diagnostic body detector. The
            # production default is deliberately unchanged until measured.
            for threads, workers in ((None,7),(1,7),(2,7),(2,4),(2,3),(1,4)):
                with ExitStack() as body_stack:
                    if threads is None:
                        def legacy_options(model, _threads):
                            return mp.tasks.BaseOptions(model_asset_buffer=model)
                        with patch('body.ThreadedBaseOptions', legacy_options):
                            body = BodyAnalyzer(models['bodyLiteModel'], workers=workers)
                    else:
                        body = BodyAnalyzer(models['bodyLiteModel'], threads=threads, workers=workers)
                    body_stack.enter_context(body)
                    run = {'bodyThreads': threads, 'bodyWorkers': workers, 'samples': []}
                    report['runs'].append(run)
                    for stamp, rgb in frames:
                        started = time.perf_counter()
                        jobs = [pool.submit(face.analyze,rgb), pool.submit(proposals.analyze,rgb,[]),
                                pool.submit(semantic.analyze,rgb), pool.submit(body_sample,body,rgb)]
                        values = [job.result() for job in jobs]
                        run['samples'].append({'timestampMs': stamp, 'faceCount': len(values[0]),
                            'proposalCount': len(values[1]), 'body': values[3], 'groupMs': (time.perf_counter()-started)*1000})
                    run['bodyP95Ms'] = float(np.percentile([s['body']['milliseconds'] for s in run['samples']],95))
                    run['groupP95Ms'] = float(np.percentile([s['groupMs'] for s in run['samples']],95))
                    reference = report['runs'][0]['samples']
                    run['identicalBodies'] = sum(s['body']['sha256']==r['body']['sha256'] for s,r in zip(run['samples'],reference))
                    print(json.dumps({key:value for key,value in run.items() if key!='samples'}), flush=True)
    except BaseException as error:
        report['error'] = str(error)
        raise
    finally:
        (directory/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({'directory':str(directory)}))


if __name__ == '__main__':
    main()
