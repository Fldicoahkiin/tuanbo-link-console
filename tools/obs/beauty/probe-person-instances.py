"""Offline person-instance candidates; separate environment, no production integration."""
import hashlib
import argparse
import json
from pathlib import Path
import tempfile
import time

import cv2
import numpy as np
import openvino as ov
from body_instances import protect_body_masks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--body-report',type=Path,help='Same-frame body probe directory; uses its 8-bit diagnostic masks')
    args = parser.parse_args()
    source = Path(__file__).parent
    work = source.resolve().parents[2]/'artifacts/beauty-prototype'
    assets = json.loads((source/'instance-assets.json').read_text(encoding='utf-8'))
    for asset in assets['files']:
        data = (work/'person-instance'/asset['file']).read_bytes()
        if hashlib.sha256(data).hexdigest() != asset['sha256'] or hashlib.sha384(data).hexdigest() != asset['sha384']:
            raise ValueError('Instance model checksum mismatch')
    annotations = json.loads((source/'semantic-regions.json').read_text(encoding='utf-8'))
    body_report = json.loads((args.body_report/'report.json').read_text(encoding='utf-8')) if args.body_report else None
    directory = Path(tempfile.mkdtemp(prefix='person-instances-',dir=work))
    compiled = ov.Core().compile_model(str(work/'person-instance/model.xml'),'CPU',{'INFERENCE_NUM_THREADS':4,'NUM_STREAMS':1})
    report = {'qualityAccepted':False,'scope':__doc__,'attribution':annotations['attribution'],
        'modelAssets':assets,
        'runtimeVersion':ov.__version__,'device':'CPU','threads':4,'samples':[]}
    for sample in annotations['samples']:
        stamp = sample['timestampMs']
        image = cv2.imdecode(np.frombuffer((work/f'face-segmentation-clc958q0/{stamp}-source.png').read_bytes(),dtype=np.uint8),1)
        if hashlib.sha256(cv2.cvtColor(image,cv2.COLOR_BGR2RGB).tobytes()).hexdigest() != sample['rawSha256']:
            raise ValueError('Source frame checksum mismatch')
        height,width = image.shape[:2]
        data = cv2.resize(image,(544,320)).transpose(2,0,1)[None].astype(np.float32)
        times = []
        for _ in range(4):
            started = time.perf_counter()
            result = compiled([data])
            times.append((time.perf_counter()-started)*1000)
        boxes = result[compiled.output('boxes')]
        masks = result[compiled.output('masks')]
        overlay = image.copy()
        instances = []
        instance_masks = []
        for index,(box,mask) in enumerate(zip(boxes,masks)):
            if box[4] < .5:
                continue
            x0,y0,x1,y1 = box[:4]*np.array([width/544,height/320,width/544,height/320])
            transform = np.array([[(x1-x0)/224,0,x0],[0,(y1-y0)/224,y0]],dtype=np.float32)
            full = cv2.warpAffine(mask,transform,(width,height),flags=cv2.INTER_LINEAR,borderMode=cv2.BORDER_CONSTANT,borderValue=0)
            instance_masks.append(full)
            cv2.imencode('.png',np.round(full*255).astype(np.uint8))[1].tofile(directory/f'{stamp}-instance-{index}.png')
            color = np.array([(80,220,80),(220,140,50),(60,80,240),(220,70,220),(50,220,220)][index%5])
            alpha = (full>.5)[:,:,None]*.5
            overlay = np.round(overlay*(1-alpha)+color*alpha).astype(np.uint8)
            cv2.putText(overlay,str(index),(int(x0),int(y0)+16),cv2.FONT_HERSHEY_SIMPLEX,.6,(255,255,255),2)
            reviewed = []
            if stamp == 12000:
                yy,xx = np.ogrid[:height,:width]
                for cx,cy,radius in [(180,250,5),(230,245,5),(265,230,5)]:
                    values = full[(xx-cx)**2+(yy-cy)**2<=radius**2]
                    reviewed.append({'circle':[cx,cy,radius],'mean':float(values.mean()),'maximum':float(values.max())})
            instances.append({'index':index,'box':[float(x0),float(y0),float(x1),float(y1)],'score':float(box[4]),'reviewed':reviewed})
        cv2.imencode('.png',np.hstack((image,overlay)))[1].tofile(directory/f'{stamp}-instances.png')
        protection = None
        if body_report is not None:
            body_sample = next(s for s in body_report['samples'] if s['timestampMs']==stamp)
            if body_sample['rawSha256'] != sample['rawSha256']:
                raise ValueError('Body and instance frames differ')
            joints = [np.array(b['joints'],dtype=np.float32) for b in body_sample['bodies']]
            body_masks = [cv2.imdecode(np.frombuffer((args.body_report/f'{stamp}-mask-{i}.png').read_bytes(),dtype=np.uint8),0).astype(np.float32)/255 for i in range(len(joints))]
            protected,assignments = protect_body_masks(joints,body_masks,instance_masks)
            protection = {'scope':'Same-frame offline agreement; body masks are 8-bit diagnostic reconstructions, no OBS pixels',
                'source':str(args.body_report),'assignments':assignments,'bodies':[]}
            for index,(before,after) in enumerate(zip(body_masks,protected)):
                cv2.imencode('.png',np.round(after*255).astype(np.uint8))[1].tofile(directory/f'{stamp}-protected-{index}.png')
                values = []
                if stamp==12000 and np.mean(joints[index][[11,12,23,24],0]) < .5:
                    yy,xx = np.ogrid[:height,:width]
                    for cx,cy,radius in [(180,250,5),(230,245,5),(265,230,5)]:
                        region = (xx-cx)**2+(yy-cy)**2<=radius**2
                        values.append({'circle':[cx,cy,radius],'beforeMaximum':float(before[region].max()),'afterMaximum':float(after[region].max())})
                protection['bodies'].append({'beforePixels':int(np.count_nonzero(before)),
                    'afterPixels':int(np.count_nonzero(after)),'reviewed':values})
        report['samples'].append({'timestampMs':stamp,'rawSha256':sample['rawSha256'],'inferenceMs':times,'instances':instances,'protection':protection})
    (directory/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({'directory':str(directory),'counts':[len(s['instances']) for s in report['samples']]}))


if __name__ == '__main__':
    main()
