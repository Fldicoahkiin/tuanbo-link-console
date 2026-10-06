"""Inspect real video detection coverage; does not claim rendering or quality acceptance."""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import time
from contextlib import nullcontext

import cv2
import numpy as np
from analyzer import FaceAnalyzer, merge_faces
from body import BodyAnalyzer
from body_stabilizer import BodyStabilizer
from face_proposals import FaceProposals


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('video',type=Path)
    parser.add_argument('--work',type=Path,default=Path('artifacts/beauty-prototype'))
    parser.add_argument('--sample-ms',type=int,default=100)
    parser.add_argument('--seconds',type=float,default=60)
    parser.add_argument('--face-proposals',action='store_true',help='Experimental checked supplementary detection; not the deployed worker')
    args=parser.parse_args()
    if not 33<=args.sample_ms<=1000 or not 0<args.seconds<=600:
        raise ValueError('Sampling interval must be 33..1000 ms and duration 0..600 seconds')
    source=Path(__file__).parent
    digest=hashlib.sha256(args.video.read_bytes()).hexdigest()
    fixtures=json.loads((source/'motion-assets.json').read_text(encoding='utf-8'))['videos']
    attribution=next((item for item in fixtures if item['sha256']==digest),None)
    assets=json.loads((source/'assets.json').read_text(encoding='utf-8'))
    models=[]
    for filename,key in [('face_landmarker.task','model'),('pose_landmarker_lite.task','bodyLiteModel')]:
        model=(args.work/filename).read_bytes()
        if hashlib.sha256(model).hexdigest()!=assets[key]['sha256']:
            raise ValueError('Model checksum mismatch')
        models.append(model)
    proposal_model=None
    if args.face_proposals:
        proposal_model=(args.work/'face_detection_yunet_2023mar.onnx').read_bytes()
        if hashlib.sha256(proposal_model).hexdigest()!='8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4':
            raise ValueError('Face proposal model checksum mismatch')
    directory=Path(tempfile.mkdtemp(prefix='motion-probe-',dir=args.work))
    capture=cv2.VideoCapture(str(args.video))
    fps=capture.get(cv2.CAP_PROP_FPS)
    if not capture.isOpened() or not np.isfinite(fps) or fps<=0:
        capture.release()
        raise ValueError('Video cannot be decoded or has invalid frame rate')
    report={'scope':'Offline real-video detection sampling; counts are not ground-truth recall and not live OBS quality acceptance',
            'video':str(args.video.resolve()),'sha256':digest,'attribution':attribution,'fps':fps,'sample_ms':args.sample_ms,
            'experimentalFaceProposals':args.face_proposals,'samples':[]}
    if proposal_model is not None:
        report['proposalModel']={'sha256':hashlib.sha256(proposal_model).hexdigest(),
            'source':'https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet',
            'licenseSource':'https://github.com/opencv/opencv_zoo/blob/main/models/face_detection_yunet/LICENSE',
            'distribution':'Experimental diagnostic model only; not deployed'}
    stabilizer=BodyStabilizer()
    try:
        with FaceAnalyzer(models[0]) as face_detector, BodyAnalyzer(models[1]) as body_detector, \
                (FaceProposals(models[0],proposal_model) if proposal_model is not None else nullcontext()) as proposals:
            index=0;next_sample=0
            while index/fps<args.seconds:
                ok,bgr=capture.read()
                if not ok:break
                stamp=round(index*1000/fps);index+=1
                if stamp<next_sample:continue
                next_sample=stamp+args.sample_ms
                height,width=bgr.shape[:2];scale=min(1,640/max(width,height))
                frame=cv2.resize(bgr,(int(width*scale),int(height*scale)),interpolation=cv2.INTER_AREA)
                height,width=frame.shape[:2];rgb=cv2.cvtColor(frame,cv2.COLOR_BGR2RGB)
                started=time.perf_counter();faces=face_detector.analyze(rgb);baseline_faces=len(faces)
                if proposals is not None:
                    # Match the worker's independent candidate selection and
                    # baseline-first merge. This offline timer is sequential,
                    # so it is not the worker's concurrent latency measurement.
                    candidates=proposals.analyze(rgb,[])
                    faces=merge_faces(list(enumerate(faces+candidates)))
                face_ms=(time.perf_counter()-started)*1000
                started=time.perf_counter();bodies=body_detector.analyze(rgb);body_ms=(time.perf_counter()-started)*1000
                stable=stabilizer.update(bodies,stamp,(1,width,height))
                report['samples'].append({'timestamp_ms':stamp,'faces':len(faces),'baseline_faces':baseline_faces,'bodies':len(bodies),'face_ms':face_ms,'body_ms':body_ms,
                    'face_centers':[[face['cx'],face['cy']] for face in faces],
                    'body_joints':[body.joints.tolist() for body in bodies], 'stable_joints':[body.joints.tolist() for body in stable]})
                if len(report['samples'])%20==1:
                    for face in faces:
                        cv2.ellipse(frame,(int(face['cx']*width),int(face['cy']*height)),(int(face['rx']*width),int(face['ry']*height)),0,0,360,(0,200,255),1)
                    for body in stable:
                        for x,y,confidence in body.joints:
                            if confidence>=.6:cv2.circle(frame,(int(x*width),int(y*height)),2,(0,255,0),-1)
                    cv2.putText(frame,f'{stamp}ms faces={len(faces)} bodies={len(bodies)}',(8,18),cv2.FONT_HERSHEY_SIMPLEX,.45,(255,255,255),1)
                    if not cv2.imwrite(str(directory/f'frame-{stamp}.png'),frame):raise RuntimeError('Cannot save inspection frame')
        samples=report['samples']
        if not samples:raise ValueError('Video yielded no analysis frames')
        report['summary']={'samples':len(samples),'samplesWithTwoFaces':sum(s['faces']>=2 for s in samples),
            'samplesWithTwoBodies':sum(s['bodies']>=2 for s in samples),'maximumFaces':max(s['faces'] for s in samples),
            'maximumBodies':max(s['bodies'] for s in samples),
            'faceMsP95':float(np.percentile([s['face_ms'] for s in samples],95)),
            'bodyMsP95':float(np.percentile([s['body_ms'] for s in samples],95))}
    except BaseException as error:
        report['error']=str(error)
        raise
    finally:
        capture.release()
        (directory/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'directory':str(directory),**report['summary']}))


if __name__=='__main__':main()
