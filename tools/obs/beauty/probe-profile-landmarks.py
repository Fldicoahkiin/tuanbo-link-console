"""Inspect missed reviewed faces without changing production acceptance thresholds."""
import hashlib
import json
from pathlib import Path
import tempfile
from contextlib import ExitStack

import cv2
import mediapipe as mp
import numpy as np
from directml_proposals import DirectMLProposals
from proposal_views import tiled_proposals
from face_landmark_region import FaceLandmarkRegion, ROI_SCALE
from face_proposals import proposal_error
from detect import face_region


def main():
    work = Path('artifacts/beauty-prototype')
    annotations = json.loads(Path(__file__).with_name('semantic-regions.json').read_text(encoding='utf-8'))
    directory = Path(tempfile.mkdtemp(prefix='profile-landmarks-', dir=work))
    report = {'scope': __doc__, 'qualityAccepted': False, 'samples': []}
    with ExitStack() as stack:
        locator = stack.enter_context(DirectMLProposals((work/'face_detection_yunet_2023mar.onnx').read_bytes()))
        detector = stack.enter_context(FaceLandmarkRegion((work/'face_landmarker.task').read_bytes()))
        for sample in annotations['samples']:
            bgr = cv2.imdecode(np.frombuffer((work/'face-segmentation-clc958q0'/f"{sample['timestampMs']}-source.png").read_bytes(), dtype=np.uint8), cv2.IMREAD_COLOR)
            source = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            if hashlib.sha256(source.tobytes()).hexdigest() != sample['rawSha256']:
                raise ValueError('Reviewed source changed')
            for portrait in (False, True):
                if portrait:
                    rgb = np.zeros((640,360,3), dtype=np.uint8)
                    rgb[219:421] = cv2.resize(source,(360,202), interpolation=cv2.INTER_AREA)
                else:
                    rgb = source
                h, w = rgb.shape[:2]
                image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
                boxes = tiled_proposals(locator,rgb,640)
                for box in ([] if boxes is None else boxes):
                    row = {'timestampMs':sample['timestampMs'], 'portrait':portrait, 'box':box.tolist(), 'variants':[]}
                    for scale in (1,1.2,1.5):
                        for axis, shift in [(axis,0) for axis in ('eyes','horizontal','mirror')]+[('shift',value) for value in (-.2,-.1,.1,.2)]:
                            roi = box.copy()
                            roi[2:4] = box[2:4]*scale/ROI_SCALE
                            roi[:2] = box[:2]+(box[2:4]-roi[2:4])/2
                            roi[0] += shift*max(box[2],box[3])
                            if axis == 'horizontal':
                                roi[7] = roi[5]
                            view = image
                            if axis == 'mirror':
                                view = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(np.fliplr(rgb)))
                                roi[0] = w-roi[0]-roi[2]
                                roi[4:14:2] = w-roi[4:14:2]
                                roi[4:8] = roi[[6,7,4,5]]
                                roi[10:14] = roi[[12,13,10,11]]
                            points = detector.detect(view,roi)
                            face = face_region(points) if points is not None else None
                            if face is not None and axis == 'mirror':
                                face = {key:1-value if key.endswith('x') and key!='rx' else value for key,value in face.items()}
                            error = proposal_error(face,box,w,h) if face is not None else None
                            valid = face is not None and error is not None and error <= .18 and all(np.isfinite(v) and 0 <= v <= 1 for v in face.values()) and face['rx'] >= .005 and face['ry'] >= .005
                            row['variants'].append({'scale':scale,'axis':axis,'shift':shift,'present':face is not None,'error':error,'valid':valid,
                                'region':None if face is None else {key:face[key] for key in ('cx','cy','rx','ry')}})
                    report['samples'].append(row)
    (directory/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({'directory':str(directory),'proposals':len(report['samples'])}))


if __name__ == '__main__':
    main()
