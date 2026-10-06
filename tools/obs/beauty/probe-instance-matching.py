"""Inspect changed person ownership using fixed real-video frames and both models."""
import hashlib
import argparse
import json
from pathlib import Path
import tempfile

import cv2
import numpy as np

from body import BodyAnalyzer, exclusive_masks
from body_instances import protect_body_masks
from person_instances import PersonInstances
from rtmdet_instances import RTMDetInstances, suppress_duplicate_masks


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--seconds',type=int,nargs='+',default=[10,13,42],choices=range(47))
    arguments=parser.parse_args()
    work=Path('artifacts/beauty-prototype')
    video=work/'public-motion/cha-cha.webm'
    if hashlib.sha256(video.read_bytes()).hexdigest()!='d60a4057489616003b6f66c26ed80825d95c8ea9b839c8c30824c06be65772fa':
        raise ValueError('Video checksum mismatch')
    asset=json.loads(Path(__file__).with_name('assets.json').read_text(encoding='utf-8'))['bodyLiteModel']
    model=(work/asset['file']).read_bytes()
    if hashlib.sha256(model).hexdigest()!=asset['sha256']:
        raise ValueError('Body model checksum mismatch')
    directory=Path(tempfile.mkdtemp(prefix='instance-matching-',dir=work))
    report={'scope':__doc__,'qualityAccepted':False,'samples':[]}
    capture=cv2.VideoCapture(str(video))
    try:
        with BodyAnalyzer(model,workers=4,threads=2) as body, PersonInstances(work/'person-instance') as original, RTMDetInstances(work/'rtmdet-export-vgxocmul') as candidate:
            for second in arguments.seconds:
                capture.set(cv2.CAP_PROP_POS_MSEC,second*1000)
                ok,bgr=capture.read()
                if not ok: raise ValueError('Missing diagnostic frame')
                rgb=np.zeros((640,360,3),dtype=np.uint8)
                rgb[219:421]=cv2.cvtColor(cv2.resize(bgr,(360,202),interpolation=cv2.INTER_AREA),cv2.COLOR_BGR2RGB)
                bodies=body.analyze(rgb)
                masks=exclusive_masks(bodies)
                item={'second':second,'joints':[person.joints.tolist() for person in bodies],'models':{}}
                for name,detector in [('original',original),('rtmdet',candidate),('rtmdet-refined',candidate)]:
                    instances=detector.analyze(rgb)
                    if name=='rtmdet-refined':
                        instances=suppress_duplicate_masks(instances)
                    protected,assignments=protect_body_masks([person.joints for person in bodies],masks,instances,
                        anchor_radius=1 if name=='rtmdet-refined' else 0)
                    anchors=[]
                    for person in bodies:
                        points=person.joints[[0,11,12]]
                        xy=np.round(points[:,:2]*np.array([359,639])).astype(int)
                        values=[[float(mask[y,x]) for x,y in xy] for mask in instances]
                        distances=[]
                        support=[]
                        for mask in instances:
                            distance=cv2.distanceTransform((mask<.6).astype(np.uint8),cv2.DIST_L2,cv2.DIST_MASK_PRECISE)
                            distances.append([float(distance[y,x]) for x,y in xy])
                            support.append([float(np.mean(mask[max(0,y-2):y+3,max(0,x-2):x+3])) for x,y in xy])
                        anchors.append({'xy':xy.tolist(),'confidence':points[:,2].tolist(),'instanceValues':values,
                            'distanceToMask':distances,'radiusTwoMean':support})
                    overlap=[]
                    for first in range(len(instances)):
                        for second_index in range(first+1,len(instances)):
                            a,b=instances[first]>=.6,instances[second_index]>=.6
                            intersection=np.count_nonzero(a&b)
                            overlap.append({'pair':[first,second_index],'iou':intersection/max(np.count_nonzero(a|b),1),
                                'smallerCoverage':intersection/max(min(np.count_nonzero(a),np.count_nonzero(b)),1)})
                    item['models'][name]={'instances':len(instances),'assignments':assignments,'anchors':anchors,
                        'overlap':overlap,'protectedPixels':[int(np.count_nonzero(mask)) for mask in protected]}
                    panels=[]
                    for index,mask in enumerate(instances):
                        panel=cv2.cvtColor(rgb,cv2.COLOR_RGB2BGR)
                        color=np.zeros_like(panel);color[:,:,1]=255
                        alpha=(mask*.5)[:,:,None]
                        panel=(panel*(1-alpha)+color*alpha).astype(np.uint8)
                        for body_index,person in enumerate(bodies):
                            for point in person.joints[[0,11,12]]:
                                x,y=np.round(point[:2]*np.array([359,639])).astype(int)
                                cv2.circle(panel,(x,y),3,(0,0,255),1)
                                cv2.putText(panel,str(body_index),(x+3,y),cv2.FONT_HERSHEY_SIMPLEX,.35,(0,0,255),1)
                        panel=panel[209:431]
                        cv2.putText(panel,f'{name} {index}',(8,16),cv2.FONT_HERSHEY_SIMPLEX,.45,(255,255,255),1)
                        panels.append(panel)
                    if panels:
                        ok,encoded=cv2.imencode('.png',np.concatenate(panels,axis=0))
                        if not ok: raise ValueError('Failed to encode diagnostic image')
                        (directory/f'{second}-{name}.png').write_bytes(encoded.tobytes())
                report['samples'].append(item)
    except Exception as error:
        report['error']=f'{type(error).__name__}: {error}'
        raise
    finally:
        capture.release()
        (directory/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
        print(json.dumps({'directory':str(directory),'error':report.get('error')}))


if __name__=='__main__': main()
