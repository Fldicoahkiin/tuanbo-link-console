"""Real-frame parity of DirectML RTMDet heads with official CPU postprocessing."""
import hashlib
import argparse
import json
from pathlib import Path
import tempfile
import time

import cv2
import mmdet
from mmdet.apis import init_detector, inference_detector
from mmdet.utils import get_test_pipeline_cfg
from mmcv.transforms import Compose
import numpy as np
import onnxruntime as ort
import torch
from body_instances import protect_body_masks
from rtmdet_postprocess import decode_people, prepare_image
from rtmdet_instances import suppress_duplicate_masks


def probe_motion(model, session, work, report):
    video = work/'public-motion/cha-cha.webm'
    if hashlib.sha256(video.read_bytes()).hexdigest() != 'd60a4057489616003b6f66c26ed80825d95c8ea9b839c8c30824c06be65772fa':
        raise ValueError('Motion fixture checksum mismatch')
    capture = cv2.VideoCapture(str(video))
    if not capture.isOpened():
        raise ValueError('Cannot open motion fixture')
    report['scope'] = '47 motion frames: standalone DirectML against official full CPU RTMDet'
    try:
        with torch.inference_mode():
            # The container advertises 1437 frames, but OpenCV decodes 1407.
            # Match the established benchmark's 0..46 second sample positions.
            for seconds in range(47):
                capture.set(cv2.CAP_PROP_POS_MSEC,seconds*1000)
                success,bgr=capture.read()
                if not success:
                    raise ValueError(f'Cannot decode frame at {seconds}s')
                bgr=cv2.resize(bgr,(640,360),interpolation=cv2.INTER_AREA)
                expected=inference_detector(model,bgr).pred_instances.cpu()
                expected=expected[(expected.labels==0)&(expected.scores>=.5)]
                start=time.perf_counter()
                inputs,metadata=prepare_image(bgr)
                prepared=time.perf_counter()
                raw=session.run(None,{'image':inputs})
                inferred=time.perf_counter()
                boxes,scores,masks=decode_people(raw,metadata)
                ended=time.perf_counter()
                reference=expected.masks.numpy()
                same_shape=masks.shape==reference.shape
                item={'timestampMs':seconds*1000,'people':len(masks),'referencePeople':len(reference),
                    'rawSha256':hashlib.sha256(bgr.tobytes()).hexdigest(),
                    'preprocessMs':(prepared-start)*1000,'gpuMs':(inferred-prepared)*1000,
                    'postprocessMs':(ended-inferred)*1000,'totalMs':(ended-start)*1000,
                    'differentPixels':int(np.count_nonzero(masks!=reference)) if same_shape else None,
                    'boxMaximumDifference':float(np.max(np.abs(boxes-expected.bboxes.numpy()))) if same_shape and len(masks) else None}
                if same_shape:
                    intersection=np.logical_and(masks,reference).sum(axis=(1,2))
                    union=np.logical_or(masks,reference).sum(axis=(1,2))
                    item['maskIoU']=(intersection/np.maximum(union,1)).tolist()
                report['samples'].append(item)
                print(json.dumps({'timestampMs':seconds*1000,'differentPixels':item['differentPixels']}),flush=True)
    finally:
        capture.release()
    report['parityPassed']=all(item['differentPixels']==0 for item in report['samples'])
    if not report['parityPassed']:
        raise ValueError('Motion parity mismatch; inspect recorded frame differences')


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--motion',action='store_true')
    arguments=parser.parse_args()
    source = Path(__file__).resolve().parent
    work = source.parents[2]/'artifacts/beauty-prototype'
    assets = json.loads((source/'rtmdet-assets.json').read_text(encoding='utf-8'))
    weights = work/'rtmdet-ins-tiny/model.pth'
    onnx = work/'rtmdet-export-vgxocmul/raw-heads.onnx'
    if hashlib.sha256(weights.read_bytes()).hexdigest() != assets['sha256']:
        raise ValueError('Checkpoint checksum mismatch')
    if hashlib.sha256(onnx.read_bytes()).hexdigest() != 'e6a5e0f5e8c6403ac3935228d66ea2b1b4d8cb67f2eb6f45eb8ef90a72653779':
        raise ValueError('ONNX checksum mismatch')
    if (mmdet.__version__,torch.__version__,ort.__version__) != ('3.3.0','2.0.0+cpu','1.24.4'):
        raise ValueError('Use the pinned experimental environment')
    directory = Path(tempfile.mkdtemp(prefix='rtmdet-directml-',dir=work))
    report = {'scope':__doc__,'qualityAccepted':False,'samples':[]}
    try:
        cv2.setNumThreads(1);torch.set_num_threads(4)
        config = Path(mmdet.__file__).parent/'.mim/configs/rtmdet'/assets['configuration']
        model = init_detector(str(config),checkpoint=None,device='cpu',cfg_options={'model.backbone.init_cfg':None})
        model.load_state_dict(torch.load(weights,map_location='cpu',weights_only=True)['state_dict'],strict=True)
        pipeline_config = get_test_pipeline_cfg(model.cfg.copy())
        pipeline_config[0].type = 'mmdet.LoadImageFromNDArray'
        pipeline = Compose(pipeline_config)
        settings = ort.SessionOptions();settings.enable_mem_pattern=False
        settings.execution_mode=ort.ExecutionMode.ORT_SEQUENTIAL
        settings.intra_op_num_threads=settings.inter_op_num_threads=1
        settings.add_session_config_entry('session.disable_cpu_ep_fallback','1')
        session=ort.InferenceSession(str(onnx),sess_options=settings,providers=['DmlExecutionProvider'])
        session.disable_fallback()
        if arguments.motion:
            probe_motion(model,session,work,report)
            return
        post_config=model.bbox_head.test_cfg.copy()
        # The final consumer already rejects scores below .5. Drop them before
        # constructing masks, while retaining the official NMS and mask math.
        post_config.score_thr=.5
        annotations=json.loads((source/'semantic-regions.json').read_text(encoding='utf-8'))
        body_dir=work/'body-real-mei_7uft'
        body_report=json.loads((body_dir/'report.json').read_text(encoding='utf-8'))
        report['attribution']=annotations['attribution']
        with torch.inference_mode():
            for sample in annotations['samples']:
                stamp=sample['timestampMs']
                bgr=cv2.imdecode(np.frombuffer((work/f'face-segmentation-clc958q0/{stamp}-source.png').read_bytes(),np.uint8),1)
                if hashlib.sha256(cv2.cvtColor(bgr,cv2.COLOR_BGR2RGB).tobytes()).hexdigest()!=sample['rawSha256']:
                    raise ValueError('Fixture checksum mismatch')
                expected=inference_detector(model,bgr).pred_instances.cpu()
                expected=expected[(expected.labels==0)&(expected.scores>=.5)]
                times=[]
                for _ in range(3):
                    started=time.perf_counter()
                    data=pipeline(dict(img=bgr,img_id=0))
                    prepared=model.data_preprocessor(dict(inputs=[data['inputs']],data_samples=[data['data_samples']]),False)
                    inputs=prepared['inputs'].numpy()
                    if inputs.shape!=(1,3,640,640): raise ValueError('Unexpected preprocessed shape')
                    ready=time.perf_counter()
                    raw=[torch.from_numpy(item) for item in session.run(None,{'image':inputs})]
                    inferred=time.perf_counter()
                    result=model.bbox_head.predict_by_feat(raw[:3],raw[3:6],raw[6:9],raw[9],
                        batch_img_metas=[prepared['data_samples'][0].metainfo],cfg=post_config,rescale=True)[0]
                    result=result[(result.labels==0)&(result.scores>=.5)]
                    ended=time.perf_counter()
                    times.append({'preprocessMs':(ready-started)*1000,'gpuMs':(inferred-ready)*1000,
                                  'postprocessMs':(ended-inferred)*1000,'totalMs':(ended-started)*1000})
                if result.masks.shape!=expected.masks.shape: raise ValueError('Person count or output shape changed')
                predicted_masks=result.masks.numpy();reference_masks=expected.masks.numpy()
                standalone_inputs,standalone_metadata=prepare_image(bgr)
                preprocessing_difference=float(np.max(np.abs(standalone_inputs-inputs)))
                if preprocessing_difference!=0:
                    raise ValueError(f'Standalone preprocessing changed: {preprocessing_difference}')
                for key in ('ori_shape','img_shape','scale_factor'):
                    if tuple(standalone_metadata[key])!=tuple(prepared['data_samples'][0].metainfo[key]):
                        raise ValueError(f'Standalone metadata changed: {key}')
                standalone_times=[]
                for _ in range(3):
                    standalone_started=time.perf_counter()
                    standalone_boxes,standalone_scores,standalone_masks=decode_people(
                        [item.numpy() for item in raw],standalone_metadata)
                    standalone_times.append((time.perf_counter()-standalone_started)*1000)
                if standalone_masks.shape!=reference_masks.shape:
                    raise ValueError('Standalone person count or mask shape changed')
                standalone_union=np.logical_or(standalone_masks,reference_masks).sum(axis=(1,2))
                standalone_intersection=np.logical_and(standalone_masks,reference_masks).sum(axis=(1,2))
                union=np.logical_or(predicted_masks,reference_masks).sum(axis=(1,2))
                intersection=np.logical_and(predicted_masks,reference_masks).sum(axis=(1,2))
                body=next(item for item in body_report['samples'] if item['timestampMs']==stamp)
                if body['rawSha256']!=sample['rawSha256']: raise ValueError('Body fixture mismatch')
                joints=[np.array(item['joints'],dtype=np.float32) for item in body['bodies']]
                masks=[cv2.imdecode(np.frombuffer((body_dir/f'{stamp}-mask-{i}.png').read_bytes(),np.uint8),0).astype(np.float32)/255 for i in range(len(joints))]
                protected,assignments=protect_body_masks(joints,masks,list(predicted_masks.astype(np.float32)))
                refined,refined_assignments=protect_body_masks(joints,masks,
                    suppress_duplicate_masks(list(standalone_masks.astype(np.float32))),anchor_radius=1)
                if stamp==12000:
                    for index,mask in enumerate(refined):
                        if np.mean(joints[index][[11,12,23,24],0])<.5:
                            yy,xx=np.ogrid[:mask.shape[0],:mask.shape[1]]
                            for cx,cy,r in [(180,250,5),(230,245,5),(265,230,5),(350,30,5)]:
                                if np.any(mask[(xx-cx)**2+(yy-cy)**2<=r*r]):
                                    raise ValueError('Refined protection leaked into reviewed exclusion')
                            if not np.all(mask[(xx-120)**2+(yy-190)**2<=25]>.9):
                                raise ValueError('Refined protection lost reviewed visible body')
                reviewed=[]
                for index,mask in enumerate(protected):
                    if stamp==12000 and np.mean(joints[index][[11,12,23,24],0])<.5:
                        yy,xx=np.ogrid[:mask.shape[0],:mask.shape[1]]
                        for cx,cy,r in [(180,250,5),(230,245,5),(265,230,5),(350,30,5),(120,190,5)]:
                            region=(xx-cx)**2+(yy-cy)**2<=r*r
                            reviewed.append({'circle':[cx,cy,r],'maximum':float(mask[region].max()),'mean':float(mask[region].mean())})
                report['samples'].append({'timestampMs':stamp,'timings':times,'people':len(result),
                    'standalonePostprocessMs':standalone_times,
                    'refinedAssignments':refined_assignments,
                    'refinedProtectedPixels':[int(np.count_nonzero(mask)) for mask in refined],
                    'standalonePreprocessMaximumDifference':preprocessing_difference,
                    'standaloneDifferentPixels':int(np.count_nonzero(standalone_masks!=reference_masks)),
                    'standaloneMaskIoU':(standalone_intersection/np.maximum(standalone_union,1)).tolist(),
                    'standaloneBoxMaximumDifference':float(np.max(np.abs(standalone_boxes-expected.bboxes.numpy()))) if len(result) else 0,
                    'maskIoU':(intersection/np.maximum(union,1)).tolist(),'differentMaskPixels':int(np.count_nonzero(predicted_masks!=reference_masks)),
                    'boxMaximumDifference':float(torch.max(torch.abs(result.bboxes-expected.bboxes))) if len(result) else 0,
                    'assignments':assignments,'protectedPixels':[int(np.count_nonzero(mask)) for mask in protected],'reviewed':reviewed})
                if not np.array_equal(standalone_masks,reference_masks):
                    raise ValueError('Standalone binary masks differ from official reference; inspect recorded pixel counts')
                if not np.array_equal(predicted_masks,reference_masks):
                    raise ValueError('DirectML binary masks differ from official reference')
                if not np.allclose(standalone_boxes,expected.bboxes.numpy(),rtol=0,atol=.001):
                    raise ValueError('Standalone boxes differ from official reference')
                if not np.allclose(standalone_scores,expected.scores.numpy(),rtol=0,atol=.0001):
                    raise ValueError('Standalone confidence differs from official reference')
        report['parityPassed']=True
    except Exception as error:
        report['error']=f'{type(error).__name__}: {error}'
        raise
    finally:
        (directory/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
        print(json.dumps({'directory':str(directory),'error':report.get('error')}))


if __name__=='__main__': main()
