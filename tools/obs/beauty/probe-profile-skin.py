"""Inspect landmark-independent skin masks; no geometry generation or deployment."""
import hashlib
import json
from pathlib import Path
import tempfile
from contextlib import ExitStack

import cv2
import numpy as np
from directml_proposals import DirectMLProposals
from directml_segmentation import DirectMLFaceSegmentation
from proposal_views import tiled_proposals
from analyzer import FaceAnalyzer, merge_faces
from face_proposals import FaceProposals
from profile_skin import profile_guard, pack_guard, smoothstep


def candidate_mask(rgb, confidence, boxes, faces):
    height,width = rgb.shape[:2]
    guard,count = profile_guard((height,width),boxes,faces,confidence)
    packed = np.round(cv2.resize(confidence,(160,160),interpolation=cv2.INTER_AREA)*255).astype(np.uint8)
    semantic = cv2.resize(packed.astype(np.float32)/255,(width,height),interpolation=cv2.INTER_LINEAR)
    guard = cv2.resize(pack_guard(guard).astype(np.float32)/255,(width,height),interpolation=cv2.INTER_LINEAR)
    return smoothstep(.55,.8,semantic)*guard,count


def main():
    work = Path('artifacts/beauty-prototype')
    annotations = json.loads(Path(__file__).with_name('semantic-regions.json').read_text(encoding='utf-8'))
    directory = Path(tempfile.mkdtemp(prefix='profile-skin-',dir=work))
    report = {'scope':__doc__,'qualityAccepted':False,'regions':[],'frames':[]}
    with ExitStack() as stack:
        detector = stack.enter_context(DirectMLProposals((work/'face_detection_yunet_2023mar.onnx').read_bytes()))
        segmenter = stack.enter_context(DirectMLFaceSegmentation((work/'selfie_multiclass_256x256.onnx').read_bytes()))
        baseline = stack.enter_context(FaceAnalyzer((work/'face_landmarker.task').read_bytes()))
        refiner = stack.enter_context(FaceProposals((work/'face_landmarker.task').read_bytes(),(work/'face_detection_yunet_2023mar.onnx').read_bytes()))
        for sample in annotations['samples']:
            bgr = cv2.imdecode(np.frombuffer((work/'face-segmentation-clc958q0'/f"{sample['timestampMs']}-source.png").read_bytes(),dtype=np.uint8),1)
            original = cv2.cvtColor(bgr,cv2.COLOR_BGR2RGB)
            if hashlib.sha256(original.tobytes()).hexdigest() != sample['rawSha256']:
                raise ValueError('Reviewed source changed')
            for portrait in (False,True):
                rgb,scale,offset = original,1,0
                if portrait:
                    scale = 360/original.shape[1]
                    h = round(original.shape[0]*scale)
                    offset = (640-h)//2
                    rgb = np.zeros((640,360,3),dtype=np.uint8)
                    rgb[offset:offset+h] = cv2.resize(original,(360,h),interpolation=cv2.INTER_AREA)
                boxes = tiled_proposals(detector,rgb,640)
                faces = merge_faces(list(enumerate(baseline.analyze(rgb)+refiner.refine(rgb,[],boxes))))
                effect,profile_count = candidate_mask(rgb,segmenter.analyze(rgb),boxes,faces)
                yy,xx = np.ogrid[:rgb.shape[0],:rgb.shape[1]]
                for region in sample['regions']:
                    x,y,r = region['circle']
                    x,y,r = round(x*scale),round(y*scale)+offset,max(1,round(r*scale))
                    values = effect[(xx-x)**2+(yy-y)**2 <= r*r]
                    report['regions'].append({'timestampMs':sample['timestampMs'],'portrait':portrait,**region,'hasMesh':any(((x-face['cx']*rgb.shape[1])/(face['rx']*rgb.shape[1]))**2+((y-face['cy']*rgb.shape[0])/(face['ry']*rgb.shape[0]))**2<1 for face in faces),'meanStrength':float(values.mean()),'maxStrength':float(values.max())})
                name = f"{sample['timestampMs']}-{'portrait' if portrait else 'landscape'}"
                cv2.imencode('.png',np.round(effect*255).astype(np.uint8))[1].tofile(str(directory/f'{name}-mask.png'))
                report['frames'].append({'name':name,'meshes':len(faces),'profiles':profile_count,'proposalCount':0 if boxes is None else len(boxes),'activePixels':int(np.sum(effect>.01))})
    report['summary'] = [{'portrait':portrait,'excludedWithEffect':sum(r['maxStrength']>.01 for r in report['regions'] if r['portrait']==portrait and r['kind']!='face'),'unmeshedFaces':sum(not r['hasMesh'] for r in report['regions'] if r['portrait']==portrait and r['kind']=='face'),'unmeshedFacesWithEffect':sum(not r['hasMesh'] and r['meanStrength']>.01 for r in report['regions'] if r['portrait']==portrait and r['kind']=='face')} for portrait in (False,True)]
    (directory/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({'directory':str(directory),'summary':report['summary']}))


if __name__ == '__main__':
    main()
