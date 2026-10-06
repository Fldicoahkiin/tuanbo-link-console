"""Export static RTMDet raw heads for an explicit DirectML feasibility experiment."""
import hashlib
import json
from pathlib import Path
import tempfile
import time

import mmdet
import numpy as np
import onnx
import onnxruntime as ort
import torch
from mmdet.apis import init_detector


class RawHeads(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, image):
        scores, boxes, kernels, masks = self.model.bbox_head(self.model.extract_feat(image))
        return tuple(scores) + tuple(boxes) + tuple(kernels) + (masks,)


def main():
    source = Path(__file__).resolve().parent
    work = source.parents[2] / 'artifacts/beauty-prototype'
    assets = json.loads((source/'rtmdet-assets.json').read_text(encoding='utf-8'))
    checkpoint_path = work/'rtmdet-ins-tiny'/assets['file']
    if hashlib.sha256(checkpoint_path.read_bytes()).hexdigest() != assets['sha256']:
        raise ValueError('RTMDet checkpoint checksum mismatch')
    if mmdet.__version__ != '3.3.0' or torch.__version__ != '2.0.0+cpu' or ort.__version__ != '1.24.4':
        raise ValueError('Use the pinned RTMDet export environment')
    directory = Path(tempfile.mkdtemp(prefix='rtmdet-export-',dir=work))
    report = {'scope':__doc__, 'qualityAccepted':False, 'assets':assets}
    try:
        torch.set_num_threads(4)
        config = Path(mmdet.__file__).parent/'.mim/configs/rtmdet'/assets['configuration']
        model = init_detector(str(config),checkpoint=None,device='cpu',cfg_options={'model.backbone.init_cfg':None})
        checkpoint = torch.load(checkpoint_path,map_location='cpu',weights_only=True)
        model.load_state_dict(checkpoint['state_dict'],strict=True)
        wrapper = RawHeads(model).eval()
        # Deterministic numerical export check; real-person quality is a
        # separate probe and is never inferred from this synthetic tensor.
        value = np.random.default_rng(7).normal(0,1,(1,3,640,640)).astype(np.float32)
        tensor = torch.from_numpy(value)
        names = [f'{kind}_{stride}' for kind in ('scores','boxes','kernels') for stride in (8,16,32)] + ['mask_features']
        output = directory/'raw-heads.onnx'
        with torch.inference_mode():
            expected = [item.numpy() for item in wrapper(tensor)]
            torch.onnx.export(wrapper,tensor,str(output),opset_version=17,
                input_names=['image'],output_names=names,do_constant_folding=True)
        onnx.checker.check_model(str(output))
        report['onnxSha256'] = hashlib.sha256(output.read_bytes()).hexdigest()
        options = ort.SessionOptions()
        options.enable_mem_pattern = False
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.intra_op_num_threads = options.inter_op_num_threads = 1
        options.add_session_config_entry('session.disable_cpu_ep_fallback','1')
        session = ort.InferenceSession(str(output),sess_options=options,providers=['DmlExecutionProvider'])
        session.disable_fallback()
        report['providers'] = session.get_providers()
        timings = []
        for _ in range(12):
            started = time.perf_counter()
            actual = session.run(names,{'image':value})
            timings.append((time.perf_counter()-started)*1000)
        report['timingsMs'] = timings
        report['differences'] = []
        for name,reference,result in zip(names,expected,actual):
            if reference.shape != result.shape or not np.isfinite(result).all():
                raise ValueError('Invalid exported output')
            delta = np.abs(reference-result)
            report['differences'].append({'name':name,'shape':list(result.shape),
                'maximum':float(delta.max()),'mean':float(delta.mean())})
        report['preprocessor'] = {'mean':model.data_preprocessor.mean.flatten().tolist(),
                                  'std':model.data_preprocessor.std.flatten().tolist()}
    except Exception as error:
        report['error'] = f'{type(error).__name__}: {error}'
        raise
    finally:
        (directory/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
        print(json.dumps({'directory':str(directory),'error':report.get('error')}))


if __name__ == '__main__':
    main()
