"""Compare full-canvas and active-image body detection on pinned video frames."""
import hashlib
import json
from pathlib import Path
import tempfile
import time

import cv2
import numpy as np

from body import BodyAnalyzer, BodyGeometry, exclusive_masks
from body_instances import protect_body_masks
from rtmdet_instances import RTMDetInstances, suppress_duplicate_masks


def main():
    work = Path('artifacts/beauty-prototype')
    video = work/'public-motion/cha-cha.webm'
    if hashlib.sha256(video.read_bytes()).hexdigest() != 'd60a4057489616003b6f66c26ed80825d95c8ea9b839c8c30824c06be65772fa':
        raise ValueError('Video checksum mismatch')
    asset = json.loads(Path(__file__).with_name('assets.json').read_text(encoding='utf-8'))['bodyLiteModel']
    model = (work/asset['file']).read_bytes()
    if hashlib.sha256(model).hexdigest() != asset['sha256']:
        raise ValueError('Body model checksum mismatch')
    directory = Path(tempfile.mkdtemp(prefix='body-framing-', dir=work))
    report = {'scope': __doc__, 'qualityAccepted': False, 'samples': []}
    capture = cv2.VideoCapture(str(video))
    try:
        with BodyAnalyzer(model) as detector, RTMDetInstances(work/'rtmdet-ins-tiny') as instance:
            for second in range(47):
                capture.set(cv2.CAP_PROP_POS_MSEC, second*1000)
                ok, bgr = capture.read()
                if not ok:
                    raise ValueError('Missing diagnostic frame')
                active = cv2.cvtColor(cv2.resize(bgr, (360,202), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
                rgb = np.zeros((640,360,3), dtype=np.uint8)
                rgb[219:421] = active
                instances = suppress_duplicate_masks(instance.analyze(rgb))
                item = {'second': second, 'modes': {}}
                panels = []
                instance_candidates = []
                for mode, frame in [('canvas', rgb), ('active', active), ('instances', rgb), ('supplement', rgb), ('owned-supplement', rgb), ('owned-instances', rgb)]:
                    start = time.perf_counter()
                    if mode == 'instances':
                        views = []
                        for mask in instances:
                            ys,xs = np.nonzero(mask >= .6)
                            if not xs.size:
                                continue
                            left,right,top,bottom = int(xs.min()),int(xs.max())+1,int(ys.min()),int(ys.max())+1
                            pad = int(np.ceil(max(right-left,bottom-top)*.15))
                            views.append((max(0,left-pad),max(219,top-pad),min(360,right+pad),min(421,bottom+pad)))
                        indexed = list(enumerate(views))
                        jobs = [detector.executor.submit(detector._analyze_views, handle, rgb, indexed[index::detector.workers])
                            for index,handle in enumerate(detector.detectors)]
                        candidates = [candidate for job in jobs for candidate in job.result()]
                        instance_candidates = sorted(candidates,key=lambda candidate:candidate[0])
                        bodies = []
                        for _,body in sorted(candidates,key=lambda candidate:candidate[0]):
                            center = np.mean(body.joints[[11,12,23,24],:2],axis=0)
                            scale = np.linalg.norm(body.joints[11,:2]-body.joints[23,:2])
                            if any(np.linalg.norm(np.mean(other.joints[[11,12,23,24],:2],axis=0)-center)<scale*.4 for other in bodies):
                                continue
                            bodies.append(body)
                            if len(bodies)==6:
                                break
                    else:
                        bodies = detector.analyze(frame)
                    if mode in ('supplement', 'owned-supplement', 'owned-instances'):
                        owners = set()
                        if mode != 'supplement':
                            for body in bodies:
                                _, assignment = protect_body_masks([body.joints], [body.mask], instances, anchor_radius=1)
                                if assignment[0] is not None:
                                    owners.add(assignment[0])
                        candidates = instance_candidates if mode == 'owned-instances' else detector._analyze_views(detector.detectors[0], rgb, [(0,(0,219,360,421))])
                        for _,body in candidates:
                            owner = None
                            if mode != 'supplement':
                                _, assignment = protect_body_masks([body.joints], [body.mask], instances, anchor_radius=1)
                                owner = assignment[0]
                                if owner is None or owner in owners:
                                    continue
                            center = np.mean(body.joints[[11,12,23,24],:2],axis=0)
                            scale = np.linalg.norm(body.joints[11,:2]-body.joints[23,:2])
                            if any(np.linalg.norm(np.mean(other.joints[[11,12,23,24],:2],axis=0)-center)<scale*.4 for other in bodies):
                                continue
                            if len(bodies)<6:
                                bodies.append(body)
                                if owner is not None:
                                    owners.add(owner)
                    if mode == 'active':
                        restored = []
                        for body in bodies:
                            joints = body.joints.copy()
                            joints[:,1] = (joints[:,1]*202+219)/640
                            mask = np.zeros((640,360), dtype=np.float32)
                            mask[219:421] = body.mask
                            restored.append(BodyGeometry(joints, mask))
                        bodies = restored
                    masks, assignments = protect_body_masks([body.joints for body in bodies], exclusive_masks(bodies), instances, anchor_radius=1)
                    item['modes'][mode] = {'milliseconds': (time.perf_counter()-start)*1000,
                        'reusedInstanceCandidates': mode == 'owned-instances',
                        'poses': len(bodies), 'assignments': assignments,
                        'protectedPixels': [int(np.count_nonzero(mask)) for mask in masks],
                        'joints': [body.joints.tolist() for body in bodies]}
                    overlay = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
                    for index, (body, mask) in enumerate(zip(bodies, masks)):
                        color = np.array([(70,220,70),(240,160,60),(80,70,240),(230,70,200),(60,220,220),(220,220,60)][index])
                        alpha = mask[:,:,None]*.5
                        overlay = np.round(overlay*(1-alpha)+color*alpha).astype(np.uint8)
                        for a,b in [(11,12),(11,23),(12,24),(23,24),(23,25),(25,27),(24,26),(26,28)]:
                            if body.usable((a,b)):
                                p = tuple(np.round(body.joints[a,:2]*(360,640)).astype(int))
                                q = tuple(np.round(body.joints[b,:2]*(360,640)).astype(int))
                                cv2.line(overlay,p,q,tuple(int(x) for x in color),1)
                    panel = overlay[209:431].copy()
                    cv2.putText(panel,mode,(8,16),cv2.FONT_HERSHEY_SIMPLEX,.45,(255,255,255),1)
                    panels.append(panel)
                ok, encoded = cv2.imencode('.png', np.concatenate(panels, axis=0))
                if not ok:
                    raise ValueError('Could not encode comparison')
                (directory/f'{second}.png').write_bytes(encoded.tobytes())
                report['samples'].append(item)
    except Exception as error:
        report['error'] = str(error)
        raise
    finally:
        capture.release()
        (directory/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
        print(json.dumps({'directory':str(directory),'error':report.get('error')}))


if __name__ == '__main__':
    main()
