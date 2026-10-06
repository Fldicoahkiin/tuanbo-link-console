"""Compare three-view YuNet batching with unchanged single-view DirectML output."""
import hashlib
import json
from pathlib import Path
import tempfile
import time

import cv2
import numpy as np
import onnx
from onnx import numpy_helper

from directml_proposals import decode, OUTPUT_NAMES, DirectMLProposals
from proposal_views import tiled_proposals


class Views:
    def __init__(self):
        self.images=[]

    def locate(self, image):
        self.images.append(image)
        return None


def main():
    work=Path('artifacts/beauty-prototype')
    assets=json.loads(Path(__file__).with_name('assets.json').read_text(encoding='utf-8'))
    source=work/assets['proposalModel']['file']
    if hashlib.sha256(source.read_bytes()).hexdigest()!=assets['proposalModel']['sha256']:
        raise ValueError('Source model checksum mismatch')
    video=work/'public-motion/cha-cha.webm'
    if hashlib.sha256(video.read_bytes()).hexdigest()!='d60a4057489616003b6f66c26ed80825d95c8ea9b839c8c30824c06be65772fa':
        raise ValueError('Video checksum mismatch')
    directory=Path(tempfile.mkdtemp(prefix='proposal-batch-',dir=work))
    report={'scope':__doc__,'qualityAccepted':False,'samples':[]}
    capture=cv2.VideoCapture(str(video))
    try:
        cv2.setNumThreads(1)
        model=onnx.load(source)
        model.graph.input[0].type.tensor_type.shape.dim[0].dim_value=3
        for output in model.graph.output:
            output.type.tensor_type.shape.dim[0].dim_value=3
        shapes={node.input[1] for node in model.graph.node if node.op_type=='Reshape'}
        report['changedShapeInitializers']=sorted(shapes)
        for initializer in model.graph.initializer:
            if initializer.name in shapes:
                value=numpy_helper.to_array(initializer).copy()
                if value.shape!=(3,) or value[0]!=1 or value[1]!=-1:
                    raise ValueError('Unexpected model reshape contract')
                value[0]=3
                initializer.CopyFrom(numpy_helper.from_array(value,initializer.name))
        del model.graph.value_info[:]
        model=onnx.shape_inference.infer_shapes(model)
        onnx.checker.check_model(model)
        output=directory/'yunet-three-views.onnx'
        onnx.save(model,output)
        report['onnxSha256']=hashlib.sha256(output.read_bytes()).hexdigest()
        original=DirectMLProposals(source.read_bytes())
        batch=DirectMLProposals(output.read_bytes(),batch_size=3)
        for second in range(47):
            capture.set(cv2.CAP_PROP_POS_MSEC,second*1000)
            ok,bgr=capture.read()
            if not ok: raise ValueError('Missing video frame')
            rgb=np.zeros((640,360,3),dtype=np.uint8)
            rgb[219:421]=cv2.cvtColor(cv2.resize(bgr,(360,202),interpolation=cv2.INTER_AREA),cv2.COLOR_BGR2RGB)
            views=Views();tiled_proposals(views,rgb,640)
            if len(views.images)!=3: raise ValueError('Expected three views')
            tensor=np.zeros((3,3,640,640),dtype=np.float32)
            for index,view in enumerate(views.images):
                tensor[index,:,:view.shape[0],:view.shape[1]]=cv2.cvtColor(view,cv2.COLOR_RGB2BGR).transpose(2,0,1)
            start=time.perf_counter()
            reference=[original.session.run(list(OUTPUT_NAMES),{'input':tensor[index:index+1]}) for index in range(3)]
            sequential_ms=(time.perf_counter()-start)*1000
            start=time.perf_counter()
            actual=batch.session.run(list(OUTPUT_NAMES),{'input':tensor})
            batch_ms=(time.perf_counter()-start)*1000
            differences=[]
            for index in range(3):
                expected=decode(reference[index])
                result=decode([value[index:index+1] for value in actual])
                if expected is None or result is None:
                    if expected is not None or result is not None: raise ValueError('Face presence changed')
                    differences.append({'faces':0,'maximumDifference':0})
                else:
                    if result.shape!=expected.shape: raise ValueError('Face count changed')
                    difference=float(np.max(np.abs(result-expected)))
                    differences.append({'faces':len(result),'maximumDifference':difference})
                    if not np.allclose(result,expected,rtol=0,atol=.001): raise ValueError('Decoded face changed')
            mapped=tiled_proposals(original,rgb,640)
            mapped_batch=tiled_proposals(batch,rgb,640,batched=True)
            mapped_difference=0
            if mapped is None or mapped_batch is None:
                if mapped is not None or mapped_batch is not None: raise ValueError('Mapped face presence changed')
            else:
                if mapped.shape!=mapped_batch.shape or not np.allclose(mapped,mapped_batch,rtol=0,atol=.001):
                    raise ValueError('Mapped face results changed')
                mapped_difference=float(np.max(np.abs(mapped-mapped_batch)))
            report['samples'].append({'second':second,'sequentialMs':sequential_ms,'batchMs':batch_ms,
                'views':differences,'mappedMaximumDifference':mapped_difference})
        report['parityPassed']=True
    except Exception as error:
        report['error']=f'{type(error).__name__}: {error}'
        raise
    finally:
        capture.release()
        (directory/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
        print(json.dumps({'directory':str(directory),'error':report.get('error')}))


if __name__=='__main__':main()
