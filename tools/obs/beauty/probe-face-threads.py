"""Compare CPU face delegate budgets with the real concurrent GPU/body pipeline."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, nullcontext
import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import time
from queue import Queue, Empty
from unittest.mock import patch

import cv2
import numpy as np
from analyzer import FaceAnalyzer, merge_faces, occupied_views
from body import BodyAnalyzer, BodyGeometry, exclusive_masks
from directml_proposals import DirectMLProposals
from directml_segmentation import DirectMLFaceSegmentation
from face_proposals import FaceProposals
from inference_options import ThreadedBaseOptions
from person_instances import PersonInstances
from body_instances import protect_body_masks
from directml_execution import capture_timings, SubmissionQueue


def measured(action, *args):
    started = time.perf_counter()
    value = action(*args)
    return value, (time.perf_counter()-started)*1000


def measured_gpu(action, *args):
    with capture_timings() as timings:
        value,elapsed = measured(action,*args)
    return value,elapsed,timings


def body_frame(body, rgb, instance=None, instance_pool=None, refined_matching=False):
    instance_job = instance_pool.submit(instance.analyze,rgb) if instance else None
    bodies = body.analyze(rgb)
    masks = exclusive_masks(bodies)
    if instance_job is not None:
        instances=instance_job.result()
        if refined_matching:
            from rtmdet_instances import suppress_duplicate_masks
            instances=suppress_duplicate_masks(instances)
        masks,assignments = protect_body_masks([person.joints for person in bodies],masks,instances,
            anchor_radius=1 if refined_matching else 0)
        pairs = [(person,mask) for person,mask,index in zip(bodies,masks,assignments) if index is not None and np.any(mask>0)]
        bodies = [person for person,_ in pairs]; masks = [mask for _,mask in pairs]
    digest = hashlib.sha256()
    for person, mask in zip(bodies,masks):
        digest.update(person.joints.tobytes()); digest.update(mask.tobytes())
    return {'sha256': digest.hexdigest(), 'bodies': len(bodies),
        'protectedPixels': [int(np.count_nonzero(mask)) for mask in masks]}


class BalancedFaceAnalyzer(FaceAnalyzer):
    """Diagnostic only: retain all views and their merge order, share pending work."""
    def analyze(self, rgb):
        if rgb.ndim != 3 or rgb.shape[2] != 3 or rgb.dtype != np.uint8:
            raise ValueError('Face input must be uint8 RGB')
        height, width = rgb.shape[:2]
        if not 0 < width <= 640 or not 0 < height <= 640:
            raise ValueError('Face analysis dimensions must be within 640 pixels')
        pending = Queue()
        for view in occupied_views(rgb):
            pending.put(view)
        def work(detector):
            candidates = []
            while True:
                try:
                    view = pending.get_nowait()
                except Empty:
                    return candidates
                candidates.extend(self._analyze_views(detector, rgb, [view]))
        jobs = [self.executor.submit(work, detector) for detector in self.detectors]
        return merge_faces([candidate for job in jobs for candidate in job.result()])


class ActiveBodyAnalyzer(BodyAnalyzer):
    """Diagnostic: analyze nonblack content and restore the full canvas coordinates."""
    def analyze(self, rgb):
        occupied = np.any(rgb != 0, axis=2)
        rows = np.flatnonzero(np.any(occupied, axis=1))
        columns = np.flatnonzero(np.any(occupied, axis=0))
        if not rows.size:
            return []
        top, bottom = int(rows[0]), int(rows[-1])+1
        left, right = int(columns[0]), int(columns[-1])+1
        bodies = super().analyze(rgb[top:bottom,left:right])
        height, width = rgb.shape[:2]
        restored = []
        for body in bodies:
            joints = body.joints.copy()
            joints[:,0] = (joints[:,0]*(right-left)+left)/width
            joints[:,1] = (joints[:,1]*(bottom-top)+top)/height
            mask = np.zeros((height,width), dtype=np.float32)
            mask[top:bottom,left:right] = body.mask
            restored.append(BodyGeometry(joints,mask))
        return restored


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scheduling', action='store_true', help='Compare eager refinement with baseline-aware refinement')
    parser.add_argument('--view-scheduling', action='store_true', help='Compare fixed view batches with shared pending views; includes the failing UI fixture')
    parser.add_argument('--instance-threads',action='store_true',help='Compare 4/2/1/4 instance CPU threads with all other models unchanged')
    parser.add_argument('--instance-pinning',action='store_true',help='Compare CPU pinning off/on/off at four threads')
    parser.add_argument('--instance-quantization',type=Path,help='Explicit offline FP16/INT8/FP16 comparison using a quantization report')
    parser.add_argument('--body-framing',action='store_true',help='Compare full canvas / active body framing / full canvas with FP16 instances')
    parser.add_argument('--body-instance-budget',action='store_true',help='Compare body CPU budgets with concurrent FP16 instance protection')
    parser.add_argument('--body-demand',action='store_true',help='Compare all analysis / face-only demand / all analysis without changing face models')
    parser.add_argument('--instance-hybrid',type=Path,help='Compare CPU/hybrid/CPU instance execution; diagnostic only')
    parser.add_argument('--instance-rtmdet',type=Path,help='Compare CPU/RTMDet/CPU instance execution; diagnostic only')
    parser.add_argument('--refine-instance-matching',action='store_true',help='Explicit RTMDet duplicate suppression and one-pixel anchor experiment')
    parser.add_argument('--proposal-batch-model',type=Path,help='Explicit sequential/batched/sequential proposal comparison with RTMDet')
    parser.add_argument('--semantic-probability-model',type=Path,help='Explicit CPU/GPU/CPU skin activation comparison with RTMDet')
    parser.add_argument('--hybrid-partition',choices=['backbone','proposals','convolutions'],default='backbone')
    parser.add_argument('--hybrid-head-budget',action='store_true',help='With --instance-hybrid compare 4/2/1/4 CPU head threads')
    parser.add_argument('--gpu-fifo',action='store_true',help='With --instance-hybrid compare ordinary lock/FIFO/ordinary lock')
    parser.add_argument('--instance-thread-values',type=int,nargs='+',choices=[1,2,4,8],default=[4,2,1,4])
    args = parser.parse_args()
    if args.refine_instance_matching and not args.instance_rtmdet:
        raise ValueError('Refined matching experiment requires RTMDet')
    if args.proposal_batch_model and not args.instance_rtmdet:
        raise ValueError('Proposal batch comparison requires RTMDet')
    if args.semantic_probability_model and (not args.instance_rtmdet or args.proposal_batch_model):
        raise ValueError('Semantic activation comparison requires RTMDet and no proposal batch experiment')
    if args.hybrid_head_budget and not args.instance_hybrid:
        raise ValueError('Hybrid head budget requires a split model directory')
    if args.gpu_fifo and (not args.instance_hybrid or args.hybrid_head_budget):
        raise ValueError('FIFO experiment requires hybrid and no head budget experiment')
    if sum([args.scheduling,args.view_scheduling,args.instance_threads,args.instance_pinning,bool(args.instance_quantization),args.body_framing,args.body_instance_budget,args.body_demand,bool(args.instance_hybrid),bool(args.instance_rtmdet)])>1:
        raise ValueError('Choose one scheduling experiment')
    work = Path('artifacts/beauty-prototype')
    manifest = json.loads(Path(__file__).with_name('assets.json').read_text(encoding='utf-8'))
    models = {}
    for key in ('model','bodyLiteModel','proposalModel','semanticModel'):
        asset = manifest[key]
        data = (work/asset['file']).read_bytes()
        if hashlib.sha256(data).hexdigest() != asset['sha256']:
            raise ValueError('Model checksum mismatch')
        models[key] = data
    directory = Path(tempfile.mkdtemp(prefix='face-threads-',dir=work))
    video = work/'public-motion/cha-cha.webm'
    video_hash = hashlib.sha256(video.read_bytes()).hexdigest()
    if video_hash != 'd60a4057489616003b6f66c26ed80825d95c8ea9b839c8c30824c06be65772fa':
        raise ValueError('Benchmark video checksum mismatch')
    report = {'scope':__doc__,'qualityAccepted':False,'videoSha256':video_hash,'runs':[]}
    if args.semantic_probability_model:
        report['semanticProbabilityModel']=str(args.semantic_probability_model.resolve())
        report['semanticProbabilitySha256']=hashlib.sha256(args.semantic_probability_model.read_bytes()).hexdigest()
    if args.proposal_batch_model:
        report['proposalBatchModel']=str(args.proposal_batch_model.resolve())
        report['proposalBatchSha256']=hashlib.sha256(args.proposal_batch_model.read_bytes()).hexdigest()
    if args.instance_rtmdet:
        report['rtmdetModelDirectory'] = str(args.instance_rtmdet.resolve())
        report['refinedMatching'] = args.refine_instance_matching
    if args.instance_hybrid:
        report['hybridPartition'] = args.hybrid_partition
        report['hybridModelDirectory'] = str(args.instance_hybrid.resolve())
    if args.instance_quantization:
        quantization = json.loads((args.instance_quantization/'report.json').read_text(encoding='utf-8'))
        for name in ('model.xml', 'model.bin'):
            if hashlib.sha256((args.instance_quantization/name).read_bytes()).hexdigest() != quantization['outputs'][name]:
                raise ValueError('Quantized artifact checksum mismatch')
        report['quantization'] = quantization
    capture = cv2.VideoCapture(str(video))
    frames = []
    try:
        for second in range(47):
            capture.set(cv2.CAP_PROP_POS_MSEC,second*1000)
            ok,bgr = capture.read()
            if not ok: raise ValueError('Missing benchmark frame')
            rgb = np.zeros((640,360,3),dtype=np.uint8)
            rgb[219:421] = cv2.cvtColor(cv2.resize(bgr,(360,202),interpolation=cv2.INTER_AREA),cv2.COLOR_BGR2RGB)
            frames.append(rgb)
    finally:
        capture.release()
    if args.view_scheduling:
        fixture = work/'paired.png'
        image = cv2.imread(str(fixture))
        if image is None:
            raise ValueError('UI fixture missing')
        height,width = image.shape[:2]
        frames.append(cv2.cvtColor(cv2.resize(image,(640,round(height*640/width)),interpolation=cv2.INTER_AREA),cv2.COLOR_BGR2RGB))
        report['uiFixtureSha256'] = hashlib.sha256(fixture.read_bytes()).hexdigest()
    reference = []
    with ExitStack() as stack:
        locator = stack.enter_context(DirectMLProposals(models['proposalModel']))
        batch_locator=stack.enter_context(DirectMLProposals(args.proposal_batch_model.read_bytes(),batch_size=3)) if args.proposal_batch_model else None
        semantic = stack.enter_context(DirectMLFaceSegmentation(models['semanticModel']))
        probability_semantic=stack.enter_context(DirectMLFaceSegmentation(args.semantic_probability_model.read_bytes(),probability_output=True)) if args.semantic_probability_model else None
        pool = stack.enter_context(ThreadPoolExecutor(max_workers=4))
        instance_pool = stack.enter_context(ThreadPoolExecutor(max_workers=1)) if args.instance_threads or args.instance_pinning or args.instance_quantization or args.body_framing or args.body_instance_budget or args.instance_hybrid or args.instance_rtmdet else None
        configurations = [(None,'eager'),(None,'baseline-aware')] if args.scheduling else [(v,'eager') for v in (None,1,2,4)]
        if args.view_scheduling:
            configurations = [(None,'fixed-views'),(None,'balanced-views'),(None,'fixed-views-repeat')]
        if args.instance_threads:
            configurations = [(None,f'instance-{threads}') for threads in args.instance_thread_values]
        if args.instance_pinning:
            configurations = [(None,'pinning-off'),(None,'pinning-on'),(None,'pinning-off')]
        if args.instance_quantization:
            configurations = [(None,'fp16'),(None,'int8'),(None,'fp16-repeat')]
        if args.body_framing:
            configurations = [(None,'canvas'),(None,'active-body'),(None,'canvas-repeat')]
        if args.body_instance_budget:
            configurations = [(None,'body-4-2'),(None,'body-4-1'),(None,'body-2-1'),(None,'body-4-2')]
        if args.body_demand:
            configurations = [(None,'all-effects'),(None,'face-only'),(None,'all-effects-repeat')]
        if args.instance_hybrid:
            configurations = [(None,'cpu'),(None,'hybrid'),(None,'cpu-repeat')]
            if args.hybrid_head_budget:
                configurations = [(None,f'hybrid-head-{value}') for value in (4,2,1,4)]
            if args.gpu_fifo:
                configurations = [(None,'hybrid-lock'),(None,'hybrid-fifo'),(None,'hybrid-lock')]
        if args.instance_rtmdet:
            configurations = [(None,'cpu'),(None,'rtmdet'),(None,'cpu-repeat')]
        if args.proposal_batch_model:
            configurations = [(None,'rtmdet'),(None,'rtmdet-batch'),(None,'rtmdet-repeat')]
        if args.semantic_probability_model:
            configurations = [(None,'rtmdet'),(None,'rtmdet-semantic'),(None,'rtmdet-repeat')]
        for threads,scheduling in configurations:
            def options(model_asset_buffer):
                return ThreadedBaseOptions(model_asset_buffer,threads)
            with ExitStack() as group:
                if scheduling == 'hybrid-fifo':
                    group.enter_context(patch('directml_execution._submission_lock',SubmissionQueue()))
                body_type = ActiveBodyAnalyzer if scheduling == 'active-body' else BodyAnalyzer
                body_workers, body_threads = map(int,scheduling.split('-')[1:]) if args.body_instance_budget else (4,2)
                body = group.enter_context(body_type(models['bodyLiteModel'], workers=body_workers, threads=body_threads))
                instance_threads = int(scheduling.split('-')[-1]) if args.instance_threads else 4 if instance_pool else None
                if scheduling.startswith('rtmdet'):
                    from rtmdet_instances import RTMDetInstances
                    instance = group.enter_context(RTMDetInstances(args.instance_rtmdet))
                else:
                    instance = group.enter_context(PersonInstances(work/'person-instance',threads=instance_threads,cpu_pinning=scheduling=='pinning-on')) if instance_pool else None
                if scheduling.startswith('hybrid'):
                    from instance_hybrid import HybridCompiled
                    head_threads = int(scheduling.split('-')[-1]) if args.hybrid_head_budget else 4
                    instance.compiled = HybridCompiled(args.instance_hybrid,head_threads=head_threads,partition=args.hybrid_partition)
                if scheduling == 'int8':
                    import openvino as ov
                    instance.compiled = ov.Core().compile_model(str(args.instance_quantization/'model.xml'), 'CPU',
                        {'INFERENCE_NUM_THREADS': 4, 'NUM_STREAMS': 1, 'ENABLE_CPU_PINNING': False})
                # Both face graph constructors resolve this same module property.
                with patch('analyzer.mp.tasks.BaseOptions',options) if threads else nullcontext():
                    analyzer = BalancedFaceAnalyzer if scheduling=='balanced-views' else FaceAnalyzer
                    face = group.enter_context(analyzer(models['model']))
                    proposals = group.enter_context(FaceProposals(models['model'],models['proposalModel'],
                        batch_locator if scheduling=='rtmdet-batch' else locator,batched=scheduling=='rtmdet-batch'))
                run = {'threads':threads,'instanceThreads':instance_threads,'scheduling':scheduling,'samples':[],'matchingFaces':0,'matchingBodies':0,'maxCoordinateDifference':0}
                report['runs'].append(run)
                for index,rgb in enumerate(frames):
                    started = time.perf_counter()
                    face_job = pool.submit(measured,face.analyze,rgb)
                    proposal_job = pool.submit(measured_gpu,proposals.locate,rgb) if scheduling=='baseline-aware' else pool.submit(measured_gpu,proposals.analyze,rgb,[])
                    semantic_job = pool.submit(measured_gpu,
                        probability_semantic.analyze if scheduling=='rtmdet-semantic' else semantic.analyze,rgb)
                    body_job = pool.submit(measured,body_frame,body,rgb,instance,instance_pool,
                        args.refine_instance_matching and scheduling.startswith('rtmdet')) if scheduling != 'face-only' else None
                    baseline,face_ms = face_job.result()
                    extra,proposal_ms,proposal_gpu = proposal_job.result()
                    if scheduling=='baseline-aware':
                        extra,refine_ms = measured(proposals.refine,rgb,baseline,extra)
                        proposal_ms += refine_ms
                    mask,semantic_ms,semantic_gpu = semantic_job.result()
                    body_result,body_ms = body_job.result() if body_job else ({'sha256':None,'bodies':0,'protectedPixels':[]},0)
                    body_hash = body_result['sha256']
                    faces = extra if scheduling=='baseline-aware' else merge_faces(list(enumerate(baseline+extra)))
                    coordinates = np.array([[person[key] for key in sorted(person)] for person in faces])
                    if len(report['runs']) == 1:
                        reference.append((coordinates,body_hash))
                    expected,expected_body = reference[index]
                    diff = None
                    if expected.shape == coordinates.shape:
                        diff = float(np.max(np.abs(expected-coordinates))) if coordinates.size else 0
                        run['maxCoordinateDifference'] = max(run['maxCoordinateDifference'],diff)
                        run['matchingFaces'] += int(diff <= 1e-5)
                    run['matchingBodies'] += int(body_hash==expected_body)
                    run['samples'].append({'second':index,'faces':len(faces),'groupMs':(time.perf_counter()-started)*1000,
                        'referenceFaces':len(expected),'coordinateDifference':diff,
                        'bodies':body_result['bodies'],'protectedPixels':body_result['protectedPixels'],
                        'hybridTiming':dict(instance.compiled.timing) if scheduling.startswith('hybrid') else None,
                        'instanceTiming':dict(instance.timing) if instance_pool else None,
                        'proposalGpu':proposal_gpu,'semanticGpu':semantic_gpu,
                        'faceMs':face_ms,'proposalMs':proposal_ms,'semanticMs':semantic_ms,'bodyMs':body_ms,'maskMaximum':float(mask.max())})
                for key in ('groupMs','faceMs','proposalMs','semanticMs','bodyMs'):
                    run[key+'P95'] = float(np.percentile([s[key] for s in run['samples']],95))
                print(json.dumps({key:value for key,value in run.items() if key!='samples'}),flush=True)
    (directory/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({'directory':str(directory)}))


if __name__ == '__main__':
    main()
