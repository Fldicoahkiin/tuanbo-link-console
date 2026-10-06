"""Split the verified instance model for experimental GPU backbone execution."""
import hashlib
import argparse
import json
from pathlib import Path
import tempfile

import cv2
import numpy as np
import openvino as ov
from openvino.runtime import opset13 as ops
from openvino.runtime.passes import Manager, ConstantFolding


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    partitions = parser.add_mutually_exclusive_group()
    partitions.add_argument('--include-proposals',action='store_true',help='Move fixed-shape proposal convolutions and selection into the GPU partition')
    partitions.add_argument('--include-convolutions',action='store_true',help='Move only proposal convolutions; keep selection on CPU')
    args = parser.parse_args()
    source = Path(__file__).resolve().parent
    work = source.parents[2]/'artifacts/beauty-prototype'
    assets = json.loads((source/'instance-assets.json').read_text(encoding='utf-8'))
    for asset in assets['files']:
        data = (work/'person-instance'/asset['file']).read_bytes()
        for algorithm in ('sha256', 'sha384'):
            if hashlib.new(algorithm,data).hexdigest() != asset[algorithm]:
                raise ValueError('Instance model checksum mismatch')
    if ov.__version__.split('-')[0] != '2024.6.0':
        raise ValueError('Unexpected OpenVINO version')
    directory = Path(tempfile.mkdtemp(prefix='instance-split-',dir=work))
    core = ov.Core()
    original = core.read_model(str(work/'person-instance/model.xml'))
    model = original.clone()
    names = [f'Conv_{index}' for index in range(405,409)]
    if args.include_proposals:
        names += ['Unsqueeze_962','Unsqueeze_964','Gather_961']
    if args.include_convolutions:
        names += [f'Conv_{index}' for index in (412,413,416,417,420,421,424,425,428,429)]
    nodes = {node.get_friendly_name():node for node in model.get_ops()}
    features = [nodes[name].output(0) for name in names]
    backbone = ov.Model(features,model.get_parameters(),'instance_backbone').clone()
    folding = Manager()
    folding.register_pass(ConstantFolding())
    folding.run_passes(backbone)
    parameters = []
    for name,feature in zip(names,features):
        parameter = ops.parameter(feature.get_partial_shape(), feature.get_element_type(), name=name)
        parameter.output(0).set_names({name})
        for target in list(feature.get_target_inputs()):
            target.replace_source_output(parameter.output(0))
        parameters.append(parameter)
    # The head also reads the input shape for proposal clipping. Preserve this
    # dependency explicitly; compilation can fold its static dimensions.
    head = ov.Model(model.get_results(),parameters+model.get_parameters(),'instance_head')
    for name,part in [('backbone',backbone),('head',head)]:
        ov.save_model(part,directory/f'{name}.xml',compress_to_fp16=False)
    config = {'INFERENCE_NUM_THREADS':4,'NUM_STREAMS':1,'ENABLE_CPU_PINNING':False}
    full = core.compile_model(original,'CPU',config)
    first = core.compile_model(backbone,'CPU',config)
    second = core.compile_model(head,'CPU',config)
    annotations = json.loads((source/'semantic-regions.json').read_text(encoding='utf-8'))
    report = {'scope':__doc__,'qualityAccepted':False,'assets':assets,'features':names,
        'attribution':annotations['attribution'],'samples':[]}
    for sample in annotations['samples']:
        stamp = sample['timestampMs']
        bgr = cv2.imdecode(np.frombuffer((work/f'face-segmentation-clc958q0/{stamp}-source.png').read_bytes(),np.uint8),1)
        if hashlib.sha256(cv2.cvtColor(bgr,cv2.COLOR_BGR2RGB).tobytes()).hexdigest() != sample['rawSha256']:
            raise ValueError('Fixture checksum mismatch')
        tensor = cv2.resize(bgr,(544,320)).transpose(2,0,1)[None].astype(np.float32)
        expected = full([tensor])
        values = first([tensor])
        inputs = {name:values[first.output(i)] for i,name in enumerate(names)}
        inputs['image'] = tensor
        actual = second(inputs)
        differences = {}
        for name in ('boxes','labels','masks'):
            a,b = expected[full.output(name)],actual[second.output(name)]
            if a.shape != b.shape or not np.isfinite(b).all():
                raise ValueError('Split model changed output shape or validity')
            delta = np.abs(a.astype(np.float64)-b.astype(np.float64))
            differences[name] = {'maximum':float(delta.max()) if delta.size else 0,
                'mean':float(delta.mean()) if delta.size else 0}
        report['samples'].append({'timestampMs':stamp,'differences':differences})
    report['outputs'] = {name:hashlib.sha256((directory/name).read_bytes()).hexdigest()
        for name in ('backbone.xml','backbone.bin','head.xml','head.bin')}
    (directory/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({'directory':str(directory),'samples':report['samples']}))


if __name__ == '__main__':
    main()
