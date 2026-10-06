"""Experimental hybrid instance execution and offline diagnostic; not production."""
import argparse
import hashlib
import json
from pathlib import Path
import time

import cv2
import numpy as np
import openvino as ov
import onnxruntime as ort
from directml_execution import run
from person_instances import PersonInstances
from body_instances import protect_body_masks


class HybridCompiled:
    def __init__(self, directory, *, head_threads=4, partition='backbone'):
        if type(head_threads) is not int or head_threads not in (1,2,4):
            raise ValueError('Hybrid head threads must be 1, 2 or 4')
        if partition not in ('backbone','proposals','convolutions'):
            raise ValueError('Unknown hybrid partition')
        manifest = json.loads((directory/'report.json').read_text(encoding='utf-8'))
        expected = {
            'backbone.onnx':'ae23e13a0d6fccfbe8ad72467db1e184cc26807ce4aae3cb26733b384b788b1a',
            'head.xml':'44b3394c686e65b88898093d318b66f9b1dddfe661d4db4c9a2196759f1fe681',
            'head.bin':'3637e653f2f8b40cd3ce28bdedaaf3567c3bb88a0436e43e83e024808af79476'}
        if partition == 'proposals':
            expected = {
                'backbone.onnx':'93949e659df2bd7170749901d829f76e566e46ea0d1e537fff3cd27e6d491cc2',
                'head.xml':'e150d3ea892d1206c3c7638bd4231e557cfa06c214ce21c42e4ff8f597342747',
                'head.bin':'2ebb14939b9ad746889237978d532b90bab4faf1373a7bbc94af910b1d2fbcc1'}
        if partition == 'convolutions':
            expected = {
                'backbone.onnx':'87b11a9d3594d6f92d97d7d8d7818fd6d06cd8c2695ad0c85fc0e4e18ee0af7b',
                'head.xml':'b1ecc9d80c075bfe077cab0e806cb1b8dc3b5662dd9e0f523f1d3e11c3e0e56c',
                'head.bin':'2c3b684dc99b18dcdc3167fac6271072212e59ffb1faaa60b76db352163d5178'}
        for name, checksum in expected.items():
            if hashlib.sha256((directory/name).read_bytes()).hexdigest() != checksum:
                raise ValueError('Split model checksum mismatch')
        if ov.__version__.split('-')[0] != '2024.6.0':
            raise RuntimeError('Pinned OpenVINO runtime unavailable')
        if ort.__version__ != '1.24.4' or 'DmlExecutionProvider' not in ort.get_available_providers():
            raise RuntimeError('Pinned DirectML provider unavailable')
        options = ort.SessionOptions()
        options.enable_mem_pattern = False
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        options.add_session_config_entry('session.disable_cpu_ep_fallback','1')
        self.session = ort.InferenceSession(str(directory/'backbone.onnx'),sess_options=options,providers=['DmlExecutionProvider'])
        self.session.disable_fallback()
        self.head = ov.Core().compile_model(str(directory/'head.xml'),'CPU',
            {'INFERENCE_NUM_THREADS':head_threads,'NUM_STREAMS':1,'ENABLE_CPU_PINNING':False})
        self.features = [f'Conv_{index}' for index in range(405,409)]
        if partition == 'proposals':
            self.features += ['Unsqueeze_962','Unsqueeze_964','Gather_961']
        if partition == 'convolutions':
            self.features += [f'Conv_{index}' for index in (412,413,416,417,420,421,424,425,428,429)]
        if manifest['features'] != self.features:
            raise ValueError('Unexpected split feature contract')
        self.input = self.session.get_inputs()[0].name
        # Conversion changes Result ordering. Match each unique static feature
        # shape explicitly, never rely on positional output order.
        self.outputs = []
        for name in self.features:
            shape = list(self.head.input(name).shape)
            tensor_type = {'f32':'tensor(float)','i64':'tensor(int64)','i32':'tensor(int32)'}[self.head.input(name).element_type.get_type_name()]
            matches = [output.name for output in self.session.get_outputs() if output.shape == shape and output.type == tensor_type]
            if len(matches) != 1:
                raise ValueError('Backbone feature mapping is ambiguous')
            self.outputs.append(matches[0])
        if len(self.session.get_inputs()) != 1 or self.session.get_inputs()[0].shape != [1,3,320,544] or len(self.outputs) != len(self.features):
            raise ValueError('Unexpected backbone tensor contract')
        self.timing = {}

    def output(self, name):
        return name

    def __call__(self, values):
        started = time.perf_counter()
        gpu_timing = {}
        features = run(self.session,self.outputs,{self.input:values[0]},timing=gpu_timing)
        middle = time.perf_counter()
        inputs = dict(zip(self.features,features))
        inputs['image'] = values[0]
        result = self.head(inputs)
        self.timing = {'backboneMs':(middle-started)*1000,'headMs':(time.perf_counter()-middle)*1000,
            'gpuWaitMs':gpu_timing['waitMs'],'gpuExecutionMs':gpu_timing['executionMs']}
        return {name:result[self.head.output(name)] for name in ('boxes','labels','masks')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory',type=Path)
    parser.add_argument('--partition',choices=['backbone','proposals','convolutions'],default='backbone')
    args = parser.parse_args()
    source = Path(__file__).resolve().parent
    work = source.parents[2]/'artifacts/beauty-prototype'
    annotations = json.loads((source/'semantic-regions.json').read_text(encoding='utf-8'))
    report = {'scope':__doc__,'qualityAccepted':False,'attribution':annotations['attribution'],
        'onnxSha256':hashlib.sha256((args.directory/'backbone.onnx').read_bytes()).hexdigest(),'samples':[]}
    try:
        hybrid = HybridCompiled(args.directory,partition=args.partition)
        report['partition'] = args.partition
        full = ov.Core().compile_model(str(work/'person-instance/model.xml'),'CPU',
            {'INFERENCE_NUM_THREADS':4,'NUM_STREAMS':1,'ENABLE_CPU_PINNING':False})
        report['providers'] = hybrid.session.get_providers()
        report['backboneOutputs'] = hybrid.outputs
        body_dir = work/'body-real-mei_7uft'
        bodies = json.loads((body_dir/'report.json').read_text(encoding='utf-8'))
        detector = PersonInstances(work/'person-instance')
        for sample in annotations['samples']:
            stamp = sample['timestampMs']
            bgr = cv2.imdecode(np.frombuffer((work/f'face-segmentation-clc958q0/{stamp}-source.png').read_bytes(),np.uint8),1)
            if hashlib.sha256(cv2.cvtColor(bgr,cv2.COLOR_BGR2RGB).tobytes()).hexdigest() != sample['rawSha256']:
                raise ValueError('Fixture checksum mismatch')
            tensor = cv2.resize(bgr,(544,320)).transpose(2,0,1)[None].astype(np.float32)
            times = {'original':[],'hybrid':[]}
            for repetition in range(7):
                started = time.perf_counter(); expected = full([tensor]); original_ms = (time.perf_counter()-started)*1000
                started = time.perf_counter(); actual = hybrid([tensor]); hybrid_ms = (time.perf_counter()-started)*1000
                if repetition:
                    times['original'].append(original_ms);times['hybrid'].append(hybrid_ms)
            differences = {}
            for name in ('boxes','labels','masks'):
                a,b = expected[full.output(name)],actual[name]
                if a.shape != b.shape or not np.isfinite(b).all():
                    raise ValueError('Hybrid output shape/validity differs')
                delta = np.abs(a.astype(np.float64)-b.astype(np.float64))
                differences[name] = {'max':float(delta.max()) if delta.size else 0,'mean':float(delta.mean()) if delta.size else 0}
            body = next(item for item in bodies['samples'] if item['timestampMs'] == stamp)
            if body['rawSha256'] != sample['rawSha256']:
                raise ValueError('Body fixture mismatch')
            joints = [np.array(item['joints'],dtype=np.float32) for item in body['bodies']]
            masks = [cv2.imdecode(np.frombuffer((body_dir/f'{stamp}-mask-{i}.png').read_bytes(),np.uint8),0).astype(np.float32)/255 for i in range(len(joints))]
            protection = {}
            for name,compiled in [('original',full),('hybrid',hybrid)]:
                detector.compiled = compiled
                instances = detector.analyze(cv2.cvtColor(bgr,cv2.COLOR_BGR2RGB))
                protected,assignments = protect_body_masks(joints,masks,instances)
                reviewed = []
                for index,mask in enumerate(protected):
                    if stamp == 12000 and np.mean(joints[index][[11,12,23,24],0]) < .5:
                        yy,xx = np.ogrid[:mask.shape[0],:mask.shape[1]]
                        for cx,cy,radius in [(180,250,5),(230,245,5),(265,230,5),(120,190,5)]:
                            region = (xx-cx)**2+(yy-cy)**2<=radius**2
                            reviewed.append({'circle':[cx,cy,radius],'maximum':float(mask[region].max()),'mean':float(mask[region].mean())})
                protection[name] = {'assignments':assignments,'protectedPixels':[int(np.count_nonzero(mask)) for mask in protected],'reviewed':reviewed}
            report['samples'].append({'timestampMs':stamp,'timings':times,'lastStages':hybrid.timing,'protection':protection,
                'differences':differences,'originalScores':expected[full.output('boxes')][:,4].tolist(),'hybridScores':actual['boxes'][:,4].tolist()})
    except Exception as error:
        report['error'] = f'{type(error).__name__}: {error}'
        raise
    finally:
        (args.directory/'hybrid-report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
