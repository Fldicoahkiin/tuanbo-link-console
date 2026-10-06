"""Compare fixed ROI scales on the same located faces; diagnostic only."""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile

import cv2
import mediapipe as mp
import numpy as np
from face_proposals import FaceProposals, proposal_error
from detect import face_region
from face_landmark_region import ROI_SCALE


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('video', type=Path)
    parser.add_argument('--work', type=Path, default=Path('artifacts/beauty-prototype'))
    parser.add_argument('--scales', default='1,1.2,1.5,1.8')
    parser.add_argument('--sample-ms', type=int, default=1000)
    args = parser.parse_args()
    scales = [float(value) for value in args.scales.split(',')]
    if not scales or len(scales) > 8 or any(not .8 <= value <= 2.5 for value in scales):
        raise ValueError('Expected 1..8 fixed ROI scales within .8..2.5')
    if not 100 <= args.sample_ms <= 1000:
        raise ValueError('Sample interval must be 100..1000 milliseconds')
    source = Path(__file__).parent
    model = (args.work/'face_landmarker.task').read_bytes()
    assets = json.loads((source/'assets.json').read_text(encoding='utf-8'))
    if hashlib.sha256(model).hexdigest() != assets['model']['sha256']:
        raise ValueError('Landmark model checksum mismatch')
    digest = hashlib.sha256(args.video.read_bytes()).hexdigest()
    videos = json.loads((source/'motion-assets.json').read_text(encoding='utf-8'))['videos']
    directory = Path(tempfile.mkdtemp(prefix='region-quality-', dir=args.work))
    report = {'video': str(args.video.resolve()), 'sha256': digest, 'scales': scales, 'sampleMs': args.sample_ms,
              'attribution': next((item for item in videos if item['sha256'] == digest), None),
              'scope': __doc__, 'qualityAccepted': False, 'samples': []}
    capture = cv2.VideoCapture(str(args.video))
    try:
        if not capture.isOpened():
            raise ValueError('Cannot decode diagnostic video')
        with FaceProposals(model, (args.work/'face_detection_yunet_2023mar.onnx').read_bytes()) as proposals:
            for sample_index, stamp in enumerate(range(0, 48000, args.sample_ms)):
                second = stamp/1000
                capture.set(cv2.CAP_PROP_POS_MSEC, second*1000)
                ok, bgr = capture.read()
                if not ok:
                    break
                h, w = bgr.shape[:2]
                factor = min(1, 640/max(w, h))
                bgr = cv2.resize(bgr, (round(w*factor), round(h*factor)), interpolation=cv2.INTER_AREA)
                h, w = bgr.shape[:2]
                rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
                image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                boxes = proposals.locate(rgb)
                sample = {'second': second, 'rawSha256': hashlib.sha256(rgb.tobytes()).hexdigest(),
                          'boxes': [] if boxes is None else boxes.tolist(), 'scales': {}}
                for scale in scales:
                    candidates = []
                    annotated = bgr.copy()
                    for box in ([] if boxes is None else boxes):
                        # Preserve center and the original eye axis when varying
                        # that physical square; validate against the ORIGINAL box.
                        roi = box.copy()
                        roi[2:4] = box[2:4]*scale/ROI_SCALE
                        roi[:2] = box[:2]+(box[2:4]-roi[2:4])/2
                        points = proposals.detectors[0].detect(image, roi)
                        face = face_region(points) if points is not None else None
                        error = proposal_error(face, box, w, h) if face is not None else None
                        valid = face is not None and error is not None and error <= .18 and \
                            all(np.isfinite(value) and 0 <= value <= 1 for value in face.values()) and \
                            face['rx'] >= .005 and face['ry'] >= .005
                        candidates.append({'present': face is not None, 'alignmentError': error,
                                           'accepted': bool(valid), 'face': face})
                        if valid:
                            cv2.ellipse(annotated, (round(face['cx']*w), round(face['cy']*h)),
                                        (round(face['rx']*w), round(face['ry']*h)), 0, 0, 360, (0, 255, 255), 1)
                    sample['scales'][str(scale)] = candidates
                    if sample_index % max(1, round(2000/args.sample_ms)) == 0:
                        cv2.putText(annotated, f'{second}s ROI {scale:g}', (8, 18), cv2.FONT_HERSHEY_SIMPLEX, .5, (255, 255, 255), 1)
                        if not cv2.imwrite(str(directory/f'frame-{second:g}-scale-{scale:g}.png'), annotated):
                            raise RuntimeError('Cannot save regional diagnostic')
                report['samples'].append(sample)
        if not report['samples']:
            raise ValueError('No diagnostic frames')
        report['summary'] = {str(scale): {
            'acceptedCandidates': sum(item['accepted'] for sample in report['samples'] for item in sample['scales'][str(scale)]),
            'framesWithTwoCandidates': sum(sum(item['accepted'] for item in sample['scales'][str(scale)]) >= 2 for sample in report['samples'])
        } for scale in scales}
    finally:
        capture.release()
        (directory/'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'directory': str(directory), 'summary': report['summary']}))


if __name__ == '__main__':
    main()
