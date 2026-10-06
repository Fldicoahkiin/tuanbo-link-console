"""Offline body detection evidence; repeated photos are not real multi-person acceptance."""
import hashlib
import argparse
import json
from pathlib import Path
import time
import cv2
import numpy as np
from body import BodyAnalyzer, exclusive_masks


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model',choices=['full','lite'],default='full')
    parser.add_argument('--repeats',type=int,default=1,choices=range(1,101))
    args=parser.parse_args()
    work = Path(__file__).resolve().parents[3] / 'artifacts' / 'beauty-prototype'
    manifest = json.loads(Path(__file__).with_name('assets.json').read_text(encoding='utf-8'))
    data = {}
    model_key='bodyModel' if args.model=='full' else 'bodyLiteModel'
    for name in (model_key,'bodyPortrait'):
        data[name] = (work / manifest[name]['file']).read_bytes()
        if hashlib.sha256(data[name]).hexdigest() != manifest[name]['sha256']:
            raise ValueError(f'{name} checksum mismatch')
    bgr = cv2.imdecode(np.frombuffer(data['bodyPortrait'], dtype=np.uint8),cv2.IMREAD_COLOR)
    if bgr is None: raise ValueError('Cannot decode body fixture')
    directory = work / f'body-probe-{args.model}'
    directory.mkdir(exist_ok=True)
    report = {'scope':'Repeated official photo, offline geometry only; no body rendering or real group acceptance','cases':[]}
    with BodyAnalyzer(data[model_key]) as detector:
        for count,cols,rows in [(1,1,1),(2,2,1),(4,2,2),(6,3,2)]:
            tiled=np.tile(bgr,(rows,cols,1))
            scale=640/max(tiled.shape[:2])
            tiled=cv2.resize(tiled,None,fx=scale,fy=scale,interpolation=cv2.INTER_AREA)
            cv2.imencode('.png',tiled)[1].tofile(directory/f'{count}-people.png')
            times=[];counts=[];coordinates=[]
            rgb=cv2.cvtColor(tiled,cv2.COLOR_BGR2RGB)
            for _ in range(args.repeats):
                started=time.perf_counter()
                bodies=detector.analyze(rgb)
                times.append((time.perf_counter()-started)*1000)
                counts.append(len(bodies))
                coordinates.append([body.joints.tolist() for body in bodies])
            masks=exclusive_masks(bodies)
            details=[]
            overlay=tiled.copy()
            for index,(body,mask) in enumerate(zip(bodies,masks)):
                cv2.imencode('.png',(mask*255).astype(np.uint8))[1].tofile(directory/f'{count}-mask-{index}.png')
                for a,b in [(11,12),(11,23),(12,24),(23,24),(23,25),(25,27),(24,26),(26,28)]:
                    if body.usable((a,b)):
                        p=tuple(np.round(body.joints[a,:2]*tiled.shape[1::-1]).astype(int))
                        q=tuple(np.round(body.joints[b,:2]*tiled.shape[1::-1]).astype(int))
                        cv2.line(overlay,p,q,(0,220,80),2)
                details.append({'joints':body.joints.tolist(),'leftLeg':body.usable((23,25,27)),
                    'rightLeg':body.usable((24,26,28)),'exclusivePixels':int(np.count_nonzero(mask))})
            cv2.imencode('.png',overlay)[1].tofile(directory/f'{count}-geometry.png')
            case={'expected':count,'detected':len(bodies),'width':tiled.shape[1],'height':tiled.shape[0],
                'inferenceMs':times,'p95Ms':float(np.percentile(times,95)),'counts':counts,
                'repeatGeometryIdentical':all(sample==coordinates[0] for sample in coordinates),'bodies':details}
            report['cases'].append(case)
            print(json.dumps({k:v for k,v in case.items() if k!='bodies'}),flush=True)
        empty=detector.analyze(np.zeros((360,640,3),dtype=np.uint8))
        report['emptyDetected']=len(empty)
        if empty: raise AssertionError('Empty frame produced body geometry')
    report['allCountsMatch']=all(all(count==case['expected'] for count in case['counts']) for case in report['cases'])
    (directory/'result.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    if not report['allCountsMatch']: raise SystemExit('Body coverage incomplete; inspect body-probe/result.json')


if __name__=='__main__':main()
