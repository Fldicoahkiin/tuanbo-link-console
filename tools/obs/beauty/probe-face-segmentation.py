"""Offline semantic face protection inspection; no production quality claim."""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import time
from contextlib import ExitStack
from concurrent.futures import ThreadPoolExecutor

import cv2
import mediapipe as mp
import numpy as np
from face_segmentation import MODEL_SHA256, LABELS, ThreadedBaseOptions, face_confidence
from analyzer import FaceAnalyzer, merge_faces
from face_proposals import FaceProposals
from body import BodyAnalyzer, exclusive_masks


def measured_segment(segmenter, image):
    started = time.perf_counter()
    return segmenter.segment(image), (time.perf_counter()-started)*1000


def analyze_bodies(detector, rgb):
    bodies = detector.analyze(rgb)
    exclusive_masks(bodies)
    return len(bodies)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('video', type=Path)
    parser.add_argument('--work', type=Path, default=Path('artifacts/beauty-prototype'))
    parser.add_argument('--sample-ms', type=int, default=2000)
    parser.add_argument('--threads', type=int, choices=[1, 2, 4, 8], default=1)
    parser.add_argument('--with-detection', action='store_true')
    args = parser.parse_args()
    if not 100 <= args.sample_ms <= 5000:
        raise ValueError('Sampling interval must be 100..5000ms')
    model = (args.work/'selfie_multiclass_256x256.tflite').read_bytes()
    if hashlib.sha256(model).hexdigest() != MODEL_SHA256:
        raise ValueError('Semantic model checksum mismatch')
    digest = hashlib.sha256(args.video.read_bytes()).hexdigest()
    assets = json.loads((Path(__file__).parent/'motion-assets.json').read_text(encoding='utf-8'))['videos']
    directory = Path(tempfile.mkdtemp(prefix='face-segmentation-', dir=args.work))
    report = {'video': str(args.video.resolve()), 'sha256': digest, 'modelSha256': MODEL_SHA256,
              'modelSource': 'https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter',
              'attribution': next((item for item in assets if item['sha256'] == digest), None),
              'scope': __doc__, 'cpuThreads': args.threads, 'concurrentDetection': args.with_detection,
              'qualityAccepted': False, 'samples': []}
    options = mp.tasks.vision.ImageSegmenterOptions(base_options=ThreadedBaseOptions(model, args.threads),
        running_mode=mp.tasks.vision.RunningMode.IMAGE, output_category_mask=True, output_confidence_masks=True)
    capture = cv2.VideoCapture(str(args.video))
    try:
        if not capture.isOpened():
            raise ValueError('Cannot decode semantic diagnostic video')
        with ExitStack() as stack:
            segmenter = stack.enter_context(mp.tasks.vision.ImageSegmenter.create_from_options(options))
            pool = None
            if args.with_detection:
                asset_manifest = json.loads((Path(__file__).parent/'assets.json').read_text(encoding='utf-8'))
                models = {}
                for key in ['model', 'bodyLiteModel', 'proposalModel']:
                    asset = asset_manifest[key]
                    data = (args.work/asset['file']).read_bytes()
                    if hashlib.sha256(data).hexdigest() != asset['sha256']:
                        raise ValueError('Concurrent detection model checksum mismatch')
                    models[key] = data
                baseline = stack.enter_context(FaceAnalyzer(models['model']))
                proposals = stack.enter_context(FaceProposals(models['model'], models['proposalModel']))
                bodies = stack.enter_context(BodyAnalyzer(models['bodyLiteModel']))
                pool = stack.enter_context(ThreadPoolExecutor(max_workers=4, thread_name_prefix='semantic-diagnostic'))
            report['labels'] = segmenter.labels
            if segmenter.labels != LABELS:
                raise ValueError(f'Unexpected model categories: {segmenter.labels}')
            for stamp in range(0, 48000, args.sample_ms):
                capture.set(cv2.CAP_PROP_POS_MSEC, stamp)
                ok, bgr = capture.read()
                if not ok:
                    break
                height, width = bgr.shape[:2]
                scale = min(1, 640/max(width, height))
                bgr = cv2.resize(bgr, (round(width*scale), round(height*scale)), interpolation=cv2.INTER_AREA)
                rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
                image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                started = time.perf_counter()
                counts = None
                if pool is not None:
                    face_job = pool.submit(baseline.analyze, rgb)
                    proposal_job = pool.submit(proposals.analyze, rgb, [])
                    body_job = pool.submit(analyze_bodies, bodies, rgb)
                    semantic_job = pool.submit(measured_segment, segmenter, image)
                    result, duration = semantic_job.result()
                    faces = merge_faces(list(enumerate(face_job.result()+proposal_job.result())))
                    counts = {'faces': len(faces), 'bodies': body_job.result()}
                else:
                    result, duration = measured_segment(segmenter, image)
                total_ms = (time.perf_counter()-started)*1000
                if len(result.confidence_masks) != 6 or result.category_mask is None:
                    raise ValueError('Missing semantic outputs')
                probabilities = np.stack([mask.numpy_view() for mask in result.confidence_masks])
                if probabilities.shape != (6, *rgb.shape[:2]) or not np.isfinite(probabilities).all() or \
                        np.any(probabilities < 0) or np.any(probabilities > 1):
                    raise ValueError('Invalid semantic probabilities')
                categories = result.category_mask.numpy_view()
                face = face_confidence(result, rgb.shape[1], rgb.shape[0])
                report['samples'].append({'timestampMs': stamp, 'inferenceMs': duration, 'totalAnalysisMs': total_ms,
                    'counts': counts,
                    'rawSha256': hashlib.sha256(rgb.tobytes()).hexdigest(),
                    'categoryPixels': np.bincount(categories.ravel(), minlength=6).tolist(),
                    'confidentFacePixels': int(np.count_nonzero(face >= .75))})
                if stamp % 2000 == 0:
                    palette = np.array([[0,0,0], [0,180,255], [255,100,0], [0,255,0], [180,0,180], [255,255,255]], dtype=np.uint8)
                    overlay = cv2.addWeighted(bgr, .6, palette[categories], .4, 0)
                    for name, pixels in [('source', bgr), ('classes', overlay), ('face', np.round(face*255).astype(np.uint8))]:
                        if not cv2.imwrite(str(directory/f'{stamp}-{name}.png'), pixels):
                            raise RuntimeError('Cannot save semantic inspection frame')
        if not report['samples']:
            raise ValueError('No semantic diagnostic frames')
        times = [sample['inferenceMs'] for sample in report['samples']]
        report['summary'] = {'samples': len(times), 'inferenceP50Ms': float(np.percentile(times, 50)),
                             'inferenceP95Ms': float(np.percentile(times, 95)),
                             'totalAnalysisP95Ms': float(np.percentile([sample['totalAnalysisMs'] for sample in report['samples']], 95))}
    except BaseException as error:
        report['error'] = str(error)
        raise
    finally:
        capture.release()
        (directory/'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'directory': str(directory), 'summary': report['summary']}))


if __name__ == '__main__':
    main()
