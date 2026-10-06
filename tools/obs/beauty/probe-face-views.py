"""Explain candidate rejection on sampled real-video frames; no accuracy claim."""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack

import cv2
import mediapipe as mp
import numpy as np
from analyzer import FaceAnalyzer, analysis_views, merge_faces
from detect import face_region
from landmarks import POINT_KEYS
from face_proposals import proposal_error


def detect_views(detector, rgb, views):
    results = []
    for order, (x0, y0, x1, y1) in views:
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb[y0:y1, x0:x1]))
        results.append((order, detector.detect(image).face_landmarks))
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('video', type=Path)
    parser.add_argument('--work', type=Path, default=Path('artifacts/beauty-prototype'))
    parser.add_argument('--confidence', type=float, default=.5)
    parser.add_argument('--presence', type=float, default=.5)
    parser.add_argument('--mirror', action='store_true')
    parser.add_argument('--yunet', action='store_true')
    parser.add_argument('--seconds', type=float, default=19)
    parser.add_argument('--sample-seconds', type=float, default=2)
    parser.add_argument('--save-every', type=int, default=1)
    parser.add_argument('--meshes-per-view', type=int, choices=range(1, 7), default=6)
    parser.add_argument('--workers', type=int, choices=range(1, 4), default=1)
    parser.add_argument('--opencv-threads', type=int, choices=range(1, 5), default=1)
    parser.add_argument('--crop-scale', type=float, default=1.8)
    args = parser.parse_args()
    # Bound the independent DNN decoder pool as well as landmark workers.
    cv2.setNumThreads(args.opencv_threads)
    if not .1 <= args.confidence <= .9 or not .1 <= args.presence <= .9:
        raise ValueError('Diagnostic confidence must be within .1..0.9')
    if not 0 < args.seconds <= 600 or not .033 <= args.sample_seconds <= 10 or not 1 <= args.save_every <= 100:
        raise ValueError('Invalid sampling bounds')
    if not 1.2 <= args.crop_scale <= 2.5:
        raise ValueError('Proposal crop scale must be 1.2..2.5')
    model = (args.work/'face_landmarker.task').read_bytes()
    source = Path(__file__).parent
    assets = json.loads((source/'assets.json').read_text(encoding='utf-8'))
    if hashlib.sha256(model).hexdigest() != assets['model']['sha256']:
        raise ValueError('Model checksum mismatch')
    digest = hashlib.sha256(args.video.read_bytes()).hexdigest()
    videos = json.loads((source/'motion-assets.json').read_text(encoding='utf-8'))['videos']
    yunet = None
    if args.yunet:
        model_path = args.work/'face_detection_yunet_2023mar.onnx'
        if hashlib.sha256(model_path.read_bytes()).hexdigest() != '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4':
            raise ValueError('YuNet model checksum mismatch')
        yunet = cv2.FaceDetectorYN.create(str(model_path), '', (640, 360), .7, .3, 5000)
    capture = cv2.VideoCapture(str(args.video))
    if not capture.isOpened():
        capture.release()
        raise ValueError('Video cannot be decoded')
    directory = Path(tempfile.mkdtemp(prefix='face-view-probe-', dir=args.work))
    report = {'video': str(args.video.resolve()), 'sha256': digest, 'confidence': args.confidence, 'presence': args.presence,
              'mirror': args.mirror, 'yunet': args.yunet, 'alignmentLimit': .18,
              'sampleSeconds': args.sample_seconds,
              'meshesPerView': args.meshes_per_view,
              'workers': args.workers,
              'opencvThreads': cv2.getNumThreads(), 'opencvVersion': cv2.__version__,
              'cropScale': args.crop_scale,
              'attribution': next((item for item in videos if item['sha256'] == digest), None),
              'samples': [], 'scope': __doc__}
    if yunet is not None:
        report['diagnosticModel'] = {
            'source': 'https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet',
            'file': 'face_detection_yunet_2023mar.onnx',
            'sha256': '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
            'licenseSource': 'https://github.com/opencv/opencv_zoo/blob/main/models/face_detection_yunet/LICENSE',
            'distribution': 'Diagnostic artifact only; not included in application resources'}
    options = mp.tasks.vision.FaceLandmarkerOptions(base_options=mp.tasks.BaseOptions(model_asset_buffer=model),
        running_mode=mp.tasks.vision.RunningMode.IMAGE, num_faces=args.meshes_per_view,
        min_face_detection_confidence=args.confidence, min_face_presence_confidence=args.presence)
    try:
        with ExitStack() as stack:
            analyzer = stack.enter_context(FaceAnalyzer(model))
            detectors = [stack.enter_context(mp.tasks.vision.FaceLandmarker.create_from_options(options)) for _ in range(args.workers)]
            executor = stack.enter_context(ThreadPoolExecutor(max_workers=args.workers))
            for sample_index, second in enumerate(np.arange(0, args.seconds, args.sample_seconds)):
                second = float(second)
                capture.set(cv2.CAP_PROP_POS_MSEC, second*1000)
                ok, frame = capture.read()
                if not ok:
                    raise ValueError(f'Cannot decode frame at {second} seconds')
                height, width = frame.shape[:2]
                scale = min(1, 640/max(width, height))
                rgb = cv2.cvtColor(cv2.resize(frame, (int(width*scale), int(height*scale))), cv2.COLOR_BGR2RGB)
                height, width = rgb.shape[:2]
                sample = {'seconds': second, 'accepted': len(analyzer.analyze(rgb)), 'candidates': []}
                diagnostic_rgb = np.ascontiguousarray(rgb[:, ::-1]) if args.mirror else rgb
                candidates = []
                started = time.perf_counter()
                views = analysis_views(width, height)
                if yunet is not None:
                    yunet.setInputSize((width, height))
                    _, boxes = yunet.detect(cv2.cvtColor(diagnostic_rgb, cv2.COLOR_RGB2BGR))
                    views = []
                    sample['boxes'] = [] if boxes is None else boxes.tolist()
                    for box in ([] if boxes is None else boxes[:6]):
                        x, y, w, h = box[:4]
                        edge = max(w, h)*args.crop_scale
                        cx, cy = x+w/2, y+h/2
                        views.append((max(0, int(cx-edge/2)), max(0, int(cy-edge/2)),
                                      min(width, int(cx+edge/2)), min(height, int(cy+edge/2))))
                indexed = list(enumerate(views))
                jobs = [executor.submit(detect_views, detector, diagnostic_rgb, indexed[index::args.workers])
                        for index, detector in enumerate(detectors)]
                results = dict(item for job in jobs for item in job.result())
                for order, (x0, y0, x1, y1) in indexed:
                    view_candidates = []
                    for points in results[order]:
                        face = face_region(points)
                        clipped = (yunet is not None or order >= 3) and not (0 <= face['cx']-face['rx'] and face['cx']+face['rx'] <= 1 and
                                                     0 <= face['cy']-face['ry'] and face['cy']+face['ry'] <= 1)
                        for key in ('cx', 'lx', 'ex') + tuple(key for key in POINT_KEYS if key.endswith('x')):
                            face[key] = (face[key]*(x1-x0)+x0)/width
                        for key in ('cy', 'ly', 'ey') + tuple(key for key in POINT_KEYS if key.endswith('y')):
                            face[key] = (face[key]*(y1-y0)+y0)/height
                        face['rx'] *= (x1-x0)/width
                        face['ry'] *= (y1-y0)/height
                        agreement = proposal_error(face, boxes[order], width, height) if yunet is not None else 0
                        if args.mirror:
                            for key in ('cx', 'lx', 'ex') + tuple(key for key in POINT_KEYS if key.endswith('x')):
                                face[key] = 1-face[key]
                        invalid = [key for key, value in face.items() if not np.isfinite(value) or not 0 <= value <= 1]
                        sample['candidates'].append({'view': order, 'center': [face['cx'], face['cy']],
                            'clipped': clipped, 'invalid': invalid, 'tiny': face['rx'] < .005 or face['ry'] < .005,
                            'alignmentError': agreement})
                        if not clipped and not invalid and face['rx'] >= .005 and face['ry'] >= .005 and agreement is not None and agreement <= .18:
                            view_candidates.append((agreement, face))
                    if yunet is not None:
                        # Each independent detection may supply at most one mesh.
                        view_candidates = sorted(view_candidates, key=lambda item: item[0])[:1]
                    candidates.extend((order, face) for _, face in view_candidates)
                faces = merge_faces(candidates)
                sample['diagnosticAccepted'] = len(faces)
                sample['diagnosticMs'] = (time.perf_counter()-started)*1000
                annotated = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
                for face in faces:
                    cv2.ellipse(annotated, (round(face['cx']*width), round(face['cy']*height)),
                                (round(face['rx']*width), round(face['ry']*height)), 0, 0, 360, (0, 255, 255), 1)
                if sample_index % args.save_every == 0 and not cv2.imwrite(str(directory/f'frame-{second:g}.png'), annotated):
                    raise RuntimeError('Cannot save diagnostic frame')
                report['samples'].append(sample)
    finally:
        capture.release()
        (directory/'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'directory': str(directory), 'samples': len(report['samples']),
        'baselineAny': sum(sample['accepted'] > 0 for sample in report['samples']),
        'diagnosticAny': sum(sample['diagnosticAccepted'] > 0 for sample in report['samples']),
        'baselineTwo': sum(sample['accepted'] >= 2 for sample in report['samples']),
        'diagnosticTwo': sum(sample['diagnosticAccepted'] >= 2 for sample in report['samples']),
        'diagnosticMsP95': float(np.percentile([sample['diagnosticMs'] for sample in report['samples']], 95))}))


if __name__ == '__main__':
    main()
