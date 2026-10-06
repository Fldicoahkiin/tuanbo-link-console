"""Sparse visually reviewed regions, not dense ground truth or quality acceptance."""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import time
import sys
from contextlib import ExitStack

import cv2
import mediapipe as mp
import numpy as np
from face_segmentation import FaceSegmentation, face_confidence
from analyzer import FaceAnalyzer, merge_faces
from face_proposals import FaceProposals


from proposal_views import tiled_proposals


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('video', type=Path)
    parser.add_argument('--work', type=Path, default=Path('artifacts/beauty-prototype'))
    parser.add_argument('--portrait', action='store_true')
    parser.add_argument('--uncropped', action='store_true', help='Diagnostic old whole-canvas reference only')
    parser.add_argument('--regional', type=int, choices=[2, 3, 4], help='Diagnostic same-frame detected-face crop scale')
    parser.add_argument('--proposal-tiles', action='store_true', help='Diagnostic fixed multiscale face proposals')
    parser.add_argument('--proposal-edge', type=int, choices=[256,384,512,640], default=640)
    parser.add_argument('--detect-only', action='store_true', help='Inspect detection without local semantic refinement')
    parser.add_argument('--directml-runtime', type=Path, help='Explicit isolated DirectML diagnostic dependencies')
    args = parser.parse_args()
    if args.regional and args.uncropped:
        raise ValueError('Regional and uncropped diagnostics are mutually exclusive')
    if args.proposal_tiles and not args.regional:
        raise ValueError('Tiled proposal inspection requires regional mode')
    if args.detect_only and not args.regional:
        raise ValueError('Detection inspection requires regional mode')
    if args.directml_runtime and not args.regional:
        raise ValueError('DirectML inspection requires regional mode')
    annotations = json.loads((Path(__file__).parent/'semantic-regions.json').read_text(encoding='utf-8'))
    if hashlib.sha256(args.video.read_bytes()).hexdigest() != annotations['videoSha256']:
        raise ValueError('Annotated video checksum mismatch')
    directory = Path(tempfile.mkdtemp(prefix='semantic-regions-', dir=args.work))
    report = {'scope': __doc__, 'qualityAccepted': False, 'portrait': args.portrait, 'uncropped': args.uncropped, 'regional': args.regional, 'proposalTiles': args.proposal_tiles, 'proposalEdge': args.proposal_edge, 'detectOnly': args.detect_only, 'annotations': annotations, 'frames': [], 'regions': []}
    report['directml']=args.directml_runtime is not None
    capture = cv2.VideoCapture(str(args.video))
    try:
        if not capture.isOpened():
            raise ValueError('Cannot decode annotated video')
        with ExitStack() as stack:
            segmenter = stack.enter_context(FaceSegmentation((args.work/'selfie_multiclass_256x256.tflite').read_bytes()))
            if args.regional:
                manifest = json.loads((Path(__file__).parent/'assets.json').read_text(encoding='utf-8'))
                models = {}
                for key in ('model', 'proposalModel'):
                    value = (args.work/manifest[key]['file']).read_bytes()
                    if hashlib.sha256(value).hexdigest() != manifest[key]['sha256']:
                        raise ValueError('Diagnostic face model checksum mismatch')
                    models[key] = value
                detector = stack.enter_context(FaceAnalyzer(models['model']))
                proposals = stack.enter_context(FaceProposals(models['model'],models['proposalModel']))
                locator = proposals
                if args.directml_runtime:
                    sys.path.insert(0,str(args.directml_runtime.resolve()))
                    from directml_proposals import DirectMLProposals
                    locator = stack.enter_context(DirectMLProposals(models['proposalModel']))
            for sample in annotations['samples']:
                capture.set(cv2.CAP_PROP_POS_MSEC, sample['timestampMs'])
                ok, bgr = capture.read()
                if not ok:
                    raise ValueError('Missing annotated frame')
                height, width = bgr.shape[:2]
                scale = min(1, 640/max(width, height))
                bgr = cv2.resize(bgr, (round(width*scale), round(height*scale)), interpolation=cv2.INTER_AREA)
                rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
                if hashlib.sha256(rgb.tobytes()).hexdigest() != sample['rawSha256']:
                    raise ValueError('Annotated frame changed; manual review required')
                region_scale, offset_y = 1, 0
                if args.portrait:
                    region_scale = 360/rgb.shape[1]
                    content_height = round(rgb.shape[0]*region_scale)
                    offset_y = (640-content_height)//2
                    canvas = np.zeros((640,360,3), dtype=np.uint8)
                    canvas[offset_y:offset_y+content_height] = cv2.resize(rgb, (360,content_height), interpolation=cv2.INTER_AREA)
                    rgb = canvas
                    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
                if args.uncropped:
                    image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                    probability = face_confidence(segmenter.segmenter.segment(image), rgb.shape[1], rgb.shape[0])
                else:
                    probability = segmenter.analyze(rgb)
                faces = []
                if args.regional:
                    located_start = time.perf_counter()
                    boxes = tiled_proposals(locator,rgb,args.proposal_edge) if args.proposal_tiles else locator.locate(rgb)
                    located_ms = (time.perf_counter()-located_start)*1000
                    faces = merge_faces(list(enumerate(detector.analyze(rgb)+proposals.refine(rgb,[],boxes))))
                    height, width = rgb.shape[:2]
                    yy, xx = np.ogrid[:height, :width]
                    selected_weight = np.zeros((height,width),dtype=np.float32)
                    started = time.perf_counter()
                    for face in ([] if args.detect_only else faces):
                        cx, cy = face['cx']*width, face['cy']*height
                        rx, ry = face['rx']*width, face['ry']*height
                        edge = max(rx,ry)*args.regional
                        x0,y0 = max(0,int(cx-edge)),max(0,int(cy-edge))
                        x1,y1 = min(width,int(np.ceil(cx+edge))),min(height,int(np.ceil(cy+edge)))
                        local = segmenter.analyze(rgb[y0:y1,x0:x1])
                        weight = np.clip(1-((xx-cx)/rx)**2-((yy-cy)/ry)**2,0,1)
                        preferred = weight[y0:y1,x0:x1] > selected_weight[y0:y1,x0:x1]
                        target = probability[y0:y1,x0:x1]
                        target[preferred] = local[preferred]
                        np.maximum(selected_weight,weight,out=selected_weight)
                    report['frames'].append({'timestampMs':sample['timestampMs'],'faces':len(faces),
                        'locateMs': located_ms,
                        'regions': [{key:face[key] for key in ('cx','cy','rx','ry')} for face in faces],
                        'proposals': [] if boxes is None else boxes.tolist(),
                        'regionalMs':(time.perf_counter()-started)*1000})
                # Exercise the transport's area reduction/uint8 quantization.
                packed = np.round(cv2.resize(probability, (160,160), interpolation=cv2.INTER_AREA)*255).astype(np.uint8)
                restored = cv2.resize(packed.astype(np.float32)/255, (rgb.shape[1],rgb.shape[0]), interpolation=cv2.INTER_LINEAR)
                strength = np.clip((restored-.55)/.25, 0, 1)
                strength = strength*strength*(3-2*strength)
                yy, xx = np.ogrid[:rgb.shape[0], :rgb.shape[1]]
                annotated = bgr.copy()
                for index, region in enumerate(sample['regions']):
                    x, y, radius = region['circle']
                    x, y, radius = round(x*region_scale), round(y*region_scale)+offset_y, max(1,round(radius*region_scale))
                    if radius < 1 or not (radius <= x < rgb.shape[1]-radius and radius <= y < rgb.shape[0]-radius):
                        raise ValueError('Annotated region outside image')
                    inside = (xx-x)**2+(yy-y)**2 <= radius**2
                    values = strength[inside]
                    row = {**region, 'timestampMs': sample['timestampMs'], 'pixels': int(values.size),
                           'detectedFace': any(((x-face['cx']*rgb.shape[1])/(face['rx']*rgb.shape[1]))**2+((y-face['cy']*rgb.shape[0])/(face['ry']*rgb.shape[0]))**2 < 1 for face in faces) if args.regional else None,
                           'meanStrength': float(values.mean()), 'maxStrength': float(values.max()),
                           'activeFraction': float(np.mean(values > .01)),
                           'rawMeanConfidence': float(probability[inside].mean())}
                    report['regions'].append(row)
                    color = (0,255,0) if region['kind'] == 'face' else (0,128,255)
                    cv2.circle(annotated, (x,y), radius, color, 1)
                    cv2.putText(annotated, str(index+1), (x+radius+1,y), cv2.FONT_HERSHEY_SIMPLEX, .35, color, 1)
                for name, image in [('review', annotated), ('strength', np.round(strength*255).astype(np.uint8))]:
                    if not cv2.imwrite(str(directory/f"{sample['timestampMs']}-{name}.png"), image):
                        raise RuntimeError('Cannot save diagnostic frame')
        excluded = [r for r in report['regions'] if r['kind'] != 'face']
        visible = [r for r in report['regions'] if r['kind'] == 'face']
        report['summary'] = {'regions': len(report['regions']),
            'excludedWithEffect': [r for r in excluded if r['maxStrength'] > .01],
            'visibleWeakEffect': [r for r in visible if r['meanStrength'] < .5],
            'undetectedVisibleRegions': [r for r in visible if r['detectedFace'] is False]}
    except BaseException as error:
        report['error'] = str(error)
        raise
    finally:
        capture.release()
        (directory/'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'directory': str(directory), 'summary': report['summary']}))


if __name__ == '__main__':
    main()
