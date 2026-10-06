"""Reproducible offline INT8 experiment; never modifies the production assets."""
import hashlib
import importlib.metadata
import json
from pathlib import Path
import tempfile
import time

import cv2
import nncf
import numpy as np
import openvino as ov


def main():
    source = Path(__file__).resolve().parent
    work = source.parents[2]/'artifacts/beauty-prototype'
    assets = json.loads((source/'instance-assets.json').read_text(encoding='utf-8'))
    for asset in assets['files']:
        data = (work/'person-instance'/asset['file']).read_bytes()
        for algorithm in ('sha256', 'sha384'):
            if hashlib.new(algorithm, data).hexdigest() != asset[algorithm]:
                raise ValueError('Original model checksum mismatch')
    video_asset = json.loads((source/'motion-assets.json').read_text(encoding='utf-8'))['videos'][0]
    video = work/'public-motion'/video_asset['file']
    if hashlib.sha256(video.read_bytes()).hexdigest() != video_asset['sha256']:
        raise ValueError('Calibration video checksum mismatch')
    if ov.__version__.split('-')[0] != '2024.6.0' or nncf.__version__ != '2.14.0':
        raise ValueError('Unexpected optimization tool version')
    directory = Path(tempfile.mkdtemp(prefix='instance-int8-', dir=work))
    report = {'scope': __doc__, 'qualityAccepted': False, 'modelAssets': assets,
        'calibrationSource': video_asset, 'calibration': [],
        'limitations': 'Calibration and held-out frames share one video; no generalization or OBS acceptance.',
        'preset': 'MIXED', 'targetDevice': 'CPU', 'versions': {
            name: importlib.metadata.version(name) for name in ('openvino', 'nncf', 'numpy', 'opencv-python')}}
    frames = []
    capture = cv2.VideoCapture(str(video))
    try:
        for second in range(47):
            stamp = second*1000+500
            if not capture.set(cv2.CAP_PROP_POS_MSEC, stamp):
                raise ValueError('Calibration seek failed')
            ok, frame = capture.read()
            if not ok:
                raise ValueError('Calibration decode failed')
            active = cv2.resize(frame, (360, 202), interpolation=cv2.INTER_AREA)
            tensor = cv2.resize(active, (544, 320)).transpose(2, 0, 1)[None].astype(np.float32)
            frames.append(tensor)
            report['calibration'].append({'requestedMs': stamp,
                'decodedMs': capture.get(cv2.CAP_PROP_POS_MSEC),
                'tensorSha256': hashlib.sha256(tensor.tobytes()).hexdigest()})
    finally:
        capture.release()
    (directory/'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'directory': str(directory), 'calibrationFrames': len(frames)}), flush=True)
    model = ov.Core().read_model(str(work/'person-instance/model.xml'))
    started = time.perf_counter()
    try:
        quantized = nncf.quantize(model, nncf.Dataset(frames), subset_size=len(frames),
            preset=nncf.QuantizationPreset.MIXED, target_device=nncf.TargetDevice.CPU)
        ov.save_model(quantized, directory/'model.xml')
        report['optimizationSeconds'] = time.perf_counter()-started
        report['outputs'] = {name: hashlib.sha256((directory/name).read_bytes()).hexdigest()
            for name in ('model.xml', 'model.bin')}
        report['fakeQuantizeNodes'] = sum(op.get_type_name() == 'FakeQuantize' for op in quantized.get_ops())
    except Exception as error:
        report['error'] = f'{type(error).__name__}: {error}'
        raise
    finally:
        (directory/'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
