"""Move semantic softmax and skin-channel selection onto DirectML without changing weights."""
import hashlib
import json
from pathlib import Path
import tempfile
import time

import cv2
import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto

from directml_segmentation import DirectMLFaceSegmentation, MODEL_SHA256


def main():
    work=Path('artifacts/beauty-prototype')
    data=(work/'selfie_multiclass_256x256.onnx').read_bytes()
    if hashlib.sha256(data).hexdigest()!=MODEL_SHA256:
        raise ValueError('Semantic source checksum mismatch')
    directory=Path(tempfile.mkdtemp(prefix='semantic-activation-',dir=work))
    report={'scope':__doc__,'qualityAccepted':False,'samples':[]}
    try:
        cv2.setNumThreads(1)
        model=onnx.load_model_from_string(data)
        model.graph.node.extend([
            helper.make_node('Softmax',['Identity'],['skin_probabilities'],axis=3),
            helper.make_node('Gather',['skin_probabilities','skin_channel'],['skin_probability'],axis=3)])
        model.graph.initializer.append(numpy_helper.from_array(np.array(3,dtype=np.int64),'skin_channel'))
        del model.graph.output[:]
        model.graph.output.append(helper.make_tensor_value_info('skin_probability',TensorProto.FLOAT,[1,256,256]))
        model=onnx.shape_inference.infer_shapes(model)
        onnx.checker.check_model(model)
        target=directory/'skin-probability.onnx'
        onnx.save(model,target)
        report['onnxSha256']=hashlib.sha256(target.read_bytes()).hexdigest()
        with DirectMLFaceSegmentation(data) as reference, DirectMLFaceSegmentation(target.read_bytes(),probability_output=True) as candidate:
            for stamp in (4000,8000,10000,12000,14000):
                bgr=cv2.imdecode(np.frombuffer((work/f'face-segmentation-clc958q0/{stamp}-source.png').read_bytes(),np.uint8),1)
                rgb=cv2.cvtColor(bgr,cv2.COLOR_BGR2RGB)
                portrait=np.zeros((640,360,3),dtype=np.uint8);portrait[217:420]=cv2.resize(rgb,(360,203))
                asymmetric=np.zeros((639,479,3),dtype=np.uint8);asymmetric[11:612,73:374]=cv2.resize(rgb,(301,601))
                cases={'landscape':rgb,'portrait':portrait,'asymmetric':asymmetric,'square':cv2.resize(rgb,(256,256)),'narrow':cv2.resize(rgb,(17,613))}
                for name,pixels in cases.items():
                    started=time.perf_counter();expected=reference.analyze(pixels)
                    reference_ms=(time.perf_counter()-started)*1000
                    started=time.perf_counter();actual=candidate.analyze(pixels)
                    candidate_ms=(time.perf_counter()-started)*1000
                    difference=np.abs(actual-expected)
                    row={'timestampMs':stamp,'case':name,'referenceMs':reference_ms,'candidateMs':candidate_ms,
                        'maxDifference':float(difference.max()),'meanDifference':float(difference.mean())}
                    report['samples'].append(row)
                    if row['maxDifference']>.0001 or row['meanDifference']>.00001:
                        raise ValueError('Skin probability parity failed')
        report['parityPassed']=True
    except Exception as error:
        report['error']=f'{type(error).__name__}: {error}'
        raise
    finally:
        (directory/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
        print(json.dumps({'directory':str(directory),'error':report.get('error')}))


if __name__=='__main__':main()
