"""Offline RTMDet instance quality probe. Not part of the shipping beauty worker."""
import hashlib
import json
from pathlib import Path
import tempfile
import time

import cv2
import mmdet
import numpy as np
import torch
from mmdet.apis import init_detector, inference_detector
from body_instances import protect_body_masks


def main():
    source = Path(__file__).resolve().parent
    work = source.parents[2] / 'artifacts/beauty-prototype'
    assets = json.loads((source / 'rtmdet-assets.json').read_text(encoding='utf-8'))
    model_path = work / 'rtmdet-ins-tiny' / assets['file']
    data = model_path.read_bytes()
    if len(data) != assets['bytes'] or hashlib.sha256(data).hexdigest() != assets['sha256']:
        raise ValueError('RTMDet checkpoint checksum mismatch')
    if mmdet.__version__ != '3.3.0' or torch.__version__ != '2.0.0+cpu':
        raise ValueError('Use the pinned isolated RTMDet environment')
    directory = Path(tempfile.mkdtemp(prefix='rtmdet-quality-', dir=work))
    report = {'scope':__doc__, 'qualityAccepted':False, 'assets':assets, 'samples':[]}
    try:
        torch.set_num_threads(4)
        cv2.setNumThreads(1)
        config = Path(mmdet.__file__).parent / '.mim/configs/rtmdet' / assets['configuration']
        # Disable the training config's ImageNet initializer. The only weights
        # permitted here are the checksum-verified complete detector checkpoint.
        model = init_detector(str(config), checkpoint=None, device='cpu',
                              cfg_options={'model.backbone.init_cfg':None})
        checkpoint = torch.load(model_path, map_location='cpu', weights_only=True)
        model.load_state_dict(checkpoint['state_dict'], strict=True)
        annotations = json.loads((source / 'semantic-regions.json').read_text(encoding='utf-8'))
        body_dir = work / 'body-real-mei_7uft'
        bodies = json.loads((body_dir / 'report.json').read_text(encoding='utf-8'))
        report['attribution'] = annotations['attribution']
        for sample in annotations['samples']:
            stamp = sample['timestampMs']
            path = work / f'face-segmentation-clc958q0/{stamp}-source.png'
            bgr = cv2.imdecode(np.frombuffer(path.read_bytes(), np.uint8), 1)
            if hashlib.sha256(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB).tobytes()).hexdigest() != sample['rawSha256']:
                raise ValueError('Fixture checksum mismatch')
            timings = []
            with torch.inference_mode():
                for _ in range(3):
                    started = time.perf_counter()
                    predicted = inference_detector(model, bgr).pred_instances.cpu()
                    timings.append((time.perf_counter() - started) * 1000)
            selected = (predicted.labels == 0) & (predicted.scores >= .5)
            instances = predicted.masks[selected].numpy().astype(np.float32)
            if len(instances) > 10:
                raise ValueError('Instance count exceeds protection contract')
            body = next(item for item in bodies['samples'] if item['timestampMs'] == stamp)
            if body['rawSha256'] != sample['rawSha256']:
                raise ValueError('Body annotation checksum mismatch')
            joints = [np.array(item['joints'], dtype=np.float32) for item in body['bodies']]
            masks = [cv2.imdecode(np.frombuffer((body_dir/f'{stamp}-mask-{i}.png').read_bytes(), np.uint8), 0).astype(np.float32)/255 for i in range(len(joints))]
            protected, assignments = protect_body_masks(joints, masks, list(instances))
            reviewed = []
            for index, mask in enumerate(protected):
                cv2.imencode('.png', np.rint(mask*255).astype(np.uint8))[1].tofile(str(directory/f'{stamp}-protected-{index}.png'))
                if stamp == 12000 and np.mean(joints[index][[11,12,23,24],0]) < .5:
                    yy,xx = np.ogrid[:mask.shape[0],:mask.shape[1]]
                    for cx,cy,radius in [(180,250,5),(230,245,5),(265,230,5),(120,190,5)]:
                        region = (xx-cx)**2+(yy-cy)**2 <= radius**2
                        reviewed.append({'circle':[cx,cy,radius], 'maximum':float(mask[region].max()), 'mean':float(mask[region].mean())})
            report['samples'].append({'timestampMs':stamp, 'timingsMs':timings,
                'scores':predicted.scores[selected].numpy().tolist(), 'assignments':assignments,
                'protectedPixels':[int(np.count_nonzero(mask)) for mask in protected], 'reviewed':reviewed})
    except Exception as error:
        report['error'] = f'{type(error).__name__}: {error}'
        raise
    finally:
        (directory/'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps({'directory':str(directory), 'error':report.get('error')}))


if __name__ == '__main__':
    main()
