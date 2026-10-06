"""Development live face analysis. Frames originate only from an OBS filter."""
import argparse
import hashlib
import json
from pathlib import Path
import time
import sys
import threading
from contextlib import ExitStack
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from analyzer import FaceAnalyzer, merge_faces
from stabilizer import GeometryStabilizer
from transport import Transport, k32
from body import BodyAnalyzer, exclusive_masks
from body_stabilizer import BodyStabilizer
from face_proposals import FaceProposals
from face_segmentation import FaceSegmentation
from owner_watch import OwnerWatch
from profile_skin import profile_guard
from body_instances import protect_body_masks
from directml_execution import capture_timings


def analyze_face_proposals(proposals, rgb):
    started = time.perf_counter()
    with capture_timings() as timings:
        boxes = proposals.locate(rgb)
        located = time.perf_counter()
        faces = proposals.refine(rgb, [], boxes)
    return faces, (located-started)*1000, (time.perf_counter()-located)*1000, boxes, timings


def analyze_semantic_face(segmenter, rgb):
    started = time.perf_counter()
    with capture_timings() as timings:
        mask = segmenter.analyze(rgb)
    return mask, (time.perf_counter()-started)*1000, timings


def status_packet(state, now, face_snapshot, body_snapshot):
    face_epoch, faces = face_snapshot
    _, body_age, bodies, body_epoch = body_snapshot
    face = faces.get(state['accepted_sequence']) if face_epoch == state['epoch'] else None
    body = bodies.get(state['body_accepted_sequence']) if body_epoch == state['epoch'] else None
    return dict(faces=face[1] if face else 0, profiles=face[2] if face else 0,
        sequence=state['sequence'], accepted=state['accepted_sequence'],
        age_ms=now-state['timestamp'] if state['timestamp'] else 0,
        face_status=state['status'], accepted_age_ms=now-face[0] if face else None,
        bodies=body[1] if body else 0, body_accepted=state['body_accepted_sequence'],
        body_age_ms=body_age, body_accepted_age_ms=now-body[0] if body else None,
        body_status=state['body_status'])


def report_status(transport, stopped, face_snapshot, body_snapshot, snapshot_lock, emit):
    while not stopped.is_set():
        # Read the acknowledgement independently of model completion. Never
        # promote a submitted result to accepted before OBS confirms it.
        state = transport.read_status()
        now = k32.GetTickCount64()
        with snapshot_lock:
            packet = status_packet(state, now, face_snapshot, body_snapshot)
        emit(packet)
        stopped.wait(.05)


def analyze_instances(detector, rgb):
    started = time.perf_counter()
    with capture_timings() as timings:
        masks = detector.analyze(rgb)
    return masks, (time.perf_counter()-started)*1000, timings


def warmup_models(transport, stopped, actions):
    """Initialize model execution once on a real frame; never publish that frame."""
    deadline = time.monotonic()+2
    frame = None
    while not stopped.is_set():
        frame = transport.read(0)
        if frame is not None:
            break
        if time.monotonic() >= deadline:
            raise TimeoutError('No OBS frame available for model warmup')
        stopped.wait(.003)
    if frame is None:
        return {'sequence':0,'stages':[],'cancelled':True}
    rgb = np.frombuffer(frame['rgba'],dtype=np.uint8).reshape(frame['height'],frame['width'],4)[:,:,:3]
    stages = []
    for name,action in actions:
        if stopped.is_set():
            break
        started = time.perf_counter()
        action(rgb)
        stages.append({'model':name,'elapsedMs':(time.perf_counter()-started)*1000})
    return {'sequence':frame['sequence'],'stages':stages,'cancelled':stopped.is_set()}


