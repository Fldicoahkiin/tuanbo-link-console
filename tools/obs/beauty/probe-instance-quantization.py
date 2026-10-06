"""Paired FP16/INT8 diagnostic on held-out timestamps; not production acceptance."""
import argparse
import hashlib
import json
from pathlib import Path
import time

import cv2
import numpy as np
import openvino as ov
from body_instances import protect_body_masks
from person_instances import PersonInstances


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    source = Path(__file__).resolve().parent
    work = source.parents[2]/'artifacts/beauty-prototype'
    manifest = json.loads((args.directory/'report.json').read_text(encoding='utf-8'))
    for name, checksum in manifest['outputs'].items():
        if hashlib.sha256((args.directory/name).read_bytes()).hexdigest() != checksum:
            raise ValueError('Quantized artifact checksum mismatch')
    annotations = json.loads((source/'semantic-regions.json').read_text(encoding='utf-8'))
    body_dir = work/'body-real-mei_7uft'
    bodies = json.loads((body_dir/'report.json').read_text(encoding='utf-8'))
    report = {'scope': __doc__, 'qualityAccepted': False, 'attribution': annotations['attribution'],
        'quantizedOutputs': manifest['outputs'], 'samples': []}
    with PersonInstances(work/'person-instance') as detector:
        original = detector.compiled
        quantized = ov.Core().compile_model(str(args.directory/'model.xml'), 'CPU',
            {'INFERENCE_NUM_THREADS': 4, 'NUM_STREAMS': 1, 'ENABLE_CPU_PINNING': False})
        for sample in annotations['samples']:
            stamp = sample['timestampMs']
            image = cv2.imdecode(np.frombuffer((work/f'face-segmentation-clc958q0/{stamp}-source.png').read_bytes(), dtype=np.uint8), 1)
            rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            if hashlib.sha256(rgb.tobytes()).hexdigest() != sample['rawSha256']:
                raise ValueError('Fixture checksum mismatch')
            body = next(item for item in bodies['samples'] if item['timestampMs'] == stamp)
            if body['rawSha256'] != sample['rawSha256']:
                raise ValueError('Body frame mismatch')
            joints = [np.array(item['joints'], dtype=np.float32) for item in body['bodies']]
            masks = [cv2.imdecode(np.frombuffer((body_dir/f'{stamp}-mask-{i}.png').read_bytes(), dtype=np.uint8), 0).astype(np.float32)/255 for i in range(len(joints))]
            record = {'timestampMs': stamp, 'variants': {}}
            timings = {'fp16': [], 'int8': []}
            outputs = {}
            for repetition in range(9):
                order = [('fp16', original), ('int8', quantized)]
                if repetition % 2:
                    order.reverse()
                for name, compiled in order:
                    # Explicit offline comparison only; production loader remains checksum restricted.
                    detector.compiled = compiled
                    started = time.perf_counter()
                    outputs[name] = detector.analyze(rgb)
                    if repetition:
                        timings[name].append((time.perf_counter()-started)*1000)
            for name, instances in outputs.items():
                protected, assignments = protect_body_masks(joints, masks, instances)
                reviewed = []
                for index, after in enumerate(protected):
                    cv2.imencode('.png', np.round(after*255).astype(np.uint8))[1].tofile(args.directory/f'{stamp}-{name}-protected-{index}.png')
                    if stamp == 12000 and np.mean(joints[index][[11,12,23,24],0]) < .5:
                        yy, xx = np.ogrid[:rgb.shape[0], :rgb.shape[1]]
                        for cx, cy, radius in [(180,250,5), (230,245,5), (265,230,5), (120,190,5)]:
                            region = (xx-cx)**2+(yy-cy)**2 <= radius**2
                            reviewed.append({'circle': [cx,cy,radius], 'mean': float(after[region].mean()), 'max': float(after[region].max())})
                record['variants'][name] = {'instances': len(instances), 'assignments': assignments,
                    'inferenceMs': timings[name], 'medianMs': float(np.median(timings[name])),
                    'protectedPixels': [int(np.count_nonzero(mask)) for mask in protected], 'reviewed': reviewed}
            report['samples'].append(record)
    (args.directory/'comparison.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
