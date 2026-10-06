"""Compare identical active pixels with and without portrait black borders."""
import hashlib
import json
from pathlib import Path
import tempfile
import time
import cv2
import numpy as np
from person_instances import PersonInstances


def main():
    source=Path(__file__).parent
    work=source.resolve().parents[2]/'artifacts/beauty-prototype'
    annotations=json.loads((source/'semantic-regions.json').read_text(encoding='utf-8'))
    directory=Path(tempfile.mkdtemp(prefix='instance-framing-',dir=work))
    report={'scope':__doc__,'qualityAccepted':False,'attribution':annotations['attribution'],'samples':[]}
    with PersonInstances(work/'person-instance') as detector:
        for sample in annotations['samples']:
            stamp=sample['timestampMs']
            bgr=cv2.imdecode(np.frombuffer((work/f'face-segmentation-clc958q0/{stamp}-source.png').read_bytes(),dtype=np.uint8),1)
            rgb=cv2.cvtColor(bgr,cv2.COLOR_BGR2RGB)
            if hashlib.sha256(rgb.tobytes()).hexdigest()!=sample['rawSha256']:
                raise ValueError('Source checksum mismatch')
            active=cv2.resize(rgb,(360,202),interpolation=cv2.INTER_AREA)
            portrait=np.zeros((640,360,3),dtype=np.uint8);portrait[219:421]=active
            uncropped_data=cv2.resize(cv2.cvtColor(portrait,cv2.COLOR_RGB2BGR),(544,320)).transpose(2,0,1)[None].astype(np.float32)
            uncropped=detector.compiled([uncropped_data])
            uncropped_count=int(np.count_nonzero(uncropped[detector.compiled.output('boxes')][:,4]>=.5))
            started=time.perf_counter();plain=detector.analyze(active);plain_ms=(time.perf_counter()-started)*1000
            started=time.perf_counter();padded=detector.analyze(portrait);padded_ms=(time.perf_counter()-started)*1000
            if len(plain)!=len(padded):raise AssertionError('Black border changed instance count')
            differences=[]
            for index,(first,second) in enumerate(zip(plain,padded)):
                if second[:219].any() or second[421:].any():raise AssertionError('Mask leaked into black border')
                delta=np.abs(first-second[219:421])
                differences.append({'max':float(delta.max()),'mean':float(delta.mean())})
                cv2.imencode('.png',np.round(second*255).astype(np.uint8))[1].tofile(directory/f'{stamp}-{index}.png')
            report['samples'].append({'timestampMs':stamp,'rawSha256':sample['rawSha256'],'instances':len(plain),
                'uncroppedInstances':uncropped_count,'plainMs':plain_ms,'paddedMs':padded_ms,'maskDifferences':differences})
    (directory/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({'directory':str(directory),'samples':report['samples']}))


if __name__=='__main__':main()
