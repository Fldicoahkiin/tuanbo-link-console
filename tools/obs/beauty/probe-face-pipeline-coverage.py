"""Measure which real-frame faces still depend on the expensive baseline views."""
from contextlib import ExitStack
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import time
from unittest.mock import patch

import cv2
import numpy as np
from analyzer import FaceAnalyzer, analysis_views, merge_faces
from face_proposals import FaceProposals
from directml_proposals import DirectMLProposals


def missing(reference, candidates):
    return [face for face in reference if not any(
        ((face['cx']-other['cx'])/max(face['rx'],other['rx']))**2 +
        ((face['cy']-other['cy'])/max(face['ry'],other['ry']))**2 < .25 for other in candidates)]


def main():
    work = Path('artifacts/beauty-prototype')
    sys.path.insert(0,str((work/'gpu-probe-deps').resolve()))
    video = work/'public-motion/cha-cha.webm'
    sha = hashlib.sha256(video.read_bytes()).hexdigest()
    if sha != 'd60a4057489616003b6f66c26ed80825d95c8ea9b839c8c30824c06be65772fa':
        raise ValueError('Diagnostic video changed')
    directory = Path(tempfile.mkdtemp(prefix='face-pipeline-coverage-',dir=work))
    manifest = json.loads(Path(__file__).with_name('assets.json').read_text())
    models = {}
    for key in ('model','proposalModel'):
        value = (work/manifest[key]['file']).read_bytes()
        if hashlib.sha256(value).hexdigest() != manifest[key]['sha256']:
            raise ValueError('Diagnostic model changed')
        models[key] = value
    report = {'scope':__doc__,'qualityAccepted':False,'videoSha256':sha,'samples':[]}
    capture = cv2.VideoCapture(str(video))
    try:
        with ExitStack() as stack:
            baseline = stack.enter_context(FaceAnalyzer(models['model']))
            locator = stack.enter_context(DirectMLProposals(models['proposalModel']))
            proposals = stack.enter_context(FaceProposals(models['model'],models['proposalModel'],locator))
            for stamp in range(0,47000,1000):
                capture.set(cv2.CAP_PROP_POS_MSEC,stamp)
                ok,bgr = capture.read()
                if not ok:
                    raise ValueError(f'Missing frame {stamp}')
                rgb = np.zeros((640,360,3),dtype=np.uint8)
                rgb[218:420] = cv2.cvtColor(cv2.resize(bgr,(360,202),interpolation=cv2.INTER_AREA),cv2.COLOR_BGR2RGB)
                start = time.perf_counter()
                full = baseline.analyze(rgb)
                full_done = time.perf_counter()
                with patch('analyzer.analysis_views',lambda width,height:analysis_views(width,height)[:3]):
                    coarse = baseline.analyze(rgb)
                coarse_done = time.perf_counter()
                regional = proposals.analyze(rgb,[])
                regional_done = time.perf_counter()
                reference = merge_faces(list(enumerate(full+regional)))
                merged = merge_faces(list(enumerate(coarse+regional)))
                report['samples'].append({'timestampMs':stamp,'baselineMs':(full_done-start)*1000,
                    'coarseMs':(coarse_done-full_done)*1000,'proposalMs':(regional_done-coarse_done)*1000,
                    'reference':reference,'regional':regional,'coarseMerged':merged,
                    'regionalMissing':missing(reference,regional),'coarseMissing':missing(reference,merged)})
        report['summary'] = {'frames':len(report['samples']),
            'regionalMissingFaces':sum(len(row['regionalMissing']) for row in report['samples']),
            'coarseMissingFaces':sum(len(row['coarseMissing']) for row in report['samples'])}
    except BaseException as error:
        report['error'] = str(error)
        raise
    finally:
        capture.release()
        (directory/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
        print(json.dumps({'directory':str(directory),'summary':report.get('summary')}))


if __name__ == '__main__':
    main()