def analyze_body(detector, transport, stopped, snapshot, snapshot_lock, samples, history_limit, instance_detector=None, instance_pool=None, initial_sequence=0, body_on_demand=False, refined_instances=False):
    previous = initial_sequence
    epoch = None
    results = {}
    stabilizer = BodyStabilizer()
    while not stopped.is_set():
        frame = transport.read(previous)
        if frame is None:
            stopped.wait(.003)
            continue
        previous = frame['sequence']
        try:
            if body_on_demand and not frame['body_requested']:
                transport.write_body(frame, [], [])
                results.clear()
                stabilizer = BodyStabilizer()
                with snapshot_lock:
                    snapshot[:] = [0, 0, {}, frame['epoch']]
                continue
            started = time.perf_counter()
            input_age = k32.GetTickCount64() - frame['timestamp']
            rgba = np.frombuffer(frame['rgba'],dtype=np.uint8).reshape(frame['height'],frame['width'],4)
            instance_job = instance_pool.submit(analyze_instances,instance_detector,rgba[:,:,:3]) if instance_detector is not None else None
            bodies = detector.analyze(rgba[:,:,:3])
            bodies = stabilizer.update(bodies, frame['timestamp'], (frame['epoch'], frame['width'], frame['height']))
            detected = time.perf_counter()
            masks = exclusive_masks(bodies)
            assignments = None
            instance_ms = instance_wait_ms = instance_protection_ms = 0
            instance_gpu = []
            if instance_job is not None:
                waiting = time.perf_counter()
                instances,instance_ms,instance_gpu = instance_job.result()
                protecting = time.perf_counter()
                instance_wait_ms = (protecting-waiting)*1000
                if refined_instances:
                    from rtmdet_instances import suppress_duplicate_masks
                    instances = suppress_duplicate_masks(instances)
                masks,assignments = protect_body_masks([body.joints for body in bodies],masks,instances,
                    anchor_radius=1 if refined_instances else 0)
                # Only protected, positively supported bodies are published and
                # counted. No stale masks or unconfirmed ownership are reused.
                pairs = [(body,mask) for body,mask,index in zip(bodies,masks,assignments) if index is not None and np.any(mask>0)]
                bodies = [body for body,_ in pairs]
                masks = [mask for _,mask in pairs]
                instance_protection_ms = (time.perf_counter()-protecting)*1000
            masked = time.perf_counter()
            transport.write_body(frame, bodies, masks)
            published = time.perf_counter()
            result_age = k32.GetTickCount64() - frame['timestamp']
            samples.append(dict(sequence=previous, bodies=len(bodies), input_age_ms=input_age,
                instance_assignments=assignments,
                instance_gpu=instance_gpu,
                instance_ms=instance_ms, instance_wait_ms=instance_wait_ms, instance_protection_ms=instance_protection_ms,
                inference_ms=(detected-started)*1000, masks_ms=(masked-detected)*1000,
                publish_ms=(published-masked)*1000, processing_ms=(published-started)*1000,
                result_age_ms=result_age))
            # Diagnostic history is bounded independently of session duration.
            del samples[:-history_limit]
            if epoch != frame['epoch']:
                results.clear()
                epoch = frame['epoch']
            results[previous] = (frame['timestamp'], len(bodies))
            if len(results) > 32:
                del results[next(iter(results))]
            with snapshot_lock:
                snapshot[:] = [len(bodies), result_age, dict(results), frame['epoch']]
        except BaseException:
            transport.write_body(frame, [], [], error=1)
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--channel", required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--body-model", type=Path)
    parser.add_argument('--instance-model-dir',type=Path,help='Explicit experimental person-instance protection')
    parser.add_argument('--instance-hybrid-dir',type=Path,help='Explicit verified experimental GPU backbone')
    parser.add_argument('--instance-rtmdet-dir',type=Path,help='Explicit experimental RTMDet person protection with refined matching')
    parser.add_argument('--gpu-fifo',action='store_true',help='Explicit experimental fair GPU submission order')
    parser.add_argument('--warmup-models',action='store_true',help='Initialize all models on a real frame before publishing')
    parser.add_argument('--body-on-demand',action='store_true',help='Analyze bodies only when OBS has a nonzero body effect')
    parser.add_argument("--proposal-model", type=Path, help="Verified supplementary face model")
    parser.add_argument('--proposal-backend', choices=['opencv','directml'], default='opencv')
    parser.add_argument("--profile-skin", action="store_true", help="Explicit landmark-independent protected skin processing")
    parser.add_argument("--semantic-model", type=Path, help="Explicit experimental face-skin segmentation model")
    parser.add_argument('--semantic-backend', choices=['mediapipe','directml'], default='mediapipe')
    parser.add_argument('--semantic-probability',action='store_true',help='Explicit GPU skin probability output model')
    parser.add_argument("--seconds", type=float, default=30)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--stop-file", type=Path)
    parser.add_argument("--managed", action="store_true")
    parser.add_argument("--diagnostic-history", type=int, default=120)
    args = parser.parse_args()
    if (args.instance_model_dir or args.instance_rtmdet_dir) and not args.body_model:
        raise ValueError('Instance protection requires a body model')
    if args.instance_rtmdet_dir and (args.instance_model_dir or args.instance_hybrid_dir):
        raise ValueError('Choose one instance protection model')
    if args.instance_hybrid_dir and not args.instance_model_dir:
        raise ValueError('Hybrid execution requires instance protection')
    if args.proposal_backend=='directml' and args.proposal_model is None:
        raise ValueError('DirectML proposals require an explicit verified model')
    if args.profile_skin and (args.proposal_model is None or args.semantic_model is None):
        raise ValueError('Profile skin requires face proposals and semantic protection')
    if args.semantic_backend=='directml' and args.semantic_model is None:
        raise ValueError('DirectML segmentation requires an explicit verified model')
    if args.semantic_probability and (args.semantic_backend!='directml' or args.semantic_model is None):
        raise ValueError('GPU skin probability requires a DirectML semantic model')
    if not 0 < args.seconds <= 14400:
        raise ValueError("Duration must be between 0 and 14400 seconds")
    if not 120 <= args.diagnostic_history <= 10000:
        raise ValueError("Diagnostic history must be between 120 and 10000 samples")
    model = args.model.read_bytes()
    expected = json.loads(Path(__file__).with_name("assets.json").read_text(encoding="utf-8"))["model"]["sha256"]
    if hashlib.sha256(model).hexdigest() != expected:
        raise ValueError("Model checksum mismatch")
    body_model = None
    if args.body_model:
        body_model = args.body_model.read_bytes()
        expected_body = json.loads(Path(__file__).with_name('assets.json').read_text(encoding='utf-8'))['bodyLiteModel']['sha256']
        if hashlib.sha256(body_model).hexdigest() != expected_body:
            raise ValueError('Body model checksum mismatch')
    proposal_model = args.proposal_model.read_bytes() if args.proposal_model else None
    semantic_model = args.semantic_model.read_bytes() if args.semantic_model else None
    report = dict(scope="Live face/body analysis transport; no member identities or production acceptance",
                  proposal_backend=args.proposal_backend,
                  semantic_backend=args.semantic_backend,
                  semantic_probability=args.semantic_probability,
                  instance_protection=args.instance_model_dir is not None or args.instance_rtmdet_dir is not None,
                  instance_rtmdet=args.instance_rtmdet_dir is not None,
                  instance_hybrid=args.instance_hybrid_dir is not None,
                  gpu_fifo=args.gpu_fifo, body_on_demand=args.body_on_demand,
                  semantic_face_protection=semantic_model is not None, profile_skin=args.profile_skin,
                  supplementary_face_detection=proposal_model is not None, samples=[], body_samples=[])
    ready = False
    stabilizer = GeometryStabilizer()
    stopped = threading.Event()
    owner = None
    output_lock = threading.Lock()
    def emit(packet):
        with output_lock:
            print(json.dumps(packet), flush=True)
    try:
        if args.managed:
            owner = OwnerWatch(sys.stdin.fileno(), stopped)
        with ExitStack() as stack:
            if args.gpu_fifo:
                from directml_execution import fifo_submissions
                stack.enter_context(fifo_submissions())
            transport = stack.enter_context(Transport(args.channel))
            detector = stack.enter_context(FaceAnalyzer(model))
            locator = None
            if args.proposal_backend=='directml':
                from directml_proposals import DirectMLProposals
                locator = stack.enter_context(DirectMLProposals(proposal_model))
            proposals = stack.enter_context(FaceProposals(model, proposal_model, locator)) if proposal_model is not None else None
            proposal_pool = stack.enter_context(ThreadPoolExecutor(max_workers=1, thread_name_prefix='face-proposal-frame')) if proposals else None
            segmenter = None
            if semantic_model is not None:
                if args.semantic_backend=='directml':
                    from directml_segmentation import DirectMLFaceSegmentation
                    segmenter = stack.enter_context(DirectMLFaceSegmentation(semantic_model,probability_output=args.semantic_probability))
                else:
                    segmenter = stack.enter_context(FaceSegmentation(semantic_model))
            semantic_pool = stack.enter_context(ThreadPoolExecutor(max_workers=1, thread_name_prefix='face-segmentation')) if segmenter else None
            body_detector = stack.enter_context(BodyAnalyzer(body_model)) if body_model else None
            instance_detector = None
            if args.instance_rtmdet_dir:
                from rtmdet_instances import RTMDetInstances
                instance_detector = stack.enter_context(RTMDetInstances(args.instance_rtmdet_dir))
            if args.instance_model_dir:
                from person_instances import PersonInstances
                instance_detector = stack.enter_context(PersonInstances(args.instance_model_dir))
                if args.instance_hybrid_dir:
                    from instance_hybrid import HybridCompiled
                    instance_detector.compiled = HybridCompiled(args.instance_hybrid_dir)
            instance_pool = stack.enter_context(ThreadPoolExecutor(max_workers=1,thread_name_prefix='body-instance')) if instance_detector else None
            body_pool = stack.enter_context(ThreadPoolExecutor(max_workers=1,thread_name_prefix='body-frame')) if body_model else None
            status_pool = stack.enter_context(ThreadPoolExecutor(max_workers=1,thread_name_prefix='obs-status')) if args.managed else None
            stack.callback(stopped.set)
            body_snapshot = [0,0,{},0]
            face_snapshot = [0,{}]
            body_lock = threading.Lock()
            warmup_sequence = 0
            if args.warmup_models:
                actions = [('face',detector.analyze)]
                if proposals:
                    actions.append(('proposals',lambda rgb:proposals.analyze(rgb,[])))
                if segmenter:
                    actions.append(('semantic',segmenter.analyze))
                if body_detector:
                    actions.append(('body',body_detector.analyze))
                if instance_detector:
                    actions.append(('instances',instance_detector.analyze))
                report['warmup'] = warmup_models(transport,stopped,actions)
                warmup_sequence = report['warmup']['sequence']
            body_future = body_pool.submit(analyze_body,body_detector,transport,stopped,body_snapshot,body_lock,report['body_samples'],args.diagnostic_history,instance_detector,instance_pool,warmup_sequence,args.body_on_demand,args.instance_rtmdet_dir is not None) if body_pool else None
            body_count = 0
            body_age = 0
            if args.managed:
                emit(dict(started=True))
            status_future = status_pool.submit(report_status,transport,stopped,face_snapshot,body_snapshot,body_lock,emit) if status_pool else None
            deadline = time.monotonic() + args.seconds
            previous = warmup_sequence
            face_results = {}
            while (args.managed or time.monotonic() < deadline) and not stopped.is_set():
                if status_future is not None and status_future.done():
                    status_future.result()
                    raise RuntimeError('OBS status reporting ended unexpectedly')
                if args.stop_file and args.stop_file.exists():
                    break
                frame = transport.read(previous)
                if frame is None:
                    time.sleep(0.003)
                    continue
                previous = frame["sequence"]
                rgba = np.frombuffer(frame["rgba"], dtype=np.uint8).reshape(frame["height"], frame["width"], 4)
                started = time.perf_counter()
                input_age = k32.GetTickCount64() - frame['timestamp']
                try:
                    if body_future is not None and body_future.done():
                        body_future.result()
                        if stopped.is_set():
                            break
                        raise RuntimeError('Body analysis ended unexpectedly')
                    with body_lock:
                        body_count, body_age, body_results, _ = body_snapshot
                    proposal_future = proposal_pool.submit(analyze_face_proposals, proposals, rgba[:, :, :3]) if proposal_pool else None
                    semantic_future = semantic_pool.submit(analyze_semantic_face, segmenter, rgba[:, :, :3]) if semantic_pool else None
                    faces = detector.analyze(rgba[:, :, :3])
                    baseline_done = time.perf_counter()
                    boxes = None
                    proposal_locate_ms = 0
                    proposal_refine_ms = 0
                    proposal_gpu = []
                    proposal_ready = baseline_done
                    if proposal_future is not None:
                        candidates, proposal_locate_ms, proposal_refine_ms, boxes, proposal_gpu = proposal_future.result()
                        proposal_ready = time.perf_counter()
                        # Both complete pipelines use this same immutable frame.
                        # Preserve baseline priority and publish one merged result.
                        faces = merge_faces(list(enumerate(faces+candidates)))
                    proposal_done = time.perf_counter()
                    # No identity claims: every detected face uses the same defaults.
                    # Regions outside the viewport are omitted, never coerced to bad coordinates.
                    faces = [f for f in faces if all(np.isfinite(value) and 0 <= value <= 1 for value in f.values())]
                    faces = stabilizer.update(faces, frame["timestamp"], (frame["epoch"], frame["width"], frame["height"]))
                    semantic_mask, semantic_ms, semantic_gpu = semantic_future.result() if semantic_future is not None else (None, 0, [])
                    guard, profile_count = profile_guard((frame['height'],frame['width']),boxes,faces,semantic_mask) if args.profile_skin else (None,0)
                    geometry_done = time.perf_counter()
                    transport.write(frame, faces, semantic_mask=semantic_mask, profile_mask=guard if profile_count else None, profile_count=profile_count)
                    publish_done = time.perf_counter()
                    if face_snapshot[0] != frame['epoch']:
                        face_results.clear()
                    face_results[previous] = (frame['timestamp'], len(faces), profile_count)
                    if len(face_results) > 32:
                        del face_results[next(iter(face_results))]
                    with body_lock:
                        face_snapshot[:] = [frame['epoch'], dict(face_results)]
                except BaseException:
                    transport.write(frame, [], error=1)
                    if body_model:
                        transport.write_body(frame,[],[],error=1)
                    raise
                # Inference can take several capture intervals. Re-read the
                # native acknowledgement now, rather than age a pre-inference
                # snapshot and misreport it as the current accepted geometry.
                accepted_state = transport.read_status()
                with body_lock:
                    body_count, body_age, body_results, _ = body_snapshot
                accepted_face = face_results.get(accepted_state['accepted_sequence']) if accepted_state['epoch'] == frame['epoch'] else None
                accepted_body = body_results.get(accepted_state['body_accepted_sequence'])
                observed_at = k32.GetTickCount64()
                report["samples"].append(dict(sequence=previous, timestamp=frame["timestamp"],
                    body_requested=frame['body_requested'],
                    inference_ms=(time.perf_counter()-started)*1000, faces=len(faces), profiles=profile_count,
                    input_age_ms=input_age, baseline_ms=(baseline_done-started)*1000,
                    semantic_ms=semantic_ms,
                    proposal_gpu=proposal_gpu, semantic_gpu=semantic_gpu,
                    proposal_locate_ms=proposal_locate_ms, proposal_wait_ms=(proposal_ready-baseline_done)*1000,
                    proposal_refine_ms=proposal_refine_ms,
                    proposal_ms=(proposal_done-baseline_done)*1000, geometry_ms=(geometry_done-proposal_done)*1000,
                    publish_ms=(publish_done-geometry_done)*1000, acknowledgement_ms=(time.perf_counter()-publish_done)*1000,
                    centers=[[f["cx"], f["cy"]] for f in faces], accepted_sequence=accepted_state['accepted_sequence'],
                    observed_sequence=accepted_state['sequence'], face_status=accepted_state['status'],
                    accepted_age_ms=observed_at-accepted_face[0] if accepted_face else None,
                    result_age_ms=k32.GetTickCount64() - frame["timestamp"],
                    bodies=body_count, body_age_ms=body_age, body_accepted_sequence=accepted_state['body_accepted_sequence'],
                    body_status=accepted_state['body_status'],
                    raw_sha256=hashlib.sha256(frame["rgba"]).hexdigest()))
                if args.managed:
                    if len(report["samples"]) > args.diagnostic_history:
                        del report["samples"][:-args.diagnostic_history]
                if (faces or body_count) and not ready:
                    emit(dict(ready=True, faces=len(faces), bodies=body_count))
                    ready = True
            stopped.set()
            if status_future is not None:
                status_future.result()
        if owner is not None:
            owner.check()
    except BaseException as error:
        report["error"] = str(error)
        raise
    finally:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(dict(frames=len(report["samples"]), report=str(args.report))))


if __name__ == "__main__":
    main()
